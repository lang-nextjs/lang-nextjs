# Lang-Next.js

**One forkable reference implementation of the LangChain agent ladder.**

Five rungs — `langchain` → `langgraph` → `deepagents` → `open-swe` → `software-developer-agent` — all running against the same streaming transport, in one repo, so the step from each rung to the next is a diff you can read instead of a rewrite you have to imagine.

Fork it, pick the rung your product is actually on, and eject the other four.

> This is a **template to fork**, not a package to install. Nothing here is published to npm — all seven packages are private and at `0.1.0`. The artifact you take away is the repo.

---

## The ladder

Each rung is a superset of the concerns below it. That ordering is the point.

| # | Rung | Demonstrates | Needs to run | State |
|---|------|--------------|--------------|-------|
| 1 | `langchain` | Single-model calls, prompt → response, basic chains | Docker + a model key | Backend implemented |
| 2 | `langgraph` | Explicit graph state, branching, cycles, checkpointing | Docker + a model key | Backend implemented |
| 3 | `deepagents` | Planning, sub-agents, virtual filesystem over a graph | Docker + a model key | Backend implemented |
| 4 | `open-swe` | Long-running async runs, approval gating, live run dashboard | Nothing extra — a bundled agent backend ships with it | Runnable: `pnpm --filter open-swe dev:local` |
| 5 | `software-developer-agent` | Autonomous code execution in ephemeral sandboxes | — | ⚠️ **Not present in this repo yet** |

Rungs 1–3 are implemented in Python, in both reference backends (`apps/django-backend/` and `apps/fastapi-backend/`, each with `ai_backends/{langchain,langgraph,deepagents}.py`). Rungs 4–5 are TypeScript. A second, TypeScript plane for rungs 1–3 is deferred — not cancelled.

**Read the State column before you plan around a rung.** Details in [Honest status](#honest-status).

---

## Quickstart

Requires **Node 22.x** and **pnpm 9** (pinned via `packageManager`; no `engines` field is declared). Verified on Node 22.22.2.

```bash
pnpm install
pnpm build                      # required — see below
pnpm --filter example dev       # → http://localhost:3000
```

### `pnpm build` is not optional

Skipping it produces a failure that looks like success. The dev server starts and prints `✓ Ready in 425ms`, and then **every page returns HTTP 500**:

```
Module not found: Can't resolve '@deepagents-nextjs/react'
GET / 500
```

The workspace packages resolve through their built `dist/` output, and the `dev` task deliberately does not depend on `build`. So a fresh clone must build once before the apps can resolve them. Build again after changing anything under `packages/`.

### What you get, and one thing that will mislead you

`http://localhost:3000` works with **zero configuration** — no backend, no API key, no `.env`. That is deliberate, and it is a real feature: you can see the transport working before you own any infrastructure.

**But the zero-config path serves a mock, and the mock does not say so.** Send a message with no backend running and you get a streamed reply:

> Hello! I am the mock DeepAgents assistant. This response streams in chunk by chunk.
> *via fastapi · deepagents · react*

That `via fastapi` label is wrong. There is no FastAPI backend running — the same page greys out the `fastapi` button as unavailable while attributing the answer to it. The request never left the Next.js process; it was served by an in-process mock (`apps/example/app/api/chat/stream/route.mock.ts`, reached from `route.ts` when no backend URL is configured).

**How to tell the difference:** check `http://localhost:3000/api/config`. With nothing running it returns

```json
{"backends":{"django":false,"fastapi":false}}
```

and both Python toggles in the UI are disabled. If those say `false`, you are talking to the mock regardless of what the message footer claims.

### Running a real backend (rungs 1–3)

```bash
cd apps/fastapi-backend
cp .env.local.example .env.local     # set NVIDIA_API_KEY (free) or OPENROUTER_API_KEY
docker compose up                    # serves :8001
```

Then point the app at it — `FASTAPI_URL=http://localhost:8001/api/chat/stream` in `apps/example/.env` (see `.env.example`). Django is the same shape on `:8002` via `apps/django-backend/docker-compose.yml`.

Once a backend URL is set, `/api/config` flips that backend to `true`, its toggle enables, and replies stop coming from the mock.

---

## Environment: what goes where, and why it is not one file

Every variable below was found by breaking it. The recurring mistake is putting a
value in a file the process that needs it does not read — so the table names the
**reader**, not just the variable.

| File | Variable | Read by | Why there |
|---|---|---|---|
| `apps/fastapi-backend/.env.local` | `NVIDIA_API_KEY` | the FastAPI **container** | `make_llm()` runs in the backend, so this is the process that needs the key. `main.py` does `load_dotenv(".env.local")` — a repo-root `.env` is never read. |
| `apps/open-swe/.env.local` | `FASTAPI_URL` | open-swe's chat route | The **full stream base**, e.g. `http://localhost:8001/api/chat/stream`. The route appends `/${aiBackend}`. A bare host 404s. |
| `apps/open-swe/.env.local` | `LANGGRAPH_PLATFORM_URL` | open-swe's **queue** routes | The queue is a different service from chat. Unset ⇒ the runs list returns `502 LANGGRAPH_PLATFORM_URL is not configured`. |
| `apps/example/.env` | `FASTAPI_URL` / `DJANGO_URL` | the example app | Per-runtime, so its django/fastapi selector can actually route. |

All of these match `.env*` in `.gitignore`; the committed files are `*.example` only.

**The model key is a fallback chain, not a single name.** Both Python backends try
`NVIDIA_API_KEY`, then `OPENROUTER_API_KEY`, then `ANTHROPIC_API_KEY`, and whichever
is present wins.

> **NVIDIA NIM is first because it is the one anyone can get.**
> [build.nvidia.com](https://build.nvidia.com) issues a free key with no card, which
> makes this repo runnable by a forker with no OpenRouter balance and no Anthropic
> account. Override the model with `NVIDIA_MODEL` (default `meta/llama-3.3-70b-instruct`).

There is deliberately **no UI field for the key**. The agents are lazily-built
singletons whose model is constructed once, so a key arriving per request would
either be ignored or force a rebuild on every message — a settings field would be a
control that does nothing. Workspace Settings *reports* which provider is live and
leaves setting it to the environment.

### Tracing: LangSmith works with no integration code, Langfuse does not

**LangSmith needs no code in this repo, and that was verified rather than
assumed.** With the variables below set on the FastAPI container and nothing
else changed, a real chat request produced two `POST /runs/batch` calls to the
LangSmith endpoint. Nothing in `ai_backends/` constructs a client or passes a
callback — the `langsmith` SDK, which arrives as a LangChain dependency, reads
the environment itself.

| File | Variable | Read by | Why there |
|---|---|---|---|
| `apps/fastapi-backend/.env.local` | `LANGSMITH_TRACING` (or `LANGCHAIN_TRACING_V2`) | the `langsmith` SDK **inside the backend container** — no repo code reads it | Tracing is off unless this is `true`. The backend process is the one making model calls, so it is the process that must see it. |
| `apps/fastapi-backend/.env.local` | `LANGSMITH_API_KEY` (or `LANGCHAIN_API_KEY`) | same | Sent as the `x-api-key` header on every batch. Without it the flag alone does nothing. |
| `apps/fastapi-backend/.env.local` | `LANGSMITH_PROJECT` (or `LANGCHAIN_PROJECT`) | same | Becomes `session_name` on the wire — the project the runs land in. Optional; unset means LangSmith's default project. |
| `apps/fastapi-backend/.env.local` | `LANGSMITH_ENDPOINT` (or `LANGCHAIN_ENDPOINT`) | same | Only for self-hosted LangSmith, or for pointing the SDK at a local sink to see what it would send. |

Django's equivalent file is `apps/django-backend/.env.local`, loaded by
`settings.py`. As everywhere else here, a repo-root `.env` is never read.

**Both spellings work and `LANGSMITH_*` wins.** With `LANGCHAIN_PROJECT` and
`LANGSMITH_PROJECT` set to different values, the `session_name` that actually
went over the wire was the `LANGSMITH_` one.

**The run names in the code do arrive.** `run_name=` in
`ai_backends/langchain.py` and `name=` in `ai_backends/deepagents.py` are not
aspirational — `fastapi-langchain-react`,
`fastapi-langchain-plan-execute-planner` and `fastapi-deepagents-react` were all
observed as run names in captured payloads, alongside the generic `ChatOpenAI` /
`RunnableSequence` entries they exist to distinguish from.

**What you can see without leaving the repo:** `curl localhost:8001/health`
reports `observability.langsmith` as `{configured, tracing, supported, project,
detail}`.

> `tracing` is **not** the same field as `configured`, and it is `null` on
> purpose. `configured` means the variables are set; `tracing` would mean a span
> was accepted, and nothing here sends a probe span — so `null` ("never probed")
> is the honest answer rather than inferring delivery from two environment
> variables. Read `configured: true` as *this process will attempt to send
> traces*, which for privacy purposes is the part that matters.

**Langfuse is detected but not wired.** It needs a `CallbackHandler` passed into
the graph invocation and nothing passes one, so keys in the environment mean
"the operator expects tracing" while no span is ever emitted. `/health` reports
it as `supported: false, detail: "not integrated"` rather than `configured`,
which is the true statement. Integration is tracked in #118.

### Running it locally, in order

```bash
# 1. the model — free key from build.nvidia.com
cd apps/fastapi-backend
cp .env.local.example .env.local        # add NVIDIA_API_KEY=...
docker compose up -d                    # :8001

# 2. the rung-4 queue backend (a DIFFERENT service from chat)
pnpm --filter open-swe agent            # :8100

# 3. the apps
pnpm --filter open-swe dev              # :3001  (needs both vars above)
pnpm --filter example dev               # :3000
```

`pnpm --filter open-swe dev:local` collapses steps 2 and 3 — it starts the agent and
exports `LANGGRAPH_PLATFORM_URL` for you. Running bare `dev` does not, which is the
usual cause of a 502 on the queue.

**Check it rather than assuming it.** `curl localhost:8001/health` reports
`llm: {configured, provider}`, and `curl localhost:3001/api/config` reports
`activeLlm` plus `llmSource` — `backend` when it asked the backend, `local-env` when
the backend was unreachable and it fell back. If the chat header says **not ready**,
it lists the missing prerequisites; that indicator is computed from those probes
rather than from whether the UI happens to be idle.

**One honesty note about the queue.** The bundled rung-4 agent serves a *canned* run
and says so — `mode=canned` on every response — even when a key is set, because the
live graph is not wired yet. A key does not change that; only pointing
`LANGGRAPH_PLATFORM_URL` at a real LangGraph deployment does.

---

## Ports

Every port below is fixed by a script or config in the repo — they do not collide.

| Port | What | Started by |
|------|------|-----------|
| 3000 | `example` app (the chat demo) | `pnpm --filter example dev` |
| 3001 | `open-swe` dashboard | `pnpm --filter open-swe dev` |
| 5173 | Remix example | `pnpm --filter remix-example dev` |
| 5174 | SvelteKit example | `pnpm --filter sveltekit-example dev` |
| 8001 | FastAPI reference backend | `apps/fastapi-backend/docker-compose.yml` |
| 8002 | Django reference backend | `apps/django-backend/docker-compose.yml` |
| 8100 | Rung-4 agent backend (bundled) | `pnpm --filter open-swe dev:local`, or `pnpm demo` |
| 8030 | FastAPI backend **as `pnpm demo` starts it** | `pnpm demo` (maps container `8001` → host `8030`) |

`pnpm dev` at the root starts all four JS apps at once via Turborepo. To move one, `PORT=3005 pnpm --filter open-swe dev` works; note the `example` app binds `0.0.0.0` (IPv4 only).

Two rows above are the same FastAPI backend on different host ports: `8001` when you run its Compose file directly, `8030` when `pnpm demo` starts it. That is deliberate — the demo avoids colliding with a Compose stack you may already have up — but it does mean `FASTAPI_URL` differs between the two paths.

---

## Repo layout

```
apps/
  example/            Chat demo — rungs 1–3 through a backend-swap UI. Zero-config mock included.
  open-swe/           Rung 4 dashboard: run queue, live streaming, approval gating, tool cards.
  django-backend/     Python reference backend (rungs 1–3), Docker + Postgres + Redis.
  fastapi-backend/    Python reference backend (rungs 1–3), Docker, no database.
  remix-example/      Same transport, Remix.
  sveltekit-example/  Same transport, SvelteKit.

packages/
  server/       Transport core: createDeepAgentsHandler(), SSE transform pipeline, adapters.
  react/        useDeepAgentsChat<TData>() + typed message union + Zod schemas.
  sveltekit/    SvelteKit handler + reactive store.
  remix/        Remix handler + streaming hook.
  edge/         Deno + Cloudflare handlers (EXPERIMENTAL), Web Streams only.
  mcp/          MCP server: trigger_task, list_runs, get_run_status, cancel_run.
  test-utils/   createMockDeepAgentsServer() for consumer suites.
```

### Why seven packages for an unpublished repo

The split is deliberate teaching, not release plumbing left behind. Two boundaries carry weight:

- **`server` has no React dependency** — the transport is importable server-side without client bloat.
- **`sveltekit` and `remix` copy `SseFrameAccumulator` rather than importing it from `server`** — that copy is what stops the `next` peerDep leaking into non-Next.js packages.

Publishing was retired; the architecture was not. Please do not "simplify" these into one package.

---

## Commands

| Command | Does |
|---------|------|
| `pnpm install` | Install the workspace |
| `pnpm build` | Build all packages (**required before first dev run**) |
| `pnpm dev` | All four JS apps via Turborepo |
| `pnpm test` | Unit tests |
| `pnpm typecheck` | Types across the workspace |
| `pnpm e2e` | Playwright E2E suite |
| `pnpm --filter open-swe dev:local` | Rung 4, self-contained: bundled agent backend + the dashboard |
| `pnpm demo` | Chat backend (rungs 1–3, Docker) + rung-4 agent + the app. `SKIP_CHAT=1` to skip Docker |

---

## Honest status

This section exists so you find out what is unfinished *before* you fork, not after.

**Rung 4 (`open-swe`) now runs from a clean fork — but the agent is canned by default.**

```bash
pnpm --filter open-swe dev:local     # bundled agent on :8100 + dashboard on :3001
```

No external clone, no LangGraph Platform, no API key. Verified from a clean checkout: `GET /api/open-swe/runs` returns `200 []`, and posting a task returns a real `run_id`.

The catch, and it is stated by the backend rather than hidden: without `OPENROUTER_API_KEY` the bundled agent runs in **canned mode** — a deterministic scripted run, no LLM call. It reports this on every response via the `x-openswe-agent-mode` header (`canned`) and `x-openswe-agent-mode-reason` (`no-openrouter-api-key`). That is the honest version of what the example app's chat mock gets wrong: it tells you it is canned instead of attributing the answer to a backend that is not running.

If you point `LANGGRAPH_PLATFORM_URL` at a real LangGraph deployment, that wins over the bundled agent.

**Older instructions may tell you to clone the upstream `open-swe` project.** That is no longer required. `scripts/dev-demo.sh` still supports it as an opt-in via `OPEN_SWE_DIR`, but leaves it unset by default and uses the bundled agent instead.

**Rung 5 (`software-developer-agent`) is not in this repo.** There is no app, backend, or module for it. What does exist is the substrate it will need: sandbox providers under `apps/open-swe/lib/sandbox/` (a Docker provider and a Blazing provider, with parity tests). Treat rung 5 as a planned rung, not a shipped one.

**`pnpm eject <rung>` does not exist yet.** Ejection is the mechanism that makes this a template rather than a demo gallery, and it is the headline of the current milestone — but it is not implemented. Forking and deleting by hand is the current answer.

**Per-rung guides do not exist yet.** Each rung should have its own walkthrough; those are planned and not yet written. Until then, the reference backends' `ai_backends/*.py` modules are the clearest read of what separates one rung from the next — the three files are deliberately small and directly comparable.

**Rungs 1–3 were not verified from a clean fork in this pass.** The backend modules are present for both Django and FastAPI and both have Docker Compose stacks, but booting them requires Docker and an OpenRouter key. What *was* verified end-to-end here: a clean clone → `install` → `build` → `dev` → the example app serving HTTP 200 on the zero-config mock path.

**No LICENSE and no CONTRIBUTING file yet.** Worth knowing before you fork.

---

*Last updated: 2026-08-24. Status claims above were verified by running a clean checkout end to end; anything not verified is marked as such rather than assumed.*
