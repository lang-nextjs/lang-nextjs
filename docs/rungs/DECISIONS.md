# Decisions behind the ladder

The two organizing ideas of the v2.0 reference implementation, and the decisions the
product owner locked while building it. Moved here from the v2.0 EPIC (#16) when that
issue closed: a decision record living in an issue is read only by someone who opens a
closed EPIC, and nothing re-measures it.

**Every claim here that the tree can contradict is written as a path, not a number.**
The EPIC's table said "all 7 packages" and "18 live cells". There are nine packages and
twenty cells. Neither number was wrong when written; both expired silently, because a
count in prose has nothing that recomputes it. So where a decision rests on a quantity,
this page names the file that computes it and lets the checker hold the path.

## 1. The ladder — how the frameworks are explained

Each rung is built from the one below:

| Rung | Framework                | What it adds                                                  |
| ---- | ------------------------ | ------------------------------------------------------------- |
| 1    | LangChain                | LLM + tool primitives                                         |
| 2    | LangGraph                | stateful orchestration over those primitives                  |
| 3    | DeepAgents               | opinionated LangGraph preset — planner, virtual FS, subagents |
| 4    | Open SWE                 | a specific LangGraph _application_ (a coding agent)           |
| 5    | software-developer-agent | a fork extending that application                             |

The ladder is a teaching order, not a dependency order. It is declared once, in
`rungs.json`, and read through `packages/rungs/src/index.ts`; the table above is prose
about that file and the manifest is what any code consults.

## 2. Severability — how the repo is consumed

> "A project sometimes only warrants using LangChain — I want to fork this repo and only
> use the LangChain part as reference."

**Conceptual dependency must never become code dependency.** Ejecting to a rung deletes
the rungs above it and leaves a coherent, building, testing, running repo.

Enforced, not asserted: `scripts/eject.mjs` performs the deletion and
`.github/workflows/severability.yml` runs one job per rung which ejects, reinstalls on a
frozen lockfile, builds, typechecks and runs a non-empty suite. The close condition is
deliberately not "eject exits 0" — that reports whether the script ran, not what the tree
became.

## Decisions locked by the product owner

### Drop npm publishing — **still in force**

The packages were unpublished, all at the same version, with no external consumers, and
the release apparatus fought a fat reference app. The artifact people take is the repo,
not a tarball.

_Enforced today by a stronger fact than the one that motivated it:_ every package
declares `"private": true`, so publication is not merely absent but refused. The
apparatus is gone — `publint`, `attw` and changesets appear nowhere in
`package.json` or the workflows, and `.github/workflows/performance.yml` retains one
comment recording that `size-limit` was removed rather than the tool itself.

_Historical, and not checkable:_ the original rationale counted packages and observed
404s on a registry. Both were true and neither can be re-measured from this tree.

### Keep the package boundaries — **still in force, and checked**

Deleting the release process was never a reason to collapse the architecture. The
boundaries carry the pedagogy:

- `packages/server` has no React dependency.
- `packages/sveltekit` and `packages/remix` each carry their own frame accumulator, so a
  `next` peer dependency cannot leak into a non-Next fork.

The duplication is deliberate and its agreement is asserted rather than assumed:
`packages/test-utils/src/accumulator-parity.test.ts` drives the real implementations
against each other, so the copies cannot drift apart silently.

### Bilingual agent plane — **still in force; the count that stated it has expired**

The Python backends were proven first and stayed; the TypeScript plane was added beside
them. Rungs 4 and 5 are TypeScript regardless, so the repo is bilingual either way.

_The expired part:_ the decision was recorded with a cell count. The live cells are
declared per rung as `runtimes[].topologies[]` in `rungs.json`, and
`scripts/check-topologies.mjs` holds that declaration against the backends that serve
them. The manifest is the answer; no count is repeated here, because a count in prose is
what expired the first time.

### Eject by deletion, not feature flags — **still in force**

A forker wants a small repo they own, not a large one with four disabled branches. Flags
would leave every rung's dependencies in the lockfile, which is the opposite of what
severability is for.

`scripts/eject.mjs` deletes; there is no rung feature flag anywhere in the tree.

## What this page does not do

It records decisions and points at the mechanisms that keep them true. It does not
re-derive them, and a decision that later stops holding will not announce itself here —
only the paths are checked. When a decision changes, change this page in the same commit
as the code, the way the citation rule works for `.planning/PROJECT.md`.
