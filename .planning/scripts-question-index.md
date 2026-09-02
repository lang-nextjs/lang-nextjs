# What `scripts/` already knows — an index by question

Snapshot of 84 non-selftest scripts, taken on the `feat/664-verdict-run-length`
branch at `ba4e4d88`. **Two entries — `verdict-streak.mjs` and
`assert-error-frame-contract.mjs` — do not exist on `main` yet**; they arrive with #670.
Marked rather than removed, because an index that quietly dropped them would be making
the same silent-narrowing move it exists to catch. **Every description below is a verbatim
quote of the file's own opening claim**, extracted mechanically, not a summary written
from the filename. That matters: an index whose entries were inferred from names would
reproduce the exact defect it exists to prevent.

## Why this exists

In one night, four things were re-derived that were already written down here:

| Re-derived | Already in |
|---|---|
| "the number that separates flaky from broken is the STREAK, not the rate" | `measure-push-only-jobs.mjs` header, with a worked outage-adjusted recount over #530's 35 reds |
| "job conclusions cannot measure the mocked tail" | `measure-e2e-flake.mjs` header, opening paragraph, with the 2%-vs-34% split |
| "a verdict whose subject is not what its name says" | #328, quoted in `assertion-vacuity-sweep.mjs`: *"the SUBJECT of a check drifted from the subject its reader assumed, and nothing failed"* |
| "unanchored testMatch claims specs by substring" | `assert-testmatch-anchored.mjs`, which cites the very issue that prompted the re-derivation |

Three different sessions reached past the same directory. **That is not four people
being careless — it is 84 files of dense reasoning with no way to ask "who already
answered this?"** These headers are organised by *what the checker does*. Nobody asking
"how do I tell a flaky job from a broken one?" would think to open a file called
`measure-push-only-jobs.mjs`.

## How to use it

Skim the question headings before starting an investigation, not after. Two entries here
are **measuring instruments rather than gates** — `measure-push-only-jobs.mjs` and
`measure-e2e-flake.mjs` — deliberately outside `checks.json` because they need the
network and a token. They are the two most likely to be re-derived, precisely because
nothing runs them.

## Staleness

This is a SNAPSHOT and it will rot. It is not wired into CI, so nothing makes it true
tomorrow. Regenerate by extracting the first block comment of each `scripts/*.mjs` and
`*.sh`, taking the first sentence. If an entry disagrees with the file, **the file is
right** — and the disagreement is the useful signal.

## Is this check actually checking anything?

*The question behind #328. Four of these were written after a check was found green over nothing.*

- **`assertion-vacuity-sweep.mjs`** — SWEEP FOR CHECKS THAT CAN GO QUIET WITHOUT GOING RED (#328).
- **`assert-checker-proof-pairing.mjs`** — Property: EVERY CHECKER CI RUNS HAS A PROOF THAT IT CAN FAIL, AND CI RUNS THAT PROOF.
- **`assert-no-silent-skips.mjs`** — a test that never runs anywhere must say why, in writing.
- **`assert-ismain-guards-resolve.mjs`** — NO SCRIPT MAY DECIDE "AM I THE PROGRAM?" BY COMPARING A RESOLVED PATH TO AN UNRESOLVED ONE (#631).
- **`assert-no-verdict-destroying-pipelines.mjs`** — Property: NO SHELL IN THIS REPO DISCARDS THE VERDICT IT EXISTS TO REPORT.
- **`check-swallowed-test-evidence.mjs`** — EVIDENCE A TEST PRINTS ON THE SUCCESS PATH IS NEVER SEEN (#456).
- **`assert-fixture-premises.mjs`** — Property: A FIXTURE THAT PLANTS INTO A DIRECTORY-GLOB-OWNED LOCATION ASSERTS THAT OWNERSHIP.
- **`assert-single-instance.mjs`** — RCT-04's second half: no duplicate module instances.

## Is this red mine, or someone else's, or nobody's?

*The live-CI attribution family. Read these BEFORE quoting any CI rate.*

- **`classify-live-failure.mjs`** — PRESENT AN UPSTREAM OUTAGE DIFFERENTLY FROM A TRANSPORT DEFECT (#400 step 1).
- **`live-transport-with-retry.sh`** — # THE RETRY POLICY, IN ONE PLACE THAT CI RUNS AND A TEST EXERCISES (#400 step 2).
- **`measure-push-only-jobs.mjs`** — Property measured, not asserted: HOW LONG DOES A RED SURVIVE ON A JOB NOBODY WATCHES.
- **`measure-e2e-flake.mjs`** — Measure how often E2E tests flake, and partition the occurrences.
- **`verdict-streak.mjs`** — ON A RED, SAY WHETHER IT IS THE SIXTEENTH OF THE SAME EXTERNAL CAUSE OR THE FIRST OF A NEW ONE (#664).
- **`check-live-log-artifact.mjs`** — THE CLASSIFIER'S INPUT IS PRESERVED, AND THE PATH IT IS WRITTEN TO IS THE PATH THAT GETS COLLECTED (#440).
- **`assert-verdict-tokens-disjoint.mjs`** — a fixture's verdict must never be readable as a real one.
- **`attach-owner.mjs`** — map an HTML report's attachments back to the tests that produced them.

## Do these two declarations still agree?

*Every one of these exists because two sides of something drifted silently.*

- **`check-cors-parity.mjs`** — ONE CORS ALLOWLIST, THREE BACKENDS, ASSERTED (#349).
- **`check-run-axes-parity.mjs`** — Both runtimes record what a run IS, identically (#118, #171).
- **`assert-error-frame-contract.mjs`** — THE EMITTER AND THE CLASSIFIER STILL AGREE (#664).
- **`assert-required-contexts-match-jobs.mjs`** — branch protection's required-context list and the jobs that produce those contexts must be THE SAME SET, in both directions.
- **`assert-workflow-event-matrix.mjs`** — WHICH JOBS RUN ON WHICH EVENTS — E2E-05 AND CI-01, ASSERTED (#E2E-05, #CI-01).
- **`assert-parity-tsconfig-pairing.mjs`** — Property: A PACKAGE'S `exclude` AND ITS PARITY PROGRAM'S `include` NAME THE SAME FILES.
- **`assert-board-declarations-agree.mjs`** — the `v2.0-reference` LABEL and the `v2.0` MILESTONE are two declarations of one fact, and this asserts they agree (#410).
- **`assert-readme-vocabulary.mjs`** — the README's vocabulary table names exactly the fields the published type has.
- **`assert-graph-id-fixture-agreement.mjs`** — RUNG 4'S MULTI-GRAPH FIXTURE AND RUNG 5'S REAL GRAPHS STAY IN STEP (#454).

## Did my search or my coverage actually cover it?

*The totality family — the answer to 'I grepped and found nothing'.*

- **`census.mjs`** — freeze WHICH FILES fall under a shared glob, so a new arrival needs a human.
- **`assert-census-fresh.mjs`** — Will this branch's census still be true AFTER it merges? (#145) `ownedFileCount` describes the tree the branch BECOMES, not the branch — so a number that is correct on the branch c
- **`assert-coverage-follows-the-surface.mjs`** — a SHARED surface must not be covered only by tests that leave with a rung.
- **`assert-e2e-partition.mjs`** — Property: WHICH PROJECT RUNS WHICH SPEC IS DECLARED, AND WHAT RUNS MATCHES THE DECLARATION.
- **`check-e2e-registration.mjs`** — Property: EVERY e2e SPEC IS ACTUALLY RUN BY SOME PROJECT, AND EVERY PROJECT ACTUALLY RUNS SOMETHING.
- **`assert-testmatch-anchored.mjs`** — Property: EVERY `testMatch` PATTERN IS ANCHORED AT BOTH ENDS.
- **`assert-scan-exclusions-justified.mjs`** — EVERY THING THE SECURITY SCAN DOES NOT LOOK AT MUST SAY WHY (#632).
- **`check-discriminant-guards.mjs`** — EVERY MANIFEST DISCRIMINANT HAS A COVERAGE DECISION, AND THE DECISIONS ARE VISIBLE (#425).
- **`assert-barrel-covers-type-exports.mjs`** — every module's TYPE-ONLY exports reach the barrel.

## Did the merge or the revert quietly lose something?

- **`assert-merge-keeps-registrations.mjs`** — a merge must not lose a registration either parent had.
- **`assert-census-fresh-on-merge.mjs`** — ask the freshness question where the union first exists.
- **`assert-no-undeclared-reverts.mjs`** — a branch must not silently undo work that is already in its own base.

## Will a fork that drops rungs still work?

- **`assert-severance-removes-rungs.mjs`** — Property: EVERY RUNG THE FORK DOES NOT RETAIN IS ABSENT FROM IT, BY NAME AND BY COUNT.
- **`assert-every-rung-is-witnessed.mjs`** — Property: EVERY RUNG ABOVE THE FLOOR IS REMOVED BY AT LEAST ONE SEVERABILITY CELL.
- **`assert-no-manifest-rung-coupling.mjs`** — Property: A SHARED FILE MUST NOT INDEX A GENERATED MANIFEST MAP WITH A RUNG ID THAT A FORK CAN REMOVE.
- **`assert-no-missing-workspace-invocations.mjs`** — Fork property: NO RETAINED CI STEP OR SCRIPT INVOKES A WORKSPACE THIS TREE DOES NOT HAVE.
- **`assert-fork-python-imports-resolve.mjs`** — every local Python import in this tree resolves to a file this tree still has.
- **`assert-dev-planes-startable.mjs`** — EVERY RUNTIME THE MANIFEST DECLARES MUST BE ONE `pnpm dev` CAN START (#633).

## Does the documentation still describe the code?

- **`check-doc-claims.mjs`** — THE RUNG DOCS ASSERT MEASURABLE FACTS. THIS RE-MEASURES THEM (#364).
- **`assert-readme-quickstart.mjs`** — Property: EVERY SYMBOL A PACKAGE'S README QUICK START TELLS A READER TO IMPORT ACTUALLY EXISTS IN THAT PACKAGE'S PUBLISHED SURFACE.
- **`assert-graph-list-doc-claim.mjs`** — THE DOCS THAT ENUMERATE UPSTREAM'S GRAPHS ARE RE-MEASURED AGAINST UPSTREAM (#468).
- **`assert-behavioural-evidence.mjs`** — Property: A BEHAVIOURAL REQUIREMENT IS NOT SATISFIED BY EVIDENCE THAT ONLY DESCRIBES SURFACE.

## The remaining 37, ungrouped

Not less useful — just not yet sorted by the question they answer.

- `assert-build-order.mjs` — PKG-01: BUILD ORDER IS ENFORCED, NOT MERELY DECLARED.
- `assert-dist-clean.sh` — # assert-dist-clean.sh — assert that a built artifact does NOT import a forbidden module.
- `assert-example-approval-policy-covers-tools.mjs` — THE EXAMPLE APP'S TOOL CLASSIFICATION IS TOTAL OVER THE BACKEND'S REAL TOOLS (#653).
- `assert-formatted.mjs` — EVERY FILE A BRANCH TOUCHES IS FORMATTED — SCOPED TO THE CHANGE, NOT THE TREE (#463).
- `assert-no-install-blocking-paths.mjs` — NOTHING IN THE TREE MAKES A FRESH CHECKOUT FAIL BEFORE ANY TEST RUNS (#585).
- `assert-no-overbroad-route-stubs.mjs` — Property: A ROUTE STUB MATCHES EXACTLY ONE REAL ENDPOINT.
- `assert-overrides-cannot-go-inert.mjs` — a dependency override must not carry a version selector, because a selector is what lets an override silently stop applying.
- `assert-playwright-leaves-history-intact.mjs` — Property: RUNNING PLAYWRIGHT UNDER CI DOES NOT SHALLOW-FLAG THE WORKSPACE.
- `assert-rung5-security-patches.mjs` — RUNG 5'S SECURITY PATCHES, ENFORCED CONTINUOUSLY RATHER THAN HISTORICALLY (#86).
- `budgeted-routes.mjs` — WHICH ROUTES CARRY A PERFORMANCE BUDGET — and the proof that they may.
- `check-github-reporter.mjs` — Property: CI'S PLAYWRIGHT RUNS EMIT ANNOTATIONS THAT NAME THE FAILING TEST.
- `check-langfuse-wiring.mjs` — Assert every LLM/graph invocation site in BOTH Python backends passes `config=langfuse_config()`.
- `check-palette.mjs` — Fail if a themed surface hardcodes a Tailwind palette colour.
- `check-pr-triggers.mjs` — CHECK: no workflow may filter `pull_request` on the BASE branch.
- `check-topologies.mjs` — Fail if a rung's declared topologies disagree with the module that serves them.
- `check-visual-baselines.mjs` — Committed Playwright baselines must be for the platform that READS them (#125).
- `ci-completion.mjs` — "Job X passes on main" — computed over runs that actually reported.
- `classify.mjs` — CHECK-1: every tracked file is owned by exactly one rung, or is shared.
- `dev-all.sh` — # ONE COMMAND. Everything up, secrets read where they already are.
- `dev-demo.sh` — # One-command launcher for the Lang-Next.js demo.
- `dev-hold-decision.sh` — # Should dev-all.sh stay in the foreground, or exit and leave things running? hold — there are background SHELL JOBS to wait on; Ctrl-C is meaningful exit — nothing this shell owns
- `diagnose-ci-billing.sh` — # diagnose-ci-billing.sh — Pinpoint whether CI "failures" are real, or just GitHub Actions refusing to start jobs because the org ran out of minutes.
- `eject.mjs` — `pnpm eject <rung>`: delete every rung above <rung> and leave a COHERENT repo.
- `format.mjs` — THE REPAIR USES THE SAME INSTRUMENT AS THE GATE (#618).
- `freeze-all.mjs` — Settle BOTH frozen artifacts in one measurement, or refuse and explain.
- `gen-rung-types.mjs` — emit rungs.generated.ts from rungs.json. rungs.json is the source of truth, not this output.
- `has-rung.mjs` — does THIS tree declare a given rung? Prints `yes` or `no`.
- `langfuse-console-url.sh` — # Prints a BROWSER-REACHABLE Langfuse console URL, or nothing.
- `langfuse-override-args.sh` — # Prints the extra `docker compose -f …` arguments needed to point a backend at a LOCALLY RUNNING Langfuse fixture — and prints NOTHING when it is not running.
- `matrix.mjs` — emit the severability CI matrix from rungs.json.
- `mutation-proof.mjs` — Shared harness for mutation-based proofs (the `*.selftest.mjs` family).
- `payload-triangulation.mjs` — every declared `data-*` part has a PRODUCER and a CONSUMER.
- `readme-quickstart.mjs` — THE ONE EXTRACTOR. Reads a README's Quick Start and says what is in it.
- `run-checks.mjs` — Runs every check declared in scripts/checks.json, and RECORDS WHAT IT ACTUALLY RAN.
- `traceability.mjs` — every ✓ requirement in PROJECT.md names a test that exists.
- `validate-manifest.mjs` — CHECK-0: rungs.json validates against rungs.schema.json.
- `write-generated-json.mjs` — A GENERATED JSON ARTIFACT IS WRITTEN IN THE SHAPE THE FORMAT GATE EXPECTS (#622).