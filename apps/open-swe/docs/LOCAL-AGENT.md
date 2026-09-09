# Running rung 4 from a clean clone

```bash
pnpm install
pnpm --filter open-swe dev:local     # starts the local agent backend + the app
```

Then open <http://localhost:3001>. No account, no Docker, no LangGraph Platform,
no GitHub App.

## What you are looking at

`dev:local` starts two processes:

|                     |                                                   |
| ------------------- | ------------------------------------------------- |
| local agent backend | `apps/open-swe/agent/server.mjs`, default `:8100` |
| the dashboard       | Next.js, default `:3001`                          |

The backend speaks the subset of the LangGraph Server REST API this app calls.
The dashboard talks to it exactly as it would to a real LangGraph deployment —
that path is not stubbed or bypassed.

## Without a model backend, the run is scripted

Without `OPENSWE_MODEL_URL` or `FASTAPI_URL` the backend serves a **scripted run**: a fixed
sequence of `save_plan` / `read_file` / `task` / `write_file` /
`enter_plan_mode` tool calls. No model is called.

That is not a reduced demonstration. This repo is the glue layer — SSE
delivery, tool-call normalization, DeepAgents card enrichment, run lifecycle,
thread state, approval gating. The scripted run exercises all of it. The LLM is
the part this repo does not own.

**The dashboard shows an amber "Scripted run — no LLM was called" banner above
the run, for as long as the run is displayed.** You should never have to consult
this file to find out whether what you just watched was a real agent.

The banner has three states, and they come from the response that carried the
content — never from your local configuration:

| Banner                     | Meaning                                                    |
| -------------------------- | ---------------------------------------------------------- |
| **Scripted run** (amber)   | this backend served canned content                         |
| **Live agent run** (green) | a real graph produced this run                             |
| **Unknown backend** (grey) | the backend did not identify itself, so we cannot tell you |

`Unknown` is deliberate. If you point `LANGGRAPH_PLATFORM_URL` at your own
LangGraph deployment, we genuinely do not know whether a real agent answered,
and guessing "live" would be a false claim rendered as a fact.

## Live queue execution

Set `OPENSWE_MODEL_URL` (or `FASTAPI_URL`) to the chat backend origin or its
`/api/chat/stream` base. The default is DeepAgents `react`. `pnpm demo` wires
this URL before starting the agent. Restart an already-running agent to load
new code and environment variables; a successful health check does not prove
that its source revision is current.

A run starts when submitted, even if nobody opens its stream. Opening or
reconnecting a stream replays recorded events and subscribes to the same run;
it never submits a second inference request. Cancellation aborts the upstream
HTTP request and preserves the interrupted status. An already-executed tool
cannot be undone by cancellation: review effects before retrying.

When a backend URL is configured, unreachable backends, provider errors,
partial/disconnected streams, and missing finish frames produce a failed run,
not a successful scripted replacement. Scripted content is only used when no
backend URL is configured. Runs have a five-minute deadline and a 4 MiB event
limit. A slow browser may disconnect and reconnect without restarting work.

Set `OPENSWE_STATE_FILE` to persist tasks, terminal results, and replay events.
The demo launcher defaults to
`${XDG_STATE_HOME:-$HOME/.local/state}/lang-nextjs/demo-queue.json`.
It also enables chat reconnect and points Docker's counter tools at the
dashboard's `APP_PORT`, rather than assuming the example app runs on port 3000.
Use a separate state file per agent process. On restart, unfinished runs become
interrupted; they are not automatically retried, avoiding duplicate tool effects.
Without this variable the agent is intentionally ephemeral. State contains
conversation and tool content; protect and delete it as appropriate.

**Capability boundary:** the bundled queue invokes the configured chat graph.
The default DeepAgents backend uses a virtual filesystem, not this repository
or the dashboard's Docker sandbox. A live `write_file` call does not prove a
host repository was edited, and the bundled agent does not execute repository
tests or create GitHub PRs. Docker sandbox execution is a separate surface.
Use a separately verified upstream deployment for autonomous repository work;
the multi-graph limitation below still applies.

## Ports

| Port   | What                | Note                                                                                |
| ------ | ------------------- | ----------------------------------------------------------------------------------- |
| `3001` | the dashboard       | `PORT` to override                                                                  |
| `8100` | local agent backend | `AGENT_PORT` to override. **Not 8000** — that collides with rung 5's DynamoDB Local |

## Topology: this backend is single-run

Real Open SWE registers **three** graphs (`manager`, `planner`, `programmer`)
and they do **not share a run** — the manager dispatches a new run on a new
thread to the planner, which dispatches another to the programmer. Upstream's
own UI opens three separate streams.

**This local backend is single-run by design**, and this app's stream route is
single-thread by construction (`GET /threads/{threadId}/runs/{runId}/stream`,
one `threadId` from a query param). Pointed at a real multi-graph Open SWE, the
dashboard would show **one third of the agent** — the other two thirds run on
thread IDs it was never told about.

That is a known limitation of rung 4 as it stands, not a property of the
scripted run. Multi-run fan-in is unresolved work.

## Not an option: the Blazing sandbox provider

`BLAZING_API_URL` is documented in `.env.local.example` but is **not usable**.
Nothing serves that API today, and its workspace endpoints carry a cross-tenant
IDOR — Redis keys have no tenant component, so any valid token can enumerate,
exec into and destroy every tenant's workspaces. Do not point it at a shared
instance. See `blazing-provider.md`.
