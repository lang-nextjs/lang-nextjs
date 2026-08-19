# Deployment Runbook

Operational procedures for shipping `deepagents-nextjs` apps safely: canary and
blue-green rollouts, Kubernetes liveness/readiness probe wiring (with
preStop/SIGTERM ordering), serverless graceful-shutdown limits, and the
health-gated rollout that ties promotion to the Phase 18 readiness probe.

Probe + shutdown APIs referenced here:

- `createHealthProbe` / `createReadinessProbe` — `packages/server/src/health.ts`
- `createGracefulShutdown` — see [GRACEFUL-SHUTDOWN.md](./GRACEFUL-SHUTDOWN.md)

## Canary Rollout

Deploy a new version (green) alongside the current one (blue) and route a small
slice of traffic to it while watching health and error metrics. Promote on green,
roll back on red.

1. **Deploy green** alongside blue (new revision, same config).
2. **Health-gate green** before sending any user traffic — assert readiness:
   ```bash
   curl -fsS -o /dev/null -w "%{http_code}" "$GREEN_URL/ready"   # expect 200
   ```
   A `503 { status: "draining" }` or any non-200 means green is not ready — abort.
3. **Route a small traffic %** to green. On Vercel this is expressed via the
   `traffic.split` in [`apps/open-swe/vercel.json`](../apps/open-swe/vercel.json);
   on Kubernetes use a weighted Service/Ingress or service-mesh split.
4. **Watch health/metrics** for an observation window (error rate, p95 latency,
   readiness). Verification pattern — send N requests and check the error rate /
   a version header:
   ```bash
   for i in $(seq 1 50); do
     curl -fsS -o /dev/null -w "%{http_code}\n" "$GREEN_URL/api/open-swe/runs"
   done | sort | uniq -c    # expect no 5xx
   ```
5. **Promote** (shift 100% to green) if metrics are clean, or **roll back**
   (shift traffic back to blue) on regression. Vercel's automatic
   health-driven rollback (`rollback.errorThreshold` in `vercel.json`) removes a
   bad release without manual intervention.

## Blue-Green Rollout

1. **Stand up green fully** at production scale (no user traffic yet).
2. **Health-gate green** — assert `GET /ready` returns 200 and run smoke tests
   against it (the staging smoke-test workflow does exactly this).
3. **Flip traffic** atomically from blue to green (DNS / LB / Vercel alias swap).
4. **Keep blue warm** for a hold period so rollback is an instant traffic flip
   back, not a redeploy.
5. **Decommission blue** once green has been stable through the hold window.

## Kubernetes Probe Wiring

Wire the liveness route to `createHealthProbe` and the readiness route to
`createReadinessProbe`. On `SIGTERM`, `createGracefulShutdown` flips
`isDraining()` so **readiness returns 503 first** — the load balancer stops
routing new traffic before in-flight streams are drained.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: deepagents-app
spec:
  template:
    spec:
      # Must exceed createGracefulShutdown drainTimeoutMs so the safety timeout,
      # not the kubelet SIGKILL, controls exit. drainTimeoutMs default = 30000ms.
      terminationGracePeriodSeconds: 45
      containers:
        - name: app
          image: deepagents-app:green
          ports:
            - containerPort: 3000
          # Liveness — backed by createHealthProbe. Restarts a wedged process.
          livenessProbe:
            httpGet:
              path: /health
              port: 3000
            periodSeconds: 10
            failureThreshold: 3
          # Readiness — backed by createReadinessProbe. Flips to 503 on drain so
          # the Service endpoint is removed before streams are drained.
          readinessProbe:
            httpGet:
              path: /ready
              port: 3000
            periodSeconds: 5
            failureThreshold: 2
          lifecycle:
            preStop:
              # preStop runs BEFORE the SIGTERM-driven drain. The sleep lets the
              # readiness probe flip to 503 and the endpoints controller remove
              # this pod from the Service so NO new requests arrive, THEN SIGTERM
              # fires and createGracefulShutdown drains in-flight streams.
              exec:
                command: ["sh", "-c", "sleep 5"]
```

**Shutdown ordering (RESEARCH Pitfall 1):**

1. Pod marked Terminating → `preStop` hook runs (`sleep`), giving the control
   plane time to act.
2. Readiness flips to **503 first** (`isDraining()` is now true) → the endpoints
   controller removes the pod from the Service → the load balancer stops routing
   **new** traffic.
3. `SIGTERM` is delivered → `createGracefulShutdown.dispose()` drains in-flight
   streams up to `drainTimeoutMs`.
4. Clean drain → `process.exit(0)`; hung streams → safety-timeout `exit(1)`,
   guaranteeing the kubelet never has to `SIGKILL`.

Keep `terminationGracePeriodSeconds` > `drainTimeoutMs` + preStop sleep. See
[GRACEFUL-SHUTDOWN.md](./GRACEFUL-SHUTDOWN.md) for the consumer integration.

## Serverless Graceful-Shutdown Limits

Graceful shutdown is **best-effort or not-applicable** on serverless — it is
**not guaranteed** there.

- **Vercel (Node functions): ~500ms window.** Instance recycling gives only a
  ~500ms window before termination — too short to drain long-lived SSE streams.
  Streams will be **truncated**; treat drain as best-effort.
- **Cloudflare Workers: no SIGTERM (N/A).** No process lifecycle, no `SIGTERM`;
  `createGracefulShutdown` does not apply (the module is Node-only and never
  bundled into the edge package).

**Mitigation:** recommend **client-side reconnection** (the `useDeepAgentsChat`
resume/`resumeId` flow re-attaches an interrupted run). Resilience lives on the
client; the server drain loop is an optimization only where the platform (long-
running Node host: Kubernetes, VM/container, bare Node) gives it room to run.

## Health-Gated Rollout

Canary and blue-green promotion are **gated on the Phase 18 readiness probe** —
a release is promoted only after readiness is asserted, and a bad release is
removed by health-driven rollback. This formalizes the Phase 17 canary infra.

- **Gate (promotion):** The staging smoke-test workflow
  [`.github/workflows/smoke-test-staging.yml`](../.github/workflows/smoke-test-staging.yml)
  runs a **Readiness gate** step that curls the open-swe app's `/api/ready` route
  (`apps/open-swe/app/api/ready/route.ts`, backed by `createReadinessProbe`) and
  requires `200` before the deploy is considered
  promotable. A non-200 (including `503 { status: "draining" }`) fails the gate.
  The step degrades cleanly (skips with a clear message) when the preview
  `BASE_URL` is empty, consistent with the manual-only, unprovisioned-secrets
  posture of that workflow.
- **Rollback (de-promotion):** [`apps/open-swe/vercel.json`](../apps/open-swe/vercel.json)
  keeps `rollback.automatic: true` with an `errorThreshold`, and a
  `traffic.split` that includes the health path. A release whose error rate
  crosses the threshold is rolled back automatically — health drives both
  promotion (the readiness gate) and de-promotion (automatic rollback).

Together: `createReadinessProbe` is the single signal that gates traffic in both
directions — the smoke-test readiness gate before promote, and the vercel.json
health-driven rollback after.
