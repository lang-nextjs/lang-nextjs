# Pitfalls: Open-SWE Integration Layer Milestone

**Domain:** Coding agent dashboard on LangGraph Platform with SSE streaming, MCP integration, and async task management  
**Researched:** 2026-05-04  
**Confidence:** MEDIUM (LangGraph Platform docs high confidence, SSE streaming patterns medium, MCP async design emerging)  
**Milestone:** Adding open-swe integration layer to existing deepagents-nextjs monorepo

---

## Critical Pitfalls

### Pitfall 1: LangGraph Platform API URL Configuration Fallacy

**What goes wrong:**
The local development server (`langgraph dev`) uses different auth mechanisms and defaults than the cloud platform. A developer configures the API URL for local testing without realizing the URL format, auth token handling, or timeout defaults differ. The code works locally but breaks in production.

**Why it happens:**
- Local dev uses `http://localhost:8123` with minimal auth; production uses cloud URLs with mandatory API keys
- In-memory storage in `langgraph dev` means state isn't persisted across restarts, hiding stateful bugs
- Documentation conflates "local development" (dev server) with "self-hosted" deployments (which use `langgraph up`)
- Environment-specific configuration is often hardcoded in the adapter, not externalized

**How to avoid:**
1. **Externalize URL and auth to environment:** `LANGGRAPH_API_URL`, `LANGGRAPH_API_KEY`, `LANGGRAPH_API_ENV` (dev/prod)
2. **Test URL/auth variants in CI:** Create fixture for both `http://localhost:8123` and cloud URLs; verify both work
3. **In openSweAdapter constructor:** Validate URL format; warn if using localhost in production code
4. **Document the difference:** README section: "Local dev (langgraph dev) vs. deployed (LangGraph Platform)"

**Warning signs:**
- Tests pass locally but fail in deployed environment
- API responses work in browser console but not in adapter
- Timeout errors that don't occur in local testing
- "Connection refused" errors when pointing to actual LangGraph server

**Phase to address:**
Phase 1 (openSweAdapter) — Must prevent adapter from working only in local mode. Test with both local and mock cloud URLs before shipping. Add environment validation to adapter constructor.

---

### Pitfall 2: SSE Stream Timeout on Long-Running Coding Tasks

**What goes wrong:**
A code generation task runs for 2+ minutes. The SSE connection times out silently or is terminated by the client, load balancer, or reverse proxy (Nginx, Cloudflare, cloud LB). The browser sees a partial stream, stops rendering, but the backend continues running. The user thinks the task failed and restarts it.

**Why it happens:**
- Default idle timeout is 5 minutes (Istio), 30 seconds (some reverse proxies), 120 seconds (corporate proxies)
- No heartbeat (keep-alive) events are sent, so the connection appears idle
- openSweAdapter doesn't emit progress frames during non-streaming phases (e.g., waiting for tool execution)
- The SSE frame format doesn't guarantee keep-alive; empty frames get dropped by some proxies

**How to avoid:**
1. **Send heartbeat every 15-30 seconds:** Include a comment frame (`:keep-alive\n\n`) or a status frame during quiet periods
2. **In openSweAdapter:** Detect periods without events; emit `[progress]` or `[heartbeat]` frame to keep stream alive
3. **Configure reverse proxy timeouts:** Set `stream_idle_timeout: 0s` (Istio), add `X-Accel-Buffering: no` header (Nginx)
4. **Client-side timeout handling:** Browser client should retry with exponential backoff if connection closes
5. **Document max task duration:** If tasks can run >5 minutes, explicitly mention this in setup docs

**Warning signs:**
- Streams stop after exactly 5 minutes, 30 seconds, or 2 minutes (these are standard timeout defaults)
- Streams work fine locally but timeout when deployed
- Inconsistent behavior across reverse proxies
- "Connection reset by peer" errors in logs

**Phase to address:**
Phase 1 (openSweAdapter + streaming) — Add heartbeat logic to adapter before shipping. Test with artificially slow runs (delays between events) to verify stream doesn't timeout. Document proxy configuration requirements.

---

### Pitfall 3: Tool Event Ordering Race Condition with Parallel Tool Calls

**What goes wrong:**
A LangGraph node invokes multiple tools in parallel (e.g., check linting, run tests, fetch dependencies). The SSE `tool_call_result` events arrive out of order compared to the original `tool_call` events. The adapter sends them in the wrong order to the client. The UI shows test results arriving before the tool was called.

**Why it happens:**
- LangGraph `astream_events` does not guarantee ordering of tool events when tools execute in parallel
- The underlying async nature of Python means threads/tasks finish at different times
- When multiple `on_tool_end` events fire simultaneously, they can be queued out of order
- The SSE adapter doesn't buffer or reorder events—it passes them through as-is

**How to avoid:**
1. **Use tool IDs for matching:** Never assume tool_call events pair sequentially; match by `tool_call_id`
2. **In openSweAdapter:** Add a small reorder buffer (100-200ms window) that holds events and emits them in `tool_call_id` order
3. **Document tool call matching:** Advise clients to match results by ID, not by order
4. **Add test:** Unit test with artificially reversed event order; verify adapter reorders correctly
5. **Monitor in production:** Add debug logs if reordering is needed; high frequency indicates larger issue

**Warning signs:**
- UI shows tool results before tool invocations
- Inconsistent event order on re-runs of the same task
- Events arrive correctly locally but out of order in production (race condition)
- Tests fail intermittently when tools run in parallel

**Phase to address:**
Phase 1 (openSweAdapter) — Research how open-swe handles parallel tool calls. If using LangGraph's ReAct agent, verify it handles this. Add reordering logic and test before shipping.

---

### Pitfall 4: Stateful Adapter Complexity (Transform Pipeline + External State)

**What goes wrong:**
The openSweAdapter is a stateless transform (frame → frame | null), but open-swe tasks have state: run ID, execution context, checkpoint references. The adapter needs to attach run context to frames, match tool calls to a specific task, and handle resumption. Adding state to a stateless transform pipeline creates subtle bugs:
- Frame N references task context from frame N-5, but the context object was mutated in between
- Stream resumption reuses old context; new context conflicts with cached values
- Two concurrent streams (same user, different runs) share context; events bleed between streams

**Why it happens:**
- The existing deepagents pipeline is pure function (frame → frame); adding state breaks this assumption
- No framework for scoped context (task-local state)
- Tempting to cache context in closure or module-level state for convenience
- SSE is per-request; multiple requests can have parallel streams

**How to avoid:**
1. **Keep adapter stateless; move state outside:**
   - Pass run context as a constructor option: `new openSweAdapter({ runId, sessionId, onRunUpdate })`
   - Let the handler (Next.js route) manage task state, not the adapter
2. **Use request-scoped context:**
   - Each SSE request has a unique task ID in the URL
   - Handler extracts it; passes to adapter as config, not mutable state
3. **Document the boundary:**
   - Adapter = stateless transform
   - Handler = manages request → task mapping
   - MCP server or separate service = manages task persistence
4. **Test concurrency:** Spin up two simultaneous requests to the same endpoint; verify no event leakage

**Warning signs:**
- Shared state in adapter module (e.g., `let currentRunId = null`)
- Context mutations mid-stream (reusing object references)
- Events from one task appearing in another stream
- Resumption bugs where old state interferes with new state

**Phase to address:**
Phase 2 (apps/open-swe dashboard) — Establish clear boundary between stateless adapter and stateful handler before shipping. Design handler to manage task → run mapping. Add integration test with concurrent streams.

---

### Pitfall 5: MCP "Trigger and Poll" Tool Design Without Async Signaling

**What goes wrong:**
An MCP tool `trigger_run` starts a long-running open-swe task and returns immediately (no wait for completion). The client must then poll `get_run_status` in a loop. The polling interval is wrong: poll too fast = wasted CPU; poll too slow = slow feedback. If the server dies, the client has no way to know the task is orphaned.

**Why it happens:**
- MCP tools are request-response (no native async); "long-running" doesn't fit the model
- Designers often implement trigger → poll as the only workaround
- Without a push notification mechanism, clients resort to polling
- No standard for "task complete" signaling; each tool invents its own
- LLM agents don't understand polling patterns; they call tools in sequence, not in a retry loop

**How to avoid:**
1. **Design for LLM agent use:**
   - `trigger_task` tool returns `run_id` AND immediate status (queued, executing, etc.)
   - Client (LLM) stores run_id in agentic memory
   - `get_run_status` tool is fast and stateless; returns current status
   - LLM calls it once after tool, not in a loop
2. **Add timeout+max-retries guard:**
   - If a task is still "running" after 10 minutes, mark as failed
   - LLM should detect this and take corrective action (retry, skip, escalate)
3. **MCP resource subscriptions (future):**
   - MCP discussion #491 proposes async task resources
   - Once available, use `resource://tasks/{id}` with server push
4. **For now, use SSE internally:**
   - `trigger_task` starts a background job and returns immediately
   - Internal handler watches SSE stream from LangGraph
   - When task completes, handler updates database
   - `get_run_status` queries database (no polling needed)

**Warning signs:**
- Client code has a polling loop calling `get_run_status` repeatedly
- Task status stuck in "running" but no error reported
- LLM agent gets confused when task takes longer than expected
- CPU spike from constant polling

**Phase to address:**
Phase 2 (MCP server extension) — Design `trigger_task` and `get_run_status` tools for agentic use, not polling. Consider using internal SSE + database as backing store. Document the architecture. Test with LLM agent calling these tools.

---

### Pitfall 6: Proxy Buffer Issues with Reverse Proxies

**What goes wrong:**
The openSweAdapter streams events perfectly locally, but when deployed behind Nginx, Cloudflare, or a cloud load balancer, events arrive in bursts instead of streaming. Or no events arrive until the stream ends. The reverse proxy is buffering the entire response before sending it to the client.

**Why it happens:**
- Nginx buffers responses by default; SSE streams defeat this assumption
- Cloudflare and many CDNs also buffer for compression
- Headers like `Content-Length` or `Cache-Control: must-revalidate` can trigger buffering
- Some proxies require explicit streaming headers that the handler isn't setting

**How to avoid:**
1. **In createDeepAgentsHandler (or openSweAdapter):**
   - Set `X-Accel-Buffering: no` (Nginx)
   - Set `Cache-Control: no-cache, no-transform` (general)
   - Set `Connection: keep-alive` (HTTP/1.1 persistence)
   - Don't set `Content-Length` (SSE has unknown length)
2. **In Nginx config:**
   ```
   proxy_buffering off;
   proxy_cache off;
   ```
3. **Test deployed stream:** Verify events arrive incrementally, not in bursts
4. **Document proxy requirements:** Include Nginx/Cloudflare config snippets in README

**Warning signs:**
- Streams work locally but buffer in production
- Client receives entire response at once (not streaming)
- `curl -N` (--no-buffer) works, but browser doesn't
- Events arrive in exact chunks matching proxy buffer size

**Phase to address:**
Phase 1 (createDeepAgentsHandler headers) — Add unbuffering headers to handler. Document proxy config. Test with Nginx locally before shipping.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Hardcode LangGraph URL in adapter | Quick local testing | Breaks in production; no env separation | Never — externalize to options |
| Skip heartbeat keep-alives | Simpler adapter code | Streams timeout on slow tasks | Never — add heartbeat logic |
| Pass context as mutable state | Easier to access in transform | Race conditions in concurrent streams | Never — pass as immutable config |
| Polling instead of real-time task updates | Simple MCP tool design | High latency, high CPU, confuses LLMs | Temporary only; plan async upgrade |
| Assume event order | Don't need reordering logic | Breaks when tools run in parallel | Never — always match by ID |
| No proxy unbuffering headers | Simpler handler code | Silent buffering in production | Never — add headers |

---

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| LangGraph Platform API | Hardcoding local dev URL in adapter | Externalize to env; test both localhost and cloud URLs |
| SSE Stream | No heartbeat on slow tasks | Emit heartbeat frame every 15-30 seconds |
| Tool Event Ordering | Assume sequential event arrival | Match events by tool_call_id; add reorder buffer for parallel calls |
| Stateful Adapter | Store run context in adapter closure | Keep adapter stateless; manage context in handler |
| MCP Polling Tools | Design as sync request-response | Add timeout+max-retries; defer to internal SSE + DB |
| Reverse Proxy | Assume transparent proxying | Add X-Accel-Buffering, Cache-Control headers; test with Nginx |
| Task Resumption | Reuse context across stream restarts | Generate fresh context per request; validate task ownership |
| Concurrent Streams | Let shared state bleed between requests | Use request-scoped task IDs; isolate context per stream |

---

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|-----------|----------------|
| No heartbeat on SSE | Stream stops after proxy timeout | Emit frame every 15-30s | Tasks >5min without events |
| Polling without backoff | CPU spike on client | Add exponential backoff; cap poll freq | Many clients polling many tasks |
| Event reordering buffer too large | Buffered events pile up, latency increases | Keep buffer small (100-200ms) | If buffer >1s, latency noticeable |
| Full task state in every frame | Large JSON objects on every event | Include only delta state; full state on demand | Tasks with large context (file diffs) |
| No max-retries on tool calls | Infinite retries if task stuck | Add retry policy with max attempts | Tool execution hangs |

---

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|-----------|
| LangGraph API key in adapter code | Key exposed in GitHub, logs, client bundles | Use env var only; validate in handler; never log key |
| Run ID guessing in URL | Attacker lists/cancels other users' runs | Validate run ownership; check session/user in handler |
| Tool execution without context validation | Task runs with wrong permissions | Validate task's user/org before invoking tool |
| SSE stream leaking between users | User A sees User B's execution events | Isolate streams by session/user; validate in handler |
| MCP tool leaking internal state | Task ID, run context in logs/errors | Sanitize errors; use opaque IDs; log to stderr only |

---

## "Looks Done But Isn't" Checklist

- [ ] **openSweAdapter:** Verify it works with both local (`http://localhost:8123`) and cloud LangGraph URLs; test switching between them
- [ ] **SSE streaming:** Emit heartbeat frame during quiet periods; confirm stream doesn't timeout on slow tasks (test with 5+ min delay)
- [ ] **Parallel tool calls:** Emit tool events out of order in a unit test; verify adapter reorders them correctly
- [ ] **Handler state management:** Two simultaneous requests to same endpoint; verify no event leakage between streams
- [ ] **MCP tools:** `trigger_task` returns immediately with run_id; `get_run_status` is read-only and stateless; no polling loop in client code
- [ ] **Reverse proxy config:** Add unbuffering headers; test behind Nginx; confirm events stream (not buffer)
- [ ] **Error handling:** Task timeout after 10 minutes; error logged securely; user notified; LLM agent can retry
- [ ] **Integration test:** End-to-end test with handler → adapter → mock LangGraph server; verify SSE output format

---

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| API URL wrong in production | HIGH | Redeploy with correct env var; existing streams are orphaned, must retry |
| Stream timeout due to missing heartbeat | MEDIUM | Add heartbeat logic; redeploy; users see graceful close + retry prompt |
| Event ordering bug revealed | MEDIUM | Add reordering buffer; re-process affected runs from database; redeploy |
| Stateful adapter pollutes stream | HIGH | Refactor adapter to stateless; likely requires rearchitecting handler; redeploy with data migration |
| Polling MCP tools cause high latency | MEDIUM | Redesign tools; switch to DB-backed status; redeploy; client logic unchanged (just faster) |
| Proxy buffering silences stream | MEDIUM | Add headers; redeploy; existing buffered responses unrecoverable, users must retry |

---

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|-----------------|--------------|
| LangGraph API URL misconfiguration | Phase 1 (openSweAdapter) | Adapter constructor validates env vars; tests use both localhost and mock cloud URLs |
| SSE timeout on long tasks | Phase 1 (openSweAdapter) | Unit test with 5-min delay between events; stream doesn't close |
| Tool event ordering race condition | Phase 1 (openSweAdapter) | Unit test with reversed event order; adapter reorders to correct sequence |
| Stateful adapter complexity | Phase 2 (apps/open-swe dashboard) | Handler manages task ID; adapter receives as option; concurrent request test shows no leakage |
| MCP "trigger and poll" design | Phase 2 (MCP server extension) | Tools are agentic-friendly; no polling loop in client code; max-retries enforced |
| Proxy buffering issues | Phase 1 (createDeepAgentsHandler headers) | Test locally with Nginx; verify events stream, not buffer |
| Task resumption conflicts | Phase 2 (apps/open-swe dashboard) | Fresh context per request; old task ID cannot be resumed |
| Concurrent stream isolation | Phase 2 (apps/open-swe dashboard) | Two parallel requests; verify event isolation by session |

---

## Sources

### LangGraph Platform & Configuration
- [Custom Authentication and Access Control for LangGraph Platform](https://www.langchain.com/blog/custom-authentication-and-access-control-in-langgraph)
- [LangGraph Platform API Reference](https://langchain-ai.github.io/langgraph/cloud/reference/api/api_ref.html)
- [Local development & testing - LangChain Docs](https://docs.langchain.com/langsmith/local-dev-testing)
- [Local development guide - LangGraph GitHub](https://github.com/langchain-ai/langgraph/blob/main/docs/docs/tutorials/langgraph-platform/local-server.md)

### SSE Streaming & Timeouts
- [Dealing with Long-Running Tasks in Web Apps: The SSE Approach](https://medium.com/@jyotsna.a.choudhary/dealing-with-long-running-tasks-in-web-apps-the-sse-approach-ba8607638335)
- [How to Configure Server-Sent Events Through Istio](https://oneuptime.com/blog/post/2026-02-24-how-to-configure-server-sent-events-sse-through-istio/view)
- [Long running HTTP calls using SSE](https://blog.nigelsim.org/2026-03-17-long-running-http-calls-using-sse/)
- [Stateless Agents, Stateful Product: Building a Resilient, Multi-User Agentic Streaming Application](https://www.kitewing.ai/blog/stateless-agents-stateful-product/)

### LangGraph Tool Events & Ordering
- [astream_events produces redundant tokens and breaks graph streams](https://github.com/langchain-ai/langchain/issues/19211)
- [Race Condition with Parallel Tool Calls - Tool Responses Out of Order](https://forum.langchain.com/t/race-condition-with-parallel-tool-calls-tool-responses-out-of-order/1112)
- [LangGraph State Management in 2025](https://sparkco.ai/blog/mastering-langgraph-state-management-in-2025/)
- [State Management of AI Agents in LangGraph](https://medium.com/@jayhardikar/state-management-of-ai-agents-in-langgraph-45f9975f2af2)

### MCP & Async Tool Patterns
- [Asynchronous operations in MCP - GitHub Discussion](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/491)
- [MCP Best Practices: Architecture & Implementation Guide](https://modelcontextprotocol.info/docs/best-practices/)
- [Model Context Protocol Architecture Overview](https://modelcontextprotocol.io/docs/learn/architecture)

### Open-SWE & Coding Agents
- [Open SWE: An Open-Source Framework for Internal Coding Agents](https://blog.langchain.com/open-swe-an-open-source-framework-for-internal-coding-agents/)
- [Open SWE GitHub Repository](https://github.com/langchain-ai/open-swe)
- [Open SWE In-Depth Guide](https://medium.com/data-science-in-your-pocket/langchain-open-swe-in-depth-guide-to-the-open-source-asynchronous-coding-agent-3957c49153e9)

### SSE & Agent Dashboards
- [Streaming AI Agents Responses with SSE: A Technical Case Study](https://akanuragkumar.medium.com/streaming-ai-agents-responses-with-server-sent-events-sse-a-technical-case-study-f3ac855d0755)
- [Streaming Agent Responses - Microsoft Learn](https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-streaming)

---

*Pitfalls research for: Open-SWE integration layer (coding agent dashboard on LangGraph)*  
*Researched: 2026-05-04*
