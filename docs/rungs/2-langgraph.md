# Rung 2 — `langgraph`

**Explicit graph state, branching, cycles, checkpointing.** The rung where the
control flow stops hiding in Python and becomes a thing you can draw.

← [Rung 1, `langchain`](./1-langchain.md) · [Which rung do I need?](./README.md) · → [Rung 3, `deepagents`](./3-deepagents.md)

---

## State: ✅ Backend implemented

Implemented in both reference backends, in Python:

- `apps/fastapi-backend/ai_backends/langgraph.py` (320 lines)
- `apps/django-backend/deepagents_backend/ai_backends/langgraph.py`

Dispatched from `_MODULES` in `apps/fastapi-backend/main.py` and
`apps/django-backend/deepagents_backend/views.py`.

**Not verified in this pass:** booting against a live model — needs Docker and an
`OPENROUTER_API_KEY`. Modules, routes, dispatch, adapter, and Compose stacks were all
read and confirmed present and wired.

---

## What it demonstrates

**Two topologies, and the gap between them is the whole point of this rung.**

- `react` — `langgraph.prebuilt.create_react_agent`. The tool-calling loop again,
  as a prebuilt. This is the most common LangGraph pattern in the wild, and it is
  *functionally close to rung 1*. If this is all you use, you are paying for
  LangGraph and getting rung 1.
- `plan-execute` — a hand-authored `StateGraph`: **planner → executor → replanner**,
  ported from the official LangGraph plan-and-execute notebook. Separate phases,
  explicit nodes, conditional edges, a replanner that can revise the plan mid-run.

That second topology is what LangGraph is actually for. Read the two side by side in
one file — that comparison is the rung.

Compare against rung 1's `plan-execute`, which does the same job as a Python loop
with no graph. The diff between those two files is the argument for climbing.

### The state object is the lesson

Rung 1 has conversation history. Rung 2 has a **typed state object with reducers** —
`Annotated[List[Tuple], operator.add]` and friends. Steps append to it, the replanner
reads it, the conditional edge decides on it. Once state is explicit you can
checkpoint it, resume it, and inspect it.

That is also the trap: **you now own state shape as a design problem.** "What is in
the state" and "when does the cycle terminate" are questions rung 1 never made you
answer, and getting them wrong produces a graph that loops forever while burning
tokens.

### Wire format

Raw `astream_events` v2 JSON — the same format `langgraph-cli dev` and LangGraph
Cloud produce. Normalized by `langGraphAdapter`
(`packages/server/src/adapters/langgraph.ts`).

Only three event types cross the wire:
`on_chat_model_stream`, `on_tool_start`, `on_tool_end` (`_INTERESTING_EVENTS` in the
module).

One deliberate filter worth knowing about before it surprises you:
`_STRUCTURED_OUTPUT_NODES = {"planner", "replanner"}`. Those nodes' token streams are
**suppressed** — they emit raw JSON from `with_structured_output` chains, which is
data-shape generation, not prose. If you add a structured-output node and its tokens
don't appear in your UI, this is why. Add your node name to that set, or remove it
from it.

Unlike rung 1, `on_tool_end` **is** a first-class event here. If your UI wants to
render "tool finished, here's the output", rung 2 is the first rung that can tell you.

---

## What it needs to run

Identical to rung 1 — Docker and an `OPENROUTER_API_KEY`. No LangGraph Platform, no
server, no cloud account: this rung runs the graph **in-process** inside the Python
backend.

```bash
cd apps/fastapi-backend
cp .env.local.example .env.local     # set OPENROUTER_API_KEY
docker compose up                    # serves :8001
```

Endpoint: `POST /api/chat/stream/langgraph` (FastAPI) or
`POST /api/chat/stream/langgraph/` (Django).

> **Do not confuse this with rung 4.** Rung 4 needs a *LangGraph Platform server*,
> which this repo does not ship. Rung 2 needs the `langgraph` Python library, which
> is in `requirements.txt`. Same name, completely different operational cost.

Optional and genuinely useful here: LangSmith tracing. Set `LANGSMITH_TRACING=true`
plus `LANGSMITH_API_KEY` in `.env.local` and every chat turn becomes a clickable
trace tree with no code changes. On a multi-node graph this is the difference between
debugging and guessing.

---

## What to delete to eject to rung 2

`pnpm eject` does not exist yet. By hand:

```
apps/fastapi-backend/ai_backends/deepagents.py
apps/django-backend/deepagents_backend/ai_backends/deepagents.py
apps/open-swe/                       # rung 4 dashboard, and the /chat page it hosts
packages/mcp/                        # MCP tools address rung-4 runs
docs/rungs/3-deepagents.md
docs/rungs/4-open-swe.md
docs/rungs/5-software-developer-agent.md
```

Keep or delete rung 1 as you like — **rung 1 is not a dependency of rung 2**, it's a
sibling. Keeping `langchain.py` costs you one file and gives readers the comparison
that justifies the graph. Most forks should keep it.

Then, by hand:

- Drop `deepagents` from `_MODULES` and from the `from . import ...` line in both
  `ai_backends/__init__.py` files.
- Drop `deepagentsAdapter` (and `openSwe*`) from `packages/server/src/adapters/index.ts`;
  delete the files and tests.
- Trim `AiBackend` and `TOPOLOGIES_BY_AI` in `apps/example/app/page.tsx`.
- Remove `deepagents>=0.0.1` from both backends' `requirements.txt`.
- Remove the rung-3/4/5 rows from the root `README.md` ladder table.
- `pnpm test && pnpm typecheck && pnpm e2e`.

**Keep `_common.py`** — shared tools, prompt, and `make_llm()` for all three rungs.

---

## What a fork looks like afterwards

A Next.js app, one Python backend, and a `StateGraph` you authored and can draw on a
whiteboard.

**You own:** the graph topology, the state schema and its reducers, the conditional
edges, and the termination condition.

**You inherit rung 1's concerns, in multiples.** Token cost is now per node per
iteration, not per turn. Latency is the sum of a path through the graph, not one
call. Bad tool arguments now fail *inside* a node, and the graph has to decide
whether that's a retry, a branch, or a stop. None of that got easier; it got
structured, which is different.

**You will know it's time to climb** when you find yourself hand-building a
supervisor: one node whose job is to decide which other agent runs, plus a scratchpad
for them to pass files through. That's rung 3, and `deepagents` ships it.
