# apps/node-backend — the TypeScript agent runtime

A third runtime beside `apps/fastapi-backend` and `apps/django-backend`, serving
**the same HTTP contract**. `apps/fastapi-backend/main.py` is the specification;
this is a translation of it, not a redesign.

```
GET  /health                        status, ai_backends, topologies, llm, observability, runtime
GET  /api/tools/{ai_backend}        ai_backend, topology, tools, mcps
POST /api/chat/stream/{ai_backend}  SSE; topology from body.topology
POST /api/chat/stream               legacy — targets deepagents, see below
```

## What it serves today, and what it does not

| | fastapi / django | node |
|---|---|---|
| `langchain` × `react` | ✅ | ✅ |
| `langchain` × `plan-execute` | ✅ | ❌ — #8 |
| `langgraph` × `react` | ✅ | ✅ |
| `langgraph` × `plan-execute` | ✅ | ✅ |
| `deepagents` | ✅ | ❌ — #10 |

Rung 2 is at **full parity** with the Python planes. Rung 1 is not: its
`plan-execute` is #8.

**The gap is advertised, not hidden.** `/health` reports
`{"langchain": ["react"]}`, and asking for anything else gets the same
404-naming-what-exists that FastAPI gives. A runtime that advertised a topology
it cannot serve is the worse failure, and that field is what prevents it.

`POST /api/chat/stream` (no rung in the path) targets `deepagents` on every
runtime, so here it 404s. It is **not** repointed at the one backend this
runtime has: that would make the same URL mean different things on different
runtimes, which is the single property the shared contract exists to prevent.

## Running it

```bash
pnpm --filter node-backend build && pnpm --filter node-backend start   # :8003
docker compose -f apps/node-backend/docker-compose.yml up -d           # :8003
```

**Node 20.11+** to build and run — declared in `engines`, and measured rather
than guessed: the compatibility matrix builds and tests this package green on
Node 20, 22 and 24.

`pnpm --filter node-backend dev` is the exception and needs **Node 22.6+**: it
runs the TypeScript directly via `--experimental-strip-types`, which older
Node does not have. That floor is stated here rather than in `engines` because
raising the package-wide floor to 22.6 would claim the built output needs it,
and CI shows it does not.

Needs one of `NVIDIA_API_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY` — the
same fallback chain, in the same order, as `_common.make_llm()`. `/health`
reports which one it would pick, by presence only, never the value.

## Pinned dependencies

Exact versions, no ranges — #7 asks for them pinned and recorded.

| package | version | why |
|---|---|---|
| `langchain` | 1.5.10 | `createAgent` — the JS mirror of Python's `langchain.agents.create_agent`, which is what makes this the **langchain** rung rather than the langgraph one |
| `@langchain/core` | 1.2.9 | `tool()`, message types |
| `@langchain/langgraph` | 1.4.13 | `createAgent` compiles to a StateGraph; declared explicitly per #7 rather than left transitive |
| `@langchain/openai` | 1.5.10 | NVIDIA NIM and OpenRouter both speak the OpenAI wire format |
| `@langchain/anthropic` | 1.5.8 | the third branch of the fallback chain |

**`zod` stays at exactly one copy.** All five accept `zod: ^3.25.76 || ^4`, so
they resolve onto the workspace's existing 4.4.3 rather than dragging in a
second major — verified, one `zod@4.4.3` in `node_modules/.pnpm`. That matters
because `scripts/assert-single-instance.mjs` tracks zod as a singleton: two
copies means a schema built by one is not `instanceof` the other's classes, and
validation fails on structurally perfect objects. This package **imports no zod
at all** — tool schemas are JSON Schema — so its rule R1 (import ⇒ peer, never
depend) does not apply either.

## Decisions a reader will want the reasoning for

### `check:run-axes-parity` does NOT cover this runtime

That gate asserts fastapi's and django's `set_run_axes` / `langfuse_trace_metadata`
are **byte-identical**. That is the right test for two copies of one Python
source, and it is not expressible against a TypeScript port — "identical" has no
meaning across languages, and weakening it to "both exist" would gut the check
for the two planes it does cover. A third implementation that drifts is worse
than two that do not, so the drift is guarded a different way: `runAxes.test.ts`
pins the **output** — tag vocabulary `axis:value`, sorted, and
`langfuse_session_id` for the session — against literals read from the Python.
Source comparison is impossible; behavioural comparison is not, and it is the
behaviour the gate exists to protect.

`runtime` for this process is `node`, a third value beside `fastapi` and
`django`, so its traces are filterable the way #118 and #171 made the others.

### Langfuse is reported as `supported: false`

This runtime attaches no Langfuse `CallbackHandler`, so no key can make a span
arrive. Reporting `supported: true` would make `tracing` unfalsifiable exactly
the way a no-op handler would: every call site would look wired and nothing
would arrive. LangSmith needs no code — `langsmith` ships inside
`@langchain/core` and reads its own environment.

### 404 bodies use `{"detail": …}`

Matching FastAPI, not Django's `{"error": …}`. #329's routing suite uses exactly
that difference to prove which process answered a request, so node could have
taken a third spelling — it does not, because these two are the ones a reader
compares and an arbitrary third envelope would be a difference that means
nothing. Something that IS about node (`/health.runtime`, and the topologies it
reports) is the honest discriminator.

### Severability

`src/ai_backends/langchain.ts` is **rung-owned** — listed under the `langchain`
rung in `rungs.json`, exactly as its two Python siblings are. Everything else
here is shared scaffold.

`registry.ts` is imported statically today, which is safe only because
`langchain` is rung 1 and survives every ejection. That stops being true the
moment rung 2 or 3 lands here: those entries must be pruned by `pnpm eject`
along with their files, and a static import left behind would break boot for
exactly the fork that removed them. `main.py` learned this by dying at boot with
`NameError: name 'deepagents' is not defined` after `eject langchain` — the
whole backend, not one rung.

**`rungs.json` gains node's FILES but not a `node` runtime declaration.**
Declaring `runtimes.node` would advertise a (rung, runtime) pair the reference
app cannot select yet, and `scripts/check-topologies.mjs` would first need to
learn to read a TypeScript `TOPOLOGIES` — it currently anchors on a line
starting `TOPOLOGIES = {` with quoted keys, which is Python's shape. Both belong
with the work that makes the selector offer `node`.
