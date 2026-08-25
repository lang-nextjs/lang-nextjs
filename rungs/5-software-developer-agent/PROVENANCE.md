# Provenance — vendored rung-5 source

This directory is **third-party source, vendored**. It is not ours, we did not write it,
and we do not track its upstream. Everything here came from one commit of one repository,
listed below, with the deviations listed below and no others.

| | |
|---|---|
| **Upstream** | https://github.com/iliazlobin/software-developer-agent |
| **Pinned commit** | `3fb3ee17ee6af4e760f6ecf7fb070030de90dd70` |
| **Commit date** | 2026-06-24 |
| **License** | MIT — `LICENSE` is verbatim upstream, dual-credited to Ilia Zlobin and LangChain, Inc. |
| **Vendored on** | 2026-08-24 |

## Why pinned and not tracked

Upstream is effectively frozen. Of its 406 commits, **7 are the fork author's** — the rest
are inherited `langchain-ai/open-swe` history. Substantive work stopped 2025-09-29; the
single commit since (the pinned one) changes only `README.md` and `LICENSE`. Zero open
issues, zero stars, one branch.

The cost of pinning is therefore near zero — there is nothing upstream to miss. **The cost
we do carry is that nobody maintains it, so anything broken here is ours to fix.** Do not
file bugs upstream expecting an answer.

## Why it lives outside `apps/`

The repo root's `pnpm-workspace.yaml` globs `apps/*` and `packages/*`. This tree is a
**yarn 3.5.1 monorepo** with its own root `package.json`, its own `workspaces` field, and
its own lockfile. Placing it under `apps/` makes pnpm adopt it as a workspace member, which
was measured to produce two failures:

1. A **name collision** — this tree's root package is also named `open-swe`, same as our
   `apps/open-swe`. Two workspace projects, one name.
2. **`ERR_PNPM_OUTDATED_LOCKFILE`** on `pnpm install --frozen-lockfile` — the exact command
   run by `ci.yml`, `e2e.yml`, `cross-version.yml`, `security.yml` and `benchmark.yml`. Every
   workflow on every rung breaks, on a fresh clone, before anyone edits a file.

`rungs/` is matched by neither glob, so pnpm ignores this tree entirely and
`pnpm-workspace.yaml` needs no exclusion rule to maintain. **Do not move this directory
under `apps/` or `packages/`, and do not add a `rungs/*` glob to the workspace file.**

## SECURITY PATCHES — this tree is NOT pristine upstream

**Read this before you copy anything out of this directory.** Two CRITICAL findings
were fixed here that are still present in `iliazlobin/software-developer-agent` at
`3fb3ee1`. If you fork upstream directly instead of taking this tree, you get the
vulnerable code.

| # | File | What upstream does | What this tree does |
|---|---|---|---|
| **#84** | `apps/open-swe/src/routes/github/unified-webhook.ts` | Reads `x-hub-signature-256`, reads `GITHUB_WEBHOOK_SECRET`, and **never compares them**. `createHmac`, `timingSafeEqual`, `.verify(` and `verifyAndReceive` have **zero occurrences** in the file. Any request with a non-empty signature header is parsed and dispatched. Mounted on `POST /` **and** `POST /webhooks/github`. | Verifies with `@octokit/webhooks` `verify()` against the **raw body**, **before** `JSON.parse` and **before** any handler. Rejects with an opaque 403. |
| **#82** | `packages/shared/src/crypto.ts` | Derives the AES-256-GCM key as a **single-pass SHA-256** of an operator-supplied env var. No salt, no work factor. Docstring called it "will be hashed to 256 bits", presenting length as a security property. | **scrypt** (N=2^15, r=8, p=1) with a **random per-ciphertext salt** stored in the envelope, plus a startup check that refuses obviously weak keys. |

Every patched region is wrapped in `BEGIN/END lang-nextjs SECURITY PATCH (issue #NN)`
banners naming the issue and what upstream did. **Grep for `SECURITY PATCH` to find
every deviation.** Nothing is silently merged into vendored source.

### Breaking change you must know about (#82)

The ciphertext envelope changed from `IV(12) || ct || TAG(16)` to
`SALT(16) || IV(12) || ct || TAG(16)`. **Ciphertext written by upstream's code cannot
be read by this code.** That is safe here because the producer (the web app) and the
consumer (the agent) both live in this tree and there is no persisted store — but
adopting this patch against live data needs a migration, not a drop-in.

### Proof, not assertion

`security-patches.test.mjs` in this directory. Run it with:

```
cd rungs/5-software-developer-agent && corepack yarn build && node --test security-patches.test.mjs
```

It is plain `node:test` rather than the repo's vitest because this is a yarn 3
workspace with its own dependency graph, and because importing rung-5 code into the
shared `packages/server` suite would itself be a severability violation.

Measured both ways, which is the only reason the numbers mean anything:

| | patched (this tree) | patched reverted (upstream code) |
|---|---|---|
| 10 tests | **10 pass / 0 fail** | **4 pass / 6 fail** |

The reject cases use a signature computed with the **wrong secret**, not a random
string — a random string is refused by a correct implementation *and* by one that
merely checks the header is well-formed, so it cannot tell them apart. And the
decisive assertion is that a forged request **never reaches the dispatcher**, not
merely that it got a 403: upstream returns 403 for a *missing* signature too, so a
status-only test passes against the vulnerable code.

### Still unpatched, and deliberately so

`apps/open-swe/src/tools/shell.ts` runs `spawn(shell, ["-c", cmd])` on the **host**,
inheriting the **full parent `process.env`**, with **no sandbox**. That is the tool's
purpose and it is not a defect to be fixed here — but it means untrusted input
reaching this agent is host RCE with the operator's credentials. #84 mattered
precisely because it was a route to that. Run this agent in a container or a VM you
are willing to lose, with a scoped token.

## Deviations from upstream

Everything that differs from the pinned commit is listed here. Nothing else was touched.

### Removed

Our repo is the *client* of this agent; the agent is the part worth reading. Its own
front-ends duplicate what we already ship, so they are not vendored.

| Path | Why |
|---|---|
| `apps/web/` | Upstream's own Next.js dashboard. Duplicates our `apps/open-swe` client, and its dev script binds `-p 3001` — our rung-4 dashboard's port, fixed by PR #21. Dropping it **dissolves that collision** rather than renumbering it. |
| `apps/cli/` | Requests the graph id `"coding"`, which the config its own dev script loads (`../../langgraph.json`) does not register. Appears non-functional as shipped. |
| `apps/open-swe-v2/` | Experimental `createDeepAgent` single-graph agent, unregistered in the root `langgraph.json`. Not the five-graph system this rung is about. |
| `apps/docs/` | ~4.5 MB of MDX + screenshots. |
| `static/`, `images/` | ~2.5 MB of screenshots and diagrams. |
| `webhooks/payloads/` | Sample GitHub webhook JSON. |
| `tests/` | Standalone diagnostic `.js`/`.mjs` scripts (GitHub App credential probes, DynamoDB schema checks) — not a test suite; the real tests live in `apps/open-swe/src/__tests__/`. |
| `package-lock.json` | Upstream shipped **both** `yarn.lock` and `package-lock.json`, neither gitignored, while its README says "do not use npm". A forker running `npm install` out of habit got a different tree than the one upstream tested. `yarn.lock` is authoritative; the npm lockfile is removed so the ambiguity cannot bite. |

### Modified

**`yarn.lock` — regenerated for the pruned workspace set.** Required: with `apps/web`,
`apps/cli` and `apps/open-swe-v2` gone, the original lockfile still carried their
`workspace:` entries, and `yarn install --immutable` failed with
`YN0028: The lockfile would have been modified by this install`. A forker running plain
`yarn install` would have succeeded while silently rewriting a vendored file — drifting off
the pin on their first command.

The regeneration was verified to be a **strict subset**, not a re-resolve:

```
resolutions removed: 813
resolutions added:     0
```

No dependency changed version. Every package still here resolves to exactly what upstream
pinned.

**No source file was modified.** `apps/open-swe/` and `packages/shared/` are byte-identical
to the pinned commit.

## Verified at vendor time

Run from this directory, on Node v22.22.2 with yarn 3.5.1 via corepack:

| Check | Result |
|---|---|
| `yarn install --immutable` | passes (0.6s) |
| `yarn build` | `2 successful, 2 total` — `@openswe/agent`, `@openswe/shared` |

Two non-fatal install warnings are expected and are upstream's, not ours: yarn's builtin
TypeScript compat patch reports `Cannot apply hunk #1` against TS 5.7.3 and 5.9.2, and
`@langchain/langgraph-cli@0.0.47` under-declares four peer dependencies.

**Not verified:** that an agent completes a task end to end. That needs an LLM API key and a
running LangGraph server, neither of which was available when this was vendored. What is
proven is that the tree installs, compiles, and is internally consistent.

## What it needs to run

Split by what you are actually trying to do — the distinction decides whether this rung is
demonstrable or merely deployable.

**To see an agent execute** (local mode — `x-local-mode: true` header, or
`OPEN_SWE_LOCAL_MODE=true`):

- Node 20+ and yarn 3 (nothing in the tree enforces the Node version — there is no `engines`
  field anywhere)
- An LLM key — `ANTHROPIC_API_KEY` is the default path
- Postgres on `:5432` — `langgraph.json` hardcodes the checkpointer DSN. `local/docker-compose.yml`
  provides it.

**Only for the full GitHub-webhook flow:**

- A GitHub App (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`) and a
  public tunnel
- DynamoDB on `:8000` plus dummy AWS credentials
- Daytona (`DAYTONA_API_KEY`) for the real cloud sandbox
- Firecrawl (`FIRECRAWL_API_KEY`) — the URL-content tool only

Local mode is load-bearing for that split, and it is genuinely plumbed rather than
aspirational: every sandbox-touching tool branches on `isLocalMode(config)`, the manager
graph's entry node `initializeGithubIssue` returns `{}` immediately in local mode before any
GitHub token read, and the one DynamoDB write on a graph path
(`apps/open-swe/src/graphs/planner/nodes/proposed-plan.ts`) is guarded by `!isLocalMode(config)`.

## Two things to know before reading the code

**The five graphs are not five registered graphs.** `langgraph.json` registers three —
`manager`, `planner`, `programmer`. `reviewer` and `testing` exist under
`apps/open-swe/src/graphs/` as subgraphs of the programmer.

**The three registered graphs do not share a run.** `manager` calls `runs.create` to start
the planner *on a new thread*, and the planner does the same for the programmer. Correlation
travels in graph state — `start-planner.ts` returns `{ plannerSession: { threadId, runId } }`
— not in a database. This is upstream `langchain-ai/open-swe` behaviour (blame:
`4ea21855`, Brace Sproul, 2025-07-03), inherited unchanged, **not** something this fork
introduced. A single-thread client sees one third of the agent.

The fork's `parentThreadId` + DynamoDB store exists for a different reason: a GitHub webhook
arrives with an issue number and no graph state to read, so it needs an issue→thread index
queryable from outside a run.
