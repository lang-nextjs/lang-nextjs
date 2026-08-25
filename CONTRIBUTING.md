# Contributing

This repo is a **forkable reference implementation** of the LangChain agent ladder. Its central
constraint is **severability**: `pnpm eject <rung>` must leave a coherent, working repo. Almost
every convention below exists to protect that, or to protect the checks that protect it.

Read [`docs/RUNGS.md`](docs/RUNGS.md) for what a rung is, and
[`docs/CHECKING-THE-CHECK.md`](docs/CHECKING-THE-CHECK.md) for the reasoning behind the house rule
below. This file is the working procedure; those are the arguments.

---

## Getting started

```bash
pnpm install
pnpm dev          # one command: backends, queue agent, apps — secrets read in place
```

`pnpm dev` starts what your tree actually contains: rung-4 services are guarded, so a fork ejected
below rung 4 starts what it has and says what it skipped. Logs land in `.dev-logs/` (gitignored).

---

## The house rule

> **A check must be able to fail, and you must have seen it fail.**

Nearly every defect this repo has recorded is one shape: **a check reporting a verdict it never
computed.** Not a wrong answer — *no answer*, presented in the format of a passing one.

Real examples, all found here:

| What it printed | What was true |
|---|---|
| `usage:` then exit 0 | `has-rung.mjs` never ran; every guarded CI step was skipped, board green |
| `0 findings, exit 0` | `actionlint` had no `shellcheck`, so it examined **no shell at all** |
| `no leaks found` | `gitleaks` scanned **0 commits** |
| `apps/open-swe is already clean` | the checker exited early through a symlinked path over 237 findings |
| `census agrees` | nothing had been enumerated |
| `MUTATION SURVIVED` | the mutation had become a no-op, and the checker was fine |

So: when you add a checker, add a selftest that **plants the defect** and proves the checker
refuses it — *and* proves it accepts clean input. Refusing everything is as useless as refusing
nothing. `pnpm pairing` enforces that every checker CI runs has a proof CI also runs; it will fail
your PR if you add one without the other.

If you cannot make your check fail on demand, you do not yet know that it works.

---

## Before you push

```bash
pnpm typecheck && pnpm build && pnpm test
pnpm rungs && pnpm census && pnpm palette && pnpm payloads && pnpm topologies
pnpm test:eject          # eject's guards still refuse what they should
pnpm pairing             # every checker has a proof
```

CI runs more than this, but a failure in any of the above is yours, not the runner's.

---

## Traps that have actually cost time here

Each of these produced a confident wrong answer for someone on this project. They are listed with
the *symptom*, because the symptom is what you will see first.

### `test:eject`'s sandbox is built at `HEAD` — your uncommitted fix is invisible

`eject.selftest.mjs` does `git worktree add --detach HEAD`. Edit the working tree, run the
selftest, and it answers about **the last commit**, naming a line you already changed. Three
passes were burned on this. **Commit, then run.** Same family: the census reads `git ls-files`, so
an untracked file is invisible to it.

### Re-freeze what is *actually* stale — and read the reason first

`pnpm rungs:freeze` and `pnpm census:freeze` write **different artifacts** (`rungs.json`'s
`ownedFileCount` vs `scripts/shared-census.json`'s glob membership). They answer different
questions. Check both, freeze what is stale.

And read the failure before reaching for either. `C4 glob: shared path "patches/**" matched zero
tracked files` is a **glob entry**, not a count — freezing does not touch it, and freezing on
reflex leaves a dead glob behind a green board.

**On a merge conflict in `ownedFileCount`, neither side is right.** Re-freeze. Picking a side bakes
in a number nobody measured, and a phantom `+1` then travels into the next honest change under
someone else's name.

### After a squash merge, `git rebase origin/main` replays work main already has

A squash-merged branch shares **no commits** with main while its content is already there. Use:

```bash
git rebase --onto origin/main <old-base>     # replays only YOUR commits
```

Measured here: a branch that should have replayed 1 commit tried to replay 6; another tried 9 and
would have re-applied a whole merged PR's diff under a new author. Check afterwards with
`git rev-list --count origin/main..HEAD`.

Related: **ancestry lies about a squash-merged base.** `git merge-base --is-ancestor` says *no*
while the content is demonstrably on main. **Verify a merge by content** — grep for a symbol the
change introduced — never by ancestry.

### `pull_request` workflows come from the **HEAD** branch

A gate added to `main` is invisible to every already-open PR and debuts at merge time. The same is
true of `.gitleaks.toml`: a fix on main clears nobody until they rebase.

### A guard eject cannot *read* is a guard eject does not *credit*

A retained file may reference a rung-owned app only if a `has-rung.mjs <app>` call sits on an `if`
line within 25 lines:

```sh
if ! __rung=$(node "$REPO/scripts/has-rung.mjs" open-swe); then
  die "cannot determine whether the open-swe rung is present"
fi
```

`[ -d "$ROOT/apps/open-swe" ]` is correct at runtime and **eject refuses it anyway** — it is not
the guard the checker looks for. Check the exit code, not just stdout: `$( )` inside `[ ]` discards
it, so a broken manifest silently takes the "absent" branch.

### Do not `git reset --hard` with uncommitted work

It ate a finished fix here, mid-session. If you are cleaning up a probe commit, commit your real
work first.

### Confirm success by its *presence*, not by the absence of an error

`git merge ... >/dev/null 2>&1 && echo "synced"` — the `synced` line never printed, the conflict
went unnoticed, and the next twenty minutes tested the wrong tree. Do not discard stderr on a
command whose empty output is the signal you are reading.

---

## Pull requests

- **Branch from current `main`.** Long-lived branches over files others are editing are the single
  most expensive thing here — see #156, where every conflict resolved cleanly by taking `HEAD` and
  that resolution silently deleted four shipped features. Git presents a relocation as *"my side
  rewrote the file"*, so the dangerous resolution is also the clean-looking one.
- **One concern per PR.** `git add <path>` explicitly; `git add -A` after a failed command has
  swept unrelated files into a PR here more than once.
- **Say what you measured.** A PR body that states the command and its output is reviewable; one
  that asserts a property is not. If a mutation test escaped, list it — a table showing only
  successes is the thing this repo keeps finding.
- **Reference the issue** with `Closes #N`.
- Commit trailers: `Co-Authored-By:` for pairing, and keep the subject in the imperative.

### Reviewing

Ask of any claimed verification: **could this have printed the same thing if it had done nothing?**
That question has found more real defects here than reading the diff has.

---

## Layout, and what not to flatten

```
apps/            example (rungs 1-3), open-swe (rung 4), fastapi-backend, django-backend
packages/        server, react, ui, rungs, edge, remix, sveltekit, mcp, test-utils
scripts/         the checkers and their selftests — retained by every eject
rungs.json       the manifest: what each rung owns, and what is shared
```

The package boundaries are **load-bearing pedagogy**, not accident:

- `packages/server` has no React dependency — it shows how to keep a proxy server-only.
- `packages/sveltekit` and `packages/remix` deliberately **copy** `SseFrameAccumulator` rather than
  importing it, so the `next` peerDep cannot leak. `scripts/assert-dist-clean.sh` enforces this in
  CI; a forker is meant to see the seam.

Do not "tidy" these into a shared import.

---

## Further reading

| Doc | For |
|---|---|
| [`docs/RUNGS.md`](docs/RUNGS.md) | the ladder, the manifest, what `owns` and `shared` mean |
| [`docs/CHECKING-THE-CHECK.md`](docs/CHECKING-THE-CHECK.md) | why the house rule exists, with the full catalogue |
| [`docs/VERIFYING-IN-A-FORK.md`](docs/VERIFYING-IN-A-FORK.md) | proving a change survives `pnpm eject` |
| [`docs/TESTING.md`](docs/TESTING.md) | test layout and what belongs where |
| [`docs/DEPLOYMENT-RUNBOOK.md`](docs/DEPLOYMENT-RUNBOOK.md) | running it for real |
