# Rung 1 — `langchain`

**Single-model calls, a tool-calling loop, prompt → response.** The bottom of the
ladder, and the rung most products actually belong on.

← [Which rung do I need?](./README.md) · → [Rung 2, `langgraph`](./2-langgraph.md)

---

## State: ✅ Backend implemented

Implemented in both reference backends, in Python:

- `apps/fastapi-backend/ai_backends/langchain.py`
- `apps/django-backend/deepagents_backend/ai_backends/langchain.py`

The two are close mirrors — 233 and 231 lines, same topologies, same wire format.
Dispatch is a dict lookup: `_MODULES` in `apps/fastapi-backend/main.py` and in
`apps/django-backend/deepagents_backend/views.py`.

They are **not** mirrors at every rung, though. Don't generalise from this one — see
[rung 3](./3-deepagents.md#state--backend-implemented) for where they diverge.

**Not verified in this pass:** booting either backend against a live model. That
needs Docker and an `OPENROUTER_API_KEY`. What was verified is that the modules,
routes, dispatch, adapter, and Docker Compose stacks are all present and wired to
each other.

---

## What it demonstrates

One agent, one tool-calling loop, one model call per step. Built on LangChain 1.x's
`create_agent(model, tools, system_prompt=...)`.

Worth knowing if you learned LangChain on 0.x: **`AgentExecutor` +
`create_openai_tools_agent` are gone.** They were replaced by the single
`create_agent` factory — which, notably, returns a `CompiledStateGraph`. Rung 1 is
already a graph underneath; the difference from rung 2 is that you don't *author*
the graph, you accept the prebuilt one.

**Two topologies** (select with `{"topology": "..."}` in the request body):

- `react` — the tool-calling loop. Default.
- `plan-execute` — a hand-rolled planner harness around `create_agent`. The planner
  uses `model.with_structured_output(Plan)` to emit an ordered list of steps, then
  each step runs in its own executor `create_agent`. **There is no graph here** —
  it's a Python loop. It exists to show that LangChain 1.x can express non-prebuilt
  topologies even though it ships no `PlanAndExecute` primitive (that was deprecated
  in 0.x).

That second topology is the honest argument for rung 2: you *can* do this in
LangChain, and the code will show you why you might not want to.

### Wire format

LangChain native SSE — what LangServe produces by default:

```
event: token
data: {"text": "Hello"}

event: tool_call
data: {"tool_name": "increment", "tool_input": {}, "tool_call_id": "..."}

event: message
data: {"content": ""}
```

Normalized to AI SDK v6 by `langchainAdapter` (`packages/server/src/adapters/langchain.ts`).

One gap the adapter has to live with: **LangChain SSE has no first-class `tool_end`
event.** Tool outputs are folded back into the agent loop and surface as later
`token` frames. If you are building a UI that wants to show "tool finished, here is
its output", rung 1's wire format cannot tell you cleanly. Rungs 2 and 3 can.

---

## What it needs to run

- Docker
- `OPENROUTER_API_KEY` (free tier available at openrouter.ai). `ANTHROPIC_API_KEY`
  works as an alternative. Model defaults to `openai/gpt-4o-mini`, overridable with
  `OPENROUTER_MODEL`.

```bash
cd apps/fastapi-backend
cp .env.local.example .env.local     # set OPENROUTER_API_KEY
docker compose up                    # serves :8001
```

Then point the example app at it — `FASTAPI_URL=http://localhost:8001/api/chat/stream`
in `apps/example/.env.local`. Django is the same shape on `:8002` via
`apps/django-backend/docker-compose.yml`.

Endpoint: `POST /api/chat/stream/langchain` (FastAPI) or
`POST /api/chat/stream/langchain/` (Django — note the trailing slash).

Health check: `GET /health` on either backend lists the wired `ai_backends` and their
topologies.

**You can see the transport before you own any of this.** `pnpm --filter example dev`
with no backend and no key serves an in-process mock at `http://localhost:3000`. Read
the root `README.md`'s warning about it first — the mock mislabels its own replies as
coming from FastAPI, and there is no FastAPI running.

---

## What to delete to eject to rung 1

`pnpm eject` does not exist yet. By hand:

```
apps/fastapi-backend/ai_backends/langgraph.py
apps/fastapi-backend/ai_backends/deepagents.py
apps/django-backend/deepagents_backend/ai_backends/langgraph.py
apps/django-backend/deepagents_backend/ai_backends/deepagents.py
apps/open-swe/                       # rung 4 dashboard, and the /chat page it hosts
packages/mcp/                        # MCP tools address rung-4 runs
docs/rungs/2-langgraph.md
docs/rungs/3-deepagents.md
docs/rungs/4-open-swe.md
docs/rungs/5-software-developer-agent.md
```

Then, by hand:

- Drop the `langgraph` and `deepagents` entries from `_MODULES` in both
  `apps/fastapi-backend/main.py` and `apps/django-backend/deepagents_backend/views.py`,
  and remove them from the `from . import ...` lines in both `ai_backends/__init__.py`
  files.
- Drop `langGraphAdapter` and `deepagentsAdapter` (and the `openSwe*` adapters) from
  `packages/server/src/adapters/index.ts` and delete their files and tests.
- Trim the framework picker in `apps/example/app/page.tsx` — `TOPOLOGIES_BY_AI` and
  the `AiBackend` union both enumerate all three.
- Remove `deepagents` and `langgraph` from `requirements.txt` in both backends.
- Remove the rung-4 and rung-5 rows from the root `README.md` ladder table.
- `pnpm test && pnpm typecheck && pnpm e2e` — the E2E suite has projects per backend
  and will tell you what still references what.

**Do not delete** either backend's `ai_backends/_common.py`. All three rungs share the
tools (`increment`, `get_counter`), the system prompt, and `make_llm()` from it.
FastAPI's copy additionally holds `web_search` / `RESEARCH_PROMPT` for rung 3's
`deep-research` topology; Django's does not have them at all. That sharing is the reason the three modules are directly
comparable — it's the control variable in the experiment.

---

## What a fork looks like afterwards

A Next.js app, one Python backend, one agent module of roughly 230 lines, and a
transport package that normalizes its SSE into AI SDK v6.

**You own:** the tool definitions, the system prompt, the model choice, and the
proxy route. That's the whole surface.

**You still inherit** — and this is what the ladder wants you to notice — every
concern the rung above would have added on top: nothing. Rung 1 is the floor. The
concerns you have are yours alone: token cost per call, latency, what happens when
the model calls a tool with bad arguments, and prompt drift as the system prompt
grows sections.

**You will know it's time to climb** when you start writing `if` statements around
what the model just said and they start nesting. That is rung 2 asking to be
written down as a graph.
