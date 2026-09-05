# @deepagents-nextjs/react

React hook for consuming DeepAgents SSE streams with typed message union and custom data-\* schema support.

## Installation

```bash
npm install @deepagents-nextjs/react
```

## Quick Start

```typescript
import { useDeepAgentsChat } from "@deepagents-nextjs/react";
const { messages, sendMessage, status } = useDeepAgentsChat({
  sessionId: "abc-123",
  endpoint: "/api/chat/stream",
});
```

## API Reference

### `useDeepAgentsChat<TData>(options)`

React hook that wraps `@ai-sdk/react useChat` with a `DefaultChatTransport` pre-wired for the DeepAgents SSE proxy route. Returns typed messages, a send function, status, and error.

**Options:**

| Option      | Type                                                                        | Required | Description                                                                                     |
| ----------- | --------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `sessionId` | `string`                                                                    | yes      | Backend session ID — caller owns session lifecycle                                              |
| `endpoint`  | `string`                                                                    | yes      | SSE proxy route URL, e.g. `'/api/chat/stream'`                                                  |
| `getToken`  | `() => Promise<string \| null \| undefined> \| string \| null \| undefined` | no       | Optional token provider — returns Bearer token string, or `null`/`undefined` for no auth header |
| `schemas`   | `TData`                                                                     | no       | Runtime schema map for custom `data-*` parts (see Custom Data Schemas below)                    |

**Returns:**

| Field         | Type                                              | Description                                                   |
| ------------- | ------------------------------------------------- | ------------------------------------------------------------- |
| `messages`    | `MessageWithCustom<TData>[]`                      | Accumulated messages from the SSE stream, narrowed by `TData` |
| `sendMessage` | `(text: string) => void`                          | Send a user message to the backend                            |
| `status`      | `"idle" \| "streaming" \| "submitted" \| "error"` | Current stream state                                          |
| `error`       | `Error \| null`                                   | Last error, if any                                            |

---

### Message Types

Every message in the `messages` array is one of these discriminated union variants:

| Type              | Fields                                                                     | Description                                                       |
| ----------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `UserMessage`     | `{ role: 'user'; content: string }`                                        | A message sent by the user                                        |
| `AIMessage`       | `{ role: 'assistant'; content: string; isStreaming: boolean }`             | AI response — `isStreaming: true` while the stream is in progress |
| `ToolCallMessage` | `{ type: 'tool-call'; toolName: string; status: 'pending' \| 'complete' }` | A tool invocation from the AI                                     |
| `ErrorMessage`    | `{ type: 'error'; message: string }`                                       | A stream error frame                                              |

---

### Custom Data Schemas

Use the `TData` generic to narrow `data-*` parts at compile time:

```typescript
import { useDeepAgentsChat, PlanSchema } from "@deepagents-nextjs/react";

const { messages } = useDeepAgentsChat<{ "data-plan": typeof PlanSchema }>({
  sessionId: "abc-123",
  endpoint: "/api/chat/stream",
  schemas: { "data-plan": PlanSchema },
});
// messages: (Message | { type: 'data-plan', data: DataPlan })[]
```

The `CustomDataParts` mapped type provides compile-time narrowing — no runtime overhead beyond the Zod parse call.

---

### Exported Zod Schemas

Pre-built schemas for common DeepAgents data parts:

| Export              | Zod Schema       | TypeScript Type |
| ------------------- | ---------------- | --------------- |
| `PlanSchema`        | Plan with tasks  | `DataPlan`      |
| `TaskSchema`        | Individual task  | `DataTask`      |
| `FileSchema`        | File reference   | `DataFile`      |
| `ApprovalSchema`    | Approval request | `DataApproval`  |
| `DataErrorSchema`   | Error data part  | `DataError`     |
| `PlanSubtaskSchema` | Plan subtask     | `PlanSubtask`   |

---

### Utilities

| Export            | Signature                                          | Description                                                                                               |
| ----------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `parseDataPart`   | `(key, schema, value) => ParseDataPartResult`      | Parse a raw data part value against a Zod schema. Returns `{ ok: true, data }` or `{ ok: false, error }`. |
| `partsToMessages` | `(uiMessages, isStreaming, schemas?) => Message[]` | Convert AI SDK v6 UIMessage parts to the DeepAgents message union. Advanced consumers only.               |
| `generateId`      | `() => string`                                     | Generate a random ID string (used internally for session IDs)                                             |
| `assertNever`     | `(x: never) => never`                              | TypeScript exhaustiveness helper                                                                          |

---

## Compatibility

- React 18+
- TypeScript 5.0+

---

## Troubleshooting

**`messages` type is `Message[]` not narrowed**

Pass the `TData` generic and `schemas` option:

```typescript
useDeepAgentsChat<{ "data-plan": typeof PlanSchema }>({
  sessionId,
  endpoint,
  schemas: { "data-plan": PlanSchema },
});
```

Without the generic, `TData` defaults to `Record<never, never>` and no custom narrowing is applied.

**`sendMessage` has no effect**

Check that `status` is `'idle'` before calling `sendMessage`. If the hook is in `'streaming'` or `'submitted'` state, the underlying AI SDK transport will ignore the call.

**`isStreaming` stays `true`**

This means the backend never sent a `finish` frame. Verify that your DeepAgents backend emits `{"type":"finish","finishReason":"stop"}` as the last SSE event in the stream.

---

## Stream Reconnection (Feature Flag)

> **WARNING — Experimental feature with known limitations**
>
> Stream reconnection requires `ENABLE_STREAM_RECONNECT=true` on the server and
> `enableReconnect: true` in the hook options. It is **disabled by default** due to open AI SDK bugs:
>
> - [#6502](https://github.com/vercel/ai/issues/6502): `stop()` does not abort generation when reconnection is active
> - [#11865](https://github.com/vercel/ai/issues/11865): tab switching does not trigger auto-reconnect

### Usage

```tsx
const { messages, sendMessage, retry, status } = useDeepAgentsChat({
  sessionId: "my-session",
  endpoint: "/api/chat/stream",
  // Stream reconnection options (all optional; requires ENABLE_STREAM_RECONNECT=true server-side)
  enableReconnect: true,
  resumeId: "conv-abc-123", // stable per-conversation ID
  resumeEndpoint: "/api/chat/stream/resume", // must match [resumeId] route
});

// Manually retry on tab switch (workaround for AI SDK bug #11865)
useEffect(() => {
  const handleVisibilityChange = () => {
    if (document.visibilityState === "visible") retry();
  };
  document.addEventListener("visibilitychange", handleVisibilityChange);
  return () =>
    document.removeEventListener("visibilitychange", handleVisibilityChange);
}, [retry]);
```

### Reconnection Options

| Option            | Type      | Default | Description                                                                                         |
| ----------------- | --------- | ------- | --------------------------------------------------------------------------------------------------- |
| `enableReconnect` | `boolean` | `false` | Enable stream reconnection. Requires `ENABLE_STREAM_RECONNECT=true` on the server                   |
| `resumeId`        | `string`  | —       | Stable per-conversation ID sent as `X-Resume-Id` header. Required when `enableReconnect` is true    |
| `resumeEndpoint`  | `string`  | —       | URL of the GET resume handler (e.g. `/api/chat/[resumeId]/stream`). Required when `resumeId` is set |

### `retry()` Return Value

`retry(): void` — Manually triggers stream reconnection. No-op when `enableReconnect` is false.

Sets `status` to `'submitted'` during reconnection so the UI can show a loading indicator:

```tsx
{
  status === "submitted" && <p>Reconnecting…</p>;
}
<button onClick={retry} disabled={status === "submitted"}>
  Retry
</button>;
```

## Human-in-the-Loop (HITL)

The package ships a complete approval flow that maps to the four LangGraph
`HumanInterrupt` response modes (`accept`, `ignore`, `edit`, `response`).

These components render a decision and send it back. What a decision changes is
decided on the server: `approvalGating` in `@deepagents-nextjs/server` gates the
frames the client receives, not whether the tool runs. Read
[What this gates](../server/README.md#what-this-gates--read-this-before-designing-around-it)
before building a flow that assumes a rejected action did not happen.

### Quick Start

```tsx
import {
  useDeepAgentsChat,
  useApprovalCardController,
  ApprovalCard,
  type DataApproval,
} from "@deepagents-nextjs/react";

function Chat() {
  const { messages } = useDeepAgentsChat({
    sessionId: "abc",
    endpoint: "/api/chat/stream",
  });

  // One call wires approve / reject / edit / respond for every approval card.
  const { cardPropsFor } = useApprovalCardController({
    endpoint: "/api/approval", // server-side createApprovalRoutes() mount
  });

  return (
    <>
      {messages.map((m) => {
        if (m.type === "data-approval") {
          return <ApprovalCard key={m.data.id} {...cardPropsFor(m.data)} />;
        }
        // …render other message types…
      })}
    </>
  );
}
```

### `useApprovalResponse(options)`

Low-level hook that POSTs decisions to the approval route. Useful when you
want full control over the UI (instead of using `ApprovalCard`).

| Option      | Type                                       | Required | Description                                             |
| ----------- | ------------------------------------------ | -------- | ------------------------------------------------------- |
| `endpoint`  | `string`                                   | yes      | Base path — `${endpoint}/${approvalId}` is the POST URL |
| `getToken`  | same shape as `useDeepAgentsChat.getToken` | no       | Bearer token provider                                   |
| `fetchImpl` | `typeof fetch`                             | no       | Override for tests                                      |

Returns:

```ts
{
  respond(id: string, decision: "approve" | "reject"): Promise<...>;
  respond(id: string, decision: "edit",    payload: { editedInput: object }): Promise<...>;
  respond(id: string, decision: "respond", payload: { response: string }):   Promise<...>;
  status: "idle" | "submitting" | "success" | "error";
  error: Error | null;
  reset(): void;
}
```

Non-2xx responses reject with an `ApprovalResponseError` carrying
`statusCode` and parsed `body` for typed error handling.

### `ApprovalCard`

A minimal headless-ish UI with four modes. Provide only the handlers for the
modes you want exposed — Edit and Respond buttons only render when
`onEdit` / `onRespond` are passed.

```tsx
<ApprovalCard
  approval={dataApproval}
  onApprove={() => respond(id, "approve")}
  onReject={() => respond(id, "reject")}
  onEdit={(editedInput) => respond(id, "edit", { editedInput })}
  onRespond={(response) => respond(id, "respond", { response })}
  disabled={status === "submitting"}
  className="rounded border p-4"
/>
```

Edit mode renders a JSON textarea pre-populated with the current arguments
and validates client-side (rejects non-object / invalid JSON with an inline
`role="alert"` error). Respond mode renders a text input; submit is disabled
while empty. All buttons disable automatically when `approval.status !==
"waiting"` (already resolved) or when `disabled` is set.

Every affordance has a `data-testid` for E2E / unit testing — see the test
suite for the full set.

### `useApprovalCardController(options)` (recommended)

Composes `useApprovalResponse` + `ApprovalCard` into a single call.
`cardPropsFor(approval, overrides?)` returns ready-to-spread props that POST
to the configured endpoint. The `disabled` flag auto-flips to `true` while a
submission is in-flight.

```tsx
const { cardPropsFor, status, error } = useApprovalCardController({
  endpoint: "/api/approval",
});

<ApprovalCard {...cardPropsFor(approval)} />;
// override individual handlers:
<ApprovalCard
  {...cardPropsFor(approval, {
    onApprove: () => { telemetry.track("approve"); return respond(...); },
  })}
/>;
// hide a mode by replacing its handler with undefined:
<ApprovalCard {...cardPropsFor(approval, { onEdit: undefined })} />;
```

### `data-human-response` frame

When a human picks `respond`, the server emits a new SSE frame with the text
reply in place of the tool frames. The tool's frames are suppressed, not the
tool call — see [Approval Gating](../server/README.md#approval-gating-adapt-05)
in `@deepagents-nextjs/server` for what this gates and what it does not. Parse
it with
`parseDataPart(envelope)` or import `DataHumanResponseSchema`:

```ts
import {
  parseDataPart,
  type DataHumanResponse,
} from "@deepagents-nextjs/react";

const parsed = parseDataPart(rawEnvelope);
if (parsed.ok && parsed.type === "data-human-response") {
  const data = parsed.data as DataHumanResponse;
  // Forward data.response back to the agent as a new user message.
}
```

The buffered tool action does **not** execute when respond is chosen — the
text reply replaces it. Consumers typically forward `response` back to the
LLM as a new user message.

---

### Known Limitations

- **`stop()` does not abort**: When `enableReconnect: true`, calling `stop()` will not abort ongoing generation (AI SDK bug [#6502](https://github.com/vercel/ai/issues/6502)). Do not expose a stop button when reconnection is enabled.
- **Tab switching does not auto-reconnect**: Only page reload / component remount triggers reconnection automatically (AI SDK bug [#11865](https://github.com/vercel/ai/issues/11865)). Use the `retry()` + Page Visibility API workaround shown above.
- **In-memory registry**: The server-side registry is a reference implementation. See `@deepagents-nextjs/server` README for production Redis guidance.
