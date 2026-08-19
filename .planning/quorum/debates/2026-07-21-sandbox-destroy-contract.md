# Quorum Debate
Question: Two sandbox-adapter contract questions — (Q1) destroy() idempotency divergence between docker and blazing; (Q2) destroy_failed unreachable in blazing
Date: 2026-07-21
Consensus: APPROVE (CE-5 full convergence — unanimous AND improvement stream dry)
Rounds: 5

## Roster
8 slots dispatched (user override of max_quorum_size=3, "use all available slots").
6 lost to infrastructure, none related to the question:

| slot | outcome | reason |
|---|---|---|
| claude-1 | VOTED (R1–R5) | — |
| copilot-1 | VOTED (R1–R5) | — |
| antigravity-1 | voted R1, UNAVAIL R2+ | headless read_file permission auto-denied |
| gemini-1 | UNAVAIL | IneligibleTierError — client no longer supported (PERMANENT) |
| claude-z-ai | UNAVAIL | 429 weekly/monthly limit, resets 2026-07-26 |
| opencode-1 | UNAVAIL | rate-limited through 2 retries, cooldown set |
| claude-minimax | UNAVAIL | stalled after 217 bytes, cooldown set |
| codex-1 | UNAVAIL | hard timeout at 5m30s |

## Round 1
| Model | Position | Citations |
|---|---|---|
| Claude (ADVISORY — not a vote) | Q1=A; Q2=C | — |
| antigravity-1 | Q1=A, Q2=B | — |
| claude-1 | Q1=A, Q2=B | blazing-sandbox.ts:155-159, 286-327; docker-sandbox.ts:221-239; index.ts:40, 79-88; route.ts:35-46 |
| copilot-1 | Q1=A, Q2=B | blazing-sandbox.ts:155-161, 383-390; docker-sandbox.ts:221-237; blazing-sandbox.test.ts:322-350 |

Claude's Q2=C was refuted: STATUS_BY_CODE maps destroy_failed→502 and provider_unavailable→503,
so the code is load-bearing, not aspirational. Position withdrawn.

## Round 2
| Model | Position | Citations |
|---|---|---|
| claude-1 | Q1=A, Q2=B — REFINE. Rejects modifying request() (shared; a 500 on create should stay provider_unavailable, nothing leaked) and raw fetch (bypasses circuit breaker) | blazing-sandbox.ts:273-333, 336-393 |
| copilot-1 | Q1=A, Q2=B — REFINE, and REFUTES ITS OWN R1 PROPOSAL: guardedFetch consumes all 5xx before request() sees a status, so "check res.status===500 in request()" is mechanically impossible | blazing-sandbox.ts:280-333, 336-408 |
| antigravity-1 | UNAVAIL | — |

## Round 3
| Model | Position | Citations |
|---|---|---|
| claude-1 | Q1=A, Q2=B, IMPL=ii — CHANGED POSITION i→ii. Adding status to SandboxError is a public change contradicting Q2=B; message-parsing unacceptable in reference code | blazing-sandbox.ts:273-333, 162-175; types.ts:92-108 |
| copilot-1 | Q1=A, Q2=B, IMPL=ii | blazing-sandbox.ts:155-160, 280-333 |

## Round 4
| Model | Position | Citations |
|---|---|---|
| claude-1 | IMPL=ii; proposes not_found→`return` (defensive) and reference-identity guard | blazing-sandbox.ts:362-367 |
| copilot-1 | IMPL=ii; proposes REMOVE not_found branch (dead code) and throw-outside-try | blazing-sandbox.ts:322 |

Both ACCEPTED IMP-1 (rethrow original DELETE error) and IMP-2 (explanatory comment).

## Round 5
| Model | Position | Citations |
|---|---|---|
| claude-1 | D1=1a, D2=2a — adopts BOTH of copilot-1's positions. "A test that fails loudly is strictly better than dead code that silently handles a case no one can verify." Nothing new. | blazing-sandbox.ts:155-159, 362-367 |
| copilot-1 | D1=1a, D2=2a. Traces that the probe already rescues a future 404, so the defensive branch is unnecessary. Finds a bug in 2b: a NEW error from get() would surface the probe error, not the causal DELETE error. Nothing new. | — |

## Outcome
VERDICT Q1: A — destroy() resolves for unknown ids on BOTH providers.
VERDICT Q2: B — provider-internal remap; SandboxError unchanged.
IMPL: ii — confirmatory GET (ground truth) rather than HTTP status.
D1: 1a — remove the not_found branch.
D2: 2a — throw outside the try (impossible by construction).

Deciding facts, not preferences:
- Blazing CANNOT implement Q1's alternative: 204 is returned for both "deleted" and "never
  existed", so not_found or a boolean needs a racy pre-GET and is still ambiguous.
- guardedFetch collapses every 5xx into provider_unavailable before request() sees a status,
  which is what made destroy_failed unreachable and killed the status-based fixes.

Implemented in commit 0dd5980. Both previously-skipped parity assertions are now live and
green on both providers. Suite: 126 passed, 10 skipped.

CAVEAT: the verdict rests on 2 surviving voters, not 8. Re-running once cooldowns clear would
strengthen it. gemini-1 will fail every future run until removed from quorum_active.

## Improvements
| Model | Suggestion | Rationale |
|---|---|---|
| copilot-1 | IMP-1: on probe failure, rethrow the ORIGINAL DELETE error | both failed means the provider is down; the original 5xx is the causal signal for triage |
| copilot-1 | IMP-2: inline comment explaining the confirmatory GET | without it the GET looks redundant and will be "optimised away" |
| copilot-1 | IMP-3/D2: throw outside the try | the catch physically cannot intercept the destroy_failed it just threw |
| copilot-1 | IMP-4/D1: remove the not_found branch | unreachable; dead branches in reference code teach the wrong thing |
| claude-1 | IMP-5: (withdrawn) not_found → return | superseded — the probe already handles a future 404 correctly |
| claude-1 | IMP-6: (withdrawn) reference-identity guard | superseded by IMP-3, which has no failure mode |
