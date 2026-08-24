"use client";

import { useState, useRef, useEffect } from "react";
import {
  useDeepAgentsChat,
  // Published card components — the example app dogfoods these directly so
  // the E2E suite exercises the same components consumers ship with, rather
  // than bespoke re-implementations. PlanProgress is rendered *inside*
  // PlanCard, so using PlanCard here also demonstrates it.
  PlanCard,
  TaskCard,
  FileCard,
  ApprovalCard,
  SubAgentCard,
  HumanResponseCard,
  TodoCard,
  AgentsMdCard,
  PlanSchema,
  TaskSchema,
  FileSchema,
  ApprovalSchema,
  TodoSchema,
  AgentsMdSchema,
  DataSubAgentSchema,
  DataHumanResponseSchema,
  DataErrorSchema,
  type DataPlan,
  type DataTask,
  type DataFile,
  type DataApproval,
  type DataTodo,
  type DataAgentsMd,
  type DataSubAgent,
  type DataHumanResponse,
  type DataError,
} from "@deepagents-nextjs/react";
import type {
  AIMessage,
  ToolCallMessage,
  UserMessage,
} from "@deepagents-nextjs/react";

// Matrix axes: pythonBackend × aiBackend × topology = 12-cell demo grid.
// Adapter is implied by aiBackend on the proxy side, not user-selectable.
type AiBackend = "deepagents" | "langgraph" | "langchain";
type PythonBackend = "django" | "fastapi";
type Topology = "react" | "plan-execute";

// Which topologies each AI backend currently exposes. All three frameworks
// now support both react and plan-execute — the matrix is at full 2×3×2 = 12 cells.
const TOPOLOGIES_BY_AI: Record<AiBackend, Topology[]> = {
  deepagents: ["react", "plan-execute"],
  langgraph: ["react", "plan-execute"],
  langchain: ["react", "plan-execute"],
};

type DataPlanMsg = { type: "data-plan"; data: DataPlan };
type DataTaskMsg = { type: "data-task"; data: DataTask };
type DataFileMsg = { type: "data-file"; data: DataFile };
type DataApprovalMsg = { type: "data-approval"; data: DataApproval };
type DataSubAgentMsg = { type: "data-sub-agent"; data: DataSubAgent };
type DataHumanResponseMsg = {
  type: "data-human-response";
  data: DataHumanResponse;
};
type DataErrorMsg = { type: "data-error"; data: DataError };
type DataTodoMsg = { type: "data-todo"; data: DataTodo };
type DataAgentsMdMsg = { type: "data-agents-md"; data: DataAgentsMd };

// Shared bubble shell — the published cards are headless (className passthrough),
// so the example wraps each in a consistent left-aligned bubble and forwards
// the bubble styling to the card's outer element via `className`.
function CardRow({ children }: { children: React.ReactNode }) {
  return <div className="flex justify-start">{children}</div>;
}

const BUBBLE = "max-w-sm rounded-xl border px-4 py-2 text-sm";

// ---------------------------------------------------------------------------
// Inline bubbles for message kinds the library does NOT export a card for
// (user / assistant / tool-call / error).
// ---------------------------------------------------------------------------

function UserBubble({ msg }: { msg: UserMessage }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-xs rounded-2xl bg-primary px-4 py-2 text-primary-foreground text-sm">
        {msg.content}
      </div>
    </div>
  );
}

function AIBubble({ msg, via }: { msg: AIMessage; via?: string }) {
  return (
    <div className="flex justify-start" data-role="assistant">
      <div className="max-w-sm rounded-2xl bg-card border border-border px-4 py-2 text-foreground text-sm shadow-sm">
        {msg.content}
        {msg.isStreaming && (
          <span className="ml-0.5 inline-block w-2 h-4 bg-muted-foreground animate-pulse" />
        )}
        {via && (
          <div className="mt-1 text-[10px] text-muted-foreground font-mono">{via}</div>
        )}
      </div>
    </div>
  );
}

function ToolCallCard({ msg }: { msg: ToolCallMessage }) {
  return (
    <div className="flex justify-start" data-testid="tool-card">
      <div className="max-w-sm rounded-xl bg-warning/10 border border-warning/40 px-4 py-2 text-sm">
        <div className="flex items-center gap-2">
          <span data-testid="tool-name" className="font-mono text-foreground">
            {msg.toolName}
          </span>
          <span
            data-testid="tool-status"
            className={
              msg.status === "complete"
                ? "rounded-full bg-success/15 text-foreground px-2 py-0.5 text-xs"
                : "rounded-full bg-warning/15 text-foreground px-2 py-0.5 text-xs"
            }
          >
            {msg.status}
          </span>
        </div>
      </div>
    </div>
  );
}

// No library card exists for data-error — keep an inline bubble.
function ErrorBubble({ msg }: { msg: DataErrorMsg }) {
  const err = msg.data;
  return (
    <div className="flex justify-start" data-testid="error-bubble">
      <div className="max-w-sm rounded-xl bg-destructive/10 border border-destructive/40 px-4 py-2 text-sm">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-foreground">Error</span>
          <span
            data-testid="error-code"
            className="rounded bg-destructive/15 px-1.5 py-0.5 text-xs text-foreground font-mono"
          >
            {err?.code}
          </span>
          {err?.retryable && (
            <span className="rounded bg-warning/15 px-1.5 py-0.5 text-xs text-foreground">
              retryable
            </span>
          )}
        </div>
        <p className="mt-1 text-foreground">{err?.message}</p>
      </div>
    </div>
  );
}

export default function ChatPage() {
  const [input, setInput] = useState("");
  const [aiBackend, setAiBackend] = useState<AiBackend>("deepagents");
  const [topology, setTopology] = useState<Topology>("react");
  const [pythonBackend, setPythonBackend] = useState<PythonBackend>("fastapi");
  const [availableBackends, setAvailableBackends] = useState<
    Record<PythonBackend, boolean>
  >({ django: true, fastapi: true });

  // When the user switches AI backend, ensure the current topology is still
  // valid for that backend. If not, reset to "react" (always supported).
  useEffect(() => {
    if (!TOPOLOGIES_BY_AI[aiBackend].includes(topology)) {
      setTopology("react");
    }
  }, [aiBackend, topology]);
  // Track which (python, ai) pair was active when each request was sent.
  // pendingVia is stamped at submit time; assigned to AI messages as they appear.
  const pendingViaRef = useRef<string>("");
  const viaMapRef = useRef<Map<string, string>>(new Map());
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((cfg: { backends: Record<PythonBackend, boolean> }) =>
        setAvailableBackends(cfg.backends)
      )
      .catch(() => {});
  }, []);

  const { messages, sendMessage, status, error } = useDeepAgentsChat<{
    "data-plan": typeof PlanSchema;
    "data-task": typeof TaskSchema;
    "data-file": typeof FileSchema;
    "data-approval": typeof ApprovalSchema;
    "data-sub-agent": typeof DataSubAgentSchema;
    "data-human-response": typeof DataHumanResponseSchema;
    "data-error": typeof DataErrorSchema;
    "data-todo": typeof TodoSchema;
    "data-agents-md": typeof AgentsMdSchema;
  }>({
    sessionId: "example-session",
    endpoint: "/api/chat/stream",
    body: { pythonBackend, aiBackend, topology },
    schemas: {
      "data-plan": PlanSchema,
      "data-task": TaskSchema,
      "data-file": FileSchema,
      "data-approval": ApprovalSchema,
      "data-sub-agent": DataSubAgentSchema,
      "data-human-response": DataHumanResponseSchema,
      "data-error": DataErrorSchema,
      "data-todo": TodoSchema,
      "data-agents-md": AgentsMdSchema,
    },
  });

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || (status !== "idle" && status !== "error")) return;
    pendingViaRef.current = `via ${pythonBackend} · ${aiBackend} · ${topology}`;
    sendMessage(text);
    setInput("");
  }

  return (
    <main className="flex flex-col h-screen max-w-2xl mx-auto">
      {/* Header */}
      <header className="border-b border-border bg-card px-4 py-3 flex items-center gap-2">
        <div
          data-testid="header-status-dot"
          className={`h-2 w-2 rounded-full ${
            status === "error" ? "bg-destructive" : "bg-success"
          }`}
        />
        <span className="font-semibold text-sm">DeepAgents Example</span>
        <span
          data-testid="header-status"
          className="ml-auto text-xs text-muted-foreground"
        >
          {status}
        </span>
      </header>

      {/* Feature info strip */}
      <div className="bg-warning/10 border-b border-warning/30 px-4 py-1.5 text-xs text-foreground flex gap-4">
        <span>
          Auth: <code>getCookieToken(&apos;session&apos;)</code>
        </span>
        <span>
          Debug: <code>localStorage.debug=&apos;deepagents:sse&apos;</code>
        </span>
        <span>
          Generic: <code>useDeepAgentsChat&lt;TData&gt;</code>
        </span>
      </div>

      {/* Error banner */}
      {error && (
        <div className="bg-destructive/10 border-b border-destructive/40 px-4 py-2 text-sm text-foreground font-mono">
          <span className="font-semibold">Error:</span> {error.message}
        </div>
      )}

      {/* Message list */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.length === 0 && (
          <div className="text-center text-muted-foreground text-sm mt-8">
            Send a message to start the demo
          </div>
        )}
        {messages.map((msg, idx) => {
          if (msg.type === "user") return <UserBubble key={msg.id} msg={msg} />;
          if (msg.type === "ai") {
            if (!viaMapRef.current.has(msg.id)) {
              viaMapRef.current.set(msg.id, pendingViaRef.current);
            }
            return (
              <AIBubble
                key={msg.id}
                msg={msg}
                via={viaMapRef.current.get(msg.id)}
              />
            );
          }
          if (msg.type === "tool-call")
            return <ToolCallCard key={msg.id} msg={msg} />;
          if (msg.type === "data-plan")
            return (
              <CardRow key={`plan-${idx}`}>
                <PlanCard
                  plan={(msg as unknown as DataPlanMsg).data}
                  className={`${BUBBLE} bg-info/10 border-info/40`}
                />
              </CardRow>
            );
          if (msg.type === "data-task")
            return (
              <CardRow key={`task-${idx}`}>
                <TaskCard
                  task={(msg as unknown as DataTaskMsg).data}
                  className={`${BUBBLE} bg-card border-border`}
                />
              </CardRow>
            );
          if (msg.type === "data-file")
            return (
              <CardRow key={`file-${idx}`}>
                <FileCard
                  file={(msg as unknown as DataFileMsg).data}
                  className={`${BUBBLE} bg-card border-border`}
                />
              </CardRow>
            );
          if (msg.type === "data-approval") {
            const approval = (msg as unknown as DataApprovalMsg).data;
            return (
              <CardRow key={`approval-${idx}`}>
                <ApprovalCard
                  approval={approval}
                  className={`${BUBBLE} bg-destructive/10 border-destructive/40`}
                  // The main page renders approvals as streamed artifacts; the
                  // full interactive HITL drain lives at /hitl-demo. Here the
                  // decisions simply continue the conversation.
                  onApprove={() =>
                    sendMessage(`Approved: ${approval.actionName}`)
                  }
                  onReject={() =>
                    sendMessage(`Rejected: ${approval.actionName}`)
                  }
                />
              </CardRow>
            );
          }
          if (msg.type === "data-sub-agent")
            return (
              <CardRow key={`sub-agent-${idx}`}>
                <SubAgentCard
                  subAgent={(msg as unknown as DataSubAgentMsg).data}
                  className={`${BUBBLE} bg-card border-border`}
                />
              </CardRow>
            );
          if (msg.type === "data-human-response")
            return (
              <CardRow key={`human-response-${idx}`}>
                <HumanResponseCard
                  response={(msg as unknown as DataHumanResponseMsg).data}
                  className={`${BUBBLE} bg-card border-border`}
                />
              </CardRow>
            );
          if (msg.type === "data-error")
            return (
              <ErrorBubble
                key={`error-${idx}`}
                msg={msg as unknown as DataErrorMsg}
              />
            );
          if (msg.type === "data-todo")
            return (
              <CardRow key={`todo-${idx}`}>
                <TodoCard
                  todo={(msg as unknown as DataTodoMsg).data}
                  className={`${BUBBLE} bg-card border-border`}
                />
              </CardRow>
            );
          if (msg.type === "data-agents-md")
            return (
              <CardRow key={`agents-md-${idx}`}>
                <AgentsMdCard
                  agentsMd={(msg as unknown as DataAgentsMdMsg).data}
                  className={`${BUBBLE} bg-card border-border`}
                />
              </CardRow>
            );
          return null;
        })}
        <div ref={bottomRef} />
      </div>

      {/* Matrix selectors: Python framework × AI backend (adapter implied by AI choice) */}
      <div className="border-b border-border bg-muted px-4 py-2 flex gap-4 items-center">
        <div className="flex gap-2 items-center">
          <span className="text-xs text-muted-foreground font-medium">Python:</span>
          {(["django", "fastapi"] as PythonBackend[]).map((b) => {
            const configured = availableBackends[b];
            return (
              <button
                key={b}
                onClick={() => configured && setPythonBackend(b)}
                disabled={!configured}
                title={configured ? b : `${b} — not configured in .env.local`}
                className={`rounded px-2 py-0.5 text-xs font-mono ${
                  !configured
                    ? "bg-muted border border-border text-muted-foreground cursor-not-allowed"
                    : pythonBackend === b
                    ? "bg-primary text-primary-foreground"
                    : "bg-card border border-border text-foreground hover:bg-muted"
                }`}
              >
                {b}
              </button>
            );
          })}
        </div>
        <div className="flex gap-2 items-center">
          <span className="text-xs text-muted-foreground font-medium">AI:</span>
          {(["deepagents", "langgraph", "langchain"] as AiBackend[]).map(
            (a) => (
              <button
                key={a}
                onClick={() => setAiBackend(a)}
                title={`${a} — agent framework + wire format; adapter auto-resolved`}
                className={`rounded px-2 py-0.5 text-xs font-mono ${
                  aiBackend === a
                    ? "bg-primary text-primary-foreground"
                    : "bg-card border border-border text-foreground hover:bg-muted"
                }`}
              >
                {a}
              </button>
            )
          )}
        </div>
        <div className="flex gap-2 items-center">
          <span className="text-xs text-muted-foreground font-medium">Topology:</span>
          {TOPOLOGIES_BY_AI[aiBackend].map((t) => (
            <button
              key={t}
              onClick={() => setTopology(t)}
              title={
                t === "react"
                  ? "ReAct — tool-calling loop (most common)"
                  : "Plan-and-Execute — planner generates steps, executor runs them"
              }
              className={`rounded px-2 py-0.5 text-xs font-mono ${
                topology === t
                  ? "bg-primary text-primary-foreground"
                  : "bg-card border border-border text-foreground hover:bg-muted"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* Input bar */}
      <form
        onSubmit={handleSubmit}
        className="border-t border-border bg-card p-4 flex gap-2"
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type a message…"
          aria-label="Chat message"
          disabled={status !== "idle" && status !== "error"}
          className="flex-1 rounded-xl border border-border px-4 py-2 text-sm outline-none focus:border-ring disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={(status !== "idle" && status !== "error") || !input.trim()}
          className="rounded-xl bg-primary px-4 py-2 text-sm text-primary-foreground font-medium disabled:opacity-50 hover:bg-primary/90 transition-colors"
        >
          Send
        </button>
      </form>
    </main>
  );
}
