# Autonomous loop: Blazing sandbox provider → Modal parity

## Mission

This repo is the reference Next.js application for LangChain, LangGraph, deepagents and
open-swe. Its sandbox provider (Blazing) must reach and prove parity with the Modal
provider, because "gold standard" means an integrator can swap backends and nothing about
their code changes.

**Premise corrected in iteration 1.** This file originally said "Modal is the reference
implementation". Verified 2026-07-21: there is **no Modal code in this repo**. The adapter
declares `SandboxProvider = "docker" | "blazing"` only.

So there are two distinct axes, and they must not be conflated:

- **Docker ↔ Blazing parity** — directly testable today, and the local definition of "swap
  backends and nothing changes". This is the cheaper, higher-confidence half.
- **Modal-surface parity** — measured against Modal's *published* sandbox API, since there
  is no local oracle. Every claim about "what Modal does" must cite a source, not a file.

Where behaviour differs on the second axis, Modal is right unless you can show otherwise
with evidence.

## Definition of done — all four, measurably

1. **Capability parity.** Every method on the adapter contract behaves identically across
   Modal and Blazing, including error types, timeout semantics, streaming chunk boundaries,
   and cleanup-on-failure.
2. **Validation parity.** Every capability has a test that runs against BOTH providers from
   the same test body. A provider-specific test is a gap, not a test.
3. **Failure parity.** For each failure mode (OOM, timeout, network loss, quota exhaustion,
   mid-stream disconnect), both providers surface the SAME typed error to the caller.
4. **Docs parity.** The setup guide gets an integrator from zero to a running agent on
   Blazing with no step that says "see Modal docs".

## Each iteration

1. Pick the highest-value unproven gap from `PARITY.md` (create it if absent).
2. Write the test FIRST, against both providers, and watch it fail for Blazing. **A test you
   did not see fail proves nothing.**
3. Close the gap in Blazing — not in the test, not in the adapter shim.
4. Run the full parity suite. Record numbers in `PARITY.md`: total capabilities, proven,
   unproven, known-divergent-with-reason.
5. Commit one gap per commit, with the evidence in the message.
6. Update this loop's stopping condition if you learned the target moved.

## Operating principles — these are checks, not aspirations

- **Broken-check test.** For every validation you add, ask *"if the thing under test were
  entirely absent, what would this print?"* If the answer is "pass" or "nothing", the check
  is worthless. Prove it fails first.
- **No suppression without classification.** Never `|| true`, `except: pass`, or
  `continue-on-error` next to a correctness claim. If you suppress an error you must
  classify it into a named bucket and act on the bucket.
- **Enumerate, don't assume the boundary.** Before claiming coverage of a surface, list it
  programmatically from the source of truth (the adapter interface, the provider SDK), not
  from the directory you expect it to live in.
- **N=1 proves nothing on a flaky signal.** If a check is known-flaky, a single pass is not
  evidence. Require consecutive passes and state how many.
- **Run the control first.** Before debugging a failure, check whether it reproduces on an
  unmodified tree. "My change broke it" is a reasonable prior, not a substitute for the
  thirty-second check.
- **Search all consumers.** When changing anything shared, grep for the symbol and fix every
  consumer. Never work from the list of things that happen to be failing.
- **Dry-run ≠ real run.** A passing plan or dry-run does not prove the executor holds the
  permissions, quota, or network access the real run will need.
- **Parse, don't grep** structured data (YAML, Python, JSON). Use the parser.
- **Comments asserting invariants get checked** against the code beneath them.
- **Know where output flows before printing.** Logs reach issues; issues are read by people
  who are not you. Never print secret values — only field paths.

## Guardrails — stop and ask

- Anything that spends money at a new order of magnitude.
- Anything that changes IAM, deletes cloud resources, or touches production data.
- Any change to the adapter's PUBLIC contract (i.e. that breaks integrators).
- If parity requires diverging from Modal, stop and present the tradeoff rather than
  choosing.

## Report every iteration, in this order

1. What is now **proven** that was not before (with the number).
2. What you found that **contradicts an earlier claim of yours**.
3. What is still **unproven**, and the specific next check for it.

Never report "done" for something you have only run once.

## Stop when

Definition-of-done 1–4 all hold AND the parity suite has passed N consecutive runs against
live providers. State N. If you cannot reach that, say precisely which capability blocks it
and why.

---

## Why these principles, specifically

They are not generic engineering virtues. Each was derived from a real failure during the
2026-07-20/21 IaC session, and the ones near the top cost the most:

- The **broken-check test** exists because five separate detectors were built that reported
  "clean" when they meant "I could not look" — missing PyYAML, an RBAC denial, an empty
  artifact download, an unreadable manifest, and a monitor whose absent check-line read as
  "settled".
- **No suppression without classification** exists because a `|| true` hid the fact that a
  `kubectl diff` review surface had been silently empty for the life of a PR, and an
  `except: pass` let a fail-closed gate certify RBAC coverage for a file it could not read.
- **Enumerate the boundary** exists because scanning only `k8s/` missed 36 manifest files in
  a top-level `control-plane/` tree, hiding 37 divergences and half the duplicate objects.
- **N=1** exists because a single green integration gate was reported as "the chain is
  confirmed", and it failed twice immediately afterwards.
- **Run the control first** exists because thirteen test failures were attributed to a
  refactor that had not caused them; the clean tree failed identically.
- **Dry-run ≠ real run** exists because a green `terraform plan` did not prove the applying
  identity held `iam.serviceAccounts.getIamPolicy`, and the apply 403'd on exactly that.
