# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-06-08)

**Core value:** A developer can wire up DeepAgents end-to-end in two lines of code — one server route, one hook — and get fully typed messages out of the box, in their framework of choice.
**Current focus:** v1.7 — Blazing Workspace Provider (COMPLETE — 12/12 requirements, including TEST-03 verified live)

## Current Position

Milestone: v1.7 — Blazing Workspace Provider
Phase: All phases complete (21–25)
Plan: —
Status: Complete — 12/12 requirements delivered; TEST-03 verified live (8/8) on 2026-06-09
Last activity: 2026-06-09 — TEST-03 live smoke test verified + `health()` contract bug fixed
Progress: [██████████] 100% — v1.7 shipped

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

- (v1.7 complete — no open todos) BLZ-F1: the adapter now forwards `SandboxConfig` `env`/`exec_timeout_ms`, but Blazing rejects them with 422 (blazing#48) — they work once Blazing wires the runtime; no further adapter change needed.
- Optional follow-up (blazing repo): `docker/Dockerfile.api` HEALTHCHECK targets `/health`, but the api serves `/v1/health` — see the dedicated fix branch.

### Blockers/Concerns

- (none) — PR #81 merged, adapter shipped, TEST-03 verified live. All v1.7 blockers resolved.

## Session Continuity

Last session: 2026-06-08
Stopped at: Created v1.7 roadmap (Phases 21-25). All 12 requirements mapped with goal-backward success criteria. ROADMAP.md and STATE.md written. Next: approve roadmap and start Phase 21 planning.
Resume file: None

---