# Rung 3 — `deepagents`

**Planning, sub-agents, a virtual filesystem over a graph.** The top of the
synchronous ladder: still a conversation, but a conversation with an org chart
behind it.

← [Rung 2, `langgraph`](./2-langgraph.md) · [Which rung do I need?](./README.md) · → [Rung 4, `open-swe`](./4-open-swe.md)

---

## State: ✅ Backend implemented

Implemented in both reference backends, in Python:

- `apps/fastapi-backend/ai_backends/deepagents.py` (336 lines, **3 topologies**)
- `apps/django-backend/deepagents_backend/ai_backends/deepagents.py` (303 lines,
  **2 topologies**)

Dispatched from `_MODULES` in `apps/fastapi-backend/main.py` and
`apps/django-backend/deepagents_backend/views.py`.

⚠️ **This is the rung where the two backends stop being mirrors.** Rungs 1 and 2 are
near-identical across FastAPI and Django. Rung 3 is not: the `deep-research` topology
is **FastAPI-only**. Django's module has no research stream, its `_common.py` has no
`web_search` tool and no `RESEARCH_PROMPT` (78 lines vs FastAPI's 109), and its
`requirements.txt` has no `ddgs`. Pick your backend with that in mind.

**Not verified in this pass:** booting against a live model — needs Docker and an
`OPENROUTER_API_KEY`. Modules, routes, dispatch, adapter, and Compose stacks were
read and confirmed present and wired.

This rung is also the repo's namesake — the transport packages are called
`@deepagents-nextjs/*` and `deepagentsAdapter` is the default adapter. That is
history, not hierarchy: the packages serve all five rungs.

---

## What it demonstrates

`create_deep_agent(model, tools, system_prompt)` gives you, out of the box, what you
would otherwise hand-build in rung 2:

- a **planning supervisor** and a `write_todos` tool
- a **virtual filesystem** the agent reads and writes across steps
- a main agent that uses tools directly

**Three topologies** — this rung has one more than the others:

- `react` — the library default. Planning supervisor + `write_todos` + virtual FS +
  a main agent using tools directly.
- `plan-execute` — `create_deep_agent(..., subagents=[planner, executor])`. The
  orchestrator delegates plan generation to a `planner` sub-agent, then delegates
  each step to an `executor` sub-agent that holds the tools. This is deepagents'
  idiomatic multi-agent design, and it is the direct contrast to rung 2's
  hand-authored planner→executor→replanner graph. **Same shape, one line of setup
  instead of a graph.**
- `deep-research` — **FastAPI only.** A research agent using `web_search` (via
  `ddgs`) and `RESEARCH_PROMPT` instead of the shared counter tools.

⚠️ **`deep-research` is reachable by API, and by neither UI nor Django.** Two separate
gaps, easy to conflate:
> - `TOPOLOGIES_BY_AI` in `apps/example/app/page.tsx` lists only `react` and
>   `plan-execute` for deepagents, so the picker will not offer it. It *is* live in the
>   FastAPI backend — `POST /api/chat/stream/deepagents` with
>   `{"topology": "deep-research"}` reaches it. Add it to the UI yourself if you want it.
> - The Django backend does not implement it at all. There, that request returns the
>   dispatch error for an unknown topology.

### What the sub-agent structure costs you

Rung 2 made state explicit. Rung 3 makes *agents* plural, and that adds three
concerns rung 2 didn't have:

- **Supervision.** Something now decides which sub-agent runs. When the plan is
  wrong, the failure is one level removed from the tool call that surfaced it.
- **Filesystem state.** The virtual FS persists across steps within a run. It is
  real state, and nothing in the framework tells you when it is stale.
- **Plan invalidation.** A plan made at step 1 against facts discovered at step 4 is
  a plan that should be revised. Whether it *is* revised depends on the topology you
  picked.

### Wire format

AI SDK v6 directly — `text-start` / `text-delta` / `text-end`,
`tool-input-start` / `tool-input-available`, `tool-output-available`, `finish`.

This is the only rung whose backend emits the client's native format. `deepagentsAdapter`
(`packages/server/src/adapters/deepagents.ts`) is consequently the thinnest of the
three: mostly the `messageId`-stripping fix, not a translation.

That thinness is why this rung is the default and why the packages carry its name.
It is not a statement that this rung is the right one for you.

---

## What it needs to run

Identical to rungs 1 and 2 — Docker and an `OPENROUTER_API_KEY`. The agent runs
in-process in the Python backend. No platform, no server, no cloud account.

```bash
cd apps/fastapi-backend
cp .env.local.example .env.local     # set OPENROUTER_API_KEY
docker compose up                    # serves :8001
```

Endpoint: `POST /api/chat/stream/deepagents` (FastAPI) or
`POST /api/chat/stream/deepagents/` (Django).

The `deep-research` topology additionally hits DuckDuckGo through `ddgs` — it needs
outbound network from the container, but no extra key.

---

## What to delete to eject to rung 3

`pnpm eject` does not exist yet. By hand:

```
apps/open-swe/                       # rung 4 dashboard, and the /chat page it hosts
packages/mcp/                        # MCP tools address rung-4 runs
docs/rungs/4-open-swe.md
docs/rungs/5-software-developer-agent.md
```

Rungs 1 and 2 are **siblings, not dependencies** — `langchain.py` and `langgraph.py`
can stay or go. Two files, and they are the comparison that makes rung 3 legible.
Recommendation: keep them.

Then, by hand:

- Drop the `openSwe*` adapters from `packages/server/src/adapters/index.ts` and
  delete their files and tests (`openSwe.ts`, `openSweEnrich.ts`,
  `openSweHeartbeat.ts` and their `.test.ts` siblings).
- **Keep `approvalGating.ts` and `approval-routes.ts`.** Human-in-the-loop approval
  looks like rung-4 machinery — it sits in the same directory and landed in the same
  milestone — but it is *not* rung-4-only: `apps/example/app/hitl-demo/` uses it at
  rung 3, and both `apps/example/app/api/approval/[approvalId]/route.ts` and
  `.../approval-protected/[approvalId]/route.ts` mount `createApprovalRoutes()`.
  Deleting it breaks the example app. Approval gating is orthogonal to the ladder — a
  run pausing for a human is useful at every rung.
- Remove `apps/open-swe` from any Turborepo/Playwright project lists — `pnpm dev`
  starts four JS apps and the E2E suite has per-app projects.
- Remove the rung-4 and rung-5 rows from the root `README.md` ladder table.
- `pnpm test && pnpm typecheck && pnpm e2e`.

**Keep `_common.py`.**

---

## What a fork looks like afterwards

A Next.js app, one Python backend, a `create_deep_agent` call, and a set of sub-agent
definitions.

**You own:** the sub-agent roster, the system prompts for each, the tool assignment
per sub-agent, and the plan format.

**You inherit rungs 1 and 2's concerns and they are now harder to see.** Token cost
is per sub-agent per step. A malformed tool call fails inside a sub-agent inside a
supervised plan, and the error the user sees is three levels of indirection from the
cause. State shape is no longer just the graph state — it's the graph state *and* the
virtual filesystem.

**This is still a synchronous conversation stream.** Request in, SSE out, done. The
client holds the conversation. Close the tab and the work is gone.

**You will know it's time to climb** when someone asks "what happens if they close
the tab?" and the honest answer is "we lose it." That question is the boundary
between rung 3 and rung 4, and crossing it is not a feature — it is a change to your
app's information architecture. Read the [divergence
section](./README.md#the-one-architectural-fact-that-decides-rungs-3-vs-4) before you
commit to it.
