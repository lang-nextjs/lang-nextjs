# Sandbox provider parity — running state

Loop: `.planning/loops/blazing-modal-parity.md`

## Premise correction (iteration 1)

The loop file said *"Modal is the reference implementation. Where behaviour differs, Modal
is right."* **That is wrong for this repo, and it was my assumption, not a measured fact.**

Verified 2026-07-21: there is **no Modal code anywhere** in the tree
(`grep -rli modal --include=*.ts --include=*.py`, excluding `node_modules`/worktrees → no
hits). The adapter declares exactly two providers:

```ts
export type SandboxProvider = "docker" | "blazing";
```

So "Modal parity" cannot mean *"match the in-repo Modal implementation."* It has to mean
**parity with Modal's published sandbox capability surface** — what an integrator gets from
modal.com that they do not get from Blazing. Modal is the external benchmark, not a local
oracle. The comparison is therefore against documented behaviour, and every claim about
"what Modal does" must cite a source rather than an in-repo file.

Second consequence: `docker` is the *de facto* local reference. Docker↔Blazing parity is
directly testable today and is the cheaper, higher-confidence half of the work. Modal-surface
parity is a separate axis that needs external documentation to assess.

## The adapter surface

Enumerated from the provider classes, not assumed — 7 methods:

`create` · `get` · `list` · `destroy` · `executeTool` · `health` · `capacity`

## Scoreboard — 7 of 7 proven, 3 bugs fixed, 1 open divergence

*(baseline at iteration 1 was 0 of 7)*

The loop's definition of proven is deliberately strict:

> Every capability has a test that runs against BOTH providers **from the same test body**.
> A provider-specific test is a gap, not a test.

Measured against that bar:

| | count |
|---|---|
| capabilities on the adapter surface | 7 |
| **proven** (shared test body, both providers) | **7 — the whole adapter surface** |
| unproven | 0 |
| **divergent — needs a decision** | **1** (`list` partial-failure semantics) |
| bugs found and fixed | 3 (`capacity.available`, `destroy` idempotency, unreachable `destroy_failed`) |

Both `destroy` divergences are **RESOLVED** — decided by a 5-round multi-model quorum
(unanimous, CE-5 full convergence) and implemented. The previously-skipped assertions are
now live and green on both providers.

At iteration 1 there was no `describe.each`, no provider-parameterised suite and no shared
test body anywhere in `lib/sandbox/*.test.ts` — every test targeted one provider.
`parity.executeTool.test.ts` is now the first exception; the other six methods are still in
that state.

This is **not** the same as "untested". Both providers have substantial per-provider unit
coverage, and Blazing additionally has a live suite:

| method | blazing unit | docker unit | blazing live |
|---|---|---|---|
| `create` | 25 | 32 | 5 |
| `get` | 4 | 8 | 5 |
| `list` | 6 | 18 | 3 |
| `destroy` | 10 | 13 | 4 |
| `executeTool` | 11 | 17 | 4 |
| `health` | 17 | 13 | 5 |
| `capacity` | 6 | 3 | 3 |

(reference counts, not assertion counts — they indicate attention, not correctness)

The gap is **not coverage, it is comparability**. Two independently-written suites can both
pass while the providers disagree about error type, timeout semantics, or cleanup-on-failure
— and nothing in CI would notice. That divergence is exactly what breaks the "swap backends
and nothing changes" promise this repo exists to make.

## Proven: `executeTool` (iteration 2)

`parity.executeTool.test.ts` — the first suite in this repo whose body runs against BOTH
providers via `describe.each`. Seven contract assertions × 2 providers = 14 tests, all green:

- a non-zero exit is a **result, not an exception** (a tool failing is not the sandbox failing)
- stdout and stderr stay separate
- `timedOut` is a boolean, and `false` when it did not time out
- `timedOut` is `true` when the execution was killed
- `durationMs` is always a finite number
- an empty command raises `invalid_command`
- an unknown workspace raises `not_found`

**The suite was mutation-tested before being believed.** All 14 passed on the first run, which
by this loop's own rule is not evidence — a suite that has never failed may be testing its own
mocks. Two deliberate mutations were applied to `blazing-sandbox.ts`:

1. `timedOut: dto.timed_out ?? false` → drop the default. *(No failure — this mutation was a
   no-op; my replacement string had the wrong indentation and never applied. Worth recording:
   a mutation test that does not mutate proves nothing either, and I nearly accepted it.)*
2. throw `exec_failed` on a non-zero exit → **2 tests failed, blazing only**, exactly the two
   that depend on exit code. Restored → 14 pass.

So the harness genuinely drives the providers, and parity on these seven dimensions holds.

Also checked during this iteration, and NOT a divergence: `executeTool` on an unknown
workspace looked asymmetric (docker throws `not_found` inline; blazing's method body has no
such path), but blazing's `request()` maps HTTP 404 → `not_found`, so both surface the same
code. Verified rather than reported.

## Proven: `create` / `get` / `destroy` lifecycle (iteration 3)

`parity.lifecycle.test.ts` — 6 assertions × 2 providers. 11 green, 1 skipped as a known
divergence (below):

- `create` returns a ready workspace tagged with its own provider
- **round trip**: create → `get` finds it → `destroy` → `get` returns null
- `get` returns `null` for an unknown id rather than throwing
- `destroy` raises `not_found` for an unknown id
- `create` raises `at_capacity` when the provider is full
- ~~a failing `destroy` raises `destroy_failed`~~ ← divergent, see below

Unlike iteration 2, this suite **failed on first run** — 4 failures — so it needed no
mutation test to prove it had teeth. Three were my own fake being wrong (I invented DTO field
names instead of reading `BlazingWorkspaceRecord`: the field is `sandbox_id`, not `id`). One
was real.

## Known divergent — `destroy` failure code

| condition | docker | blazing |
|---|---|---|
| removal fails / HTTP 500 | `destroy_failed` | `provider_unavailable` |

Blazing's `request()` maps every unrecognised non-ok response to `provider_unavailable`, so
**`destroy_failed` is unreachable in blazing** despite being part of `SandboxErrorCode`. The
two signals mean different things operationally: `provider_unavailable` says *"Blazing is
down"*, `destroy_failed` says *"this one workspace would not go away"* — and the first sends
an operator to debug the wrong system.

**Why it is not fixed yet.** I applied the obvious fix — remap non-404 failures in blazing's
`destroy()` to `destroy_failed` — and an existing test correctly rejected it. That test
asserts `503 → provider_unavailable`, which is *right*: a 503 genuinely is the provider being
unavailable. My remap collapsed "the delete failed" and "the service is down" into one code.

Distinguishing them needs the HTTP status carried on `SandboxError`, which is a change to the
adapter's public error surface — a guardrail item in the loop file, so it stops here for a
human rather than being decided by me. The assertion is `it.skip`ped with the reasoning
inline, not deleted and not weakened.

## Proven: `health` / `capacity` (iteration 4) — and a real bug fixed

`parity.telemetry.test.ts` — 6 assertions × 2 providers, all green after one fix.

**The bug.** `SandboxCapacity.available` is documented as *"max - used, floored at 0"*.
Docker computed it. Blazing did `dto.available ?? Math.max(0, max - used)` — trusting the
API's number when present. So a malformed or stale response could hand callers a **negative**
`available`, or one contradicting the `used`/`max` in the same payload, and the two providers
would disagree for identical state.

That matters because these are the methods an orchestrator **polls to place work**. A
divergence here does not fail loudly; it misroutes. A scheduler checking `available > 0`
would happily dispatch to a full backend.

Fixed: blazing now computes `available` and never passes it through. No existing test
defended the old behaviour — checked before changing it, having learned that lesson in
iteration 3.

Also pinned: `health` must **return** `available: false` when the provider is down, never
throw. A health check that throws is useless to the thing polling it.

## CORRECTION to iteration 3

Iteration 3 claimed `destroy` was proven for "2 of 3 properties", including *"destroy raises
`not_found` for an unknown id"* on both providers. **That claim was false, and my own fake
produced it.**

The real Blazing API returns **204 for an unknown id** — destroy is idempotent — and
`blazing-sandbox.test.ts` pins that explicitly as the intended contract. My lifecycle fake
returned **404** because I assumed it would. That assumption made the assertion pass on both
providers and concealed a genuine divergence.

Corrected: the fake now returns 204 for unknown ids, matching documented behaviour, and the
assertion is skipped as a known divergence.

This is the second time in this file that a fake built from my assumptions rather than from
the source produced a false result (the first was inventing DTO field names). The pattern is
worth naming: **a fake encodes a claim about the system, and an unverified fake is an
unverified claim wearing a test's clothing.**

## Known divergent — `destroy`, on two counts

**1. Idempotency**

| `destroy(unknown_id)` | docker | blazing |
|---|---|---|
| | throws `not_found` | resolves (API returns 204) |

Both are defensible — HTTP DELETE is specified as idempotent, so blazing follows the stricter
reading; docker's throw is more informative to a caller that believed the workspace existed.
What is not defensible is disagreeing silently, because a caller wrapping `destroy` in
try/catch behaves differently per backend.

**2. Failure code** (from iteration 3)

| removal fails / HTTP 500 | docker | blazing |
|---|---|---|
| | `destroy_failed` | `provider_unavailable` |

`destroy_failed` is unreachable in blazing. The obvious fix was tried and correctly rejected
by an existing test asserting `503 → provider_unavailable`; distinguishing "the delete failed"
from "the service is down" needs the HTTP status carried on `SandboxError`.

Both are contract decisions, so they stop here per the loop's guardrails rather than being
decided unilaterally.

## Resolved by quorum — both `destroy` divergences (iteration 5)

Escalated rather than decided unilaterally, then settled by 8-slot quorum (5 rounds,
2 surviving voters after infrastructure attrition, unanimous, no improvements left):

| question | verdict |
|---|---|
| Q1 — idempotency | **A** — `destroy` resolves for unknown ids on BOTH providers |
| Q2 — `destroy_failed` | **B** — provider-internal remap; no change to the public error type |
| implementation | **ii** — confirmatory GET (ground truth), not HTTP status |
| `not_found` branch | **remove** — the probe already handles a future 404 correctly |
| self-catch guard | **throw outside the `try`** — impossible by construction, not merely checked |

Deciding factor on Q1: blazing physically **cannot** implement the alternative. Its API
returns 204 for both "existed and deleted" and "never existed", so `not_found` — or a
`boolean` return — would need a racy pre-GET. Docker was the outlier.

Deciding factor on Q2: `guardedFetch` collapses every 5xx into `provider_unavailable` before
`request()` sees a status, so `destroy_failed` was unreachable. Rather than recover the
status (leaky, and a proxy can set it), `destroy()` now asks the question the error code
actually asks — *did the workspace survive?* — via a confirmatory `GET`.

## `list` — proven, plus a third divergence found

`parity.list.test.ts`: 4 assertions × 2 providers, all green — empty state returns an array
not null, every entry carries its provider, the list reflects create/destroy, ids are unique.

**Open divergence:** one malformed record fails blazing's ENTIRE `list()`, because every
record is mapped through `toWorkspace`, which throws when `sandbox_id` is missing. Docker
cannot be fed bad data at all, so only the remote provider is exposed.

Not fixed, because the trade is real: *skip-and-log* hands the caller 49 of 50 while it
believes it has all of them; *fail-the-call* denies them everything over one broken record.
The third option — good records plus an incompleteness signal — changes `list()`'s return
type, a public-contract change. Queued for the next quorum.

## Log

- **iter 1** — Corrected the loop's premise (no in-repo Modal). Enumerated the 7-method
  surface from source. Established baseline 0/7 proven. No code changed.
- **iter 2** — `executeTool` proven across both providers (1/7). Mutation-tested the harness;
  the first mutation silently failed to apply, which is itself recorded above. Providers
  unmodified — parity already held. Full `lib/sandbox` suite: 94 passed, 9 skipped.
- **iter 3** — lifecycle suite added; `create`/`get` proven. **First real divergence found**:
  blazing cannot emit `destroy_failed`. Attempted fix was too broad and an existing 503 test
  caught it — reverted rather than deleting the test that was right. Suite: 104 passed.
- **iter 5** — `list` proven (7/7 — whole surface covered). Third divergence found (partial
  failure in `list`). Both `destroy` divergences RESOLVED by quorum and implemented; the two
  previously-skipped assertions are now live and green. Suite: 126 passed, 10 skipped.
- **iter 4** — `health`/`capacity` proven (5/7). **Found and fixed a real bug**: blazing
  passed through the API's `available` instead of computing it, so a scheduler could see a
  negative value. **Corrected a false claim from iter 3**: destroy-of-unknown is idempotent on
  blazing (204), not `not_found`; my fake had encoded the wrong assumption and hidden the
  divergence. Suite: 114 passed, 13 skipped.
