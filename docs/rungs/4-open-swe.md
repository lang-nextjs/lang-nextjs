# Rung 4 — `open-swe`

**Long-running async runs, approval gating, a live run dashboard.** The rung where
the unit of work stops being a request and starts being a resource.

← [Rung 3, `deepagents`](./3-deepagents.md) · [Which rung do I need?](./README.md) · → [Rung 5](./5-software-developer-agent.md)

---

## State: ⚠️ Not runnable from a clean fork

Read this section before you plan around this rung.

**What is real:** the Next.js dashboard, the API routes, the adapter, the approval
gating, the MCP tools, and their tests. `apps/open-swe/` builds. The route handlers
are exercised by unit tests. This is not vapour.

**What does not work:** the runnable experience. `apps/open-swe/` is a *client* for a
LangGraph Platform server, and **this repo does not contain that server.** With a
clean clone and no extra setup, the dashboard renders and then shows:

```
Couldn't load runs: Failed to fetch runs: 502
```

The underlying cause is more specific than the UI reveals.
`GET /api/open-swe/runs` returns `{"error":"LANGGRAPH_PLATFORM_URL is not configured"}`
with status 502; `lib/hooks/useRuns.ts` throws on `!res.ok` with only the status code;
`app/page.tsx` renders that message. So the dashboard tells you "502" when the actual
problem is "you have not configured anything."

Making this rung runnable from a clean fork is in flight.

**Be precise about which claim you are making.** "Rung 4 is implemented" is *true* of
the adapter, the routes, and the dashboard, and *false* of the end-to-end experience.
Both halves matter.

---

## What it demonstrates

Everything rung 3 does, plus the async run model — and the async run model is the
reason this rung exists.

- `POST /api/open-swe/runs` — submit a task, get back a `run_id` immediately (201).
- `GET /api/open-swe/runs` — list runs with status, time, task.
- `GET /api/open-swe/runs/[runId]/stream` — attach to a run's live SSE output.
- `GET /api/open-swe/runs/[runId]/state`, `.../plan`, `.../cancel` — inspect and
  control a run that is already in flight.
- **Approval gating** — `createApprovalGatingTransform` emits a
  `data-approval-required` frame and the run pauses until an explicit approve or
  reject. A human is in the loop *inside* a run, not in front of it.
- **SSE heartbeats** — `openSweHeartbeat` emits frames every 15–30s on idle, because
  a run that thinks for two minutes without emitting will otherwise be killed by an
  intermediate proxy.
- **MCP tools** — `packages/mcp/` exposes `trigger_task`, `list_runs`,
  `get_run_status`, `cancel_run`, so another agent can drive runs.

### This rung changes your app's information architecture

**This is the most important thing on this page.** Rungs 1–3 are synchronous
conversation streams. Rung 4 is asynchronous run management. Moving between them is
not adding a feature.

| | Rungs 1–3 | Rung 4 |
|---|---|---|
| **Lifetime** | Bounded by the HTTP request | Outlives it; minutes to hours |
| **Identity** | The conversation, client-held | The `run_id`, server-issued |
| **Reconnection** | Not meaningful — resend | Load-bearing — must re-attach |
| **Client state** | Client is the source of truth | Server is; client is a view |
| **A finished run** | Nothing to render | Must render from stored state, no live stream |

Three consequences you will hit in the first afternoon:

1. **Routes change shape.** You stop having "the chat page" and start having a run
   list and a run detail route (`app/runs/[runId]/`). The URL now names a resource
   that exists on the server whether or not anyone is looking at it.
2. **Timeouts split in two.** Look at
   `app/api/open-swe/runs/[runId]/stream/route.ts`: `STREAM_TIMEOUT_MS` is a
   **connect** timeout only, and the code explicitly detaches the `AbortController`
   once headers arrive. The comment records why — leaving it attached truncated the
   stream to its first frame. In rung 3 one timeout covers the whole interaction. In
   rung 4, "did it respond" and "is it still running" are different questions with
   different answers.
3. **You need a rendering path with no stream.** A run that finished an hour ago has
   no SSE to attach to. Something has to reconstruct the view from stored state.

The repo already shows this split: `apps/open-swe/components/DemoNav.tsx` routes by
interaction shape — 💬 Live Chat vs ⚙ Queue — not by framework name.

### Wire format

LangGraph Platform SSE, normalized by `openSweAdapter`
(`packages/server/src/adapters/openSwe.ts`) with `openSweEnrich` and the heartbeat
transform layered on.

---

## What it needs to run

Three things, and this repo ships one of them.

1. **A LangGraph Platform server**, reachable at `LANGGRAPH_PLATFORM_URL`. ❌ Not in
   this repo.
2. **A separate clone of the upstream `open-swe` project.** `scripts/dev-demo.sh`
   expects it at `$HOME/code/open-swe` (override with `OPEN_SWE_DIR`) and runs
   `uv run langgraph dev --port 2024` inside it. So the "LangGraph server" rung 4
   needs is, concretely, the upstream open-swe repo running under `langgraph dev`. It
   also needs `uv` on your PATH. ❌ Not in this repo.
3. **The dashboard.** ✅ `apps/open-swe/`, in this repo, on port 3001.

Configuration lives in `apps/open-swe/.env.local` — copy `.env.local.example`:

```
LANGGRAPH_PLATFORM_URL=http://localhost:8000
OPEN_SWE_ASSISTANT_ID=open-swe
LANGGRAPH_API_KEY=
```

### ⚠️ Two traps in that setup, both verified by reading the files

**The example file's port does not match the demo script's port.**
`.env.local.example` ships `LANGGRAPH_PLATFORM_URL=http://localhost:8000`.
`scripts/dev-demo.sh` starts `langgraph dev` on **:2024** (`LG_PORT`). Copy the
example verbatim, run `pnpm demo`, and the app will be pointed at a port with nothing
on it.

**`scripts/dev-demo.sh` never sets `LANGGRAPH_PLATFORM_URL` at all.** It boots
`langgraph dev` and then `exec`s `pnpm --filter open-swe dev` without exporting the
variable, so the app sees only whatever is in `.env.local`. `pnpm demo` alone does not
wire rung 4 up.

If you are getting rung 4 running today, set
`LANGGRAPH_PLATFORM_URL=http://localhost:2024` in `apps/open-swe/.env.local` to match
what `dev-demo.sh` actually starts.

> These two are read from `scripts/dev-demo.sh` and `apps/open-swe/.env.local.example`
> in this checkout. **We did not boot an upstream open-swe clone to confirm the
> end-to-end fix works** — that needs `uv` and a separate repo. The mismatch itself is
> certain; that correcting it is *sufficient* is not.

### What does work in `apps/open-swe/` without a Platform

- **The `/chat` page** — rungs 1–3, proxied to a real FastAPI backend. Note this route
  reads **only `FASTAPI_URL`**, has **no Django support**, and **no mock fallback**
  (unlike `apps/example`, which has both). Without `FASTAPI_URL` it returns
  `{"error":"FASTAPI_URL is not configured"}`.
- **The sandbox routes** under `/api/open-swe/sandbox/*` — a Docker-backed workspace
  executor. See rung 5's guide; this is the substrate rung 5 will use.
- **The unit tests** — `pnpm --filter open-swe test` runs the route and component
  suites without any Platform.

---

## What to delete to eject to rung 4

`pnpm eject` does not exist yet. Rung 4 is a superset of rungs 1–3 in *concerns*, but
in this repo it is a **separate app**, so ejecting to rung 4 is mostly about what you
keep:

```
apps/example/                        # the rungs 1-3 demo app; apps/open-swe has /chat
docs/rungs/5-software-developer-agent.md
```

Keep `apps/open-swe/`, `packages/server/`, `packages/react/`, `packages/mcp/`, and —
if you want the `/chat` page to work — `apps/fastapi-backend/`.

Then, by hand:

- If you drop `apps/example`, you lose more than a demo. `apps/open-swe/app/chat` is
  FastAPI-only with no mock, so you lose: the zero-config **mock** path
  (`app/api/chat/stream/route.mock.ts`), the Django toggle, the 2 × 3 × 2 topology
  grid, the **HITL approval demo** (`app/hitl-demo/` plus the
  `app/api/approval/[approvalId]/` and `app/api/approval-protected/[approvalId]/`
  routes that mount `createApprovalRoutes()`), and the `concurrent-test` and
  `reconnect-test` pages. Decide deliberately; this is the most commonly-regretted
  deletion.
- Remove `apps/example` from Turborepo and from `playwright.config.ts` projects.
- Delete `apps/remix-example/`, `apps/sveltekit-example/`, `packages/remix/`,
  `packages/sveltekit/`, `packages/edge/` unless you want those framework planes.
- Update the root `README.md` port table — 3000 and 5173/5174 go away.
- `pnpm test && pnpm typecheck`. The E2E suite has per-app projects and will need
  trimming to match.

---

## What a fork looks like afterwards

A Next.js app that is a **client for an agent platform you run separately**, plus an
MCP server so other agents can drive it.

**You own:** the run list and run detail UI, the approval UX, the reconnection story,
and the proxy routes. **You do not own the agent** — it lives in the Platform, in a
different repo, in a different process, with its own deploy.

That split is the honest cost of rung 4 and it is easy to underestimate. On rungs
1–3, "deploy the agent" means "deploy the backend." On rung 4 you have two systems, a
network boundary between them, and a circuit breaker
(`lib/langgraph-client.ts`, `CircuitOpenError` → 503 with `Retry-After`) because that
boundary will fail.

**You inherit every concern from rungs 1–3**, now reconstructed after a reconnect
rather than held in a live client. Rung 3's plan invalidation is still there — except
now the plan may have been invalidated while nobody was watching.

**Before you commit to this rung, be honest about the trigger.** It is: "the work
takes minutes and the user shouldn't sit and watch." If your work takes eight
seconds, rung 3 with a spinner is a better product and a tenth of the operational
surface.
