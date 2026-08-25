Closes #

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
