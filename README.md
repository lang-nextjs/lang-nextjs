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
| 1 | `langchain` | Single-model calls, prompt → response, basic chains | Docker + `OPENROUTER_API_KEY` | Backend implemented |
| 2 | `langgraph` | Explicit graph state, branching, cycles, checkpointing | Docker + `OPENROUTER_API_KEY` | Backend implemented |
| 3 | `deepagents` | Planning, sub-agents, virtual filesystem over a graph | Docker + `OPENROUTER_API_KEY` | Backend implemented |
| 4 | `open-swe` | Long-running async runs, approval gating, live run dashboard | A running LangGraph Platform **and a separate `open-swe` clone** | ⚠️ **Not runnable from a clean fork** |
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
cp .env.local.example .env.local     # set OPENROUTER_API_KEY
docker compose up                    # serves :8001
```

Then point the app at it — `FASTAPI_URL=http://localhost:8001/api/chat/stream` in `apps/example/.env` (see `.env.example`). Django is the same shape on `:8002` via `apps/django-backend/docker-compose.yml`.

Once a backend URL is set, `/api/config` flips that backend to `true`, its toggle enables, and replies stop coming from the mock.

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

`pnpm dev` at the root starts all four JS apps at once via Turborepo. To move one, `PORT=3005 pnpm --filter open-swe dev` works; note the `example` app binds `0.0.0.0` (IPv4 only).

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
| `pnpm demo` | Scripted full-stack demo — **needs a separate `open-swe` clone**, see below |

---

## Honest status

This section exists so you find out what is unfinished *before* you fork, not after.

**Rung 4 (`open-swe`) does not run from a clean fork.** The dashboard renders and the app builds, but it needs two things this repo does not contain: a running LangGraph Platform (`LANGGRAPH_PLATFORM_URL`) and a separate clone of the upstream `open-swe` project — `scripts/dev-demo.sh` expects it at `$HOME/code/open-swe`, overridable via `OPEN_SWE_DIR`. Without those, the dashboard loads and shows:

```
Couldn't load runs: Failed to fetch runs: 502
```

The underlying cause is more specific than the UI reveals — `GET /api/open-swe/runs` returns `{"error":"LANGGRAPH_PLATFORM_URL is not configured"}`, but the dashboard surfaces only the status code. Making rung 4 runnable from a clean fork is in flight.

**Rung 5 (`software-developer-agent`) is not in this repo.** There is no app, backend, or module for it. What does exist is the substrate it will need: sandbox providers under `apps/open-swe/lib/sandbox/` (a Docker provider and a Blazing provider, with parity tests). Treat rung 5 as a planned rung, not a shipped one.

**`pnpm eject <rung>` does not exist yet.** Ejection is the mechanism that makes this a template rather than a demo gallery, and it is the headline of the current milestone — but it is not implemented. Forking and deleting by hand is the current answer.

**Per-rung guides do not exist yet.** Each rung should have its own walkthrough; those are planned and not yet written. Until then, the reference backends' `ai_backends/*.py` modules are the clearest read of what separates one rung from the next — the three files are deliberately small and directly comparable.

**Rungs 1–3 were not verified from a clean fork in this pass.** The backend modules are present for both Django and FastAPI and both have Docker Compose stacks, but booting them requires Docker and an OpenRouter key. What *was* verified end-to-end here: a clean clone → `install` → `build` → `dev` → the example app serving HTTP 200 on the zero-config mock path.

**No LICENSE and no CONTRIBUTING file yet.** Worth knowing before you fork.

---

*Last updated: 2026-08-24. Status claims above were verified by running a clean checkout end to end; anything not verified is marked as such rather than assumed.*
