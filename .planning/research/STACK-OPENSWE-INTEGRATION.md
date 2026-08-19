# Technology Stack: open-swe Integration Layer

**Project:** deepagents-nextjs + open-swe integration milestone  
**Researched:** 2026-05-04  
**Confidence Level:** HIGH (LangGraph SDK versions verified; stack minimal due to reuse strategy)

## Executive Summary

The open-swe integration layer requires **minimal new stack additions** to the existing deepagents-nextjs monorepo. The core integration point is the LangGraph Platform REST API, accessed via `@langchain/langgraph-sdk` v1.8.9 (published 2026-04-21). The new `openSweAdapter` applies the same stateless transform pattern used by `langGraphAdapter` to normalize LangGraph Platform tool events to AI SDK v6 format. The dashboard (`apps/open-swe`) reuses existing Next.js + shadcn/ui + Tailwind stack with zero new npm dependencies. The MCP layer extends `@modelcontextprotocol/sdk` v1.12.0 with four new async tools, all implemented inline — no new packages needed.

**Core principle:** Reuse existing patterns. The `langGraphAdapter` already proven in v1.2-01 demonstrates that composable transforms work for LangGraph event normalization. `openSweAdapter` applies the same architecture to LangGraph Platform's `client.runs.stream()` tool events. No new transport library, no new streaming abstraction — just composable event transforms.

---

## Recommended Stack by Component

### 1. Server Package Additions (`@deepagents-nextjs/server`)

**Add to `packages/server/package.json`:**

| Dependency | Version | Purpose | Why This Version |
|------------|---------|---------|------------------|
| @langchain/langgraph-sdk | ^1.8.9 | LangGraph Platform REST API client | Current (published 2026-04-21, 13 days ago). Provides `Client` class with `client.runs.stream(threadId, assistantId, { streamMode: "tools" })` for tool-call lifecycle events. Stable; no known breaking changes. |
| @langchain/langgraph | ^1.2.9 | Type definitions for LangGraph events | Current (published 2026-04-26, 8 days ago). Used by openSweAdapter to type-check event discriminant `event: "on_tool_start" | "on_tool_event" | "on_tool_end" | "on_tool_error"`. Optional but recommended for DX. |

**Installation:**
```bash
cd packages/server
npm install @langchain/langgraph-sdk@^1.8.9 @langchain/langgraph@^1.2.9
```

### 2. New Adapter (`openSweAdapter`)

**Location:** `packages/server/src/adapters/open-swe.ts` (inline, no new package)

**Dependencies:** Inherited from `packages/server`

| Technology | Version | Purpose |
|------------|---------|---------|
| TypeScript | ^5.8.3 | Type-safe event normalization | Same as v1.2; no bump needed |
| (SseFrameAccumulator pattern) | — | Reuse SSE frame splitting logic | Adapter receives pre-split frames from accumulator; handles `data: {...}` lines and `[DONE]` terminator |

**Pattern:** Identical to `langGraphAdapter` but routes on `event` field instead of platform-specific type discriminant.

```typescript
export const openSweAdapter: SseAdapter = {
  name: "open-swe",
  transforms: [openSweToAiSdk], // Maps LangGraph Platform tool events to AI SDK v6
};

// Transform function receives frame from SseFrameAccumulator
function openSweToAiSdk(frame: SseFrame): SseFrame | null {
  // 1. Extract data line
  // 2. Check for LangGraph Platform event shape (has "event" discriminant)
  // 3. Map event type: on_tool_start → tool-call-start, on_tool_end → tool-result, etc.
  // 4. Return normalized frame or null to drop
}
```

### 3. Dashboard Package (`apps/open-swe`)

**New package:** Create as new Next.js App Router app (similar to `apps/example`).

**Dependencies:** All reused from existing monorepo stack.

| Dependency | Version | Purpose | Already In Monorepo? |
|------------|---------|---------|---------------------|
| next | ^15.0.0 | App Router framework | Yes (apps/example uses this) |
| react | ^19.0.0 | Component library | Yes (peerDep of @deepagents-nextjs/react) |
| react-dom | ^19.0.0 | React DOM bindings | Yes (apps/example uses this) |
| tailwindcss | ^4.0.0 | Styling utility framework | Yes (apps/example configured) |
| zod | ^4.0.0 | Schema validation | Yes (monorepo-wide) |
| @deepagents-nextjs/react | workspace:* | useDeepAgentsChat hook + message types | Yes (package) |
| @deepagents-nextjs/server | workspace:* | SseAdapter types + patterns | Yes (package) |
| ai | ^6.0.0 | AI SDK client library | Yes (apps/example uses this) |

**shadcn/ui Components (vendored, no npm entry):**
- @shadcn/ui/button
- @shadcn/ui/card
- @shadcn/ui/table (wraps TanStack Table v8)
- @shadcn/ui/badge
- @shadcn/ui/toast
- @shadcn/ui/input
- @shadcn/ui/dialog

**Optional (NOT required for MVP):**
- recharts ^3.0.0 — Charts for token usage/run duration analytics (recommend for Phase 2 if dashboard needs visualizations)

**Why zero new dependencies:**
- `useDeepAgentsChat` hook already handles SSE streaming + message state
- shadcn/ui is vendored by `npx shadcn-ui@latest init` (copied into `components/ui/`, no package.json entry)
- TanStack Table v8 included with shadcn/table component
- No new HTTP clients, no new state management, no new UI library

**Installation:**
```bash
# Create app
mkdir -p apps/open-swe
cd apps/open-swe
npm install next@^15.0.0 react@^19.0.0 react-dom@^19.0.0 zod@^4.0.0 ai@^6.0.0 \
  @deepagents-nextjs/react@workspace:* \
  @deepagents-nextjs/server@workspace:*

# Dev deps
npm install -D typescript@^5.8.3 @types/node@^22.0.0 @types/react@^19.0.0 @types/react-dom@^19.0.0 tailwindcss@^4.0.0

# Set up shadcn/ui
npx shadcn-ui@latest init
# Choose: TypeScript, Tailwind CSS, CSS variables (defaults)

# Add components as needed
npx shadcn-ui@latest add button card table badge toast input dialog
```

### 4. MCP Server Extensions (`@deepagents-nextjs/mcp`)

**No new npm packages.** Extend existing `@deepagents-nextjs/mcp` with four new async tools.

| Dependency | Version | Purpose | Change Needed? |
|------------|---------|---------|----------------|
| @modelcontextprotocol/sdk | ^1.12.0 | MCP server implementation (already in use) | No; v1.12.0 already supports async tool handlers |

**New MCP Tools (inline in `packages/mcp/src/tools/open-swe/index.ts`):**
1. `trigger_task` — POST to LangGraph Platform, return threadId + assistantId
2. `list_runs` — Query run history
3. `get_run_status` — Poll run state (database-backed, not LangGraph polling)
4. `stream_run_output` — Get cached run output

**Why async-first:** LangGraph Platform operations take 5-30+ seconds; MCP v1.12.0 fully supports `async (input) => { ... }` handlers.

---

## Streaming Integration: LangGraph Platform → AI SDK v6

### Transport Pattern

```
LangGraph Platform API
    ↓ client.runs.stream()
SSE response (HTTP 200, Content-Type: text/event-stream)
    ↓ fetch() on server, wrap in Response
Server action / API route
    ↓ returns Response with body = readable stream
    ↓ SseFrameAccumulator (from @deepagents-nextjs/server)
Frame objects { raw: "data: {...}" }
    ↓ openSweAdapter transform pipeline
Normalized frames { raw: "data: {type: \"tool-result\", ...}" }
    ↓ useDeepAgentsChat hook (client-side)
Message union: ToolCallMessage | ToolResultMessage | ErrorMessage
    ↓ React components
Live dashboard updates
```

### Supported Stream Modes

LangGraph Platform SDK accepts `streamMode: "tools"` (and can combine with other modes):

| Mode | Events Emitted | Usage |
|------|----------------|-------|
| "tools" | on_tool_start, on_tool_event, on_tool_end, on_tool_error | For tool-call lifecycle display |
| "updates" | state deltas | For intermediate task progress |
| "messages" | LLM token stream | For debugging / token-level output |

**openSweAdapter handles "tools" mode.** If dashboard needs other modes, extend transforms accordingly.

### Event Lifecycle: Incoming → Normalized

**Incoming LangGraph Platform event (via client.runs.stream()):**

```json
{
  "event": "on_tool_start",
  "name": "bash_execute",
  "run_id": "run-xyz-123",
  "data": {
    "tool_call": {
      "id": "call_456",
      "name": "bash_execute",
      "args": { "command": "git status" }
    }
  }
}
```

**Normalized to AI SDK v6 format by openSweAdapter:**

```json
{
  "type": "tool-call-start",
  "toolName": "bash_execute",
  "toolUseId": "call_456",
  "args": { "command": "git status" }
}
```

Then React client parses as `ToolCallMessage`.

### Server Action Pattern

```typescript
// apps/open-swe/app/actions.ts
"use server"

import { Client } from "@langchain/langgraph-sdk";
import { createDeepAgentsHandler } from "@deepagents-nextjs/server";
import { openSweAdapter } from "@deepagents-nextjs/server/adapters";

const client = new Client({
  apiUrl: process.env.LANGGRAPH_API_URL || "http://localhost:2024",
});

export async function submitTask(input: TaskInput) {
  // 1. Create LangGraph thread + run
  const result = await client.threads.create();
  const threadId = result.thread_id;

  // 2. Start run with tool streaming
  const run = client.runs.stream(threadId, "open-swe-agent", {
    input,
    streamMode: "tools", // Receive tool-call lifecycle
  });

  // 3. Return run ID for client to fetch
  return { threadId, assistantId: "open-swe-agent" };
}

// API route wrapper (if needed for fetch)
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const threadId = searchParams.get("threadId");
  const assistantId = searchParams.get("assistantId");

  // Stream run via createDeepAgentsHandler with openSweAdapter
  const response = await createDeepAgentsHandler({
    backendUrl: `${process.env.LANGGRAPH_API_URL}/threads/${threadId}/runs`,
    adapter: openSweAdapter,
  })(req);

  return response;
}
```

---

## Technology Decisions (Why NOT?)

### Why NOT: New SSE library (`eventsource`, `sse.js`)

**Considered:** Explicit SSE client library for lower-level control.  
**Decision:** Use `@langchain/langgraph-sdk`'s `client.runs.stream()` async iterable.  
**Rationale:** SDK handles reconnection, backoff, auth headers automatically. No need to reinvent SSE parsing. Existing `SseFrameAccumulator` in `@deepagents-nextjs/server` already handles frame splitting from fetch responses.

### Why NOT: Real-time database (Firebase, Supabase)

**Considered:** Real-time subscription to run state for dashboard updates.  
**Decision:** Poll LangGraph Platform API via `client.runs.stream()` only.  
**Rationale:** LangGraph Platform already manages run state durably. Adding RTDB introduces deployment complexity and new failure modes. Poll pattern sufficient for MVP.

### Why NOT: Specialized agent UI library

**Considered:** Libraries like `agent-ui`, `chat-ui`, etc.  
**Decision:** shadcn/ui + TanStack Table v8 (via shadcn/table).  
**Rationale:** shadcn/ui is vendored (no package lock-in), TanStack Table proven in production, existing team familiarity. Zero new dependencies.

### Why NOT: WebSocket for streaming

**Considered:** WebSocket for bidirectional streaming.  
**Decision:** Stick with SSE (HTTP/1.1 unidirectional).  
**Rationale:** LangGraph Platform API uses SSE/REST. WebSocket would require custom server-to-server WebSocket bridge (out of scope). SSE sufficient for task streaming.

### Why NOT: Upgrade MCP to v2

**Considered:** Wait for MCP v2 (anticipated Q1 2026, possibly past cutoff).  
**Decision:** Stay on v1.12.0.  
**Rationale:** v1.12.0 released within last 30 days; async tool handlers fully supported. v2 may have breaking changes. Ship stable now, upgrade later.

### Why NOT: GraphQL subscriptions

**Considered:** GraphQL subscriptions for run state.  
**Decision:** REST + SSE (LangGraph Platform shape).  
**Rationale:** Minimal client code. LangGraph Platform doesn't expose GraphQL. Overkill for this integration.

---

## Version Compatibility Matrix

| Package | Version | Required By | Status | Notes |
|---------|---------|-------------|--------|-------|
| @langchain/langgraph-sdk | ^1.8.9 | openSweAdapter | ✓ Current | Supports `streamMode` array; async iterable streams |
| @langchain/langgraph | ^1.2.9 | openSweAdapter types | ✓ Current | Type definitions only; optional for DX |
| next | ^15.0.0 | apps/open-swe | ✓ Existing | Already in monorepo via apps/example |
| react | ^19.0.0 | apps/open-swe | ✓ Existing | Already peerDepended by @deepagents-nextjs/react |
| ai | ^6.0.0+ | apps/open-swe | ✓ Existing | Already in apps/example; no bump needed |
| @modelcontextprotocol/sdk | ^1.12.0 | @deepagents-nextjs/mcp | ✓ Existing | No bump needed; async handlers already supported |
| TypeScript | ^5.8.3 | All packages | ✓ Existing | No change from v1.2 |
| pnpm | 9.0.0 | Monorepo | ✓ Existing | No change needed |
| Turborepo | ^2.9.6 | Monorepo | ✓ Existing | No change needed |

---

## Verification Checklist

Pre-phase implementation:

- [ ] `@langchain/langgraph-sdk@1.8.9` installs via pnpm without conflicts
- [ ] `client.runs.stream()` API accepts `streamMode: "tools"` parameter
- [ ] LangGraph Platform local dev server (`langgraph dev`) runs at `http://localhost:2024`
- [ ] `openSweAdapter` transform correctly maps `on_tool_start` → `tool-call-start` in vitest
- [ ] SSE frame accumulation works for multi-line tool event data (integration test)
- [ ] `apps/open-swe` can import `useDeepAgentsChat` from `@deepagents-nextjs/react` without errors
- [ ] shadcn/ui components vendor correctly via `npx shadcn-ui@latest init`
- [ ] MCP server loads new open-swe tools without v1.12.0 compatibility errors
- [ ] No new peerDependencies leak to consumers (validate with `publint` + `attw`)

---

## Configuration & Environment

### LangGraph Platform Connection (apps/open-swe)

```bash
# .env.local (development)
LANGGRAPH_API_URL=http://localhost:2024
LANGGRAPH_API_KEY=optional-if-local

# .env.production (cloud deployment)
LANGGRAPH_API_URL=https://api.langchain-platform.com/...
LANGGRAPH_API_KEY=secretkey-...
```

### MCP Tool Configuration (packages/mcp)

```typescript
// packages/mcp/src/tools/open-swe/index.ts
export const openSweTools = {
  trigger_task: {
    description: "Trigger an open-swe coding task on LangGraph Platform",
    inputSchema: {
      type: "object",
      properties: {
        task_description: { type: "string" },
        // ... other fields
      },
      required: ["task_description"],
    },
  },
  // ... other tools
};
```

---

## Sources

### LangGraph Platform & SDKs
- [@langchain/langgraph-sdk - npm](https://www.npmjs.com/package/@langchain/langgraph-sdk)
- [@langchain/langgraph - npm](https://www.npmjs.com/package/@langchain/langgraph)
- [Streaming - Docs by LangChain](https://docs.langchain.com/oss/javascript/langgraph/streaming)
- [LangGraph.js API Reference](https://langchain-ai.github.io/langgraphjs/reference/modules/langgraph-sdk.html)
- [Local development & testing - Docs by LangChain](https://docs.langchain.com/langsmith/local-server)

### MCP
- [@modelcontextprotocol/sdk - npm](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
- [MCP Tools - Model Context Protocol](https://modelcontextprotocol.info/docs/concepts/tools/)
- [Streaming Progress from MCP in Real Time - Medium (2026)](https://medium.com/@leonid.o.babich/streaming-progress-from-mcp-in-real-time-faaa29c1b574)

### open-swe
- [Open SWE: An Open-Source Framework for Internal Coding Agents](https://blog.langchain.com/open-swe-an-open-source-framework-for-internal-coding-agents/)
- [GitHub - langchain-ai/open-swe](https://github.com/langchain-ai/open-swe)

### UI & Dashboard
- [shadcn/ui Installation - Next.js](https://ui.shadcn.com/docs/installation/next)
- [Vercel AI SDK 6 - Vercel](https://vercel.com/blog/ai-sdk-6)
- [AI SDK UI: useChat](https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat)
- [Build a Dashboard with shadcn/ui (2026)](https://designrevision.com/blog/shadcn-dashboard-tutorial)

---

**Status:** Ready for phase implementation  
**Next Steps:** Use this stack as the foundation for Phase 1 (openSweAdapter) and Phase 2 (apps/open-swe dashboard)
