# Feature Research: Open-SWE Integration Layer

**Domain:** Coding agent UI/API/MCP layer on top of LangGraph-based AI coding agent (open-swe)  
**Researched:** 2026-05-04  
**Confidence:** MEDIUM-HIGH

---

## Executive Summary

The open-swe integration layer must bridge four communication planes: **(1) live task streaming** via openSweAdapter (tool events → UI state), **(2) run management** (history, status, concurrent execution), **(3) REST API** for programmatic triggering, and **(4) MCP tools** for bidirectional automation.

The ecosystem reveals clear **table stakes** (run history, streaming output, task submission) vs. **differentiators** (approval flows, parallel run management, tool event detail visualization). The biggest risk is underestimating the complexity of displaying streaming shell output and structured file diffs alongside agent reasoning — VS Code and contemporary tools handle this by **separating concerns** (terminal → collapsible section, diffs → dedicated viewer) rather than unified streaming.

Key insight: **Tool event visualization is not UI polish—it's essential for debugging**. When a long-running coding task fails after 10 minutes and 47 tool invocations, users need to see which tool failed, what the command was, and what the output said. Without this, the dashboard is unusable.

---

## Feature Landscape

### Table Stakes (Users Expect These)

Features users assume exist. Missing these = product feels incomplete.

| Feature | Why Expected | Complexity | Notes | Dependencies |
|---------|--------------|------------|-------|--------------|
| **Task submission form** | Agents need input; form captures repo, issue, instructions | MEDIUM | Open-swe expects `repo`, `issue_ids`, `instructions`; optional `commit_prefix`, `model` | None (entry point) |
| **Run history table** | Users navigate completed/running/failed tasks; persistent state required | MEDIUM | Requires database table: run_id, task_id, status, created_at, updated_at, result_summary | Task submission form |
| **Live streaming output** | Users watch agent work; no feedback = stalled perception | MEDIUM | SSE stream carrying tool events; append-only timeline; 100+ events per run typical | openSweAdapter |
| **Tool event visualization** | Agent actions (shell, fetch, git, PR) must be visible | MEDIUM | on_tool_start/on_tool_end events carry tool_name, input, output; tool-specific rendering | Live streaming output |
| **Run status indicator** | Users need to know: running, completed, failed, pending approval | LOW | States: pending → running → (approval_needed?) → completed/failed; last_status_change timestamp | Run history table |
| **Stop/cancel run** | Long-running tasks need user control | LOW | Signal handling; graceful vs. hard stop; prevent orphaned sandbox processes | Run status indicator |
| **Run details panel** | Users drill into single run: full command log, errors, exit codes | MEDIUM | Requires storing structured tool event stream (JSON lines) for replay/inspection | Tool event visualization |
| **Error surfacing** | Failed runs need root cause; not just "failed" | MEDIUM | Parse tool output for error types (syntax, test failure, git conflict); link to specific tool invocation | Run details panel |

### Differentiators (Competitive Advantage)

Features that set the product apart. Not required, but valuable.

| Feature | Value Proposition | Complexity | Notes | Why Now |
|---------|-------------------|------------|-------|---------|
| **Approval workflows for risky tools** | Gate PR creation, Slack messages, Linear tickets behind human review | HIGH | AG-UI INTERRUPT pattern; pause run, show preview of proposed action, user approves/rejects/modifies | Differentiator: Competitors (Codex, Claude Code, VS Code) lack explicit approval gates |
| **Parallel run management** | Queue multiple tasks; UI tracks N concurrent runs (within sandbox limits) | HIGH | Requires async task queue (Bull, RabbitMQ, or simple DB-backed poll); per-run WebSocket/SSE stream routing | Differentiator: Editor-based tools are single-session only |
| **Unified diff viewer for file changes** | Show changed files side-by-side with agent reasoning | MEDIUM-HIGH | Integration with react-diff-viewer or git-diff-view; requires parsing tool output for file paths/diffs | Differentiator: Streaming diffs in UI is non-trivial; most tools show this in sidebar post-hoc |
| **Tool event detail panel** | Click on "execute" tool event → see full command, exit code, output in modal | MEDIUM | Structured tool event storage; syntax highlighting for shell output | Differentiator: Complete transparency into "what did the agent do" |
| **Run comparison** | Side-by-side view of two runs: what commands differed, why success vs. failure | HIGH | Requires run versioning, diff algorithm for tool event sequences | Differentiator: Debugging tool; competitors have no analogue |
| **Streaming search across run history** | Users search old runs by command, error message, or agent reasoning | HIGH | Requires full-text indexing (Elasticsearch, or database FTS) of tool output + reasoning steps | Differentiator: As run history grows, search becomes essential |
| **Agent reasoning visibility** | Show LLM thinking steps (not just tool events) in timeline | MEDIUM | AG-UI TEXT_MESSAGE events carry intermediate reasoning; requires structured event capture | Differentiator: Transparency into why agent chose a tool |
| **Automatic retry suggestions** | On failure, AI proposes "try this" as prefilled form for new run | MEDIUM | ML over run history; pattern matching on error types; UX challenge around when to suggest | Differentiator: Learning from failure; not in competitors |

### Anti-Features (Commonly Requested, Often Problematic)

Features that seem good but create problems.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| **Real-time unified view of agent reasoning + tool output + diffs in single stream** | Looks elegant; "single source of truth" appeal | Creates rendering bottlenecks; tool output is line-based (append-only); diffs require parsing; reasoning steps are bursty; mixing them confuses causality ("did agent decide X *because* Y succeeded?"). VS Code avoids this by separating terminal → collapsible, diffs → sidebar. | **Separate concerns:** timeline of tool events (left), detail panel for selected event (right), reasoning thread in chat-like sidebar |
| **Store entire tool output as plain text in database** | Simple; "just append logs" | Unsearchable; hard to parse for errors; large disk footprint; can't render diffs or structured output cleanly | **Store as JSON lines:** each tool event is a structured object with fields {tool_name, input, status, output_lines: [], exit_code, duration_ms, error_type?} |
| **WebSocket for all streaming (instead of SSE)** | Bidirectional feels more capable | Adds complexity; SSE + REST polling handles most cases; WebSocket reserved for rare cases (approval interrupts) where true bidirectionality needed. Vercel AI SDK uses SSE as default for exactly this reason. | **SSE for agent streaming** (tool events), **REST POST for approval responses**, **optional WebSocket for interrupt-heavy workflows** (advanced) |
| **Manual approval for every tool call** | Safety feels prudent | Approval fatigue; runs stall; users approve without reading. Contemporary pattern: ask for approval only on "dangerous" tools (PR creation, Linear/Slack messaging, file deletion) or high-risk parameter combinations. | **Use agent-assessed risk score** (TOOL_RISK metadata); only interrupt on high risk or user-configured threshold |
| **Global run queue limiting (max N concurrent)** | Prevents sandbox overload | Unfair to early submitters; hard to predict sandbox capacity; creates backlog surprises. Better: per-user quotas (rate limiting) + clear feedback on sandbox availability. | **REST endpoint returns 429 if capacity full;** user sees "2 of 3 quota used" in UI; clear wait estimate |
| **Real-time agent chat interface** | Users want to talk to the agent mid-run | Interrupts agent thinking; breaks autonomy model; creates confusion about agent state; open-swe is designed for batch execution, not interactive chat | **Approval workflows instead:** show what agent wants to do, user approves/rejects, then agent continues (not a chat) |

---

## Feature Dependencies

```
Task Submission Form
    └──requires──> Run History (stores submitted tasks)
                       └──requires──> Database schema + Run Status Indicator

Run History + Status Indicator
    └──requires──> Live Streaming Output (feed runs into UI)
                       └──requires──> openSweAdapter (tool event transform)
                                          └──requires──> LangGraph `on_tool_start/end` hooks

Tool Event Visualization
    ├──requires──> Live Streaming Output (data source)
    └──requires──> openSweAdapter (structured events with tool_name, input, output)

Tool Event Detail Panel
    ├──requires──> Tool Event Visualization (clickable events)
    └──requires──> Structured tool event storage (JSON with full output)

Approval Workflows
    ├──requires──> Tool Event Visualization (preview what to approve)
    ├──requires──> Run Status Indicator (pause state)
    └──enhances──> Tool Event Detail Panel (show risk assessment + context)

Parallel Run Management
    ├──requires──> Run History (track N runs)
    ├──requires──> Run Status Indicator (per-run state)
    ├──requires──> Async task queue (Bull, RabbitMQ, or DB polling)
    └──enhances──> Live Streaming Output (multiplex N SSE streams by run_id)

Unified Diff Viewer
    ├──requires──> Tool Event Visualization (detect file change events)
    ├──requires──> File diff parsing (extract unified diffs from tool output)
    └──enhances──> Run Details Panel (visual file inspection)

REST API (Programmatic)
    ├──requires──> Task Submission Form (business logic reuse)
    ├──requires──> Run Status Indicator (returns current state)
    ├──requires──> Run History (returns past runs)
    └──interfaces with──> MCP Tools (same data sources)

MCP Tools (trigger_task, list_runs, get_run_status)
    ├──requires──> REST API (same data sources)
    ├──requires──> Database backing (task state persistence)
    └──enhances──> Parallel Run Management (agents can spawn sibling runs)

Streaming Search
    ├──requires──> Tool Event Visualization (indexing data)
    └──requires──> Full-text index (Elasticsearch or database FTS)

Agent Reasoning Visibility
    ├──requires──> Live Streaming Output (AG-UI TEXT_MESSAGE events)
    └──enhances──> Tool Event Detail Panel (show why tool was chosen)

Run Comparison
    ├──requires──> Run History (select 2+ runs to compare)
    ├──requires──> Structured tool event storage (diff algorithm)
    └──enhances──> Error Analysis (debug: why did this fail?)
```

### Dependency Notes

- **Task Submission Form requires Run History:** Users expect new runs to appear immediately in history.
- **Live Streaming Output requires openSweAdapter:** Adapter transforms open-swe's on_tool_start/end events into structured UI events; without this, raw LangGraph events are hard to render.
- **Tool Event Visualization requires openSweAdapter:** Specific tool names (execute, fetch_url, commit_and_open_pr) need specific rendering logic; adapter normalizes these to canonical form.
- **Approval Workflows require both Tool Event Visualization and Run Status Indicator:** User must see what's being approved; run must pause to await response.
- **Parallel Run Management conflicts with naive single-SSE-stream design:** Each run needs independent stream; either multiple SSE connections (event_stream?run_id=123) or WebSocket channels.
- **Unified Diff Viewer conflicts with real-time unified stream:** Diffs require parsing tool output; can't render incrementally. Better: capture diffs, render on demand in detail panel.
- **REST API and MCP Tools share requirements:** Both trigger and monitor runs; code reuse opportunity for business logic.
- **Streaming Search requires structured tool event storage:** Plain text logs unsearchable; JSON lines enable FTS.

---

## MVP Definition

### Launch With (v1: Minimal Open-SWE Dashboard)

Minimum viable product — what's needed to validate the concept. Focuses on run management and streaming visibility.

**Must include:**
- [ ] **openSweAdapter** — Transform on_tool_start/end events into structured tool events; map tool names (execute, fetch_url, commit_and_open_pr, etc.); pass through input/output/status; add heartbeat every 30s
- [ ] **Task submission form** — Input: repo URL, GitHub issue IDs, instructions; Output: POST to /api/runs with task config
- [ ] **Run history table** — List all runs: id, task, status, created_at, duration; sort by date; filter by status (pending/running/done)
- [ ] **Live streaming via SSE** — Dashboard subscribes to /api/runs/{runId}/stream; appends tool events to timeline; shows status transitions
- [ ] **Run status indicator** — Displays: pending → running → completed/failed; last updated timestamp; stop button (graceful shutdown)
- [ ] **Run details panel** — Click run → shows full tool event sequence; each event: tool name, input params, output (first 500 chars truncated), status, exit code
- [ ] **Basic error surfacing** — If tool event has error, display it prominently; capture exit codes from execute events; link to specific invocation
- [ ] **REST API** — POST /api/runs (submit), GET /api/runs (list), GET /api/runs/{id} (details), GET /api/runs/{id}/stream (SSE), DELETE /api/runs/{id} (cancel)
- [ ] **Database schema** — Runs table with: id, user_id, repo_url, issue_ids, instructions, status, created_at, updated_at, result_summary, error_summary

**Why this set:**
- Validates that openSweAdapter + SSE streaming works
- Users can submit and monitor runs end-to-end
- Error cases visible enough to debug
- No approval workflows yet (adds UX complexity)
- No parallel run management yet (need async queue first)
- No MCP tools yet (API stability first)

**Success Criteria:**
- ✓ Users can submit a task and see it stream in real-time
- ✓ Tool events (execute, fetch_url, git, PR) render with tool names and status
- ✓ Failed run shows which tool failed and the error output
- ✓ REST API supports headless run submission
- ✓ Run history persists across restarts
- ✓ Streams don't timeout on 5+ minute tasks (heartbeat working)

### Add After Validation (v1.x: UX Polish & Monitoring)

Features to add once core is working and users are submitting real tasks.

- [ ] **Approval workflows for risky tools** — Agent assesses risk; pauses before PR creation/Slack message; user reviews in modal; REST endpoint for approval response
- [ ] **Tool event detail modal** — Click individual event → full command, full output, exit code, duration; syntax highlighting for shell
- [ ] **Unified diff viewer** — Detect "file modified" tool events; render side-by-side diffs for changed files in detail modal
- [ ] **MCP tools (trigger_task, list_runs, get_run_status)** — Agents can spawn sibling runs, check status, integrate with other tools
- [ ] **Concurrent run tracking** — UI shows multiple running tasks with individual progress bars; queue management if sandbox capacity full
- [ ] **Run comparison UI** — Side-by-side view of two runs; timeline diff of tool events; "why did this fail?"

**Triggers to add these:**
- Approval workflows: When first user attempts a high-risk task (PR creation)
- Detail modal: When users ask "why did the execute command fail?" (100+ times in logs)
- Diff viewer: When users need to review file changes before merging
- MCP tools: When first agent/CI integration attempts to call the API
- Concurrent runs: When first user tries to run 2 tasks in parallel
- Run comparison: When user investigates "run #5 worked but run #6 failed"

**Implementation notes:**
- All v1.x features require no database schema changes
- Approval workflows add a new `approval_pending` status; UI needs a modal component
- MCP tools reuse REST API; just wrap the endpoints

### Future Consideration (v2+)

Features to defer until product-market fit is established and operational complexity understood.

- [ ] **Parallel run management with async queueing** — Bull/RabbitMQ queue; track multiple concurrent runs; manage sandbox quotas; complex operational setup
- [ ] **Run-to-run state persistence** — Sandboxes cached between runs; agent can reuse repo state; requires sandbox lifecycle management + security audit
- [ ] **Streaming search** — Full-text index of tool output + reasoning; requires Elasticsearch or database FTS; adds infrastructure
- [ ] **Agent reasoning visibility** — Capture LLM thinking steps; render in thread below tool events; requires AG-UI TEXT_MESSAGE event handling
- [ ] **Automatic retry suggestions** — On failure, AI proposes "try this" as prefilled form; requires ML over run history + heuristics
- [ ] **Custom tool definitions** — Users define new tools beyond execute/fetch/git; requires schema validation + security review
- [ ] **Workflow templates** — Save common task patterns (e.g., "fix test suite", "update deps"); users fill in blanks
- [ ] **Org-level run analytics** — Dashboard: most common failures, slowest tools, cost per run; requires aggregation

**Why defer:**
- Parallel runs: Sandbox architecture not yet proven; adds operational complexity
- Cached state: High risk of subtle bugs (state leakage); requires safety audit
- Search: Nice-to-have for large run histories; add when users exceed 100 runs
- Reasoning: Interesting but not critical; reasoning steps are in logs/stream events
- Retry suggestions: ML over run history requires corpus; wait until 100+ runs exist
- Custom tools: Security nightmare without careful design; defer until core is trusted
- Templates: Nice-to-have for power users; MVP is direct task input
- Analytics: Useful for ops, not for product-market fit; add when users are paying

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority | Notes |
|---------|------------|---------------------|----------|-------|
| openSweAdapter | CRITICAL | MEDIUM | P0 | Entire system depends on this; tool event schema must be stable |
| Task submission form | HIGH | LOW | P0 | Users need a way to submit work; simple form input |
| Run history table | HIGH | MEDIUM | P0 | Users expect to find old runs; requires DB schema |
| Live streaming output | HIGH | MEDIUM | P0 | No feedback = stuck perception; SSE + React state management |
| Run status indicator | HIGH | LOW | P0 | Users need to know if run is working; simple state machine |
| REST API (core endpoints) | HIGH | MEDIUM | P0 | Enables both UI and future programmatic access |
| Stop/cancel run | MEDIUM | MEDIUM | P1 | Nice to have; requires signal handling in open-swe |
| Run details panel | MEDIUM | MEDIUM | P1 | Users drill into failures; essential for debugging |
| Tool event visualization | MEDIUM | MEDIUM | P1 | Tool-specific rendering (shell vs. PR link); critical UX |
| Error surfacing | MEDIUM | MEDIUM | P1 | Without this, failed runs are opaque; parse tool output |
| Approval workflows | MEDIUM-HIGH | HIGH | P2 | Valuable but complex; adds approval state machine |
| Diff viewer | MEDIUM | MEDIUM-HIGH | P2 | Nice to see changes; not critical if detail panel works |
| Concurrent run tracking | MEDIUM | HIGH | P2 | Advanced feature; requires async queue |
| MCP tools | MEDIUM | MEDIUM | P2 | Unlocks automation; can wait until API is stable |
| Run comparison | LOW-MEDIUM | HIGH | P3 | Analytical feature; add after core is proven |
| Streaming search | LOW-MEDIUM | HIGH | P3 | Nice-to-have; full-text search adds complexity |
| Agent reasoning visibility | MEDIUM | MEDIUM | P3 | Interesting but not critical; reasoning in logs |
| Retry suggestions | LOW-MEDIUM | MEDIUM | P3 | Requires ML corpus; add after 100+ runs exist |

**Priority key:**
- **P0 (Must have for v1 launch):** Blocks validation; users can't use product without it
- **P1 (Should have, add in v1.x):** Improves UX significantly; low risk to add after launch
- **P2 (Nice to have, consider for v2):** Valuable but can wait; assess after market feedback
- **P3 (Future, v3+):** Advanced; defer until product-market fit proven

---

## Feature Interaction Patterns

### Run Lifecycle (Happy Path)

```
User submits form (repo="langchain-ai/open-swe", issues=[42], instructions="fix typo")
    → POST /api/runs
        → Validate input; create Run in DB with status="pending"
        → Return { runId: "run_123", status: "pending" }

Dashboard immediately subscribes to /api/runs/run_123/stream
    → SSE: { type: "status_change", status: "running", timestamp: ... }
    → SSE: { type: "tool_start", tool: "fetch_url", input: "https://github.com/langchain-ai/open-swe/pull/42", id: "tool_1" }
    → SSE: { type: "tool_end", tool: "fetch_url", status: "success", output: "<issue description>", duration_ms: 340 }
    → SSE: { type: "tool_start", tool: "execute", input: "cd /repo && grep -r typo .", id: "tool_2" }
    → SSE: { type: "tool_output", id: "tool_2", text: "src/index.ts:42: typo in variable name" }
    → SSE: { type: "tool_end", tool: "execute", status: "success", exit_code: 0, duration_ms: 1200 }
    → ... (more tool events)
    → SSE: { type: "tool_start", tool: "commit_and_open_pr", input: "fix: correct typo in src/index.ts", id: "tool_N" }
    → SSE: { type: "tool_end", tool: "commit_and_open_pr", status: "success", output: "PR #9999 opened", duration_ms: 2340 }
    → SSE: { type: "status_change", status: "completed", timestamp: ... }

Dashboard timeline shows:
    [RUNNING] fetch_url → PR description loaded (340ms)
    [SUCCESS] execute → Found typo in line 42 (1200ms)
    ... (other steps)
    [SUCCESS] commit_and_open_pr → PR #9999 created (2340ms)
    [COMPLETED] Run took 5 minutes 24 seconds

User clicks tool_2 event → detail panel shows:
    Command: cd /repo && grep -r typo .
    Status: success
    Exit code: 0
    Output: src/index.ts:42: typo in variable name
    Duration: 1200ms
```

### Error Path (With Error Surfacing)

```
User submits form (repo="...", issues=[99], instructions="implement new feature")
    → POST /api/runs
    → Return { runId: "run_456", status: "pending" }

Dashboard subscribes to /api/runs/run_456/stream
    → SSE: { type: "status_change", status: "running" }
    → SSE: { type: "tool_start", tool: "execute", input: "npm test", id: "tool_1" }
    → SSE: { type: "tool_output", id: "tool_1", text: "FAIL: expected 42 received 41" }
    → SSE: { type: "tool_end", tool: "execute", status: "error", exit_code: 1, error_type: "test_failure", duration_ms: 3450 }
    → SSE: { type: "status_change", status: "failed", error_summary: "Test suite failed with exit code 1", timestamp: ... }

Dashboard timeline shows:
    [RUNNING] execute → Test suite (3450ms)
    [ERROR] execute → Test suite failed: FAIL: expected 42 received 41
            ↳ EXIT CODE: 1
            ↳ TYPE: test_failure

Status bar shows red: "FAILED — Test suite failed with exit code 1 at 14:32:45"

User clicks error event → detail panel shows full output:
    Command: npm test
    Status: error
    Exit code: 1
    Error type: test_failure
    Full output: (entire test output, truncated in timeline)
    Duration: 3450ms

User can now:
    1. Click [Retry] → submits new run with same config
    2. Click [Edit Task] → modifies instructions and resubmits
    3. Look at run history to compare with previous attempts
```

### Approval Workflow (When Enabled)

```
Agent decides to create PR (high-risk tool)
    → openSweAdapter detects tool: "commit_and_open_pr" with risk_level: "high"
    → SSE: { type: "tool_start", tool: "commit_and_open_pr", risk: "high", preview: { title: "...", body: "..." }, id: "tool_N" }
    → Run pauses (status: "approval_pending")

Dashboard shows modal:
    "🚨 Approval Required"
    "Agent wants to create a pull request"
    Title: "fix: handle null check in UserService"
    Body: (first 200 chars of PR description)
    [Approve] [Reject] [Edit & Resubmit]

User clicks [Approve]
    → POST /api/runs/run_789/approve { tool_id: "tool_N", approved: true }
    → Backend resumes run
    → SSE: { type: "tool_resume", tool_id: "tool_N" }
    → SSE: { type: "tool_end", tool: "commit_and_open_pr", status: "success", output: "PR #9999 created", duration_ms: 1200 }
    → SSE: { type: "status_change", status: "completed" }

Dashboard timeline shows:
    [APPROVAL_PENDING] commit_and_open_pr → (paused)
                        ↳ USER APPROVED at 14:33:10
    [SUCCESS] commit_and_open_pr → PR #9999 created (1200ms)
    [COMPLETED] Run completed
```

---

## Competitor Feature Analysis

| Feature | Codex (OpenAI) | Claude Code | VS Code + Copilot | Our Approach |
|---------|----------------|------------|------------------|----|
| **Task submission** | Command palette / natural language | Direct prompting | Commands/inline chat | Form-based; structured inputs (repo, issue, instructions) |
| **Run visibility** | Terminal output + inline editor changes | Real-time diffs in editor | Terminal + diff sidebar | Timeline of tool events + detail modal |
| **Run history** | Implicit in editor undo/chat history | Chat transcript | Not persistent; implicit in file system | Explicit table with status, timestamps, searchable |
| **Tool visualization** | Inline code edits shown in editor | Real-time diffs in editor | Inline suggestions + diff review | Tool events as timeline items; click for detail |
| **Approval flows** | Implicit: user reviews inline changes | Implicit: user accepts/rejects edits | Implicit: user accepts suggestion | Explicit: modal review for risky tools before execute |
| **Error handling** | User sees errors in terminal | Visible in chat + error messages | Terminal + inline diagnostics | Surfaced in tool event; linked to command that failed |
| **Parallel runs** | N/A (single editor session) | N/A (single chat thread) | N/A (single terminal) | Queue multiple tasks; track all in history |
| **Programmatic access** | API (experimental) | API (planned) | None | REST API + MCP tools; automation-first |
| **Streaming pattern** | Inline editing as agent works | Live delta updates to code | Real-time suggestions | SSE event stream; append-only; no state reconciliation |

**Our Differentiation:**
- **Explicit run history:** Codex/Claude/VSCode focus on the editing surface; we focus on the task history. Better for batch/background work, dev teams, CI/CD automation.
- **Form-based task submission:** More structured than chat; clearer for complex tasks (multiple repos, linked issues, custom instructions).
- **Tool event transparency:** Timeline of what the agent did; easy to debug. Competitors blur tool execution into editing or chat.
- **Approval workflows:** Explicit gate for risky actions; reduces surprise failures. Competitors relegate approval to implicit user review.
- **REST/MCP APIs:** Enable automation and integration; competing tools are editor/IDE-centric, harder to integrate into workflows.
- **Run comparison & analytics:** Tools for understanding why a task succeeded or failed; competitors lack this.

**Our Weaknesses vs. Competitors:**
- No real-time code editing (Codex, Claude Code, VSCode do this). Our model: agent makes changes, user reviews via diffs, then merges.
- No interactive chat mid-run (competitors allow asking clarifying questions). Our model: approval workflows instead (safer, less disruptive).
- Requires setup (Next.js, database, MCP server). Competitors integrate into IDEs (lower setup friction).

**Market Implication:**
We're not competing with Codex/Claude Code/VSCode—we're complementing them. Our target: autonomous task management (CI/CD, dev team automation, complex multi-step tasks). Their target: interactive coding (individual developer at keyboard).

---

## Sources

### Core Frameworks & Patterns
- [Introducing Open SWE: An Open-Source Asynchronous Coding Agent](https://blog.langchain.com/introducing-open-swe-an-open-source-asynchronous-coding-agent/)
- [GitHub - langchain-ai/open-swe](https://github.com/langchain-ai/open-swe)
- [LangGraph: Agent Orchestration Framework for Reliable AI Agents](https://www.langchain.com/langgraph)
- [AG-UI Overview - Agent User Interaction Protocol](https://docs.ag-ui.com/introduction)

### Streaming & Real-Time UI Patterns
- [Using server-sent events - Web APIs | MDN](https://developer.mozilla.org/en-us/docs/Web/API/Server-sent_events/Using_server-sent_events)
- [How to Implement Server-Sent Events (SSE) in React](https://oneuptime.com/blog/post/2026-01-15-server-sent-events-sse-react/view)
- [Real-time Log Streaming with Node.js and React using Server-Sent Events (SSE) - DEV Community](https://dev.to/manojspace/real-time-log-streaming-with-nodejs-and-react-using-server-sent-events-sse-48pk)
- [Vercel AI SDK useChat in Production: Streaming, Errors, and the Patterns Nobody Writes About - DEV Community](https://dev.to/whoffagents/vercel-ai-sdk-usechat-in-production-streaming-errors-and-the-patterns-nobody-writes-about-4ecf)

### Tool Visualization & UI Components
- [react-diff-view - npm](https://www.npmjs.com/package/react-diff-view)
- [Git Diff View - High-Performance Diff Component for React, Vue, Solid & Svelte](https://mrwangjusttodo.github.io/git-diff-view/)
- [react-diff-viewer: A simple and beautiful text diff viewer component](https://github.com/praneshr/react-diff-viewer)
- [Terminal | React Components & Templates](https://magicui.design/docs/components/terminal)
- [Ink — React for interactive command-line apps](https://github.com/vadimdemedes/ink)

### Run & Task Management Patterns
- [UI patterns for async workflows, background jobs, and data pipelines - LogRocket Blog](https://blog.logrocket.com/ux-design/ui-patterns-for-async-workflows-background-jobs-and-data-pipelines/)
- [Background tasks with progress updates: UI patterns that work | AppMaster](https://appmaster.io/blog/background-tasks-progress-ui)
- [Making agents practical for real-world development - VS Code Blog](https://code.visualstudio.com/blogs/2026/03/05/making-agents-practical-for-real-world-development)

### Agentic Design & Approval Flows
- [Designing For Agentic AI: Practical UX Patterns For Control, Consent, And Accountability — Smashing Magazine](https://www.smashingmagazine.com/2026/02/designing-agentic-ai-practical-ux-patterns/)
- [Building Interactive Agent UIs with AG-UI and Microsoft Agent Framework | Microsoft Community Hub](https://techcommunity.microsoft.com/blog/azuredevcommunityblog/building-interactive-agent-uis-with-ag-ui-and-microsoft-agent-framework/4488249)
- [Agent UI: The Essential Chat Interface for AI Agents - BrightCoding](https://www.blog.brightcoding.dev/2026/03/26/agent-ui-the-essential-chat-interface-for-ai-agents/)

### MCP & Automation
- [MCP Apps - Bringing UI Capabilities To MCP Clients | Model Context Protocol Blog](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/)
- [Complete Guide to MCP (Model Context Protocol) in 2026 — Architecture, Implementation, and Enterprise Roadmap - DEV Community](https://dev.to/x4nent/complete-guide-to-mcp-model-context-protocol-in-2026-architecture-implementation-and-4a11)

### Concurrent Execution & Parallelism
- [Best Multi-Agent Frameworks in 2026: LangGraph, CrewAI ...](https://gurusup.com/blog/best-multi-agent-frameworks-2026)
- [AI agent frameworks that actually work for cross-functional teams in 2026](https://monday.com/blog/ai-agents/ai-agent-frameworks/)
- [5 Key Trends Shaping Agentic Development in 2026 - The New Stack](https://thenewstack.io/5-key-trends-shaping-agentic-development-in-2026/)

---

*Feature research for: open-swe integration layer (UI/API/MCP)*
*Researched: 2026-05-04*
*Focus: Run management UX patterns, tool event visualization, streaming output display*
*Related research: OPENSWE-INTEGRATION-RESEARCH-SUMMARY.md (pitfalls), PITFALLS-OPENSWE-INTEGRATION.md (detailed)*
