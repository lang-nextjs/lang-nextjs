# Rung 2 — `langgraph`

**Explicit graph state, branching, cycles, checkpointing.** The rung where the
control flow stops hiding in Python and becomes a thing you can draw.

← [Rung 1, `langchain`](./1-langchain.md) · [Which rung do I need?](./README.md) · → [Rung 3, `deepagents`](./3-deepagents.md)

---

## State: ✅ Backend implemented

Implemented in both reference backends, in Python:

- `apps/fastapi-backend/ai_backends/langgraph.py` (548 lines)
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
  _functionally close to rung 1_. If this is all you use, you are paying for
  LangGraph and getting rung 1.
- `plan-execute` — a hand-authored `StateGraph`: **planner → executor → replanner**,
  ported from the official LangGraph plan-and-execute notebook. Separate phases,
  explicit nodes, conditional edges, a replanner that can revise the plan mid-run.

That second topology is what LangGraph is actually for. Read the two side by side in
one file — that comparison is the rung.

**`react` is approval-gated upstream, and `plan-execute` is not.** A tool call the
request's policy does not excuse pauses the graph BEFORE the tool runs, and the
run reports the pause rather than ending in silence. The mechanism is this rung's
own: a `post_model_hook` that calls `langgraph.types.interrupt()` for the calls
the policy names, with a process-lifetime checkpointer so the decision can arrive
on a later request.

It is deliberately NOT `interrupt_before=["tools"]`, which is the obvious reading
of the LangGraph docs and was what #332's own experiment table prescribed.
Measured against langgraph 1.2.11: `interrupt_before` withholds the effect
correctly and never calls `interrupt()`, so nothing lands on the graph state and
the client receives a 200 carrying no explanation. It is also node-level, so it
would pause on read-only tools the policy has excused — which the rung-1 plane
does not do, for the same request. Both are why the hook is used instead.

`plan-execute` is ungated and that is a stated position rather than an omission:
it has not been measured on this rung, and a declaration is the wrong place to
express a hope. See `GATED_TOPOLOGIES` in the module.

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

> **Do not confuse this with rung 4.** Rung 4 needs a _LangGraph Platform server_,
> which this repo does not ship. Rung 2 needs the `langgraph` Python library, which
> is in `requirements.txt`. Same name, completely different operational cost.

Optional and genuinely useful here: LangSmith tracing. Set `LANGSMITH_TRACING=true`
plus `LANGSMITH_API_KEY` in `.env.local` and every chat turn becomes a clickable
trace tree with no code changes. On a multi-node graph this is the difference between
debugging and guessing.

---

## Ejecting to rung 2

```bash
pnpm eject langgraph
```

`pnpm eject` **exists** — `scripts/eject.mjs`, landed in #49. Earlier versions of this
page said it did not; that was true when written and is not true now.

```
retain : langchain, langgraph
drop   : deepagents, open-swe, software-developer-agent
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
`pnpm eject langgraph --dry-run` prints the retain/drop sets without touching the tree.

## What a fork looks like afterwards

A Next.js app, one Python backend, and a `StateGraph` you authored and can draw on a
whiteboard.

**You own:** the graph topology, the state schema and its reducers, the conditional
edges, and the termination condition.

**You inherit rung 1's concerns, in multiples.** Token cost is now per node per
iteration, not per turn. Latency is the sum of a path through the graph, not one
call. Bad tool arguments now fail _inside_ a node, and the graph has to decide
whether that's a retry, a branch, or a stop. None of that got easier; it got
structured, which is different.

**You will know it's time to climb** when you find yourself hand-building a
supervisor: one node whose job is to decide which other agent runs, plus a scratchpad
for them to pass files through. That's rung 3, and `deepagents` ships it.
