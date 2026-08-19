# Research Summary: Open-SWE Integration Milestone

**Project:** deepagents-nextjs + open-swe integration  
**Domain:** Coding agent dashboard on LangGraph Platform with SSE streaming and async task management  
**Researched:** 2026-05-04  
**Overall confidence:** MEDIUM (core LangGraph/SSE patterns HIGH; async MCP patterns emerging)

---

## Executive Summary

Adding open-swe integration to deepagents-nextjs requires careful handling of three orthogonal concerns: **LangGraph Platform API integration** (auth/URL config), **SSE streaming resilience** (timeouts, heartbeats), and **async task state management** (stateless adapters vs. stateful handlers). The critical risk is that the existing stateless transform pipeline works well for simple backends but will silently accumulate bugs when adding long-running task management, concurrent streams, and event reordering.

The research reveals six critical pitfalls that must be addressed in Phase 1 and Phase 2:

1. **API configuration leakage** — local dev URLs/auth break in production if not externalized
2. **Stream timeouts** — no heartbeat on 2+ minute tasks causes connection timeout
3. **Event ordering races** — parallel tool calls arrive out-of-order without reordering logic
4. **Stateful adapter creep** — keeping adapter stateless while managing task context requires architectural discipline
5. **MCP async design mismatch** — "trigger and poll" pattern doesn't work for LLM agents; needs timeout+DB fallback
6. **Reverse proxy buffering** — Nginx/Cloudflare buffer SSE streams without explicit unbuffering headers

Of these, pitfalls #1, #2, #3, and #6 must be handled in Phase 1 (adapter implementation) to avoid shipping a broken foundation. Pitfalls #4 and #5 emerge during Phase 2 (dashboard/MCP server) but require architectural decisions made in Phase 1.

---

## Key Findings

### Stack
- **LangGraph Platform API** (primary integration point)
- **openSweAdapter** (maps LangGraph astream_events to AI SDK v6 format)
- **SSE heartbeat/keep-alive** (must emit every 15-30 seconds during execution)
- **Adapter pattern** (must remain stateless; context managed in handler)
- **MCP tools** (trigger_task + get_run_status, with DB-backed status for safety)

### Architecture
- Stateless transform pipeline (adapter) with request-scoped context management (handler)
- SSE stream as internal transport; database as authoritative task state
- Task resumption via fresh context per request (no state reuse)
- Concurrent stream isolation by session/user ID

### Critical Pitfalls
1. **API URL configuration** — LOCAL DEV vs. PRODUCTION mismatch (HIGH impact, MEDIUM difficulty to prevent)
2. **SSE stream timeout** — No heartbeat on long tasks (HIGH impact, LOW difficulty to prevent)
3. **Tool event ordering** — Race condition with parallel tool calls (MEDIUM impact, MEDIUM difficulty to prevent)
4. **Stateful adapter complexity** — State creep breaks concurrent streams (HIGH impact, HIGH difficulty to recover from)
5. **MCP async design** — Polling pattern doesn't scale (HIGH impact, HIGH difficulty to redesign later)
6. **Proxy buffering** — Nginx silently buffers SSE without headers (MEDIUM impact, LOW difficulty to prevent)

---

## Implications for Roadmap

### Phase 1: openSweAdapter Implementation

**Must address:**
- Pitfall #1 (API config): Externalize LANGGRAPH_API_URL/KEY to env; test both local and cloud URLs in CI
- Pitfall #2 (timeouts): Add heartbeat logic; emit status/progress frame every 15-30s during execution
- Pitfall #3 (event ordering): Research LangGraph tool call semantics; add reorder buffer if tools run in parallel
- Pitfall #6 (proxy buffering): Add X-Accel-Buffering + Cache-Control headers to handler

**Success criteria:**
- Adapter accepts run_id/sessionId as constructor option (no module-level state)
- Adapter emits heartbeat frame when no events for 30 seconds
- Unit test: reversed tool events reorder correctly
- Integration test: adapter works with both `http://localhost:8123` and mock cloud URL
- Handler sets unbuffering headers; verified with Nginx locally

### Phase 2: apps/open-swe Dashboard

**Must address:**
- Pitfall #4 (stateful adapter): Design handler to manage task context; adapter receives as config only
- Pitfall #5 (MCP async): `trigger_task` returns immediately + run_id; `get_run_status` reads DB; NO polling loop in client

**Success criteria:**
- Handler validates task ownership by user/session before passing to adapter
- Two concurrent requests to same endpoint; no event leakage between streams
- MCP tools designed for LLM agent use (trigger once, status once, not polling)
- Integration test: concurrent dashboard users don't see each other's events

### Phase 3: Extended MCP Server

**Recommendations (not critical for Phase 1/2):**
- Plan for MCP resource subscriptions (#491) when available (async task resources)
- Add webhook/SSE-based notifications instead of polling (future upgrade path)
- Design tool signatures for real-time feedback (e.g., `get_run_status` includes progress %)

---

## Confidence Assessment

| Area | Confidence | Reasoning |
|------|-----------|-----------|
| LangGraph API gotchas | HIGH | Documented in official LangChain auth tutorials and LangGraph Platform docs |
| SSE timeout patterns | HIGH | Istio/Nginx defaults well-documented; heartbeat strategy confirmed across multiple sources |
| Tool event ordering | MEDIUM | GitHub issues show race conditions; LangGraph astream_events docs lack clarity on ordering guarantees |
| Stateful adapter risks | HIGH | Existing deepagents codebase demonstrates stateless pattern working well; extrapolation to stateful design clear |
| MCP async design | MEDIUM | MCP discussion #491 is still open; no finalized pattern yet; polling is common workaround but not ideal |
| Reverse proxy buffering | MEDIUM | Nginx/Cloudflare behavior documented; but consumer proxy configs not tested (varies by environment) |

---

## Gaps to Address

### Phase 1 Research Gaps
- **LangGraph tool call ordering guarantees:** Official docs unclear; need to test actual behavior with parallel tools
- **LangGraph Platform local dev memory limitation:** Confirmed in-memory storage exists, but unclear if this affects streaming behavior
- **MCP tool parameter inspection:** How to dynamically determine which MCP tools need state injection?

### Phase 2 Research Gaps
- **SSE reconnection on client side:** AI SDK v6 stream reconnection (#6502) status unclear; may affect long-running task UX
- **Database schema for task state:** What fields are needed for `get_run_status` to be useful to LLM agents?
- **Multi-region deployment:** How does task context work if handler moves between regions mid-stream?

### Phase 3 Research Gaps
- **MCP resource subscriptions timeline:** When will GitHub discussion #491 result in a standard pattern?
- **Task cancellation via MCP:** How to safely cancel running open-swe task without corrupting state?

---

## Roadmap Implications

### Recommended Phase Structure

1. **Phase 1 (Sprint 1-2):** openSweAdapter + SSE streaming foundation
   - Implement adapter with heartbeat logic
   - Add event reordering for parallel tools
   - Test with local + mock cloud LangGraph URLs
   - Add unbuffering headers to handler
   - Deliverable: Core adapter shipped; known to work locally and with cloud API

2. **Phase 2 (Sprint 3-4):** apps/open-swe dashboard + handler state management
   - Implement request-scoped context in handler
   - Design MCP server with trigger/status pattern
   - Test concurrent user streams for isolation
   - Deliverable: Dashboard with task management; MCP tools ready for LLM agents

3. **Phase 3 (Post-MVP):** Extended MCP server + async notifications
   - Add webhook/SSE-based task updates (internal)
   - Plan for MCP resource subscriptions when available
   - Add task cancellation + resumption
   - Deliverable: Production-ready task orchestration

### Why This Order

- **Phase 1 first:** Adapter is the foundation; stateless design must be locked in before handler complexity
- **Phase 2 next:** Dashboard validates adapter in realistic scenario; handler patterns guide Phase 3 design
- **Phase 3 last:** Async patterns can wait for MCP spec to stabilize; MVP works without them

### Risk Mitigation

| Risk | Mitigation | Phase |
|------|-----------|-------|
| API config breaks in prod | Externalize env vars; CI tests both local/cloud | Phase 1 |
| Streams timeout silently | Add heartbeat logic; test with 5+ min delays | Phase 1 |
| Event ordering race condition | Add reorder buffer; unit test with reversed events | Phase 1 |
| Adapter state leaks between requests | Keep adapter stateless; test concurrent requests | Phase 2 |
| MCP tools block LLM loops | Design for single-call use; timeout after 10 min | Phase 2 |
| Proxy silently buffers | Add headers; verify locally with Nginx | Phase 1 |

---

## Success Criteria for Research Validation

- [ ] openSweAdapter works with both local dev and cloud LangGraph URLs
- [ ] SSE streams don't timeout on tasks >5 minutes (heartbeat verified)
- [ ] Parallel tool events reorder correctly (unit test passes)
- [ ] Concurrent requests don't leak events between streams (integration test passes)
- [ ] MCP tools don't rely on polling (no client-side loops)
- [ ] Reverse proxy unbuffering headers configured (Nginx test passes)
- [ ] LangGraph tool event ordering behavior confirmed (GitHub issue or official docs)

---

*Research for: Open-SWE integration milestone*  
*Researched: 2026-05-04*  
*Used to inform: Roadmap creation for subsequent phases*
