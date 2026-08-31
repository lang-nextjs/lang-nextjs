# Rung 5 — `software-developer-agent`

**Extending an agent with a domain-specific graph.** The top of the ladder.

← [Rung 4, `open-swe`](./4-open-swe.md) · [Which rung do I need?](./README.md)

---

## State: vendored source + a transport adapter

**The rung-5 agent is now in this repository**, vendored at
[`rungs/5-software-developer-agent/`](../../rungs/5-software-developer-agent/), pinned
to upstream commit `3fb3ee1`. A plain `git clone` gets it — no submodule, no
`--recursive`, no fetch script. Read
[`PROVENANCE.md`](../../rungs/5-software-developer-agent/PROVENANCE.md) before you
change anything in there: it lists the pin, every deviation from upstream, and why the
directory sits outside `apps/`.

What is here, and what is not:

|                                 |                                                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| ✅ The agent itself             | `rungs/5-software-developer-agent/` — the five graphs, tools, and `packages/shared`. Installs and builds.                       |
| ✅ Transport for its vocabulary | `packages/server/src/adapters/sdaEnrich.ts` — maps rung 5's tools to the `data-*` parts the dashboard renders.                  |
| ✅ A part of its own            | `data-testing`, for the Testing graph's six-state status.                                                                       |
| ⚠️ Not verified end to end      | Nobody has watched a rung-5 agent complete a task through this repo's dashboard. See [What is still owed](#what-is-still-owed). |

> ### ⚠️ This is a SECURITY-PATCHED copy, not pristine upstream
>
> Two CRITICAL findings were fixed in the vendored tree that are **still present
> upstream** at `3fb3ee1`. If you fork `iliazlobin/software-developer-agent`
> directly instead of taking this tree, **you get the vulnerable code.**
>
> - **The GitHub webhook never verified its signature.** It read
>   `x-hub-signature-256`, read `GITHUB_WEBHOOK_SECRET`, and never compared them —
>   any request with a non-empty signature header was parsed and dispatched, on
>   `POST /` as well as `POST /webhooks/github`. Now verified against the raw body
>   before parsing or dispatch.
> - **The encryption key was a single-pass SHA-256** of an operator-supplied env
>   var — a fast hash with no salt and no work factor, standing in for a KDF. Now
>   scrypt with a per-ciphertext salt, plus a startup check that rejects obviously
>   weak keys. **This changed the ciphertext envelope**, so upstream ciphertext is
>   not readable here.
>
> Every patched region carries a `BEGIN/END lang-nextjs SECURITY PATCH` banner —
> `grep -r "SECURITY PATCH" rungs/5-software-developer-agent` finds all of them.
> Full manifest, rationale, and the accept/reject test results are in
> [`PROVENANCE.md`](../../rungs/5-software-developer-agent/PROVENANCE.md).
>
> **You do not have upstream. You have our fork of it, and the differences are
> security-relevant.**

> ### ⚠️ This agent executes shell commands on the host
>
> `rungs/5-software-developer-agent/apps/open-swe/src/tools/shell.ts` runs
> `spawn(shell, ["-c", cmd])` **on the host**,
> inheriting the **full parent `process.env`**, with **no sandbox**. That is the
> tool's purpose, not a bug — but the consequence is blunt: **anything that can
> influence this agent's input can run commands as you, with your environment and
> your credentials.** The webhook finding above mattered precisely because it was an
> unauthenticated route to exactly that.
>
> Run it in a container or a VM you are willing to lose, with a scoped token. Do not
> point it at a repository whose issues strangers can open.

**It is deliberately the agent only.** Upstream ships its own Next.js dashboard and a
CLI; neither is vendored, because _this repo is the client_ — that is the whole point
of rungs 1-4. Dropping upstream's dashboard also removed a port collision: its dev
script binds `-p 3001`, which is this repo's own open-swe dashboard.

---

## What it demonstrates — and how to bill it

The upstream source is `iliazlobin/software-developer-agent` (MIT, TypeScript),
vendored here at commit `3fb3ee1`.

**Bill this rung as "extending an agent with a domain-specific graph." Do not bill it
as "building a product."**

That distinction is not editorial fussiness — it is what recon found. The upstream
repo is a fork of `langchain-ai/open-swe` carrying 406 commits, **of which 7 are the
fork author's.** The original contribution is specific and legible:

- a **Playwright-driven Testing graph** — a specialist graph that drives a browser
- a **DynamoDB run store** — durable run persistence
- a **GitHub webhook front door** — runs triggered by repository events

Calling that "extending a framework application into a product" oversells it. Calling
it "extending an agent with a domain-specific graph" is exactly what a forker who
wants to add their _own_ specialist graph needs to see — because that is the shape of
the work: take rung 4's agent, add one graph that knows your domain, add a store, add
a trigger.

**Read those 7 commits before you build this rung yourself.** The ratio is the
lesson: rung 5 is a thin, high-leverage layer on rung 4, not a rewrite.

---

## What actually exists here today

The substrate rung 5 will need — **this part is real and tested**, and it lives under
rung 4's app:

**`apps/open-swe/lib/sandbox/`** — a sandbox provider abstraction with two
implementations:

- `docker-sandbox.ts` — ephemeral Docker containers on the local daemon. The default.
- `blazing-sandbox.ts` — a remote workspace API.

`getSandbox()` (`lib/sandbox/index.ts`) selects between them: `BLAZING_API_URL` set →
Blazing, unset → Docker. Provider parity is covered by dedicated suites —
`parity.executeTool.test.ts`, `parity.lifecycle.test.ts`, `parity.list.test.ts`,
`parity.telemetry.test.ts` — with the running state written up in
`lib/sandbox/PARITY.md`.

**`apps/open-swe/sandbox/Dockerfile`** — the recommended workspace image. Build with
`docker build -t open-swe-sandbox:latest apps/open-swe/sandbox` and set
`SANDBOX_IMAGE`. Unset, it falls back to public `node:22-alpine`.

**`apps/open-swe/app/api/open-swe/sandbox/*`** — the routes that execute shell
commands in those workspaces.

### Three warnings about that substrate, from the repo's own config

These are documented in `apps/open-swe/.env.local.example` and
`apps/open-swe/docs/blazing-provider.md`. They are not hypothetical.

1. **Nothing serves the Blazing API today.** Its `/v1/workspace*` routes are described
   upstream as deployment-dead — no deployment mounts a Docker socket, the workspace
   service is built by no pipeline. Pointing `BLAZING_API_URL` at a URL that 500s buys
   you nothing. **Use the Docker provider.**
2. **Security — do not point Blazing at a shared or multi-tenant instance.** Its
   workspace API has a documented cross-tenant IDOR: Redis keys carry no tenant
   component, so any valid token can enumerate, exec into, and destroy _every_
   tenant's workspaces. Local single-tenant only, until that is fixed upstream.
3. **The variable is `BLAZING_API_TOKEN`, not `BLAZING_API_KEY`.** The adapter reads
   `TOKEN`. An `API_KEY` in your env does nothing and fails silently.

And one API contract worth reading before you build a reaper on top of it:
`Sandbox.list()` is **best-effort**. A provider that cannot parse a record skips it and
reports `droppedCount`. The returned list is a _lower bound_, not a census — a garbage
collector that destroys anything absent from it will destroy live workspaces. Cross-check
with `get()` before destroying, or refuse to sweep while `droppedCount > 0`.

### Also relevant: the sandbox routes are unauthenticated in dev

`OPEN_SWE_SANDBOX_TOKEN` unset means the shell-executing routes are **open in dev** (so
`pnpm dev` and the E2E suite work) and **404 in production**. Unconfigured production
serves nothing rather than an unauthenticated shell. Set the token for any deployment
that is not your laptop.

---

## What it needs to run

The list splits in two, and the split is the useful part — it decides whether this
rung is _demonstrable_ or merely _deployable_.

**To see an agent execute** — local mode, via the `x-local-mode: true` header or
`OPEN_SWE_LOCAL_MODE=true`:

- **Node 20+** and **yarn 3** (corepack resolves it from `packageManager`). Nothing in
  the tree enforces the Node version — there is no `engines` field anywhere.
- **An LLM key.** `ANTHROPIC_API_KEY` is the default path.
- **Postgres on `:5432`.** `langgraph.json` hardcodes the checkpointer DSN;
  `local/docker-compose.yml` provides a matching container.

**Only for the full GitHub-webhook flow** — everything below is skippable if you just
want to watch the agent work:

- A **GitHub App** (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`)
  and a public tunnel
- **DynamoDB** on `:8000` plus dummy AWS credentials
- **Daytona** (`DAYTONA_API_KEY`) for the real cloud sandbox
- **Firecrawl** — the URL-content tool only

Local mode is what makes that split real, and it is genuinely plumbed rather than
aspirational: every sandbox-touching tool branches on `isLocalMode(config)`, the
manager graph's _entry_ node returns immediately in local mode before any GitHub token
is read, and the single DynamoDB write on a graph path is guarded by
`!isLocalMode(config)`.

**Verified:** `yarn install --immutable` and `yarn build` both pass in the vendored
tree on Node 22 / yarn 3.5.1. **Not verified:** an agent completing a task, which
needs an LLM key.

---

## What to delete to eject to rung 5

Nothing — rung 5 is the top of the ladder, so ejecting _to_ it drops the four rungs
below and leaves everything here. `pnpm eject software-developer-agent` is the whole
operation.

Ejecting **away** from rung 5 (down to rung 4 or lower) removes its leaves, and they
are deliberately few: the vendored tree, `sdaEnrich.ts` and its test, the
`data-testing` schema entry, and its Zod schemas in `@deepagents-nextjs/react`. That
list is short by design — the transport core, the dashboard, approval gating and the
sandbox substrate are all shared, so a fork that drops rung 5 loses the Testing graph
and keeps everything else.

## What is still owed

Stated plainly, because a guide that omits its gaps is how a chooser starts lying:

- **No end-to-end run has been observed.** The adapter's mappings are proven against
  fixtures built from the vendored tool schemas, not against a live agent. Verifying
  the live shape needs an LLM key and a running LangGraph server.
- **A single subscription sees one of three graphs.** Rung 5's three graphs
  dispatch _separate runs on separate threads_ — inherited unchanged from
  `langchain-ai/open-swe`, so rung 4 has this too. Correlation travels in graph state
  (`plannerSession: { threadId, runId }`), and adopting it is rung 4's work, not
  rung 5's.
- **Nobody maintains upstream.** It is frozen: 406 commits, 7 of them the fork
  author's, substantive work stopped in September 2025. Anything broken in the
  vendored tree is ours to fix.

---

## What a fork looks like afterwards

Speculative — labelled as such, because no code here supports it.

Rung 4's shape (a dashboard client for an agent platform you run separately), plus:
one domain-specific graph you wrote, a durable run store, and a non-human trigger —
a webhook, a schedule, a queue.

The interesting change is that last one. On rungs 1–4 a human starts every run. Rung
5 is where runs start themselves, which means: **there may be nobody watching when it
fails.** Every concern inherited from rungs 1–4 — token cost, cycle termination, plan
invalidation, reconnection, rendering a finished run — now has to be legible to
someone reading it hours later with no context.

That is the real content of the top rung, and it is why the ladder's ordering is the
teaching. You do not get to skip to here.

---

## If you need this today

You have two honest options, and neither is "fork this repo for rung 5":

1. **Fork `iliazlobin/software-developer-agent` directly** (MIT). It is the actual
   implementation. Read its 7 fork-author commits first to see how thin the domain
   layer is.
2. **Fork this repo at rung 4** and add your own specialist graph upstream. You get
   this repo's transport, dashboard, approval gating, MCP tools, and sandbox
   substrate; you write the graph.

Option 2 is what this repo is for. Option 1 is faster if your domain is close to
theirs.
