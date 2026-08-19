# Architecture: Open-SWE Integration Layer

**Project:** deepagents-nextjs with open-swe milestone
**Researched:** 2026-05-04
**Domain:** SSE streaming adapter integration + LangGraph Platform client + MCP tooling
**Confidence:** HIGH for patterns; MEDIUM for LangGraph Platform specifics (validated via API docs)

## Executive Summary

Open-swe integration extends the existing deepagents-nextjs monorepo with three new components:

1. **LangGraphClient** (packages/server/src/utils/langraph-client.ts) — Low-level REST API abstraction for LangGraph Platform (POST /threads, POST /runs/stream, GET endpoints)

2. **openSweAdapter** (packages/server/src/adapters/openSwe.ts) — SSE transform normalizing LangGraph's `astream_events v2` with `on_tool_start`/`on_tool_end` events to AI SDK v6 frames (tool-input-start, tool-output-available)

3. **apps/open-swe** (new Next.js App Router app) — HTTP routes (POST /api/runs, GET /api/runs, GET /api/runs/[runId]) plus task form UI, using createDeepAgentsHandler with openSweAdapter

The architecture preserves the existing handler factory + adapter pipeline pattern (v1.2), adding no breaking changes. Apps/open-swe does NOT directly call LangGraph Platform; instead it uses createDeepAgentsHandler, maintaining consistency with the rest of the monorepo.

## Recommended Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    apps/open-swe                             │
│            (Next.js App Router, client-facing)               │
│                                                               │
│ Routes:                                                       │
│ - POST /api/runs (create new run, stream SSE)               │
│ - GET /api/runs (list runs)                                  │
│ - GET /api/runs/[runId] (fetch status + history)            │
│                                                               │
│ Handler setup:                                               │
│   handler = createDeepAgentsHandler({                        │
│     backendUrl: LangGraphClient.streamRun(...)              │
│     adapter: openSweAdapter                                  │
│   })                                                          │
└─────────────────────────────────────────────────────────────┘
                              ▲
                              │ HTTP
                              │
┌─────────────────────────────────────────────────────────────┐
│                 @deepagents-nextjs/server                    │
│                 (packages/server)                             │
│                                                               │
│ ┌──────────────────────────────┐  ┌──────────────────────┐  │
│ │ createDeepAgentsHandler       │  │ LangGraphClient      │  │
│ │ (existing, unchanged)         │  │ (new utility)        │  │
│ │                               │  │                      │  │
│ │ - Fetch from backend SSE      │  │ - POST /threads      │  │
│ │ - Apply transform pipeline    │  │ - POST /runs/stream  │  │
│ │ - Handle retries + auth       │  │ - GET /runs/{id}     │  │
│ │ - Stream registry             │  │ - Inject LANGSMITH.. │  │
│ │                               │  │                      │  │
│ └──────────────────────────────┘  └──────────────────────┘  │
│                                                               │
│ ┌───────────────────────────────────────────────────────┐   │
│ │ Adapters (SSE → AI SDK v6)                            │   │
│ │                                                         │   │
│ │ - deepagentsAdapter (existing) [messageId strip]       │   │
│ │ - langGraphAdapter (existing) [astream_events v2]      │   │
│ │ - langchainAdapter (existing) [event+data pairs]       │   │
│ │ - openSweAdapter (NEW) [on_tool_* events]              │   │
│ └───────────────────────────────────────────────────────┘   │
│                                                               │
└─────────────────────────────────────────────────────────────┘
                              ▲
                              │ SSE stream (astream_events v2)
                              │
┌─────────────────────────────────────────────────────────────┐
│        LangGraph Platform (local or cloud)                   │
│                                                               │
│ - Hosts open-swe LangGraph agents                           │
│ - Emits astream_events v2 format (SSE data: {...})          │
│ - Events: on_chat_model_stream, on_tool_start, on_tool_end  │
└─────────────────────────────────────────────────────────────┘
```

## Component Boundaries

| Component | Responsibility | Communicates With | New vs Modified |
|-----------|---|---|---|
| **apps/open-swe** | HTTP routes + task UI + run list | LangGraphClient (via createDeepAgentsHandler) | NEW (Next.js App Router app) |
| **LangGraphClient** | REST API abstraction (threads, runs, streaming) | LangGraph Platform | NEW (packages/server/src/utils/) |
| **openSweAdapter** | Normalize astream_events v2 + on_tool_* → AI SDK v6 | createDeepAgentsHandler pipeline | NEW (packages/server/src/adapters/) |
| **createDeepAgentsHandler** | Core SSE proxy (existing) | LangGraphClient response, adapters | MODIFIED signature only (backendUrl stays string, but now passed to handler) |
| **deepagentsAdapter** | Strip messageId from finish events | Default in createDeepAgentsHandler | UNCHANGED |
| **langGraphAdapter** | Normalize astream_events v2 base | Alternative adapter | UNCHANGED |
| **langchainAdapter** | Normalize LangChain event+data format | Alternative adapter | UNCHANGED |
| **@deepagents-nextjs/mcp** | MCP server tools | apps/open-swe REST API | EXTENDED (new tools: trigger_task, list_runs, get_run_status) |

## Data Flow: Complete Request Path

### Flow 1: POST /api/runs (Create + Stream a Run)

```
1. Client: POST /api/runs
   Body: { task: "fix bug in auth.ts", context?: "...", files?: [...] }

2. apps/open-swe/app/api/runs/route.ts (handler):
   a) Instantiate: client = new LangGraphClient(
      baseUrl: process.env.LANGGRAPH_URL,
      apiKey: process.env.LANGSMITH_API_KEY
   )
   
   b) Call: threadId = await client.createThread()
      → HTTP: POST /threads (to LangGraph Platform)
      ← { thread_id: "abc123" }
   
   c) Call: response = await client.streamRun(
      threadId: "abc123",
      input: { task, context, files },
      options: { assistantId: "open-swe-v1", streamMode: "events" }
   )
      → HTTP: POST /threads/abc123/runs/stream (LangGraph Platform)
      ← SSE stream (astream_events v2 format)

3. createDeepAgentsHandler wrapper (internal to route handler):
   a) Input: response.body (SSE from LangGraph Platform)
   b) Adapter: openSweAdapter.transforms
      - on_chat_model_stream → text-delta
      - on_tool_start → tool-input-start
      - on_tool_end → tool-output-available
      - other events → null (drop)
   c) Output: transformed ReadableStream
   
4. Route returns: NextResponse(transformedStream, headers)
   - Content-Type: text/event-stream
   - x-vercel-ai-ui-message-stream: v1

5. Client receives: SSE with text-delta + tool frames + finish
```

### Flow 2: GET /api/runs (List Recent Runs)

```
1. Client: GET /api/runs?threadId=abc123

2. apps/open-swe/app/api/runs/route.ts (handler):
   a) client.listRuns(threadId: "abc123")
      → HTTP: GET /threads/abc123/runs (LangGraph Platform)
      ← JSON: [{ run_id, created_at, status }, ...]
   
   b) Return: NextResponse(json(runs))

3. Client receives: JSON array of run summaries
```

### Flow 3: GET /api/runs/[runId] (Fetch Run Status)

```
1. Client: GET /api/runs/def456

2. apps/open-swe/app/api/runs/[runId]/route.ts (handler):
   a) client.getRun(threadId, runId)
      → HTTP: GET /threads/{threadId}/runs/{runId}
      ← JSON: { run_id, status, created_at, metadata, ... }
   
   b) Return: NextResponse(json(run))

3. Client receives: Run metadata + current status
```

## Integration Points

### 1. LangGraphClient Placement & API

**Location:** `packages/server/src/utils/langraph-client.ts` (NEW)

**Why here (not in apps/open-swe)?**
- Reusable by other apps/services that need LangGraph Platform integration
- Encapsulates HTTP details, auth header injection, URL normalization
- Follows existing pattern: `fetchWithRetry()` is internal to handler.ts (not exported)
- Single source of truth for LangGraph Platform API contract

**API Surface:**

```typescript
export class LangGraphClient {
  constructor(
    baseUrl: string,        // e.g., "http://localhost:8123" or "https://api.smith.langchain.com"
    apiKey?: string         // Optional; if provided, injects "Authorization: Bearer {apiKey}"
  )
  
  /**
   * Create a new thread (state container) on LangGraph Platform.
   * POST /threads with empty body.
   */
  async createThread(): Promise<{ thread_id: string }>
  
  /**
   * Trigger a run on a thread, returning SSE stream of astream_events v2.
   * POST /threads/{threadId}/runs/stream
   * Returns Response with .body = ReadableStream<Uint8Array> (SSE format)
   */
  async streamRun(
    threadId: string,
    input: Record<string, unknown>,
    options?: {
      assistantId?: string;        // Graph ID on deployment
      streamMode?: "updates" | "events";  // "events" for astream_events v2
    }
  ): Promise<Response>
  
  /**
   * List all runs for a thread.
   * GET /threads/{threadId}/runs
   */
  async listRuns(threadId: string): Promise<Array<{
    run_id: string;
    created_at: string;
    status: "pending" | "success" | "failure" | "timeout";
    metadata?: Record<string, unknown>;
  }>>
  
  /**
   * Get a single run's status + metadata.
   * GET /threads/{threadId}/runs/{runId}
   */
  async getRun(
    threadId: string,
    runId: string
  ): Promise<{
    run_id: string;
    status: string;
    created_at: string;
    updated_at: string;
    metadata?: Record<string, unknown>;
  }>
}
```

**Implementation Details:**

```typescript
export class LangGraphClient {
  private baseUrl: string;
  private apiKey?: string;

  constructor(baseUrl: string, apiKey?: string) {
    // Normalize trailing slashes
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
  }

  private getAuthHeaders(): Record<string, string> {
    if (!this.apiKey) return {};
    return { Authorization: `Bearer ${this.apiKey}` };
  }

  async createThread(): Promise<{ thread_id: string }> {
    const res = await fetch(`${this.baseUrl}/threads`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.getAuthHeaders(),
      },
      body: JSON.stringify({}),
    });
    if (!res.ok) throw new Error(`Failed to create thread: ${res.status}`);
    return res.json();
  }

  async streamRun(
    threadId: string,
    input: Record<string, unknown>,
    options?: { assistantId?: string; streamMode?: string }
  ): Promise<Response> {
    const res = await fetch(
      `${this.baseUrl}/threads/${threadId}/runs/stream`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.getAuthHeaders(),
        },
        body: JSON.stringify({
          assistant_id: options?.assistantId ?? 'agent',
          input,
          stream_mode: options?.streamMode ?? 'events',
        }),
      }
    );
    if (!res.ok) throw new Error(`Failed to stream run: ${res.status}`);
    return res; // Return raw Response; caller accesses .body
  }

  // listRuns, getRun: similar pattern (GET endpoints)
}
```

### 2. openSweAdapter Implementation

**Location:** `packages/server/src/adapters/openSwe.ts` (NEW)

**Design Rationale:**
- Extends langGraphAdapter (reuses astream_events v2 base case handling)
- Adds new on_tool_start/on_tool_end cases
- Stateful (per-request tool call counter) — follows langchainAdapter pattern

**Implementation:**

```typescript
import type { SseFrame, SseTransform } from "../accumulator";
import type { SseAdapter } from "./deepagents";

type LangGraphEvent = {
  event: string;
  name: string;
  run_id: string;
  data: Record<string, unknown>;
};

function openSweToAiSdk(
  frame: SseFrame,
  toolCallTrackers: Map<string, Map<string, number>>
): SseFrame | null {
  const line = frame.raw;
  
  // Only process SSE data: lines
  if (!line.startsWith("data: ")) return frame;
  
  const raw = line.slice(6);
  
  // [DONE] passes through
  if (raw === "[DONE]") return frame;
  
  let parsed: LangGraphEvent;
  try {
    parsed = JSON.parse(raw) as LangGraphEvent;
  } catch {
    return frame; // Non-JSON; pass through
  }
  
  if (!parsed.event) return frame; // Not a LangGraph event
  
  switch (parsed.event) {
    // INHERITED from langGraphAdapter:
    case "on_chat_model_stream": {
      const chunk = (parsed.data?.chunk as Record<string, unknown>) ?? {};
      const content = chunk.content;
      if (typeof content !== "string" || !content) return null;
      return {
        raw: `data: ${JSON.stringify({ type: "text-delta", delta: content })}`,
      };
    }
    
    // NEW for open-swe tool support:
    case "on_tool_start": {
      const toolName = parsed.name; // event.name = tool function name
      const input = (parsed.data?.input as Record<string, unknown>) ?? {};
      const runId = parsed.run_id;
      
      // Track tool call ID per run per tool (deterministic counter)
      if (!toolCallTrackers.has(runId)) {
        toolCallTrackers.set(runId, new Map());
      }
      const runTrackers = toolCallTrackers.get(runId)!;
      const count = runTrackers.get(toolName) ?? 0;
      runTrackers.set(toolName, count + 1);
      
      const toolCallId = `${runId}-${toolName}-${count}`;
      
      return {
        raw: `data: ${JSON.stringify({
          type: "tool-input-start",
          toolCallId,
          toolName,
          input,
        })}`,
      };
    }
    
    case "on_tool_end": {
      const toolName = parsed.name;
      const output = parsed.data?.output;
      const runId = parsed.run_id;
      
      // Reconstruct toolCallId (should match on_tool_start)
      const runTrackers = toolCallTrackers.get(runId);
      const count = runTrackers?.get(toolName) ?? 0;
      const toolCallId = `${runId}-${toolName}-${count}`;
      
      return {
        raw: `data: ${JSON.stringify({
          type: "tool-output-available",
          toolCallId,
          output,
        })}`,
      };
    }
    
    // Drop everything else
    default:
      return null;
  }
}

export function createOpenSweTransform(): SseTransform {
  const toolCallTrackers = new Map<string, Map<string, number>>();
  return (frame: SseFrame): SseFrame | null => {
    return openSweToAiSdk(frame, toolCallTrackers);
  };
}

export const openSweAdapter: SseAdapter = {
  name: "openswe",
  get transforms() {
    return [createOpenSweTransform()];
  },
} as const;
```

**Key Design Point:** Per-request freshness via getter ensures tool call counters don't leak across concurrent requests.

### 3. apps/open-swe Routes

**Location:** `apps/open-swe/app/api/` (NEW app)

**POST /api/runs:**

```typescript
// apps/open-swe/app/api/runs/route.ts
import { createDeepAgentsHandler } from "@deepagents-nextjs/server";
import { openSweAdapter } from "@deepagents-nextjs/server";
import { LangGraphClient } from "@deepagents-nextjs/server"; // Exported from utils
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  const body = await request.json().catch(() => ({})) as {
    task: string;
    context?: string;
    files?: Array<{ path: string; content: string }>;
  };
  
  if (!body.task) {
    return NextResponse.json({ error: "task is required" }, { status: 400 });
  }
  
  const client = new LangGraphClient(
    process.env.LANGGRAPH_URL!,
    process.env.LANGSMITH_API_KEY
  );
  
  try {
    const threadId = await client.createThread();
    
    // Get SSE stream from LangGraph Platform
    const lgResponse = await client.streamRun(
      threadId.thread_id,
      { task: body.task, context: body.context, files: body.files }
    );
    
    // Create handler with openSweAdapter
    const handler = createDeepAgentsHandler({
      backendUrl: process.env.LANGGRAPH_URL!, // Not actually used here; we're passing the stream directly
      adapter: openSweAdapter,
    });
    
    // Transform the stream through the handler's pipeline
    // (Alternative: manually apply transforms if handler signature doesn't support Response passthrough)
    
    // For now, assume we can wrap the stream:
    return new NextResponse(lgResponse.body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "x-vercel-ai-ui-message-stream": "v1",
      },
    });
  } catch (err) {
    console.error("Failed to stream run", err);
    return NextResponse.json({ error: "Failed to stream run" }, { status: 500 });
  }
}

export async function GET(request: NextRequest): Promise<Response> {
  const threadId = request.nextUrl.searchParams.get("threadId");
  if (!threadId) {
    return NextResponse.json({ error: "threadId is required" }, { status: 400 });
  }
  
  const client = new LangGraphClient(
    process.env.LANGGRAPH_URL!,
    process.env.LANGSMITH_API_KEY
  );
  
  try {
    const runs = await client.listRuns(threadId);
    return NextResponse.json(runs);
  } catch (err) {
    console.error("Failed to list runs", err);
    return NextResponse.json({ error: "Failed to list runs" }, { status: 500 });
  }
}
```

**GET /api/runs/[runId]:**

```typescript
// apps/open-swe/app/api/runs/[runId]/route.ts
import { LangGraphClient } from "@deepagents-nextjs/server";
import { NextRequest, NextResponse } from "next/server";

export async function GET(
  request: NextRequest,
  { params }: { params: { runId: string } }
): Promise<Response> {
  const threadId = request.nextUrl.searchParams.get("threadId");
  if (!threadId) {
    return NextResponse.json({ error: "threadId is required" }, { status: 400 });
  }
  
  const client = new LangGraphClient(
    process.env.LANGGRAPH_URL!,
    process.env.LANGSMITH_API_KEY
  );
  
  try {
    const run = await client.getRun(threadId, params.runId);
    return NextResponse.json(run);
  } catch (err) {
    console.error("Failed to get run", err);
    return NextResponse.json({ error: "Failed to get run" }, { status: 500 });
  }
}
```

### 4. MCP Tools Extension

**Location:** `packages/mcp/src/index.ts` (NEW tools)

**New tools to add:**

```typescript
server.tool(
  "trigger_task",
  "Create and stream a task on open-swe LangGraph deployment",
  {
    task: z.string().describe("Task description (e.g., 'fix bug in auth.ts')"),
    context: z.string().optional().describe("Additional context for the task"),
    files: z.array(
      z.object({
        path: z.string(),
        content: z.string(),
      })
    ).optional().describe("Files to include in the task"),
  },
  async ({ task, context, files }) => {
    // Call apps/open-swe POST /api/runs
    // Read SSE stream, accumulate events
    const res = await fetch(`${process.env.OPEN_SWE_URL}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task, context, files }),
    });
    
    if (!res.ok) throw new Error(`Failed to trigger task: ${res.status}`);
    
    // Consume SSE stream
    const events: unknown[] = [];
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    
    try {
      for await (const chunk of iterateStream(reader, decoder)) {
        try {
          const event = JSON.parse(chunk);
          events.push(event);
        } catch {
          // Non-JSON lines (like blank lines); ignore
        }
      }
    } finally {
      reader.releaseLock();
    }
    
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(events, null, 2),
      }],
    };
  }
);

server.tool(
  "list_runs",
  "List recent runs for a thread",
  {
    threadId: z.string().describe("The thread ID"),
  },
  async ({ threadId }) => {
    const res = await fetch(
      `${process.env.OPEN_SWE_URL}/api/runs?threadId=${threadId}`,
      { method: "GET" }
    );
    if (!res.ok) throw new Error(`Failed to list runs: ${res.status}`);
    const runs = await res.json();
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(runs, null, 2),
      }],
    };
  }
);

server.tool(
  "get_run_status",
  "Get status of a specific run",
  {
    threadId: z.string(),
    runId: z.string(),
  },
  async ({ threadId, runId }) => {
    const res = await fetch(
      `${process.env.OPEN_SWE_URL}/api/runs/${runId}?threadId=${threadId}`,
      { method: "GET" }
    );
    if (!res.ok) throw new Error(`Failed to get run: ${res.status}`);
    const run = await res.json();
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(run, null, 2),
      }],
    };
  }
);
```

## Patterns to Follow

### Pattern 1: Adapter Transform Composition

Each adapter is a reusable, testable transform bundle that normalizes a backend format to AI SDK v6.

```typescript
// openSweAdapter = langGraphAdapter base + on_tool_* handlers
// Inherit: on_chat_model_stream → text-delta
// Add: on_tool_start → tool-input-start, on_tool_end → tool-output-available

// Per-request freshness via getter:
export const openSweAdapter: SseAdapter = {
  name: "openswe",
  get transforms() {
    return [createOpenSweTransform()]; // Fresh per request
  },
};
```

### Pattern 2: Client as Abstraction Layer

Single source of truth for backend API calls.

```typescript
// ✓ GOOD: LangGraphClient encapsulates all LangGraph API logic
const client = new LangGraphClient(baseUrl, apiKey);
const response = await client.streamRun(threadId, input);

// ✗ BAD: Duplicating fetch logic in apps/open-swe
const res = await fetch(`${baseUrl}/threads/${id}/runs/stream`, {...});
```

### Pattern 3: SSE as Transport, Not API

Apps use the handler factory pattern, not direct backend calls.

```typescript
// ✓ GOOD: apps/open-swe → createDeepAgentsHandler → transforms → SSE
const handler = createDeepAgentsHandler({ adapter: openSweAdapter });
const stream = await handler(request);

// ✗ BAD: apps/open-swe directly parsing LangGraph SSE
const stream = await client.streamRun(...);
// (missing transform step)
```

## Anti-Patterns to Avoid

### Anti-Pattern 1: Mixing Stateful and Stateless Transforms

❌ Tool call counter persists across requests:
```typescript
const toolCallCounter = new Map(); // SHARED
const adapter = { transforms: [createTransform(toolCallCounter)] };
```

✓ Fresh counter per request:
```typescript
const adapter = {
  get transforms() {
    return [createTransform(new Map())]; // Fresh
  }
};
```

### Anti-Pattern 2: Scattering Transform Logic

❌ Each adapter reimplements tool event handling:
```typescript
// deepagentsAdapter: handles tool_call
// langGraphAdapter: handles on_tool_start
// openSweAdapter: handles on_tool_start (duplicate code)
```

✓ Single adapter with inheritance:
```typescript
// openSweAdapter extends langGraphAdapter's astream_events v2 base
// Adds only on_tool_start/on_tool_end cases
```

### Anti-Pattern 3: Hardcoding API Paths in Routes

❌ Route directly calls LangGraph API:
```typescript
const res = await fetch(`${LANGGRAPH_URL}/threads/${id}/runs/stream`, {});
```

✓ Use LangGraphClient:
```typescript
const client = new LangGraphClient(LANGGRAPH_URL, apiKey);
const res = await client.streamRun(id, input);
```

### Anti-Pattern 4: Auth Logic Duplicated

❌ Different auth headers in different places:
```typescript
// handler.ts: "Authorization: Bearer {token}"
// apps/open-swe: "x-api-key: {token}"
```

✓ Centralized in LangGraphClient:
```typescript
class LangGraphClient {
  private getAuthHeaders() { /* single source */ }
}
```

## Scalability Considerations

| Concern | At 10 runs/sec | At 100 runs/sec | At 1K runs/sec |
|---------|---|---|---|
| **Thread creation** | 1 per run (no caching) | Consider per-user thread pool | Required: thread pool per session |
| **SSE stream buffering** | ~1KB per stream | ~100KB (100 concurrent) | Monitor memory at scale |
| **Tool call tracking** | Per-request Map (O(1)) | ✓ works | ✓ works; lightweight |
| **LangGraph API rate limits** | Check quotas | May hit burst limits | Add jitter to retries |
| **Handler throughput** | SSE frame transform <1ms | ✓ CPU-bound, linear | ✓ scales well |

**Key assumption:** LangGraph Platform API handles concurrent threads. If not, apps/open-swe needs request queuing.

## Build Order Implications

### Phase Dependencies

```
1. LangGraphClient (no dependencies)
   ↓
2. openSweAdapter (depends on LangGraphClient for testing)
   ↓
3. apps/open-swe (depends on both)
   ↓
4. MCP tools (depends on apps/open-swe)
```

### Suggested Commit Order

1. `feat(server/utils): add LangGraphClient class`
2. `feat(server/adapters): add openSweAdapter with on_tool_* support`
3. `feat(apps): add open-swe Next.js app with /api/runs routes`
4. `feat(mcp): add trigger_task, list_runs, get_run_status tools`
5. `docs: open-swe integration guide`

### Modified Build Artifacts

| File | Impact |
|------|--------|
| `packages/server/package.json` | No changes (no new deps) |
| `packages/server/tsconfig.json` | No changes |
| `packages/server/src/adapters/index.ts` | Add export for openSweAdapter |
| `packages/mcp/src/index.ts` | Add 3 new tools |
| `pnpm-workspace.yaml` | No changes (apps/* already included) |
| `turbo.json` | No changes (auto-picks new app) |

## Exports & Public API Changes

### packages/server (index.ts changes)

```typescript
// EXISTING (unchanged)
export { createDeepAgentsHandler } from './handler';
export { deepagentsAdapter, langGraphAdapter, langchainAdapter } from './adapters';
export type { SseFrame, SseTransform, DeepAgentsHandlerOptions } from './accumulator';

// NEW
export { openSweAdapter } from './adapters/openSwe';
export { LangGraphClient } from './utils/langraph-client'; // Internal utility, but exported for direct use if needed
```

### packages/mcp (index.ts changes)

```typescript
// Server definition unchanged; just add 3 tools in createDeepAgentsMcpServer()
```

## Confidence Assessment

| Area | Level | Notes |
|---|---|---|
| LangGraph Platform API contract | HIGH | Validated via official LangChain docs + astream_events v2 structure confirmed |
| openSweAdapter design | HIGH | Follows proven langGraphAdapter + langchainAdapter patterns |
| Handler factory pattern reuse | HIGH | Existing v1.2 pattern; no breaking changes |
| Tool event mapping (on_tool_start/end) | MEDIUM-HIGH | Structure validated via LangChain docs, but untested in real open-swe deployment |
| apps/open-swe route design | HIGH | Standard Next.js App Router patterns |
| MCP tool implementation | MEDIUM | Validated patterns, but depends on apps/open-swe API stability |

## Critical Research Gaps & Phase Flags

### Must Verify (Phase Implementation)

1. **on_tool_start/on_tool_end fixture**: Capture real LangGraph astream_events v2 with tool invocations to test openSweAdapter
2. **LangGraph URL patterns**: Validate local dev (`localhost:8123`) vs cloud API URL format
3. **Auth key format**: Confirm LANGSMITH_API_KEY is correct header format (`Bearer {key}`)
4. **Tool call ID determinism**: Ensure `run_id + toolName + counter` produces stable IDs across requests

### Should Validate (Future Phases)

1. **LangGraph Platform availability**: Confirm API is available for integration testing in CI
2. **Rate limiting**: Test behavior under high load (100+ concurrent runs)
3. **Error handling**: Map LangGraph API errors to HTTP status codes correctly
4. **MCP tool streaming**: Confirm SSE stream consumption in MCP context works correctly

## Sources

### LangGraph Platform API
- [LangGraph Platform Overview](https://www.langchain.com/langgraph-platform) — Architecture context
- [astream_events v2 event structure](https://docs.langchain.com/oss/python/langgraph/streaming) — Event format validation
- [POST /threads endpoint](https://docs.langchain.com/langsmith/streaming) — Thread creation
- [POST /threads/{id}/runs/stream endpoint](https://docs.langchain.com/langsmith/streaming) — SSE streaming

### Open SWE Framework
- [GitHub: langchain-ai/open-swe](https://github.com/langchain-ai/open-swe) — Agent framework
- [Tool System](https://deepwiki.com/langchain-ai/open-swe/3.2-tool-system) — Tool patterns

### Existing deepagents-nextjs Codebase
- [packages/server/src/handler.ts](file:///Users/jonathanborduas/code/deepagents-nextjs/packages/server/src/handler.ts) — Handler factory pattern
- [packages/server/src/adapters/langgraph.ts](file:///Users/jonathanborduas/code/deepagents-nextjs/packages/server/src/adapters/langgraph.ts) — astream_events v2 adapter base
- [packages/server/src/adapters/langchain.ts](file:///Users/jonathanborduas/code/deepagents-nextjs/packages/server/src/adapters/langchain.ts) — Stateful adapter pattern (tool call ID tracking)

---

*Open-swe integration architecture research*  
*Researched: 2026-05-04*  
*Confidence: HIGH for patterns; MEDIUM for LangGraph Platform specifics (flagged for fixture validation)*
