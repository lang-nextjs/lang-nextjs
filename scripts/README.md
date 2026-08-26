# `scripts/` — the checkers, and the one rule they all follow

Everything here is **retained by every `pnpm eject`**. These files survive into a rung-1 fork, so
a checker that names a rung-owned path, or runs against one, breaks that fork. See
[`../CONTRIBUTING.md`](../CONTRIBUTING.md) → *"A guard eject cannot read is a guard eject does not
credit"*.

## Before you add a checker, read this

**[`../docs/CHECKING-THE-CHECK.md`](../docs/CHECKING-THE-CHECK.md)** — the reasoning, with the full
catalogue of what has actually gone wrong here.

The short version, because a pointer nobody follows is not a pointer:

> **A check must be able to fail, and you must have seen it fail.**

Nearly every defect this repo has recorded is one shape — *a check reporting a verdict it never
computed.* Not a wrong answer; **no answer**, in the format of a passing one:

| It printed | It had |
|---|---|
| `usage:` then exit 0 | never run — every guarded CI step silently skipped |
| `0 findings, exit 0` | no `shellcheck`, so **no shell was examined at all** |
| `no leaks found` | scanned **0 commits** |
| `already clean` | exited early through a symlinked path, over 237 findings |
| `census agrees` | enumerated nothing |
| `MUTATION SURVIVED` | a mutation that had become a no-op — the checker was fine |

## What a new checker owes

1. **A selftest that plants the defect** — `<stem>.selftest.mjs`, proving it *refuses* the bad
   input **and** *accepts* the good. Refusing everything is as useless as refusing nothing.
2. **A vacuity guard.** If your checker can run with no subject — a missing directory, an empty
   file list — it must exit **non-zero saying so**, never 0. `0 findings` and `nothing was
   examined` must not print the same thing.
3. **Both wired into a workflow.** `pnpm pairing` fails the build if a checker CI runs has no
   proof CI also runs, and it will tell you so by name.
4. **A case count the harness asserts** (`EXPECTED_CASES`), so a case that silently stops running
   is caught. A suite that quietly shrank still says PASS.

## Conventions worth copying

- **Print the subject.** `roots [apps/example, e2e]`, `1218 tracked files`, `20/20 cases`. A green
  that names what it covered is falsifiable; one that just says `ok` is not.
- **Fail closed.** When a checker cannot tell, it refuses. *"Cannot determine"* read as *"fine"* is
  the whole defect class above.
- **Distinguish failure modes in the message.** "No guard at all" and "a guard that does not
  branch" need different fixes; one message for both sends the reader looking for the wrong thing.
- **Do not discard stderr**, and **do not chain a verification into an irreversible step** — the
  verdict has to be read by a person before the next thing runs.
