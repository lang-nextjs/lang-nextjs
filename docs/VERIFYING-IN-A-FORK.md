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

## Related

`docs/TURBOPACK-DEV-CACHE.md` covers the other family of false REDs in this
repo — a stale turbopack cache making correctly-restored files look broken, and
`next build` clobbering a running `next dev`. Same lesson, different mechanism:
**before believing a red, check whether the harness produced it.**
