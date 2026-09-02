# Design: Reference Backend Stacks for Local E2E Testing

**Date:** 2026-04-29
**Status:** Approved
**Scope:** Two minimal local backend stacks (Django + FastAPI) enabling end-to-end testing of `deepagents-nextjs` against real SSE backends.

---

## Problem

The `deepagents-nextjs` monorepo currently has no way to run end-to-end tests against a real SSE backend. The existing `apps/example/` uses `MockLanguageModelV3` — a unit-level mock that never exercises the actual HTTP proxy path through `createDeepAgentsHandler`. This means the transport layer (SSE framing, `defaultTransforms`, header forwarding) is untested end-to-end.

## Context

`deepagents-nextjs` was extracted from `stsfront` — the existing Next.js frontend app. The production backend is a **Django service** that handles multi-tenancy, auth, per-tenant LLM keys, and business logic, with `langchain-ai/deepagents` (a LangGraph-based agent harness) running inside it as the AI engine. `createDeepAgentsHandler` is already backend-agnostic — it proxies any `backendUrl` that emits the DeepAgents SSE wire format. Django and FastAPI are both valid backends; the package doesn't care which framework generates the stream.

## Goal

Add two self-contained reference backend stacks — one Django, one FastAPI — each emitting the DeepAgents SSE wire format using `langchain-ai/deepagents` internally. A shared E2E test suite runs against both, validating the full stack: `useDeepAgentsChat` → Next.js route → `createDeepAgentsHandler` → backend → SSE stream → correct typed messages.

---

## Architecture

```
Django (multi-tenancy, auth, ORM, Celery)     FastAPI (lightweight, greenfield)
  └── langchain-ai/deepagents (LangGraph)        └── langchain-ai/deepagents (LangGraph)
      └── emits DeepAgents SSE format                 └── emits DeepAgents SSE format
          └── createDeepAgentsHandler                     └── createDeepAgentsHandler
              └── useDeepAgentsChat (React)                   └── useDeepAgentsChat (React)
```

Same `deepagents-nextjs` package, same Next.js consumer code, two different Python backends — zero changes to the package required.

---

## Repository Structure

```
apps/
  example/                         # existing shared Next.js app (extended)
    app/
      api/chat/stream/route.ts     # createDeepAgentsHandler({ backendUrl: process.env.BACKEND_URL! })
      page.tsx
  django-backend/                  # Django SSE backend
    deepagents_backend/
      views.py                     # POST /api/chat/stream/ — LangGraph SSE view
      urls.py
    manage.py
    requirements.txt               # django, langchain-ai/deepagents, channels
    Dockerfile
    docker-compose.yml             # db (postgres) + redis + backend + frontend (apps/example)
  fastapi-backend/                 # FastAPI SSE backend
    main.py                        # POST /api/chat/stream/ — LangGraph SSE endpoint
    requirements.txt               # fastapi, uvicorn, langchain-ai/deepagents
    Dockerfile
    docker-compose.yml             # backend + frontend (apps/example) only
e2e/
  chat.spec.ts                     # shared Playwright test suite, BACKEND_URL selects backend
```

---

## SSE Wire Format Contract

Both backends must emit the exact DeepAgents SSE protocol. This is the contract that `createDeepAgentsHandler` and `defaultTransforms` depend on:

```
data: {"type":"text-start","id":"text-1"}

data: {"type":"text-delta","id":"text-1","delta":"Hello "}

data: {"type":"text-delta","id":"text-1","delta":"world"}

data: {"type":"text-end","id":"text-1"}

data: {"type":"finish","finishReason":"stop","usage":{"inputTokens":N,"outputTokens":N},"messageId":"msg-<uuid>"}

```

The `finish` event deliberately includes `messageId`. `defaultTransforms` strips it before forwarding to the AI SDK client. Its presence in backend output and absence in client stream is what the E2E tests validate.

---

## Agent Behavior

Both backends run `langchain-ai/deepagents` (`create_deep_agent()`) internally and convert the LangGraph stream to DeepAgents SSE format. A real LLM is used — API keys are required.

**Local development:** `.env.local` with `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`.
**CI:** Secrets injected via GitHub Actions environment secrets. E2E jobs only run when secrets are present (skipped on external PRs).

The agent is minimal — no custom tools, default system prompt, default model. The goal is transport validation, not agent quality.

---

## Django Backend (`apps/django-backend/`)

- **Runtime:** Python 3.12-slim, Django 5
- **AI engine:** `create_deep_agent()` from `langchain-ai/deepagents` (LangGraph graph)
- **SSE delivery:** `StreamingHttpResponse(generator(), content_type="text/event-stream")` — converts LangGraph `astream_events()` to DeepAgents SSE format
- **Compose services:** `db` (postgres:16), `redis` (redis:7-alpine), `backend`, `frontend`
- **Why postgres + redis:** Matches production topology where Django uses ORM for multi-tenancy and Redis for Celery/caching
- **Ports:** backend on `8000`, Next.js frontend on `3001`
- **Auth:** No auth on the reference backend — `getToken` integration tested separately in unit tests

---

## FastAPI Backend (`apps/fastapi-backend/`)

- **Runtime:** Python 3.12-slim, FastAPI + uvicorn
- **AI engine:** `create_deep_agent()` from `langchain-ai/deepagents` (same LangGraph graph)
- **SSE delivery:** `StreamingResponse(generator(), media_type="text/event-stream")` — same LangGraph → DeepAgents SSE conversion
- **Compose services:** `backend`, `frontend` only (no postgres/redis — stateless reference)
- **Why lightweight:** Demonstrates `createDeepAgentsHandler` is backend-agnostic. Django is the production choice; FastAPI is the greenfield/minimal alternative.
- **Ports:** backend on `8001`, Next.js frontend on `3002`

---

## LangGraph → DeepAgents SSE Conversion

Both backends share the same conversion logic (copy-paste or extracted to a shared Python utility):

```python
async def langgraph_to_sse(graph, input_messages):
    text_id = "text-1"
    yield f'data: {{"type":"text-start","id":"{text_id}"}}\n\n'

    async for event in graph.astream_events({"messages": input_messages}, version="v2"):
        if event["event"] == "on_chat_model_stream":
            delta = event["data"]["chunk"].content
            if delta:
                yield f'data: {{"type":"text-delta","id":"{text_id}","delta":{json.dumps(delta)}}}\n\n'

    yield f'data: {{"type":"text-end","id":"{text_id}"}}\n\n'
    yield f'data: {{"type":"finish","finishReason":"stop","usage":{{"inputTokens":0,"outputTokens":0}},"messageId":"msg-{uuid4()}"}}\n\n'
```

This conversion is the reference implementation of the DeepAgents SSE protocol — it lives in the backend, not in `deepagents-nextjs`.

---

## Shared Next.js App (`apps/example/`)

The existing `apps/example/` is extended:

- `route.ts` updated to use `createDeepAgentsHandler({ backendUrl: process.env.BACKEND_URL! })` when `BACKEND_URL` is set. Existing `MockLanguageModelV3` route moved to `route.mock.ts` for reference.
- `BACKEND_URL` is injected by each backend's `docker-compose.yml` as a container environment variable
- No UI changes — `useDeepAgentsChat` usage and page layout stay as-is

---

<!-- doc-claims:cite -->

## E2E Test Suite (`e2e/chat.spec.ts`)

<!-- /doc-claims:cite -->

Single Playwright test suite. `BACKEND_URL` env var determines which backend is under test.

**Assertions:**

1. POST to `/api/chat/stream` returns `200` with `content-type: text/event-stream`
2. SSE stream delivers at least one `text-delta` frame
3. `finish` frame received by the client has **no `messageId` field** (proves `defaultTransforms` ran)
4. Stream closes cleanly (no error frames)
5. `useDeepAgentsChat` `messages` array contains a well-formed `AIMessage` after stream ends

---

## CI Integration

Two independent jobs, same test suite, secrets required:

```yaml
e2e-django:
  if: secrets.ANTHROPIC_API_KEY != ''
  steps:
    - cd apps/django-backend && docker compose up -d
    - wait-on http://localhost:3001
    - BACKEND_URL=http://localhost:8000 pnpm e2e

e2e-fastapi:
  if: secrets.ANTHROPIC_API_KEY != ''
  steps:
    - cd apps/fastapi-backend && docker compose up -d
    - wait-on http://localhost:3002
    - BACKEND_URL=http://localhost:8001 pnpm e2e
```

Both jobs run on every PR from trusted contributors. External PRs skip E2E (no secret access) and rely on unit tests only.

---

## Out of Scope

| Item                           | Reason                                                                    |
| ------------------------------ | ------------------------------------------------------------------------- |
| Multi-tenancy implementation   | Django backend is a reference, not a production clone                     |
| Auth / `getToken` E2E testing  | Covered by unit tests in `packages/server`                                |
| Custom agent tools             | Transport validation only — default `create_deep_agent()` config          |
| Production deployment          | Reference stacks are local-only                                           |
| LangGraph Platform / LangServe | Not needed — FastAPI + `astream_events()` is sufficient for the reference |
| Additional backends            | V2 — same pattern, add `apps/langgraph-server-backend/` when needed       |

---

_Spec written: 2026-04-29_
_Updated: 2026-04-29 — LangGraph inside both backends; stsfront clarified as frontend; architecture diagram added_
