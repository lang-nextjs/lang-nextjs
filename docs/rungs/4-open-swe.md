# Rung 4 — `open-swe`

**Long-running async runs, approval gating, a live run dashboard.** The rung where
the unit of work stops being a request and starts being a resource.

← [Rung 3, `deepagents`](./3-deepagents.md) · [Which rung do I need?](./README.md) · → [Rung 5](./5-software-developer-agent.md)

---

## State: ✅ Runnable from a clean fork — with a scripted agent

```bash
pnpm install
pnpm --filter open-swe dev:local
```

That starts a local agent backend (`apps/open-swe/agent/`, port 8100) and the
dashboard (port 3001), wired together by `agent/dev-local.sh`, which exports
`LANGGRAPH_PLATFORM_URL` at the local backend. **No account, no Docker, no LangGraph
Platform, no GitHub App.** The `Couldn't load runs: 502` earlier versions of this page
described is gone — #37 fixed it.

**The run you get is scripted.** Without `OPENROUTER_API_KEY` the local backend serves
a fixed sequence of tool calls; no model is called. That is not a reduced
demonstration of this rung — run lifecycle, SSE delivery, tool-call normalization,
card enrichment, thread state and approval gating are all exercised. The LLM is the
part this repo does not own.

**The dashboard says so, while the run is on screen.** An amber banner reads _"Scripted
run — no LLM was called"_ (`lib/agent-mode.ts`). You should never have to read this
page to find out whether what you watched was a real agent.

**Be precise about which claim you are making.** "Rung 4 runs" is _true_ of the
lifecycle, the transport, and the UI, and _false_ of "an LLM planned that." Both
halves matter — that distinction is the whole reason the banner exists.

> **Who ran what.** The `dev:local` path above was **executed by DEV2** — backend on
> :8100, dashboard on :3001, no account — and the four upstream endpoints they
> exercised are listed below. The author of this page verified the supporting files by
> **reading `origin/main`**: `apps/open-swe/agent/*`, the `dev:local` script,
> `dev-local.sh` exporting `LANGGRAPH_PLATFORM_URL`, and the banner states in
> `lib/agent-mode.ts`. Not re-run here.

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
  reject. A human is in the loop _inside_ a run, not in front of it.
- **SSE heartbeats** — `openSweHeartbeat` emits frames every 15–30s on idle, because
  a run that thinks for two minutes without emitting will otherwise be killed by an
  intermediate proxy.
- **MCP tools** — `packages/mcp/` exposes `trigger_task`, `list_runs`,
  `get_run_status`, `cancel_run`, so another agent can drive runs.

### This rung changes your app's information architecture

**This is the most important thing on this page.** Rungs 1–3 are synchronous
conversation streams. Rung 4 is asynchronous run management. Moving between them is
not adding a feature.

|                    | Rungs 1–3                     | Rung 4                                        |
| ------------------ | ----------------------------- | --------------------------------------------- |
| **Lifetime**       | Bounded by the HTTP request   | Outlives it; minutes to hours                 |
| **Identity**       | The conversation, client-held | The `run_id`, server-issued                   |
| **Reconnection**   | Not meaningful — resend       | Load-bearing — must re-attach                 |
| **Client state**   | Client is the source of truth | Server is; client is a view                   |
| **A finished run** | Nothing to render             | Must render from stored state, no live stream |

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

The repo already shows this split: `apps/open-swe/components/shell/AppSidebar.tsx` routes by
interaction shape — 💬 Live Chat vs ⚙ Queue — not by framework name.

### Wire format

LangGraph Platform SSE, normalized by `openSweAdapter`
(`packages/server/src/adapters/openSwe.ts`) with `openSweEnrich` and the heartbeat
transform layered on.

### How a card gets on screen

**The backend emits base AI SDK frames · the adapter enriches them into `data-*`
parts · the cards render those.**

**The Python backends emit no `data-*` parts at all.** Verified across both planes —
`apps/fastapi-backend/ai_backends/*.py` and
`apps/django-backend/deepagents_backend/ai_backends/*.py` — with the TypeScript
adapters as a known-positive control (`deepagentsEnrich.ts` does contain `data-file`,
`data-todo`, `data-sub-agent`; the Python files contain none). The only `data-`
substring in either plane is the English phrase "data-shape" in a comment.

Every `data-*` frame in this product is synthesised by a **TypeScript adapter**.
Three consequences, and each one costs a forker a day if they learn it late:

- If you write your own backend, **do not emit `data-*` frames.** Emit base AI SDK
  frames and let the adapter enrich them.
- If you go reading the Python backends looking for where the cards come from,
  **it is not there.** Read `packages/server/src/adapters/` instead.
- **A Python fork of rungs 1–3 is not a smaller version of the TypeScript
  experience — it is a different one.**

Which rung emits which frame is annotated on every frame in
`docs/sse-frame-schema.json` as `x-emitted-by` (`core` / `deepagents` / `open-swe`,
added in #62). Read it there. This page deliberately does not restate that list — a
restated list is a second authority, and it drifts.

---

## What it needs to run

**Nothing beyond the repo.** `pnpm --filter open-swe dev:local` is the whole
instruction; it starts the backend and the app together.

Everything below is optional, for when you outgrow the bundled backend.

| Piece                       | Where                                |
| --------------------------- | ------------------------------------ |
| The dashboard               | ✅ `apps/open-swe/`, port 3001       |
| A local agent backend       | ✅ `apps/open-swe/agent/`, port 8100 |
| A real LangGraph deployment | optional — see below                 |

Configuration lives in `apps/open-swe/.env.local`; copy `.env.local.example`, which
now ships `LANGGRAPH_PLATFORM_URL=http://localhost:8100` to match the bundled backend.
Any value already in your environment wins, so pointing at a real deployment still
works.

> **Correction to earlier versions of this page.** This section used to document two
> traps: that `.env.local.example` shipped port 8000 while the demo script started
> :2024, and that `scripts/dev-demo.sh` never exported `LANGGRAPH_PLATFORM_URL` at
> all. **Both are fixed.** The example ships 8100, `agent/dev-local.sh` exports the
> variable, and `dev-demo.sh` now exports it in every branch that starts a backend and
> passes `PORT` through so `APP_PORT` works. The `$HOME/code/open-swe` + `uv` route
> still exists, but it is no longer the only way in and no longer leads this page.

## Pointing rung 4 at your own deployment

The bundled backend is a reference implementation, not the only option. The dashboard
is an ordinary client of the LangGraph Server REST API, so it will talk to any
deployment you run:

```
LANGGRAPH_PLATFORM_URL=http://your-host:port
```

**The client contract was verified against real upstream.** Booting
`langchain-ai/open-swe` under `langgraph dev` and exercising the endpoints this app
calls, these four responded, and `GET /threads/{id}` returned the `status` and
`values` keys `lib/langgraph-client.ts` reads:

| Endpoint                 | Observed                         |
| ------------------------ | -------------------------------- |
| `POST /threads`          | thread created                   |
| `POST /threads/search`   | 200                              |
| `GET /threads/{id}`      | 200, carries `status` + `values` |
| `GET /threads/{id}/runs` | 200                              |

_Not checked:_ streaming a completed run end to end, and the plan/cancel routes.

### The banner reports what answered, not what you configured

Provenance is read off the **response**, not your environment
(`lib/agent-mode.ts`):

| Banner                     | When                                      |
| -------------------------- | ----------------------------------------- |
| **Scripted run** (amber)   | the bundled backend served canned content |
| **Live agent run** (green) | a backend identified itself as live       |
| **Unknown backend** (grey) | the backend sent no provenance header     |

**Your own deployment will show `Unknown backend`, and that is correct.** A missing
header resolves to `unknown`, never to `live` — we cannot tell whether a real agent
answered, so we do not claim one did. Setting `OPENROUTER_API_KEY` does not turn it
green either: a key says what was _requested_; only the responder knows what
_answered_.

Contrast `/api/config`, which reports `fastapi: !!process.env.FASTAPI_URL` — that
stays `true` while FastAPI is down, because it describes configuration rather than a
responder. This banner deliberately does not work that way.

### What upstream `open-swe` needs before it will run

It **boots** without GitHub App credentials — verified: all five graphs import, auth is
`noop`, the server serves. **Completing a run is a different question**, and every
known path needs an account:

- **A normal run** calls `resolve_github_token()` unconditionally
  (`agent/server.py:1164`, inside the `_prepare` graph node) → needs GitHub credentials.
- **A `source: "desktop"` run** skips GitHub but requires a sandbox, and the only
  sandbox backend in that codebase is LangSmith-hosted
  (`api.smith.langchain.com/v2/sandboxes`) → needs a LangSmith account.

_Read from source, not executed:_ the desktop-path conclusion. No LangSmith key was
available to run it and watch it fail.

**Open question, deliberately not closed:** `resolve_github_token` mentions per-user
OAuth tokens from a "dashboard store" for `slack` / `linear` / `dashboard` / `schedule`
sources. Whether that store can be populated **without** registering a GitHub App was
not established. It would still require GitHub credentials of some kind, so it is
unlikely to remove the requirement — but nobody has proven it either way.

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

<a id="what-to-delete-to-eject-to-rung-4"></a>

## Ejecting to rung 4

<!-- The old heading was "What to delete to eject to rung 4"; the anchor above
     keeps inbound links (docs/rungs/5-software-developer-agent.md) working across
     the rename. Remove it once no file links to the old fragment. -->

```bash
pnpm eject open-swe
```

`pnpm eject` **exists** — `scripts/eject.mjs`, landed in #49. Earlier versions of this
page said it did not; that was true when written and is not true now.

```
retain : langchain, langgraph, deepagents, open-swe
drop   : software-developer-agent
```

**It drops the rungs ABOVE this one and keeps this one plus everything it requires.**
That is not "delete the other four" — the rungs below are kept, and kept
_mandatorily_. `rungs.json` declares a linear `requires` chain
(`langgraph` requires `langchain`, `deepagents` requires `langgraph`, and so on), and
eject retains the downward transitive closure of it. Earlier versions of these guides
described the lower rungs as optional siblings you could delete at will. **That was
wrong** — the manifest makes them dependencies.

A rung is an entry in `rungs.json` and nothing else defines one; `docs/RUNGS.md` is
the mechanical contract, and it is the authority over anything on this page.
`pnpm eject open-swe --dry-run` prints the retain/drop sets without touching the tree.

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
