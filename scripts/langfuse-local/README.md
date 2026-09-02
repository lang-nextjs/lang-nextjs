# Local Langfuse — for proving spans actually arrive

`#118` wired a Langfuse `CallbackHandler` into every invocation site in both
Python backends. "It imports" is not evidence that a span lands, so this fixture
exists to make the claim checkable.

```bash
pnpm langfuse:up          # or: bash scripts/langfuse-local/up.sh up -d --wait
# then point a backend at it:
docker compose -f apps/fastapi-backend/docker-compose.yml \
               -f scripts/langfuse-local/backend-override.yml up -d --build --wait
```

UI on <http://localhost:3100> (`local@example.com` / `local-password-123`).
All credentials here are throwaway, bound to 127.0.0.1, and must never be reused.

## Why `up.sh` exists instead of a plain `docker compose up`

`ENCRYPTION_KEY` must be exactly 64 hex characters, so unlike the neighbouring
values it cannot be labelled `local-only-not-a-secret-...`. **A 64-hex literal is
indistinguishable from a real key by construction** — to gitleaks, to a reviewer
skimming a diff, and to whoever copies this file somewhere less throwaway.

One committed here turned secret scanning red on **every open pull request in the
repo**: `security.yml` checks out with `fetch-depth: 0` and runs
`gitleaks detect --source .`, which scans the whole object graph rather than the
PR's diff, so a secret-shaped string on any branch blocks all of them. It was a
throwaway value for an ephemeral container and it still cost the whole board.

`up.sh` generates the key into a gitignored `.env` and refuses to run if that file
would not be ignored. The compose file uses `${ENCRYPTION_KEY:?...}` so an unset
value fails loudly rather than booting with an empty key.

This costs nothing here: `ENCRYPTION_KEY` only encrypts data at rest inside a
container that `pnpm langfuse:down` destroys. What makes the trace proof
reproducible is the `LANGFUSE_INIT_*` project keys, which are deliberately
low-entropy labelled strings and stay in the compose file.

`pnpm check:langfuse-wiring` asserts no secret-shaped literal comes back.

## Why v3, when v2 on Postgres alone would be so much smaller

That was the plan and it does not work. Both halves measured, not assumed:

- langfuse **v2's** SDK imports `langchain.callbacks`, which LangChain 1.x
  removed. This repo runs LangChain 1.x, so the v2 handler cannot be imported at
  all:
  `ModuleNotFoundError: No module named 'langchain.callbacks'`
- langfuse **v3's** SDK imports cleanly against `langchain-core 1.6` — but
  pointed at a **v2 server** its `auth_check()` fails on the API schema:
  `ValidationError: data -> 0 -> organization: field required`

The only SDK this repo can run talks exclusively to a v3+ server. ClickHouse,
Redis and MinIO are v3's required dependencies, not gold-plating.

## What was actually observed

Against Langfuse **3.225.4**, backend on `:8001` with a real NVIDIA NIM key:

| path                              | trace                                     | observations                       |
| --------------------------------- | ----------------------------------------- | ---------------------------------- |
| `deepagents` react                | `fastapi-deepagents-react`                | 4                                  |
| `langgraph` react                 | `fastapi-langgraph-react`                 | 7                                  |
| `langgraph` plan-execute          | `fastapi-langgraph-plan-execute`          | 13                                 |
| `langchain` react                 | `fastapi-langchain-react`                 | 2                                  |
| `langchain` plan-execute planner  | `fastapi-langchain-plan-execute-planner`  | 4–13                               |
| `langchain` plan-execute executor | `fastapi-langchain-plan-execute-executor` | observed in isolation — see caveat |

`/health` reported `langfuse: {configured: true, tracing: true, supported: true}`
with `detail: "tracing — Langfuse accepted our credentials"`.

### The nested-`ainvoke` question, answered by observation

`langgraph.py`'s planner/executor/replanner call `.ainvoke()` **inside** the
compiled graph. Whether they inherit the parent run's callbacks was an open
question and was deliberately not settled by reasoning. The
`fastapi-langgraph-plan-execute` trace came back with 13 observations including:

```
CHAIN | fastapi-langgraph-plan-execute   (root)
 └ CHAIN | planner / executor / replanner
    └ CHAIN | fastapi-langgraph-plan-execute-planner
    └ GENERATION | ChatOpenAI
```

They **do** arrive as child spans. They need no `config=` of their own, which is
why `check-langfuse-wiring.mjs` deliberately does not demand one there.

### Caveat, stated plainly

The `langchain` plan-execute **executor** was observed tracing when invoked
directly in-process, producing a `fastapi-langchain-plan-execute-executor` trace.
It was **not** re-observed end-to-end over HTTP, because on the configured model
the planner kept returning an **empty step list** (`"Plan:\n\n\n"`, zero `Step`
markers), so the executor loop never ran. That is a property of the model's
output on the test prompts, not evidence of a wiring gap — but it is also not the
end-to-end observation, and it is recorded here as the limit it is rather than
rounded up.
