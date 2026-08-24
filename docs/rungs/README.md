# Which rung do I need?

You arrived here knowing your problem, not our taxonomy. This page routes you by
what you are trying to build. Read it before you read any individual rung guide.

> **Read the state column before you plan around a rung.** This repo's ladder is
> uneven right now. Rungs 1–3 are implemented and runnable. Rung 4 is implemented
> but **not runnable from a clean fork**. Rung 5 **is not in this repo at all**.
> Saying so is the point of this page; a guide that flattened that would cost you
> a day.

---

## The ladder, and why it is ordered

| # | Rung | Shape | Demonstrates | State |
|---|------|-------|--------------|-------|
| 1 | [`langchain`](./1-langchain.md) | sync stream | Single-model calls, tool-calling loop, prompt → response | ✅ Backend implemented |
| 2 | [`langgraph`](./2-langgraph.md) | sync stream | Explicit graph state, branching, cycles, checkpointing | ✅ Backend implemented |
| 3 | [`deepagents`](./3-deepagents.md) | sync stream | Planning, sub-agents, virtual filesystem over a graph | ✅ Backend implemented |
| 4 | [`open-swe`](./4-open-swe.md) | **async runs** | Long-running runs, approval gating, live run dashboard | ⚠️ **Not runnable from a clean fork** |
| 5 | [`software-developer-agent`](./5-software-developer-agent.md) | **async runs** | Extending an agent with a domain-specific graph | ⚠️ **Not present in this repo yet** |

**Each rung is a superset of the concerns below it. The ordering is the lesson.**

That is not a slogan about elegance — it is a warning about inheritance. A team
that takes rung 3 has taken rungs 1 and 2's problems with it, whether or not they
plan for them:

- Rung 1's problems — token cost, latency per model call, tool-call error handling,
  prompt drift — do not go away when you add a graph. They multiply by the number
  of nodes.
- Rung 2's problems — state shape, cycle termination, what happens when a branch
  never converges — do not go away when you add a planner. The planner is now the
  thing choosing which cycles run.
- Rung 3's problems — sub-agent supervision, filesystem state, plan invalidation —
  do not go away when you make runs asynchronous. They become problems you now have
  to *reconstruct after a reconnect*.

So: **pick the lowest rung that solves your problem.** Climbing is cheap in this
repo (the diff is readable); descending after you have built on the wrong rung is
not.

---

## The one architectural fact that decides rungs 3 vs 4

This is the single most useful thing on this page.

**Rungs 1–3 are synchronous conversation streams. Rungs 4–5 are asynchronous run
management.**

In rungs 1–3, the user sends a message, an SSE stream opens, tokens arrive, the
stream closes. The request *is* the unit of work. The client holds the state. If
the tab closes, the work is gone and nobody minds, because the work was seconds long.

In rungs 4–5, the user *fires a run* and then *reconnects to it*. The run is the
unit of work, it outlives the request that created it, and it has an identity
(`run_id`) that the client did not invent.

They diverge on five things, and every one of them is an application-architecture
decision, not a feature flag:

| | Rungs 1–3 (sync stream) | Rungs 4–5 (async runs) |
|---|---|---|
| **Lifetime** | Bounded by the HTTP request | Outlives it; minutes to hours |
| **Identity** | The conversation (client-held `sessionId`) | The run (`run_id`, server-issued) |
| **Reconnection** | Not meaningful — resend the message | Load-bearing — you *must* be able to re-attach |
| **Client state** | The client is the source of truth | The server is; the client is a view |
| **A finished run** | Nothing to render — the stream just ended | Must render from stored state, with no live stream |

**A forker moving from rung 3 to rung 4 is not adding a feature. They are changing
their app's information architecture.** Routes stop being "the chat page" and start
being "the run list" and "one run's detail". Loading state stops being a spinner
during a request and starts being a status on a resource. Error handling stops being
"the request failed" and starts being "the run failed, hours ago, and you are seeing
it now."

You can see this already in the repo: `apps/open-swe/components/DemoNav.tsx` splits
the app by *interaction shape* — 💬 Live Chat vs ⚙ Queue — not by framework name.
That split is the divergence made visible.

---

## Route yourself

Find the row that sounds like your problem.

### "I want to call a model and stream the answer back"
→ **Rung 1, [`langchain`](./1-langchain.md).** One agent, one tool-calling loop.
If you don't yet have a reason to draw a graph, don't draw one. Most products that
think they need an agent framework need this.

### "My agent needs to branch, loop, or remember where it was"
→ **Rung 2, [`langgraph`](./2-langgraph.md).** The moment you want *explicit* state
that survives between steps — a plan you revise, a retry that knows it's a retry, a
conditional edge — you want a graph, and you want it visible rather than hidden in
control flow.

Signal you're here: you find yourself writing `if` statements around what the model
just said, and they're getting nested.

### "One agent isn't enough — I need it to plan, delegate, and keep files"
→ **Rung 3, [`deepagents`](./3-deepagents.md).** Planning supervisor, sub-agents,
a virtual filesystem. This is the top of the synchronous ladder: still a
conversation, but a conversation with an org chart behind it.

Signal you're here: your single agent's system prompt has grown sections, and
they're starting to contradict each other.

### "The work takes minutes, and the user shouldn't sit and watch"
→ **Rung 4, [`open-swe`](./4-open-swe.md)** — and read the divergence section
above first, because this is the expensive step.

Signal you're here: someone asked "what happens if they close the tab?" and the
honest answer was "we lose it."

⚠️ **Rung 4 does not run from a clean fork today.** It needs a LangGraph server
this repo does not ship. See the guide for exactly what is missing and what does
work without it.

### "I want the agent to actually run code, and I want to add my own specialist graph"
→ **Rung 5, [`software-developer-agent`](./5-software-developer-agent.md).**

⚠️ **Rung 5 is not in this repo.** It is planned and sourced, not vendored. What
*does* exist is the substrate it will need — sandbox providers under
`apps/open-swe/lib/sandbox/`. If you fork today expecting rung 5 code, you will
find none. The guide says what is there and what isn't.

### "I just want to see the transport working"
→ Don't pick a rung yet. `pnpm install && pnpm build && pnpm --filter example dev`
gives you a streaming chat at `http://localhost:3000` with **no backend, no API key,
no `.env`** — served by an in-process mock. Read the "one thing that will mislead
you" section of the root `README.md` first: the mock does not announce itself, and
it mislabels its own replies.

---

## Two axes, not one — don't confuse them

The ladder is the **framework** axis. There is a second, orthogonal axis in the
Python backends: **topology**, the shape of the agent within a framework.

| Framework (the rung) | FastAPI backend | Django backend |
|---|---|---|
| `langchain` | `react`, `plan-execute` | `react`, `plan-execute` |
| `langgraph` | `react`, `plan-execute` | `react`, `plan-execute` |
| `deepagents` | `react`, `plan-execute`, **`deep-research`** | `react`, `plan-execute` |

⚠️ **The two Python backends are not perfect mirrors.** `deep-research` exists in
FastAPI only. Django's `deepagents.py` has two topologies, its `_common.py` has no
`web_search` tool or research prompt, and its `requirements.txt` has no `ddgs`. If
you eject to the Django backend, that topology does not come with you.

Both axes are selectable at request time — `POST /api/chat/stream/{ai_backend}` with
`{"topology": "..."}` in the body. The example app exposes a 2 × 3 × 2 grid
(python backend × framework × topology). `deep-research` is outside that grid: it is
**not** in the example app's topology picker, and it is reachable via the FastAPI API
only.

Moving from `react` to `plan-execute` is **not** climbing the ladder. It is changing
the agent's shape inside one rung. Climbing the ladder is changing which framework's
abstractions you are paying for.

---

## What ejection will do (and does not do yet)

The intent: `pnpm eject <rung>` deletes the other four rungs — apps, backends,
routes, docs, tests — and leaves a repo that builds, tests, and runs clean with no
dangling references.

**`pnpm eject` does not exist yet.** It is the headline of the current milestone and
it is not implemented. Until it lands, each rung guide's *What to delete* section is
the manual version: the concrete paths to remove, by hand.

---

## How these claims were checked

Everything above about file paths, routes, environment variables, and dispatch was
read directly from the source in this checkout, not inferred from a filename.

What was **not** re-verified in this pass: booting the Python backends against a live
OpenRouter key (requires Docker and a paid/free key), and running rung 4 against a
live LangGraph server. Where a claim depends on something not booted here, the guide
says so at that spot rather than rounding it up to "works".

Where this page and the root `README.md` overlap, they should agree. If they ever
don't, the `README.md` is the front door and wins — file an issue.
