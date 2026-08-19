# Blazing Workspace Provider

The Blazing workspace provider allows open-swe agents to execute code in ephemeral container workspaces backed by [Blazing](https://github.com/Borduas-Holdings/blazing) infrastructure.

## Setup

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BLAZING_API_URL` | Yes | Base URL of the Blazing API (e.g. `http://localhost:8005`) |
| `BLAZING_API_TOKEN` | No | Bearer token for authentication (sent as `Authorization: Bearer <token>`) |

When `BLAZING_API_URL` is set, `getSandbox()` returns a `BlazingSandbox` instance. When unset, it returns the default `DockerSandbox`.

### Example

```bash
export BLAZING_API_URL=http://localhost:8005
export BLAZING_API_TOKEN=your-bearer-token
pnpm dev
```

## API Endpoints

The provider consumes the `/v1/workspace` REST API (6 workspace-specific endpoints + health):

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/workspace` | Create an ephemeral workspace |
| POST | `/v1/workspace/{id}/exec` | Run an arbitrary command |
| DELETE | `/v1/workspace/{id}` | Destroy a workspace (idempotent) |
| GET | `/v1/workspace/{id}` | Get workspace metadata |
| GET | `/v1/workspaces` | List all workspaces |
| GET | `/v1/workspaces/capacity` | Capacity report (used/max/available) |
| GET | `/v1/health` | Provider health check |

## Known Limitations

- **`env` and `exec_timeout_ms` rejected by Blazing (blazing#48)** — the adapter *forwards* both from `SandboxConfig`, but Blazing's `POST /v1/workspace` currently **rejects them with HTTP 422** (mapped to `create_failed`): its workspace runtime does not apply them yet. Setting either on `create()` therefore fails loud rather than silently dropping the caller's request, and will start working automatically once Blazing wires them through — no adapter change needed. (The create body uses `extra="forbid"`, so unknown fields also 422.)
- **`stderr` is mostly empty** — the container runtime merges stdout and stderr into a single stream. The `stderr` field in exec results is best-effort.
- **Kill switch** — The Blazing server has a `WORKSPACE_API_ENABLED` env var that can disable all workspace routes (returns 404) without a code revert.

## Error classification (blazing#140)

As of blazing#140, the workspace API maps its runtime exceptions to HTTP so the
adapter's circuit breaker is not tripped by ordinary *user-level* errors:

- **`create` returns `201 Created`** (was 200) — matches the documented contract.
- **OOM-killed exec → `200` with `exit_code: 137` and `oom_killed: true`** (was a
  500). A command exceeding its memory cgroup is the caller's command, not a
  provider outage — the workspace stays usable; the adapter sees a normal
  non-zero exit, not `provider_unavailable`.
- **Nonexistent / unauthorized image → `422`** (`create_failed`, was a 500).
- **Blank exec command → `422`** at the API edge (the adapter also guards this
  client-side as `invalid_command`).
- Destroy now removes the per-sandbox host workspace dir (no disk leak).

## Local integration testing (TEST-03)

`lib/sandbox/blazing-sandbox.live.test.ts` drives the real adapter through the
full `create → get → exec → list → destroy` lifecycle against a live Blazing
API. It is **skipped unless `BLAZING_API_URL` is set**, so it never runs in CI.

The workspace REST API (PR #81) reached Blazing's `master` after the default
local Docker image was built, and the workspace routes are gated behind
`WORKSPACE_API_ENABLED` (default on). To get a target that actually serves
`/v1/workspace*`, run a throwaway `blazing-api` built from `master` alongside
the existing stack — it needs only **Redis + the Docker socket + the
`blazing/workspace:latest` image** (the workspace runtime calls
`docker.from_env()` directly; it does *not* use the executor/coordinator):

```bash
# 1. Build blazing-api from a master checkout/worktree of the blazing repo
git -C ~/code/blazing worktree add --detach /tmp/blazing-master origin/master
docker build -t blazing-api:master -f /tmp/blazing-master/docker/Dockerfile.api /tmp/blazing-master

# 2. Reuse the running stack's redis ACL env, then run an isolated api on :8009
docker exec blazing-api printenv \
  | grep -vE '^(GPG_KEY|HOME|HOSTNAME|PATH|PYTHON_|NODE_ID)=' > /tmp/ws-env.txt
mkdir -p /tmp/blazing-ws-isolated
docker run -d --name blazing-api-ws --network blazing_blazing-network -p 8009:8000 \
  --env-file /tmp/ws-env.txt \
  -e NODE_ID=node-ws-isolated -e WORKSPACE_API_ENABLED=true \
  -e WORKSPACE_DEFAULT_WORKSPACE_PATH=/tmp/blazing-ws-isolated \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /tmp/blazing-ws-isolated:/tmp/blazing-ws-isolated \
  blazing-api:master

# 3. Run the gated live test through the adapter
BLAZING_API_URL=http://localhost:8009 BLAZING_API_TOKEN=test-token \
  pnpm --filter open-swe test -- lib/sandbox/blazing-sandbox.live.test.ts

# 4. Teardown
docker rm -f blazing-api-ws
git -C ~/code/blazing worktree remove --force /tmp/blazing-master
```

> The isolated api joins the same Docker network and shares Redis, so give it a
> distinct `NODE_ID`. Workspace state lives under the `blazing:workspace:*` key
> namespace, isolated from other Blazing work.

## Error Mapping

| HTTP Status | Sandbox Error Code | Description |
|-------------|-------------------|-------------|
| 404 | `not_found` | Workspace ID is unknown |
| 409 | `create_failed` | Workspace already being created |
| 422 | `create_failed` | Unsupported create option (`env`/`exec_timeout_ms`/unknown field) **or image not found / blank command** (blazing#140) |
| 429 | `at_capacity` | Maximum concurrent workspaces reached |
| 503 | `provider_unavailable` | Blazing service unavailable |
| Timeout | `provider_unavailable` | Request exceeded timeout |
| Circuit open | `provider_unavailable` | Too many failures, circuit breaker open |

> Note: an OOM-killed `exec` is **not** an error here — blazing#140 returns it as
> a normal `200` exec result with `exit_code: 137` (so it never trips the breaker).

## Architecture

```
open-swe → getSandbox() → BlazingSandbox
  ├── Circuit breaker (5 failures → open)
  ├── Bearer token auth
  ├── Snake_case → camelCase DTO mapping
  └── HTTP status → SandboxError mapping
```
