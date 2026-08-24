# Rung 5 — `software-developer-agent`

**Extending an agent with a domain-specific graph.** The top of the ladder.

← [Rung 4, `open-swe`](./4-open-swe.md) · [Which rung do I need?](./README.md)

---

## State: ⚠️ Not present in this repo yet

**There is no rung-5 code in this repository.** No app, no backend, no module, no
route, no test. An exhaustive grep for `software-developer-agent` across the tree
returns exactly two hits, and both are prose: the root `README.md` and
`.planning/PROJECT.md`.

If you fork this repo expecting rung 5 to be here, you will find nothing to fork.
Everything below is either about the **planned** rung or about the **substrate that
already exists for it** — and each paragraph says which.

This page exists because a chooser with a gap in it is worse than one that names the
gap.

---

## What it is planned to demonstrate — and how to bill it

The upstream source is `iliazlobin/software-developer-agent` (MIT, TypeScript). It is
**not vendored here.**

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
wants to add their *own* specialist graph needs to see — because that is the shape of
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
   component, so any valid token can enumerate, exec into, and destroy *every*
   tenant's workspaces. Local single-tenant only, until that is fixed upstream.
3. **The variable is `BLAZING_API_TOKEN`, not `BLAZING_API_KEY`.** The adapter reads
   `TOKEN`. An `API_KEY` in your env does nothing and fails silently.

And one API contract worth reading before you build a reaper on top of it:
`Sandbox.list()` is **best-effort**. A provider that cannot parse a record skips it and
reports `droppedCount`. The returned list is a *lower bound*, not a census — a garbage
collector that destroys anything absent from it will destroy live workspaces. Cross-check
with `get()` before destroying, or refuse to sweep while `droppedCount > 0`.

### Also relevant: the sandbox routes are unauthenticated in dev

`OPEN_SWE_SANDBOX_TOKEN` unset means the shell-executing routes are **open in dev** (so
`pnpm dev` and the E2E suite work) and **404 in production**. Unconfigured production
serves nothing rather than an unauthenticated shell. Set the token for any deployment
that is not your laptop.

---

## What it needs to run

**Nothing runs today, because nothing is here.** When rung 5 lands it will need
everything rung 4 needs — a LangGraph Platform server and the upstream agent — plus,
based on what upstream built: a container runtime for the sandbox, a run store, and a
webhook receiver.

Do not plan a schedule against that list. It is read from the upstream repo's shape,
not from code in this checkout.

---

## What to delete to eject to rung 5

Not applicable. There is nothing to eject *to*.

If you are building rung 5 yourself, the honest starting point is **eject to rung 4**
(see [that guide](./4-open-swe.md#what-to-delete-to-eject-to-rung-4)), keep
`apps/open-swe/lib/sandbox/` and `apps/open-swe/sandbox/`, and add your specialist
graph upstream in the agent — not in this repo. Rung 5's original work happens on the
agent side of the network boundary; this repo is the client.

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
