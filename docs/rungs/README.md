# Which rung do I need?

You arrived here knowing your problem, not our taxonomy. This page routes you by
what you are trying to build. Read it before you read any individual rung guide.

> **Read the state column before you plan around a rung.** Rungs 1–4 are implemented
> and runnable from a clean fork. Rung 4's bundled agent serves a **scripted** run
> unless you supply a key or point it at your own deployment, and the dashboard says
> so on screen. Saying that plainly is the point of this page.

---

## The ladder, and why it is ordered

| # | Rung | Shape | Demonstrates | State |
|---|------|-------|--------------|-------|
| 1 | [`langchain`](./1-langchain.md) | sync stream | Single-model calls, tool-calling loop, prompt → response | ✅ Backend implemented |
| 2 | [`langgraph`](./2-langgraph.md) | sync stream | Explicit graph state, branching, cycles, checkpointing | ✅ Backend implemented |
| 3 | [`deepagents`](./3-deepagents.md) | sync stream | Planning, sub-agents, virtual filesystem over a graph | ✅ Backend implemented |
| 4 | [`open-swe`](./4-open-swe.md) | **async runs** | Long-running runs, approval gating, live run dashboard | ✅ Runnable — bundled agent is scripted |
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

**Rung 4 runs from a clean fork:** `pnpm --filter open-swe dev:local` starts a local
agent backend and the dashboard together — no account, no Docker, no LangGraph
Platform. The bundled run is **scripted** (no model is called) and an amber banner
says so while it is on screen. To use a real agent, point `LANGGRAPH_PLATFORM_URL` at
your own deployment — see the guide.

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
`{"topology": "..."}` in the body. **In an un-ejected checkout** the example app
exposes a 2 × 3 × 2 grid (python backend × framework × topology). That grid is a
property of the full repo, not of the app: `apps/example` is severable, and after
`pnpm eject langchain` it serves exactly one backend button. Do not plan around the
grid surviving an eject. `deep-research` is outside that grid: it is
**not** in the example app's topology picker, and it is reachable via the FastAPI API
only.

Moving from `react` to `plan-execute` is **not** climbing the ladder. It is changing
the agent's shape inside one rung. Climbing the ladder is changing which framework's
abstractions you are paying for.

---

## Ejection

```bash
pnpm eject <rung>          # add --dry-run to see the plan without touching anything
```

**It exists** — `scripts/eject.mjs`, landed in #49. Earlier versions of this page said
it did not.

It drops every rung **above** the one you name and keeps that rung **plus everything it
requires**:

| `pnpm eject …` | retains | drops |
|---|---|---|
| `langchain` | langchain | langgraph, deepagents, open-swe, software-developer-agent |
| `langgraph` | langchain, langgraph | deepagents, open-swe, software-developer-agent |
| `deepagents` | langchain, langgraph, deepagents | open-swe, software-developer-agent |
| `open-swe` | langchain, langgraph, deepagents, open-swe | software-developer-agent |

**The rungs below are kept, and kept mandatorily.** `rungs.json` declares a linear
`requires` chain and eject retains its downward transitive closure. If you were told
elsewhere that the lower rungs are optional siblings you can delete at will — earlier
versions of these guides said exactly that — the manifest disagrees, and the manifest
is what runs.

**A rung is an entry in `rungs.json`. Nothing else defines one.**
[`docs/RUNGS.md`](../RUNGS.md) is the mechanical contract and outranks this page
wherever they differ.

---

## How these claims were checked

A doc claim a forker acts on is a check with no gate behind it, so this page names
what was actually run rather than asserting a state.

**Established by running:** `pnpm install && pnpm --filter open-swe dev:local` — agent
backend on :8100, dashboard on :3001, no account. **Run by DEV2, not by the author of
this page**, and reported with the four upstream endpoints they exercised listed in
[the rung-4 guide](./4-open-swe.md#pointing-rung-4-at-your-own-deployment).

**Established by reading source on `origin/main`:** every file path, route, env var,
port and dispatch table here; `apps/open-swe/agent/*` and the `dev:local` script;
`dev-local.sh` exporting `LANGGRAPH_PLATFORM_URL`; the three banner states and the
missing-header⇒`unknown` rule in `lib/agent-mode.ts`; `scripts/eject.mjs` and the
`requires` chain in `rungs.json`; and the absence of `data-*` parts in both Python
planes, checked with the TypeScript adapters as a known-positive control.

**NOT checked by anyone, and load-bearing if you depend on it:**
- Booting the Python backends against a live model — needs Docker and an
  `OPENROUTER_API_KEY`. Rungs 1–3's "runnable" rests on reading, not running.
- Streaming a completed rung-4 run end to end against real upstream, and the
  plan/cancel routes.
- Whether upstream `open-swe`'s "dashboard store" OAuth path can be populated without
  a GitHub App. Open question, deliberately not closed.

Where this page and the root `README.md` overlap they should agree; the `README.md` is
the front door and wins. Where this page and [`docs/RUNGS.md`](../RUNGS.md) differ on
what a rung *is*, `RUNGS.md` wins — it is the mechanical contract.

*These pages describe a moving repo. The claims above were re-verified against
`origin/main` after #37, #49 and #62 landed; the first version of this page was written
before #37 and shipped describing a rung-4 failure that had already been fixed.*
