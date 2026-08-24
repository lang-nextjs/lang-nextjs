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

```bash
# 1. throwaway worktree at HEAD — never eject in a tree you care about
git worktree add --detach /tmp/forkcheck HEAD
cd /tmp/forkcheck

# 2. copy your uncommitted files in, then STAGE THEM (see pitfall 2)
git add -A apps/example

# 3. eject IN PLACE. Not --cwd (see pitfall 4)
node scripts/eject.mjs langchain

# 4. install and BUILD PACKAGES (see pitfall 3)
pnpm install --frozen-lockfile --prefer-offline --ignore-scripts
pnpm --filter './packages/*' build

# 5. the actual checks
cd apps/example && pnpm exec tsc --noEmit
pnpm exec vitest run

# 6. clean up — a stray worktree is a shared-repo mutation
cd - && git worktree remove --force /tmp/forkcheck && git worktree prune
```

## Four pitfalls, all of which produce a convincing false RED

Each of these looks like a defect in `eject` or in your code. None is.

**1. `rm` instead of `git rm`.** `eject` enumerates **git-tracked** files. A path
that git tracks but is missing from disk crashes it with `ENOENT` —
and `eject` is **not atomic**, so it will already have deleted a hundred-plus
files before it dies, leaving a tree that is neither the original nor a fork.
The next run then refuses with *"classification is not clean — refusing to eject
against a stale census"*, naming files that exist at HEAD. That refusal is the
guard working correctly on damage the previous run caused. Use `git rm`.

**2. Untracked files are invisible to a git-based classifier.** Copy your new
files in without `git add` and `eject` treats every one as unclassified and
deletes it. The symptom is alarming and specific: *your* new files vanish while
files already committed survive. Nothing is misclassified — they were not
visible. `git add` first.

**3. A fresh worktree has no `packages/*/dist`.** Skip step 4 and `tsc` reports
**dozens of errors across twenty-plus files** — every `@deepagents-nextjs/*`
import unresolvable — none of them real. Build the packages before believing any
typecheck in a new tree.

**4. Do not pass `--cwd`.** `gen-rung-types.mjs` derives its root from its own
file location and ignores `cwd`, so the fork ends up with a `generated.ts`
declaring all five rungs while its `rungs.json` declares one. A manifest-driven
UI checked that way renders a *correct-looking* five-rung nav inside a one-rung
fork and proves nothing. Eject in place, in a throwaway.

## Related

`docs/TURBOPACK-DEV-CACHE.md` covers the other family of false REDs in this
repo — a stale turbopack cache making correctly-restored files look broken, and
`next build` clobbering a running `next dev`. Same lesson, different mechanism:
**before believing a red, check whether the harness produced it.**
