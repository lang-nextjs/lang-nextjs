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

## Ejecting to rung 1

```bash
pnpm eject langchain
```

`pnpm eject` **exists** — `scripts/eject.mjs`, landed in #49. Earlier versions of this
page said it did not; that was true when written and is not true now.

```
retain : langchain
drop   : langgraph, deepagents, open-swe, software-developer-agent
```

**It drops the rungs ABOVE this one and keeps this one plus everything it requires.**
That is not "delete the other four" — the rungs below are kept, and kept
*mandatorily*. `rungs.json` declares a linear `requires` chain
(`langgraph` requires `langchain`, `deepagents` requires `langgraph`, and so on), and
eject retains the downward transitive closure of it. Earlier versions of these guides
described the lower rungs as optional siblings you could delete at will. **That was
wrong** — the manifest makes them dependencies.

A rung is an entry in `rungs.json` and nothing else defines one; `docs/RUNGS.md` is
the mechanical contract, and it is the authority over anything on this page.
`pnpm eject langchain --dry-run` prints the retain/drop sets without touching the tree.


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
