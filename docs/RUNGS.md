# The rung contract

This repo is one reference implementation of the LangChain agent ladder:

```
langchain → langgraph → deepagents → open-swe → software-developer-agent
```

Each rung is a superset of the concerns below it. `pnpm eject <rung>` deletes the rungs above
it and leaves a **coherent, working repo** — one you could have written by hand, not a tree with
the files removed.

That last distinction is the whole document.

---

## What a rung is, mechanically

**A rung is an entry in `rungs.json`. Nothing else defines one.**

Not a directory. Not a naming convention. Not a path prefix. The manifest is the sole authority,
and it is a _build and CI input_, not documentation.

### Why not a path convention

We tried one. A close condition that matched a **path string** went green while nine rung files
were still shipping.

A string can be satisfied by a tree that violates the property. A manifest gives you a **set with
a declared cardinality**, and a set is the only thing you can write an exact-count assertion
against. `|deleted| == 106` cannot pass on a no-op the way "the grep found nothing" can.

### The two facets, and why they are separate

Each rung declares two things that look alike and answer different questions:

| field    | question                                      | consumer               |
| -------- | --------------------------------------------- | ---------------------- |
| `owns`   | which files **die** when this rung is ejected | `pnpm eject`           |
| `target` | where the shell **sends you** for this rung   | the shape-routed shell |

Conflating them cannot express this ladder. Rungs 1–3 own files in _two language planes_ but
share _one surface_, selected by a parameter. Rung 4 owns a whole app served from a _different
origin_. Rung 5 owns documentation and nothing else.

`target` is a discriminated union over `param | origin | none`. There is deliberately **no
`route` variant**: no rung has its own in-app route, and a variant nothing exercises cannot be
tested, rots, and reads to a reviewer as "handled" when nothing proved it. Adding one later is a
schema line plus a compile error from `assertNever()` pointing at the switch that needs a branch.

### Ownership is total and disjoint

> Every tracked file is owned by **exactly one** rung, or matched by `shared`.
> A file matching neither is a hard CI failure.

`shared` is an **enumerated allowlist, never a fallback**. If it were a fallback, "forgot to
classify" would become the way to pass — which is exactly how nine rung files shipped.

---

## What `eject` does

`pnpm eject <rung>` retains the target plus the transitive closure of its `requires`, so a fork
never gets a bare single rung. Then, four steps:

1. **Delete** every path owned by a rung outside the retain set.
2. **Rewrite** `rungs.json` _itself_ — the fork is an **input** to this same tooling, not an
   artifact — plus barrel re-exports, Playwright projects, and the generated types.
3. **Prune** the lockfile, so the fork's own `pnpm install --frozen-lockfile` succeeds.
4. **Edit the Python plane by path.** Neither backend has a `package.json`, so despite the
   `apps/*` workspace glob **pnpm cannot see them at all** — both are absent from the lockfile
   while all four TS apps are present. Deleting `ai_backends/<rung>.py` and editing two
   `__init__.py` registries and two `_MODULES` dispatch dicts is filesystem work no pnpm tooling
   reaches.

**Edits are derived, not listed.** Which barrel exports to drop, which Playwright projects and
`testMatch` entries to prune — all computed from the deletion set. A hardcoded list of names goes
stale on the first rename, and goes stale _silently_.

**Eject refuses to run on a stale manifest**, exiting before it touches the tree. Ejecting
against an incomplete census is precisely how you get an incoherent-but-green repo.

---

## Adding or changing a rung

1. Add the entry to `rungs.json`. `shape` must be `conversation` or `run`; `state` must be
   `implemented`, `external-required`, or `planned`.
2. Declare `owns` globs for every plane the rung has files in, and `runtimes` for every backend
   that serves it, with that pair's real `topologies` and a `topologiesSource` to check them
   against.
3. Run `pnpm rungs` until classification is total and disjoint.
4. Run `pnpm rungs:freeze` to re-freeze `ownedFileCount`.
5. Run `node scripts/gen-rung-types.mjs` and commit the regenerated types.

A `planned` rung must own no source. The tripwire exists so a rung cannot start shipping without
its manifest entry being updated first.

### Topologies are per `(rung, runtime)`, never per rung

The ladder is **ragged**. Verified by reading all six `ai_backends` modules:

```
django  × {langchain, langgraph, deepagents} → react, plan-execute
fastapi × {langchain, langgraph}             → react, plan-execute
fastapi ×  deepagents                        → react, plan-execute, deep-research
```

`deep-research` exists in **one of six pairs**. A rung-level `topologies[]` array structurally
cannot express that — it would emit a `django × deep-research` cell that 404s, or silently drop
fastapi's real one. A uniform 3×2×3 grid emits 20 cells; **15 exist**.

> **An empty `topologies` array means one cell with no topology axis — not zero cells.**
> If empty collapsed to zero, every `run`-shaped rung would vanish from the matrix silently.
> Do not re-derive that rule: `matrixCells()` in `@deepagents-nextjs/rungs` encodes it once.

### `runtimes` is not `languages`

Close enough to be conflated, different enough that conflating them is wrong:

- **`languages`** — which planes hold files this rung _owns_. Drives the 8-job eject matrix.
- **`runtimes`** — which backends _serve_ it. Drives the behavioural matrix.

Rung 1 has `languages: [ts, py]` (it owns a TS adapter and two Python modules) but
`runtimes: [django, fastapi]`, because no node runtime serves it.

### What must never go in the manifest

`threadId`, `runId`, `streamUrl`, `graphs` — and the schema **rejects** them rather than merely
omitting them.

A shape is not a stream topology. Real Open SWE registers three graphs (manager, planner,
programmer) that **do not share a run**; the manager dispatches new runs on new threads. A
per-rung thread or single stream endpoint would bake in a topology already documented as wrong
(`apps/open-swe/docs/LOCAL-AGENT.md`, "Topology: this backend is single-run"). Declaring `shape`
is enough; the shape handler owns everything downstream.

### Prefer a glob that owns a directory over a list of filenames

Where a rung has a home of its own — `e2e/rungs/<rung>/`, `apps/open-swe/` — own it with
`<dir>/**` rather than by listing the files inside it.

The difference is not tidiness. **A glob makes a new file owned the moment it lands; a list makes
it owned when someone remembers to add it.** The first is a property of the tree, the second is a
convention someone has to keep. Conventions decay silently, and a rung file nobody remembered to
list is indistinguishable from a shared one until `eject` ships it into a fork that dropped that
rung.

Where a rung's files are scattered through a shared directory — `packages/server/src/adapters/`,
`packages/react/src/` — a list is unavoidable. That is exactly where C7's misfiled-file check
earns its keep, and where it has found every real misclassification so far.

### Where a shared-looking file belongs

When a file _looks_ shared but carries a rung's name, assign it to the **lowest rung that emits
the payload it consumes**. Higher rungs inherit it through `requires`, so one owner is enough.

Apply that per file, not per batch. Nine rung-named renderers in `packages/react` split four
ways under it — and three of them are genuinely shared, because the parts they render come from
`approval-gating.ts`, which is core. Filing those under a rung would make `eject langgraph`
delete the UI for a core feature. `shared._rendererNote` records the reasoning per card.

---

## The close condition

> **"eject runs green" is not acceptable and is not what CI checks.**

`eject`'s exit code reports whether the _script_ ran. It says nothing about the tree it produced,
and that has already been proven satisfiable over a live defect.

`.github/workflows/severability.yml` runs **8 jobs** — 3 bilingual rungs × 2 planes, plus 2
TS-only rungs — derived from each rung's `languages`, never hardcoded. Add a Python
implementation for open-swe and a ninth job appears on its own.

**Why not 5 jobs, one per rung?** Because a pnpm-only job would edit the Python plane and never
execute a line of it. Five green ticks over a plane nothing ran is the same shape as a grep over
a missing file: a confident verdict about something the check never looked at.

Each job ejects, then holds the **result** to the standard a hand-written repo would meet:

- classification is _still_ total and disjoint in the fork;
- the fork declares exactly the retained rungs;
- `pnpm install --frozen-lockfile` succeeds — this proves eject rewrote the **lockfile**, not
  just deleted files, which plain `pnpm install` would paper over;
- `pnpm build && pnpm typecheck && pnpm test` pass;
- the test suite is **non-empty and above half its original size** — a repo with no tests passes
  `pnpm test`, and a fork that quietly dropped 90% of its coverage is green, not working;
- on the Python side the **real server boots**, `/health` lists exactly the retained rungs, and
  **every dropped rung 404s**.

That last negative is not optional. Without it, eject could leave a rung serving and the positive
assertion would still pass.

---

## The rule every check here is written to

State the property. Then ask **both** questions:

> **What would have to be true for this check to pass while the property is violated?** > **What would have to be true for this check to fail while the property holds?**

If either has an answer, the check is a proxy and it is wrong.

The second question is easy to skip and it is how this repo lost an hour. `rungs.schema.json`
once declared `additionalProperties: false` over a set that no longer matched the manifest, so it
rejected **every** document. Injecting forbidden fields still produced "rejected", and the
prohibition looked like it was working. A validator that rejects everything is indistinguishable
from one that rejects the right things — unless something asserts that a **known-good document is
accepted**.

That is why every self-test here leads with a positive case, and why the schema's
baseline-accept runs first.

Checks in this repo have been caught failing in both directions:

- **Failing open:** four `dist` checks used `grep … && exit 1 || echo Clean`. `grep` exits **2**
  on a missing file, which short-circuits into the `||`. A deleted, unbuilt or renamed artifact
  reported "Clean", exit 0. (`set -euo pipefail` does _not_ fix this: POSIX exempts `&&`/`||`
  operands and `if` conditions from `-e`.)
- **Failing closed:** the schema above.

Both report a confident verdict they never computed.

### Every checker must be proven able to fail

A checker never observed to fail is indistinguishable from one that cannot. So each one ships
with a self-test that CI runs, and the self-test asserts **both directions** — it rejects what it
should and accepts what it should:

| checker                      | proof                                                             |
| ---------------------------- | ----------------------------------------------------------------- |
| `assert-dist-clean.sh`       | 25 cases — every import form, plus **a nonexistent path**         |
| `classify.mjs`               | 18 cases — one mutation per gate, asserting _which_ gate fires    |
| `validate-manifest.mjs`      | 15 cases — **baseline-accept first**                              |
| `eject.mjs`                  | 18 cases — refusals, proceeds, and atomicity asserted as _damage_ |
| `matrix.mjs`                 | 5 cases — arity follows the manifest; an empty matrix is refused  |
| `has-rung.mjs`               | 7 cases — a failure must be distinguishable from "absent"         |
| `assert-no-silent-skips.mjs` | 10 cases — 4 of them proving it _spares_ conditional skips        |

Each suite also asserts its own case count, so a broken harness fails loudly instead of
reporting green over zero assertions. The list is not exhaustive.

**Where the proof runs, and why "immediately before" was the wrong thing to promise.** This
paragraph replaced a sentence claiming every proof ran "immediately before it, in the same job".
Measured against `ci.yml`, that was true of three (`rungs:validate`, `skips`, the dist checker),
four steps early for the classifier, and three early for `matrix` — and _none of that matters_,
because a job fails if any step fails, whatever the order. Adjacency inside one job is cosmetic.

**What is not cosmetic is a proof in a different workflow from its checker.** Workflows triggered
by the same event run **independently**: a failing proof in one does not stop a checker in another
from running, or that workflow from going green. The push fails, so nothing merges — but the
checker's own board is not gated by its proof.

Measured across every workflow rather than `ci.yml` alone, **six checkers are in that position**,
and all six proofs live in `ci.yml`:

| checker                     | runs in                        | proof runs in |
| --------------------------- | ------------------------------ | ------------- |
| `classify.mjs`              | `ci.yml`, `severability.yml`   | `ci.yml`      |
| `validate-manifest.mjs`     | `ci.yml`, `severability.yml`   | `ci.yml`      |
| `matrix.mjs`                | `ci.yml`, `severability.yml`   | `ci.yml`      |
| `payload-triangulation.mjs` | `ci.yml`, `severability.yml`   | `ci.yml`      |
| `eject.mjs`                 | `severability.yml`             | `ci.yml`      |
| `has-rung.mjs`              | `cross-version.yml`, `e2e.yml` | `ci.yml`      |

The repo already contains the other arrangement, so this is a convention unevenly applied rather
than a standard being invented here: `await-http-json.sh` is proved inside `severability.yml` and
`assert-resolved-version.sh` inside `cross-version.yml` — each in the workflow that runs it.

Three checkers have **no proof at all**, which is a plain gap rather than a misplaced one:
`gen-rung-types.mjs`, `budgeted-routes.mjs` and `assert-no-missing-workspace-invocations.mjs`.
The last two are addressed in #110, which also proves `budgeted-routes.mjs` inside
`performance.yml` — the arrangement described above. Counted here as they stand on `main`, because
a document that credits work sitting on an unmerged branch is asserting something of a tree that
is not true of it.

If you want a gate rather than a companion, the proof has to live in the workflow that runs the
checker.

**`has-rung` is a worse case than the other five, and a flat list hides that.** The first five sit
in workflows firing on the same events as `ci.yml`, so the cost is a board reading better than it
should. `cross-version.yml` carries `paths:` filters — so on a docs-only PR its checker never
executes at all while its proof runs and reports green. A proof that passed tells you the checker
_would_ work, not that it ran — which is the same distinction
this whole document is about, one level up, applied to CI scheduling rather than to a grep.

_(`census` and `payloads` invoke their proof after their check, in the same job. By the reasoning
above that is fine, and it is the reason the reasoning is worth stating.)_

> **Why these checks look the way they do:** `docs/CHECKING-THE-CHECK.md` carries the reasoning —
> the three respects in which a check can differ from the property it stands for, and the worked
> instances behind each rule here. Read it before writing a new checker; most of these rules exist
> because something shipped without them. That list of instances is **not exhaustive**, and should
> not be read as a checklist that retires the question.

Asserting _which_ gate fires, rather than merely that something failed, is not pedantry — it
caught a real bug where `eject`'s census gate crashed with a raw stack instead of refusing
cleanly. The refusal happened; the message a maintainer needs was buried.

---

## Commands

```bash
pnpm rungs              # classify: total and disjoint?
pnpm rungs:freeze       # re-freeze ownedFileCount after a deliberate change
pnpm rungs:validate     # rungs.json against its schema
pnpm matrix             # show the 8 severability jobs
pnpm eject <rung>       # eject (add --dry-run to see the deletion set first)

pnpm test:rungs         # prove the classifier can fail
pnpm test:rungs-schema  # prove the schema accepts truth and rejects the rest
pnpm test:eject         # prove eject refuses, and proceeds
pnpm test:dist-checks   # prove the dist checker can fail
```
