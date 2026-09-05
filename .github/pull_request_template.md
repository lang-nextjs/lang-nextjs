Closes #

<!-- ⚠️ NAMING ANOTHER ISSUE TO SAY IT IS *NOT* CLOSED WILL CLOSE IT.
     GitHub's parser matches a closing keyword followed by a number and DOES NOT
     UNDERSTAND NEGATION. A PR body reading "Closing this does not close <number>"
     closed that issue — written by an author who added the sentence specifically
     to prevent it.

     A closed issue is invisible to the board, so the work is then counted as done
     while its subject is untouched: an absence rendered as a presence, in the
     tracker instead of the code.

     Safe ways to reference an issue you are NOT closing:
         see issue 126 / related: issue 126     (no closing keyword adjacent)
         a bare number with no keyword anywhere near it
     Unsafe, even inside a negation, a quote, or a code fence — any of
     close/closes/closed/fix/fixes/fixed/resolve/resolves/resolved followed by
     ANY of these three reference forms:
         #<number>
         GH-<number>                            (yes, this closes too)
         a full https://github.com/... issue URL
     The keyword is what arms it. The reference form does not matter.

     NOTE the examples above deliberately avoid writing a live reference, because
     an example inside this comment would be parsed the same way if you leave the
     comment in place. -->

## What changed

<!-- One paragraph. What is different afterwards, not a list of files. -->

## What you measured

<!-- The commands and their OUTPUT. A body that states a command and its result is
     reviewable; one that asserts a property is not.

     If you added or changed a check: show it FAILING on planted input as well as
     passing on clean input. A check that has only been seen to pass has not been
     seen to work.

     If you mutation-tested and something escaped, list it. A table showing only
     successes is the failure mode this repo keeps finding. -->

```

```

## Severability

<!-- Delete if this touches no rung-owned or shared path.

     - Does a retained file now name a rung-owned app? It needs a has-rung.mjs
       guard on an `if` line within 25 lines — a `[ -d ... ]` test is correct at
       runtime and eject refuses it anyway.
     - Did file counts or shared-glob membership move? `pnpm rungs:freeze` and
       `pnpm census:freeze` write DIFFERENT artifacts. Read the failure first;
       a C4 "matched zero tracked files" is a glob entry, not a count.
     - `pnpm test:eject` reads its sandbox from HEAD. Commit before running it. -->

- [ ] `pnpm test:eject` run **after committing**
- [ ] `pnpm rungs` / `pnpm census` clean, and anything re-frozen is explained above

## Checklist

- [ ] Branched from current `main` (not a long-lived branch over files others are editing)
- [ ] One concern; files staged explicitly rather than with `git add -A`
- [ ] `pnpm typecheck && pnpm build && pnpm test` pass
