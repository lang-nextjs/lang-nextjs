# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-06-08)

**Core value:** A developer can wire up DeepAgents end-to-end in two lines of code — one server route, one hook — and get fully typed messages out of the box, in their framework of choice.
**Current focus:** v1.7 shipped (12/12, TEST-03 verified live). Active work is the post-milestone
sandbox parity loop plus an unblocked-but-unimplemented CI port fix — see Pending Todos.

## Current Position

Milestone: v1.7 — Blazing Workspace Provider (shipped) → post-milestone parity loop (active)
Phase: v1.7 phases 21–25 all complete
Plan: `.planning/loops/blazing-modal-parity.md` (iterations 1–5 done)
Status: v1.7 complete (12/12, TEST-03 verified live 2026-06-09). Parity loop 7/7 capabilities
        proven across both providers, 5 bugs found, 0 open divergences as of 2026-08-24.
Last activity: 2026-08-24 — ARCHITECT decided AND implemented `list()` partial-failure
               semantics (skip-and-log); 2 further bugs found and fixed while deciding.
Progress: [██████████] 100% v1.7 · parity loop [██████████] surface covered, change set pending

> Previous milestone v1.6 (Production Readiness & Observability) shipped 2026-06-06.
> 21 requirements, 3 phases (18–20), all verified. See MILESTONES.md.

### v1.7 Phase Map
- Phase 21: Blazing API Merge (BLZ-01, BLZ-02, BLZ-03) — dependency phase
- Phase 22: TypeScript Adapter Contract (ADPT-01, ADPT-02, ADPT-03) — contract implementation
- Phase 23: Provider Wiring (ADPT-04, ADPT-05) — factory integration
- Phase 24: Test Suite Integration (TEST-01, TEST-02, TEST-03) — validation coverage
- Phase 25: Provider Documentation (DOC-01) — setup guide

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table. Recent decisions affecting current work:

- [v1.7 kickoff]: Two-repo milestone — Phase 21 lands the blazing API dependency, Phases 22+ are the TypeScript adapter + tests (split between repos)
- [v1.7 kickoff]: BLZ-01 (merge PR #81) is a hard dependency — TypeScript adapter can't be tested against real contract until merged
- [v1.7 kickoff]: ADPT-01..05 can be done in parallel with BLZ work (adapter code doesn't depend on merged PR, just knowing the contract)
- [v1.7 kickoff]: TEST-01..02 (mock tests) can happen alongside ADPT work
- [v1.7 kickoff]: TEST-03 (live smoke) depends on both BLZ-01 AND ADPT-01..05 being complete
- [v1.7 kickoff]: DOC-01 can happen alongside any phase
- [v1.7 roadmap]: Phase 21 as separate dependency phase — TypeScript adapter cannot be tested against real contract until PR #81 is merged
- [v1.7 roadmap]: ADPT-01..05 mapped to single phase — all contract changes are interdependent (URLs, types, errors, exec format, factory)
- [v1.7 roadmap]: TEST-01..02 can start after Phase 22 — mock tests don't need live API, just contract specification
- [v1.7 roadmap]: TEST-03 last phase — requires both live API and complete adapter implementation
- [v1.7 roadmap]: DOC-01 standalone — documentation can proceed alongside development
- [2026-06-09 TEST-03 verified live]: Ran the deferred live smoke test 8/8 through the real `BlazingSandbox` adapter (create → get → exec → list → destroy + health/capacity) against an isolated `blazing-api` built from `origin/master` on `:8009` (the running local image predated PR #81, so its image lacked `/v1/workspace*`). Surfaced + fixed a `health()` contract bug: the live `/v1/health` returns `{status:"healthy"}`, which the adapter mis-read as unavailable. Added `lib/sandbox/blazing-sandbox.live.test.ts` (gated on `BLAZING_API_URL`). The workspace REST runtime calls `docker.from_env()` directly — it needs only Redis + Docker socket + the `blazing/workspace:latest` image, not the executor/coordinator.

### Pending Todos

- ~~[PARITY] `list()` change set~~ **IMPLEMENTED 2026-08-24** — all 6 items landed
  (uncommitted, for TEAMLEAD to land as a scoped PR). Both bugs found during the decision
  are fixed: the unguarded sandbox workspaces GET now maps through `sandboxErrorToResponse`,
  and `toWorkspace` takes a call-path context so the list path throws `list_failed`.
  `lib/sandbox` 129 passed / 9 skipped; full app 309 passed; tsc clean.
  Still deferred on its trigger: the `{ workspaces, incomplete }` return-type change.
- **[CI] e2e.yml has never passed** — two runs in retained history (2026-08-19), both fully
  red. Root cause: `apps/open-swe/package.json` hardcodes `--port 3000`, colliding with
  apps/example; `--port` beats the `PORT` env CI sets. Change set delivered to TEAMLEAD
  2026-08-24. Also uncovered: `run: <cmd> &` masks server exit status in 5 workflow steps,
  and `playwright.config.ts:86,111,121` regressed from the `:3001` its own plan specified
  (`.planning/phases/v1.5-06-.../v1.5-06-01-PLAN.md:88`).
- **[DEFERRED] a11y** — 5 WCAG A/AA violations on `/`, `/hitl-demo`, `/open-swe`,
  `/concurrent-test`, `/reconnect-test` (78 pass). Real product bugs; own ticket.
- **[DEFERRED] `OPENROUTER_API_KEY`** unset — e2e-llm job fails its precheck. Org setting.
- (v1.7 itself — no open todos) BLZ-F1: the adapter now forwards `SandboxConfig` `env`/`exec_timeout_ms`, but Blazing rejects them with 422 (blazing#48) — they work once Blazing wires the runtime; no further adapter change needed.
- Optional follow-up (blazing repo): `docker/Dockerfile.api` HEALTHCHECK targets `/health`, but the api serves `/v1/health` — see the dedicated fix branch.

### Blockers/Concerns

- **CI is fully red and always has been.** `e2e.yml` has two recorded runs (2026-08-19), all
  five jobs failed in both; the mocked Playwright step has never executed, so every
  `open-swe*` project is UNPROVEN code rather than a working suite with a config bug. Nothing
  is merge-blocked (no branch protection, no rulesets, zero PRs ever opened), so this is not
  an emergency — but do not read any part of the e2e suite as validated.
- v1.7 itself: no blockers. PR #81 merged, adapter shipped, TEST-03 verified live.

## Session Continuity

Last session: 2026-08-24 (ARCHITECT)
Stopped at: Implemented the `list()` change set (6 items) — uncommitted on main, reported to
TEAMLEAD to land as its own scoped PR. The e2e port contract shipped separately as #21.
Next: land the `list()` PR. Then the deferred a11y and OPENROUTER_API_KEY items.
Resume file: None

> NOTE (2026-08-24): this file had drifted ~2 months — it claimed v1.7 complete with no open
> todos while HEAD contained a 5-iteration parity loop dated 2026-07-21 that it never
> mentioned. In a repo whose git history is two squashed commits, `.planning/` IS the record.
> Update it in the same change as the work, not after.

---