# Checking the check

**Every failure recorded here returned an accurate answer.** None of these checks
was buggy in the ordinary sense — they computed correctly and reported honestly.
They were looking at something other than what the reader believed they were
looking at, and nothing in the output said so.

That is why they are collected apart from the procedures that found them. A
procedure doc answers *"how do I do X safely"*; this one answers *"how do I know
my check checked anything"*, and the people who need it most are writing a gate
in `scripts/`, an assertion in a spec, or a one-off grep in a shell — none of
whom would think to open a document about ejecting a fork.

**The organising question, and the cheapest one to ask:**

> **What is this check's subject, and is it the same as the property's?**

It is the companion to *"what would make this check pass while the property is
still violated?"* — asked about the **subject** rather than about the verdict.
The verdict question is asked about a subject you *assume*: it works when the
subject is in view and fails silently when it is not, because with the wrong
assumption it does not return "no answer", it returns confident reassurance.

A practical proxy, since nobody knows their assumptions are wrong: **is the
subject an explicit input you could vary?** If it is derived, ambient or
implicit, there is nothing to interrogate. **The first fix is usually to make the
subject a parameter, before asking any question about it.**

The fuller taxonomy — the three *respects* in which a check can differ from the
property it stands for (what counts as passing, what it looks at, what kind of
answer it can produce) — lives in issue #36. This document is the worked
instances.

> **Caution on this document, and on #36.** An incomplete cause list does not
> degrade to a partial fix, it degrades to a discredited document. A reader who
> hits a cause that is not listed, applies the nearest listed fix, and still gets
> a wrong answer concludes the doc is wrong about the hazard rather than
> incomplete about its causes — and stops consulting it, losing the entries that
> were correct. Add rows when you find them.

---

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

Two task-side hazard documents, kept separate on purpose — a warning belongs
where the tool is, not where the essay is:

- **`docs/VERIFYING-IN-A-FORK.md`** — verifying a change survives `pnpm eject`.
  Where the subject question bites as *"which tree am I actually verifying?"*
- **`docs/TURBOPACK-DEV-CACHE.md`** — false REDs from a stale dev-server cache,
  where a correct tree looks broken. Note its status-code loop carries its own
  caveat inline: the loop reports all-200 on the inert-hydration case and tells
  you nothing. That caveat stays beside the loop.
