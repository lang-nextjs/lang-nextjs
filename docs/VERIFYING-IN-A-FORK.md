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

## The entrypoint guard is part of the check

A checker is two things: the logic, and the branch that decides to run it. **The
second one can fail silently, and a selftest that imports the logic directly
will never touch it.**

This is not hypothetical. `scripts/check-palette.mjs` shipped with:

```js
if (import.meta.url === `file://${process.argv[1]}`) { ... }   // BROKEN
```

`import.meta.url` is realpath-resolved; `process.argv[1]` is not. One symlink in
the invoking path — `/tmp` → `/private/tmp` on macOS is enough — and the
comparison is false, `main()` never runs, and node exits **0 with no output at
all**. In a CI log that is a step that passed with nothing in it. It was
reported as a clean result on a directory holding 237 findings.

```js
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}
```

**Cover it by spawning the file, through a symlink, on a planted violation, and
asserting a non-zero exit AND non-empty output.** Exit code alone is not enough:
the broken guard's failure mode *is* a zero exit, so a test that only checks
"exit 0 on clean input" passes against it.

This was the third gate in one night that could return a verdict it never
computed — the other two were an `existsSync` filter that hid an
index/worktree divergence from eject's own verify, and a perf config where
erroring on a 404 looked like a passing check. **All three were written by
people actively hunting that exact defect.** Assume yours has one.

## Zero is a real answer — and say exactly when

The fork rules above ("derive the expected side from the manifest, or filter by
presence") have a sharper general form worth stating as a biconditional:

> `rungHref(rung)` returns null **exactly when** the rung has no target.

Not "returns null when something is wrong". Both directions are the assertion:
a rung with a target must never yield null, and a rung without one must never
yield a string. Written that way, an implementation that returns null on an
internal error fails the test, and so does one that invents a plausible href for
a rung the manifest says has no target. Written as a one-way "planned rungs have
no link", both bugs slip through.

The same shape applies anywhere a fork legitimately reduces a count to zero:
assert the count the code produced **equals** the count the manifest declares.
At zero that is still a real assertion — it says the code invented nothing —
whereas a bare loop over an empty slice asserts nothing at all and reports green.

**The two forms are not interchangeable, and the count is the weaker one.** A
count is aggregate, so it passes on compensating errors: one rung wrongly
yielding null and another wrongly yielding an href leaves the total unchanged
and the assertion green. The biconditional is per-element and cannot be
satisfied that way — every rung has to be right on both directions
independently. Use the count where the property genuinely is about a quantity;
use the biconditional where it is about a correspondence, which is most of the
time.

A worked pair, so the difference is concrete:

```ts
// aggregate — passes if two rungs are wrong in opposite directions
expect(items.filter((i) => i.href === null)).toHaveLength(
  RUNGS.filter((r) => r.target.kind === "none").length
);

// per-element — cannot be satisfied by compensating errors
for (const r of RUNGS) {
  expect(rungHref(r) === null).toBe(r.target.kind === "none");
}
```

Both are non-vacuous at zero rungs. Only the second is non-vacuous at *every*
rung count, including one — which is the case a single-rung fork actually is.

## The comparison you reach for answers a different question

Twice in one session a `git diff` reported catastrophic deletions. **One was real
and one was an artifact, and they looked identical.**

```
ARCHITECT:  branch was genuinely 434 deletions behind          REAL
DEV6:       "1156 deletions" including PALETTE-EXCEPTION.md,
            TestingCard.tsx, payload-triangulation.mjs —
            files that branch had never touched                ARTIFACT
```

The artifact came from `git diff --stat origin/main..my-branch`. A **two-dot**
diff compares two endpoints, so every file `main` gained *after* the branch
started shows up as something the branch deleted. Nothing was wrong. The PR's
real content was 485 insertions and 20 deletions across 12 files.

**What a PR actually changes is measured from the merge base:**

```bash
# what your PR does
git diff $(git merge-base origin/main HEAD)..HEAD --stat
git diff origin/main...HEAD --stat        # three dots — same thing

# NOT this: it also reports everything main gained since you branched
git diff origin/main..HEAD --stat         # two dots
```

The same shape bites `git reset --soft origin/main` used as a squash. Against a
base that has moved, it does not squash your commits — **it stages a tree that
reverts everyone else's merged work**, and `git status` looks entirely normal
because staged reversions and staged edits render the same. Rebase, or
`commit --amend` after adding, but do not reset against a ref you have not just
rebased onto.

**The rule is not "sanity-check the number".** A reader who pattern-matches
1156-looks-wrong gets ARCHITECT's real 434 wrong in the other direction. The rule
is to run the comparison that answers the question you are asking — and to know
which one that is before you read the output.

### And sometimes no comparison answers it

After a **squash merge**, "did my work land?" stops being a question about the
relationship between two commits, because the squash severed that relationship.
Both diffs then lie, in opposite directions. Measured on `feat/6-shell-nav`
after #70 was squash-merged:

```
git diff origin/main...BRANCH    20 files, 1270 insertions
                                 → "my work is NOT on main"        FALSE
git diff origin/main..BRANCH     278 files, 52793 deletions
                                 → "my branch deletes half the repo"  FALSE
```

The three-dot form is wrong because the squash moved the merge base, so landed
work reads as unlanded. The two-dot form is wrong because the branch is behind,
so main's newer files read as deletions. **Reaching for a third dot-count keeps
you wrong.**

The question is answered by looking for the artifacts, not by diffing:

```bash
git cat-file -e origin/main:apps/example/app/r/\[rung\]/page.tsx && echo present
grep -c 'data-status' e2e/shared/nextjs.spec.ts
```

That is a different **kind** of check, not a different diff. When the history has
been rewritten under you — squash, rebase, force-push — ask what exists, not what
changed.

*(Found by DEV7 after the section above was written: they had confirmed a
"deleting 221 lines" claim as fact, and checking it three ways showed the branch
had no unique commits at all. The indistinguishability is not hypothetical — it
has already cost a reader who repeated a number instead of running the
comparison.)*

## Related

`docs/TURBOPACK-DEV-CACHE.md` covers the other family of false REDs in this
repo — a stale turbopack cache making correctly-restored files look broken, and
`next build` clobbering a running `next dev`. Same lesson, different mechanism:
**before believing a red, check whether the harness produced it.**
