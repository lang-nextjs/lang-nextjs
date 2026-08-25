# Verifying your change survives `pnpm eject`

**A change can be correct in the full repo and broken in a one-rung fork, and
neither `pnpm test` nor `tsc` in the full repo will tell you.** Two defect
classes only appear after an eject:

1. **`RungId` narrows.** In a `langchain` fork `RungId` is the single literal
   `"langchain"`, so `rung.id === "deepagents"` becomes **TS2367 "no overlap"** —
   a type error in the fork, invisible here. Use `String(id) === "…"` if you
   genuinely need the comparison.
2. **Non-emptiness assertions invert.** "The registry is non-empty", "both nav
   groups render", "there are three adapters" are all correct here and *wrong*
   in a fork where the right answer is zero or one. Worse, the reverse also
   bites: a test that loops over a filtered slice of `RUNGS` runs **zero
   assertions** when the slice is empty and reports green having checked
   nothing.

   The rule three of us converged on independently: **derive the expected side
   from the manifest, or filter it by presence.** A literal is fine as the
   expected side of an equality — it just has to shrink when the manifest does.
   Asserting a *count* against `RUNGS.filter(...).length` is meaningful even at
   zero, because it still says "the code invented nothing the manifest lacks".

## The loop

`eject` refuses to run against a dirty tree, so commit or stash first — that gate
is what makes its rollback possible.

```bash
# 1. throwaway worktree at the ref you actually mean to verify, and eject INTO
#    it with --cwd. The tree you care about is never the subject, so a mistake
#    cannot cost you anything. NAME THE REF — see below; `HEAD` is a trap.
git worktree add --detach /tmp/forkcheck origin/main
node scripts/eject.mjs langchain --cwd /tmp/forkcheck

# 2. install and BUILD PACKAGES (see the one live pitfall below)
cd /tmp/forkcheck
pnpm install --frozen-lockfile --prefer-offline --ignore-scripts
pnpm --filter './packages/*' build

# 3. the actual checks
cd apps/example && pnpm exec tsc --noEmit
pnpm exec vitest run

# 4. clean up — a stray worktree is a shared-repo mutation
cd - && git worktree remove --force /tmp/forkcheck && git worktree prune
```

## Name the ref — do not inherit it

`git worktree add --detach /tmp/forkcheck HEAD` reads as harmless and is the
line most likely to waste your afternoon. **`HEAD` means "whatever worktree I am
standing in right now."** Measured in this repo: **59 worktrees, 51 of them on a
named branch.** Standing in the one you intend to verify is the exception, not
the default, and the natural way to run a documented loop is from wherever you
already are.

It has a real cost, already paid: a fork check run three times from a feature
worktree carried `apps/example/components/DemoNav.tsx` — a file **deleted on
main** — so it verified a tree that cannot occur. Its base was **17 commits
behind** and not an ancestor of `origin/main` at all. That it was inert was luck
about which file it happened to be.

**Three distinct ways the base is not what you think, with three distinct fixes.
This matters because printing one fix beside three symptoms leaves two live:**

| | what happened | fix |
|---|---|---|
| **A** | local `main` is stale — `git fetch` does not move it | branch from `origin/main` |
| **B** | base was cut correctly, then `main` moved on | rebase |
| **C** | you never branched at all — `HEAD` was ambient | **name the ref** |

Neither A's fix nor B's fix reaches C. There was no branching to do differently,
and rebasing a feature branch does not make it the right base for a fork check.

**Row A is not the rare one.** It was hit ten minutes after the fix for row C
merged, by the person who merged it: a local `main` ten commits behind origin,
used to check whether a PR was stale. The greps answered — `0 hits` for a
declaration that had landed, `No such file` for a test that existed — and the
conclusion "that PR never landed its pruning" was one keystroke away. **A stale
local `main` reports 0 dirty and 0 behind and answers questions about a tree that
is ten commits gone.** In the same shell, a worktree cut with an explicit
`origin/main` was correct; the grep against ambient `main` was not. The correct
and incorrect halves of row A sat side by side, and only the named one was right.

**`HEAD` is correct only when the current worktree IS the subject** — verifying
your own in-progress branch, standing in it. Say so explicitly when you mean it:

```bash
git worktree add --detach /tmp/forkcheck origin/main       # verify main
git worktree add --detach /tmp/forkcheck my-feature-branch # verify that branch
git worktree add --detach /tmp/forkcheck HEAD              # only if you ARE the subject
```

## The one live pitfall: a fresh worktree has no `packages/*/dist`

Skip the package build and `tsc` reports **dozens of errors across twenty-plus
files** — every `@deepagents-nextjs/*` import unresolvable — none of them real.
Build the packages before believing any typecheck in a new tree. This one is
still live, and it is the same family as everything in
`docs/TURBOPACK-DEV-CACHE.md`: **before believing a red, check whether the
harness produced it.**

## Three pitfalls that #71 removed — and what the tool now guarantees

These were real and are fixed. They are recorded because knowing the guarantees
tells you how to read a refusal: **when `eject` refuses now, it has changed
nothing, so the refusal is information rather than damage.**

**`eject` is atomic.** It gates on a clean tree, pre-flights the entire deletion
set, and rolls back on any failure in the mutating phase — verification
included. It previously deleted files as it walked and a mid-run error left a
tree that was neither the original nor a fork; a crash on one missing path had
already destroyed 134 tracked files.

Use `git rm` rather than `rm` anyway, but for a different reason now: a
tracked-but-missing path is caught by pre-flight, so eject refuses having
touched nothing instead of dying halfway.

**Untracked files can no longer be silently swept.** A git-based classifier
cannot see them, so they were unclassified and deleted — the symptom was your
new files vanishing while committed ones survived. The clean-tree gate makes
that unreachable by accident, and says so in its own refusal message.

**`--cwd` is correct, and is now the safer choice.** `gen-rung-types.mjs`
honours `RUNGS_CWD` and eject passes it. It previously derived its root from its
own file location, so a `--cwd` fork got a `generated.ts` declaring all five
rungs beside a `rungs.json` declaring one — and a manifest-driven UI checked
that way renders a *correct-looking* five-rung nav inside a one-rung fork.
Verified after the fix: fork `rungs.json` `["langchain"]`, fork `RUNG_IDS`
`["langchain"]`, source repo's `generated.ts` byte-identical afterwards.

That last one is worth remembering as a shape rather than a bug: it was a check
whose **subject** was the source repo, which is correct by construction. The
answer was right about the wrong thing.

## The general lessons these hazards taught — moved

Three sections used to sit here: the entrypoint guard, the biconditional-vs-count
rule, and the git-comparison artifacts. **None of them is about ejecting a fork.**
They were 54% of this document by volume and they were filed where only somebody
about to run an eject would find them — which is nobody writing the gate, the
assertion or the grep that each lesson is actually about.

They now live in **`docs/CHECKING-THE-CHECK.md`**, with the question that unifies
them: *what is this check's subject, and is it the same as the property's?*

## Related

- **`docs/CHECKING-THE-CHECK.md`** — the general discipline these hazards taught:
  a check that computed correctly and honestly, about the wrong subject. Read it
  before writing a gate, an assertion, or a grep you intend to trust.
- **`docs/TURBOPACK-DEV-CACHE.md`** — the other family of false REDs here: a
  stale dev-server cache making a correct tree look broken. Same lesson,
  different mechanism: **before believing a red, check whether the harness
  produced it.**
