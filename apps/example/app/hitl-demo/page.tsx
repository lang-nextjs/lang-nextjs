"use client";

import { useMemo, useState } from "react";
import {
  useDeepAgentsChat,
  useApprovalCardController,
  ApprovalCard,
  ApprovalSchema,
  DataHumanResponseSchema,
  DataErrorSchema,
  type MessageWithCustom,
} from "@deepagents-nextjs/react";

type HitlSchemas = {
  "data-approval-required": typeof ApprovalSchema;
  "data-human-response": typeof DataHumanResponseSchema;
  // AI SDK v6 only attaches a data-* part to message.parts when its type has
  // a registered schema. We register data-error here so partsToMessages
  // (which has a built-in DataErrorSchema branch) sees the part and emits
  // an ErrorMessage entry the page can render.
  "data-error": typeof DataErrorSchema;
};

type HitlMessage = MessageWithCustom<HitlSchemas>;

// No hand-written type guards here (#59). `MessageWithCustom<HitlSchemas>` is a
// discriminated union on `type`, with each member's `data` inferred from the
// REGISTERED Zod schema — so `m.type === "data-approval-required"` narrows
// natively and correctly. The predicates this replaced asserted
// `m is { type: ...; data: DataApproval }` through an `as` cast, which told the
// compiler a payload shape instead of deriving it: had the schema changed, the
// guard would have kept claiming the old type. They existed because
// `data-approval-required` was missing from the library's schema map; it is
// registered now.

const PROXY_ENDPOINTS: Record<string, string> = {
  default: "/api/hitl-demo",
  timeout: "/api/hitl-demo-timeout",
  multi: "/api/hitl-demo-multi",
};

export default function HitlDemoPage() {
  const [sessionId] = useState(() => `hitl-${Date.now()}`);
  const schemas: HitlSchemas = useMemo(
    () => ({
      "data-approval-required": ApprovalSchema,
      "data-human-response": DataHumanResponseSchema,
      "data-error": DataErrorSchema,
    }),
    []
  );

  // ?proxy=timeout|multi selects an alternate proxy; default otherwise.
  const proxyEndpoint = useMemo(() => {
    if (typeof window === "undefined") return PROXY_ENDPOINTS.default;
    const proxy = new URLSearchParams(window.location.search).get("proxy");
    return PROXY_ENDPOINTS[proxy ?? "default"] ?? PROXY_ENDPOINTS.default;
  }, []);

  const {
    messages,
    sendMessage,
    status,
    error: chatError,
  } = useDeepAgentsChat<HitlSchemas>({
    sessionId,
    endpoint: proxyEndpoint,
    schemas,
  });

  const {
    cardPropsFor,
    status: respondStatus,
    error: respondError,
  } = useApprovalCardController({
    endpoint: "/api/approval",
  });

  // Hide the approval card once the user resolves it (each card carries the
  // approval id; the SSE side doesn't push a follow-up status update, so we
  // dismiss client-side after a successful submit).
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  return (
    <main
      data-testid="hitl-demo-page"
      style={{
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        padding: "1.5rem",
        maxWidth: 720,
        margin: "0 auto",
      }}
    >
      <h1>HITL Demo</h1>
      <p data-testid="status">Status: {status}</p>

      <button
        type="button"
        data-testid="start-button"
        onClick={() => sendMessage("List the files in /tmp")}
        disabled={status === "streaming" || status === "submitted"}
        style={{ padding: "0.5rem 1rem", marginBottom: "1rem" }}
      >
        Start demo run
      </button>

      <section aria-label="Conversation">
        {messages.map((m, idx) => {
          if (m.type === "data-approval-required") {
            const approval = m.data;
            if (dismissed.has(approval.id)) return null;
            const wired = cardPropsFor(approval);
            const dismiss = () =>
              setDismissed((s) => new Set(s).add(approval.id));
            return (
              <div
                key={`approval-${approval.id}-${idx}`}
                style={{
                  border: "1px solid #d1d5db",
                  borderRadius: 8,
                  padding: "0.75rem",
                  margin: "0.5rem 0",
                }}
              >
                <ApprovalCard
                  {...wired}
                  onApprove={async () => {
                    await wired.onApprove();
                    dismiss();
                  }}
                  onReject={async () => {
                    await wired.onReject();
                    dismiss();
                  }}
                  onEdit={async (editedInput) => {
                    await wired.onEdit!(editedInput);
                    dismiss();
                  }}
                  onRespond={async (response) => {
                    await wired.onRespond!(response);
                    dismiss();
                  }}
                />
              </div>
            );
          }
          if (m.type === "data-human-response") {
            const data = m.data;
            return (
              <div
                key={`hr-${data.id}-${idx}`}
                data-testid="human-response"
                style={{
                  background: "#fef3c7",
                  borderRadius: 8,
                  padding: "0.5rem 0.75rem",
                  margin: "0.5rem 0",
                  fontStyle: "italic",
                }}
              >
                You replied: {data.response}
              </div>
            );
          }
          if ((m as { type: string }).type === "user") {
            return (
              <div
                key={`u-${idx}`}
                data-testid="user-msg"
                style={{ color: "#1e3a8a" }}
              >
                You: {(m as { content: string }).content}
              </div>
            );
          }
          if ((m as { type: string }).type === "ai") {
            return (
              <div
                key={`a-${idx}`}
                data-testid="ai-msg"
                style={{ color: "#111827" }}
              >
                Agent: {(m as { content: string }).content}
              </div>
            );
          }
          if ((m as { type: string }).type === "tool-call") {
            const t = m as {
              type: "tool-call";
              toolName: string;
              status: string;
              arguments?: Record<string, unknown>;
              result?: unknown;
            };
            return (
              <div
                key={`t-${idx}`}
                data-testid="tool-call-msg"
                data-tool-name={t.toolName}
                data-tool-status={t.status}
                style={{ fontFamily: "ui-monospace, monospace" }}
              >
                tool {t.toolName} [{t.status}]
                {t.arguments !== undefined && (
                  <pre data-testid="tool-arguments">
                    {JSON.stringify(t.arguments, null, 2)}
                  </pre>
                )}
                {t.result !== undefined && (
                  <pre data-testid="tool-result">
                    {JSON.stringify(t.result, null, 2)}
                  </pre>
                )}
              </div>
            );
          }
          if ((m as { type: string }).type === "error") {
            const e = m as { message: string };
            return (
              <div key={`e-${idx}`} data-testid="error-msg" role="alert">
                Error: {e.message}
              </div>
            );
          }
          // When data-error is registered in customSchemaMap, the converter
          // emits it as { type: "data-error", data: DataError } instead of
          // the default { type: "error", ... } shape. Handle both.
          if ((m as { type: string }).type === "data-error") {
            const e = m as { data: { code: string; message: string } };
            return (
              <div key={`e-${idx}`} data-testid="error-msg" role="alert">
                Error: {e.data.message}
              </div>
            );
          }
          return null;
        })}
      </section>

      {chatError && (
        <p data-testid="chat-error" role="alert" style={{ color: "#b91c1c" }}>
          Chat error: {chatError.message}
        </p>
      )}

      {respondError && (
        <p data-testid="respond-error" role="alert">
          Approval submit failed: {respondError.message}
        </p>
      )}
      <p data-testid="respond-status">Respond status: {respondStatus}</p>
    </main>
  );
}
