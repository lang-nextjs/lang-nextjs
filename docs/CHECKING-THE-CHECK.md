# Checking the check

**Every failure recorded here returned an accurate answer.** None of these checks
was buggy in the ordinary sense — they computed correctly and reported honestly.
They were looking at something other than what the reader believed they were
looking at, and nothing in the output said so.

That is why they are collected apart from the procedures that found them. A
procedure doc answers _"how do I do X safely"_; this one answers _"how do I know
my check checked anything"_, and the people who need it most are writing a gate
in `scripts/`, an assertion in a spec, or a one-off grep in a shell — none of
whom would think to open a document about ejecting a fork.

**The organising question, and the cheapest one to ask:**

> **What is this check's subject, and is it the same as the property's?**

It is the companion to _"what would make this check pass while the property is
still violated?"_ — asked about the **subject** rather than about the verdict.
The verdict question is asked about a subject you _assume_: it works when the
subject is in view and fails silently when it is not, because with the wrong
assumption it does not return "no answer", it returns confident reassurance.

A practical proxy, since nobody knows their assumptions are wrong: **is the
subject an explicit input you could vary?** If it is derived, ambient or
implicit, there is nothing to interrogate. **The first fix is usually to make the
subject a parameter, before asking any question about it.**

## The three respects

A check stands in for a property you actually care about. It can differ from that
property in three respects, and they are independent — a check can be wrong in
one while being right in the other two:

| respect        | the question                        | when it is wrong                               | the fix               |
| -------------- | ----------------------------------- | ---------------------------------------------- | --------------------- |
| **verdict**    | what counts as passing?             | it can pass while the property is violated     | rewrite the assertion |
| **subject**    | what is it looking at?              | it answers correctly about the wrong thing     | re-aim it             |
| **instrument** | what kind of answer can it produce? | the property is not in its output space at all | **change tools**      |

**Independent, not nested.** `grep` is the right instrument pointed at the wrong
file. A `git diff` between two correct endpoints is the right subject and the
wrong instrument — no choice of endpoints makes a diff report _existence_. You
do not reach the third by asking the first more carefully.

**Distinguishable without being separable.** The verdict question can reach all
three when it is asked with correct assumptions: _"what would make this diff
report 0 while the property is violated?"_ → _"the file is absent from both"_ is
an instrument error surfaced by the verdict question. The respects tell you
**which fix you need**, which is what a taxonomy is for; they are not three
separate tests to run in sequence.

**The degenerate case is the subject being nothing.** A check that does not run
has an empty subject and returns the verdict for it — which is why a script whose
entrypoint guard is broken reports clean on a directory holding 237 findings.
That is the same defect as every other row, at the limit.

**How we got here — the corrections, the reversals, who caught what — is in issue
#36.** That record is worth keeping and would be flattened by a document. This
file is what to do; the issue is how it was arrived at.

> **Caution on this document, and on #36.** An incomplete cause list does not
> degrade to a partial fix, it degrades to a discredited document. A reader who
> hits a cause that is not listed, applies the nearest listed fix, and still gets
> a wrong answer concludes the doc is wrong about the hazard rather than
> incomplete about its causes — and stops consulting it, losing the entries that
> were correct.
>
> **So, on hitting a cause that is not listed here:** the organising question
> above still applies even when no row matches — ask what your check's subject
> is, and whether the property is in your instrument's output space at all. Then
> **add the row.** This list is the instances we have hit, not the instances that
> exist.

---

## The entrypoint guard is part of the check

**Respect: subject — the degenerate case.** The check did not run, so its
subject was empty and it returned the verdict for nothing at all.

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
    return (
      realpathSync(fileURLToPath(import.meta.url)) ===
      realpathSync(process.argv[1])
    );
  } catch {
    return false;
  }
}
```

**Cover it by spawning the file, through a symlink, on a planted violation, and
asserting a non-zero exit AND non-empty output.** Exit code alone is not enough:
the broken guard's failure mode _is_ a zero exit, so a test that only checks
"exit 0 on clean input" passes against it.

This was the third gate in one night that could return a verdict it never
computed — the other two were an `existsSync` filter that hid an
index/worktree divergence from eject's own verify, and a perf config where
erroring on a 404 looked like a passing check. **All three were written by
people actively hunting that exact defect.** Assume yours has one.

## Zero is a real answer — and say exactly when

**Respects: subject, then verdict.** A loop over an empty slice has no subject
and asserts nothing. A count that _is_ non-vacuous can still be too weak a
verdict, because it passes on compensating errors. Two different faults in one
section, which is why the fix differs between halves.

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

Both are non-vacuous at zero rungs. Only the second is non-vacuous at _every_
rung count, including one — which is the case a single-rung fork actually is.

## A zero the query could never have avoided

**Respects: instrument, then subject.** The section above is about a check whose
subject is empty — a real answer about nothing. This one is about a query that
cannot return anything but zero **for any input at all**. The property is not in
the instrument's output space, which is the third row of the table: no amount of
re-aiming helps, because the pattern is not asking a narrower question, it is
asking one with no possible answer.

It is worth separating because the two need different remedies. A pattern with
the wrong **scope** is caught by re-reading it against the question — you look at
it and see that it asks something narrower than you meant. A pattern that cannot
match looks **correct** on re-reading; the error is in a dialect rule you would
have to already suspect. Re-reading is not a remedy for it. Running it is.

### Four dialects, and the shell's `grep` is not the system's

The structural fact, and the whole reason this happens: several regular-expression
dialects are in daily use in this repository, and a pattern behaves differently
across them. Measured on macOS 26.6.2 (Darwin 25.6.0), git 2.50.1 (Apple
Git-155), BSD grep 2.6.0-FreeBSD, ugrep 7.8.4, Node v22.22.2:

| dialect                                   | `\s`              | `(2)`   |
| ----------------------------------------- | ----------------- | ------- |
| `git grep -E` — strict POSIX ERE          | **not an escape** | a group |
| `/usr/bin/grep -E` — BSD grep             | accepted          | a group |
| `grep` in this shell — **ugrep**          | accepted          | a group |
| JS `RegExp` — every checker in `scripts/` | accepted          | a group |

Two traps, and they fail in opposite ways. **`\s` varies**, so a pattern that
works in one tool silently matches nothing in another:

```
printf 'x || true\n' > ok.txt
grep -qE '\|\|\s*true'  ok.txt          # exit 0 — matched
git grep -qE '\|\|\s*true' -- ok.txt    # exit 1 — CANNOT match, same pattern, same file
```

**Parentheses are a group in all four**, which is worse, because uniformity is
what makes it believable. `/process\.exit(2)/` does not match `process.exit(2)`
in any of them — it matches `process.exit2`, a string that does not occur. That
is a JS regex, so it is as true inside a checker in `scripts/` as at a shell
prompt. On any file containing the literal — `scripts/assert-formatted.mjs` is
one — `grep -cF 'process.exit(2)'` and `grep -cE 'process\.exit(2)'` disagree,
and the ERE side reports **0**.

The count is deliberately not quoted here. It was measured as 3 on one branch and
2 on `main` an hour later, and a number that depends on which tree you are
standing in is the kind of claim this document is about — the ratio is the
finding, not the magnitude.

Note also that `grep` is not necessarily `/usr/bin/grep`: in this shell it
resolves to ugrep. "Which grep" is a question with a per-shell answer, so quoting
a result without saying which tool produced it is already ambiguous.

### The control: run the pattern against something you know contains the thing

Before believing any zero, spell the pattern **in the dialect that produced the
zero** and point it at a subject that certainly contains the target. Read the
**exit status** rather than inferring from `&&`/`||`, which conflates grep's 1
with everything above it:

```bash
git grep -qE "$PATTERN" -- known-good.txt; rc=$?
case $rc in
  0) echo "evidence — the pattern CAN match" ;;
  1) echo "CANNOT MATCH its own subject — a zero from it means nothing" ;;
  *) echo "COULD NOT RUN (exit $rc) — not a verdict about the pattern at all" ;;
esac
```

**Keep a known-good pattern alongside the known-bad one, because the status does
not cover everything it looks like it covers.** Measured:

| situation                              | exit | distinguishable? |
| -------------------------------------- | ---- | ---------------- |
| pathspec exists, pattern matches       | 0    | yes              |
| pathspec exists, pattern cannot match  | 1    | yes              |
| pathspec **mistyped**, inside the repo | 1    | **no**           |
| pathspec outside the repository        | 128  | yes              |
| not a git repository at all            | 128  | yes              |

A mistyped filename inside the repository returns a clean **1** — identical to
"the pattern cannot match", with nothing anomalous in the status. So exit status
covers _could not run at all_; it does **not** cover a wrong subject, and a
mistyped path is the ordinary way to get one. The known-good arm is what reveals
it: if the pattern you know is correct also fails to say "evidence", the fixture
is wrong rather than the pattern. Neither check subsumes the other.

The control therefore has the same structure as the thing it is checking — an
absence claim that needs a presence companion, and a status that has to be read
rather than inferred. That is not a coincidence; it is why building the control
carelessly reproduces the defect one level up.

**The reason a zero is worth this much care:** it is the shape of good news for a
presence check ("no violations") and of bad news for a claim check ("the code
does not do what you said"). In both directions it reads as an answer, and
nothing downstream ever re-derives it.

## The comparison you reach for answers a different question

**Respects: subject, then instrument.** The two-dot artifact is a subject error —
the right tool between the wrong pair of commits. The post-squash case is an
instrument error: both subjects were defensible and no diff can report existence.
That is why reaching for a third dot-count keeps you wrong.

Twice in one session a `git diff` reported catastrophic deletions. **One was real
and one was an artifact, and they looked identical.**

```
ARCHITECT:  branch was genuinely 434 deletions behind          REAL
DEV6:       "1156 deletions" including PALETTE-EXCEPTION.md,
            TestingCard.tsx, payload-triangulation.mjs —
            files that branch had never touched                ARTIFACT
```

The artifact came from `git diff --stat origin/main..my-branch`. A **two-dot**
diff compares two endpoints, so every file `main` gained _after_ the branch
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
because staged reversions and staged edits render the same.

### "Just rebase" is not the fix, and a plain rebase is its own version of this

The advice this section used to end with — _rebase, or `commit --amend` after
adding_ — is **wrong after a squash merge**, which is how this repository merges
everything.

A squash-merged branch shares **no commits** with `main`, while its content is
already there. So `git rebase origin/main` finds a merge-base far back and
**replays commits whose changes main already has**. You get conflicts on every
file two PRs touched, and "resolving" them means re-applying work that landed
hours ago under someone else's name.

```
git rebase origin/main                          # replays everything since the fork point
git rebase --onto origin/main <your-old-base>    # replays only YOUR commits
```

**Always name the old base.** Then verify by counting, not by feeling:

```
git rev-list --count origin/main..HEAD    # must equal the number of commits you wrote
```

Measured instances from a single session: a branch that should have replayed 1
commit tried to replay 6; another tried to replay 9 and would have re-applied a
whole merged PR's diff. Both were caught by the count, not by reading the diff.

**And ancestry lies about a squash-merged base.** `git merge-base --is-ancestor`
says NO while the content is demonstrably on main, so a branch can be
simultaneously "fully merged" and "not an ancestor". Verify a merge by CONTENT —
grep for a symbol the change introduced — never by ancestry.

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

_(Found by DEV7 after the section above was written: they had confirmed a
"deleting 221 lines" claim as fact, and checking it three ways showed the branch
had no unique commits at all. The indistinguishability is not hypothetical — it
has already cost a reader who repeated a number instead of running the
comparison.)_

## A wrong answer that hands you a task

<!-- doc-claims:cite -->

**Respect: subject.** The check answered correctly about a subject it invented.

Verifying that this document's cross-references resolved, a five-line loop:

```bash
for f in $(grep -ohE 'docs/[A-Z-]+\.md' docs/*.md | sort -u); do
  [ -f "$f" ] && echo ok || echo "*** BROKEN LINK ***"
done
```

reported `docs/LOCAL-AGENT.md` broken. **It was not.** The only reference is to
`apps/open-swe/docs/LOCAL-AGENT.md`, which exists. The regex matched the **tail**
of that path, and the loop then asked whether a file at a path nobody had written
existed. It does not. The answer was correct; the question was about a subject
the checker had constructed.

**This is the more dangerous shape, and it is worth separating from the others
here.** A check with an empty subject returns an empty result, and an empty
result at least invites _"should this be empty?"_. This one **named a specific
file to go repair.** It converted a non-problem into a work item with an address,
and the work would have looked justified from start to finish — you would edit a
correct link, the checker would go green, and the green would be evidence.

It is the same direction as a baseline that is wrong toward red: it does not
merely fail to find real problems, it **invites you to fix code that was never
broken**. See `docs/TURBOPACK-DEV-CACHE.md`, where an e2e baseline wrong by four
specs did exactly that.

**The tell was the same one that catches most of these: the result did not match
what the subject should have contained.** Nothing in the repo references a bare
`docs/LOCAL-AGENT.md`, so a checker reporting on one was reporting on something
it had made up. Checking _what the check enumerated_, rather than only what it
concluded, is the cheap move — and it is the same move as looking at a control.

**And the obvious fix does not fix it.** Widening the regex to require full
paths stops it matching tails — and it still reports this very section as a
broken link, because the paragraphs above _quote_ `docs/LOCAL-AGENT.md` while
explaining that no such file exists. The checker's subject was never "tails
versus full paths." It is **"strings that look like paths"**, and that is not the
same set as **"links this document asserts."** A quotation of a non-existent path
is indistinguishable from a claim about an existing one, to a checker that reads
neither.

Which is the general lesson rather than a footnote: **narrowing a pattern is not
the same as correcting a subject.** The first makes the wrong subject smaller;
only the second makes it the right one. A link checker whose subject is actually
links has to know what a link _is_ in the format it is reading — and if that is
more than you want to build, the honest move is to say the check is advisory and
read its output, not to tighten the regex until the current file passes.

Written in five lines while assembling this document, about this failure.

<!-- /doc-claims:cite -->

## Related

Two task-side hazard documents, kept separate on purpose — a warning belongs
where the tool is, not where the essay is:

- **`docs/VERIFYING-IN-A-FORK.md`** — verifying a change survives `pnpm eject`.
  Where the subject question bites as _"which tree am I actually verifying?"_
- **`docs/TURBOPACK-DEV-CACHE.md`** — false REDs from a stale dev-server cache,
  where a correct tree looks broken. Note its status-code loop carries its own
  caveat inline: the loop reports all-200 on the inert-hydration case and tells
  you nothing. That caveat stays beside the loop.
