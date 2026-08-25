"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  PYTHON_BACKENDS,
  topologiesFor,
  type PythonBackend,
} from "../../lib/frameworks";
import {
  ChatWorkspace,
  type WsFile,
  type WsTodo,
  type WsSubAgent,
  type WsTool,
} from "../../components/ChatWorkspace";
import {
  useDeepAgentsChat,
  PlanCard,
  TaskCard,
  FileCard,
  ApprovalCard,
  SubAgentCard,
  TodoCard,
  PlanSchema,
  TaskSchema,
  FileSchema,
  ApprovalSchema,
  TodoSchema,
  AgentsMdSchema,
  DataSubAgentSchema,
  DataHumanResponseSchema,
  DataErrorSchema,
  type AIMessage,
  type UserMessage,
  type ToolCallMessage,
} from "@deepagents-nextjs/react";

// The three frameworks this app demonstrates compatibility with. The adapter is
// resolved server-side from this value; the agent itself is identical.
type AiBackend = "langgraph" | "langchain" | "deepagents";
const FRAMEWORKS: { id: AiBackend; label: string }[] = [
  { id: "langgraph", label: "LangGraph" },
  { id: "langchain", label: "LangChain" },
  { id: "deepagents", label: "DeepAgents" },
];

// Agent topology — the backend dispatches on this (body.topology):
//   react        → single ReAct agent (reason ↔ act loop)
//   plan-execute → planner drafts steps, executor carries them out
type Topology = "react" | "plan-execute" | "deep-research";
const TOPOLOGIES: {
  id: Topology;
  label: string;
  title: string;
}[] = [
  {
    id: "react",
    label: "ReAct",
    title: "Single ReAct agent (reason ↔ act loop)",
  },
  {
    id: "plan-execute",
    label: "Plan-Execute",
    title: "Planner drafts steps, executor carries them out",
  },
  {
    id: "deep-research",
    label: "DeepResearch",
    title: "Web-search research agent (DuckDuckGo) — deepagents only",
  },
];

const CARD =
  "max-w-md rounded-xl border border-neutral-800 bg-neutral-900/60 px-4 py-2 text-sm text-neutral-200";

/**
 * Shared styling for the toolbar's toggle groups (Runtime, Mode).
 *
 * One definition rather than one per group: the two groups are the same
 * control with different options, and duplicating the class literals also
 * duplicates this app's hardcoded palette — which apps/open-swe/docs/
 * PALETTE-EXCEPTION.md bounds with a ratchet. Adding the Runtime group as a
 * copy grew that count by 8 and the ratchet refused it, correctly.
 */
function toggleClass(
  active: boolean,
  disabled: boolean,
  activeBg = "bg-indigo-600"
): string {
  const base = "rounded-lg px-3 py-1 text-xs font-medium transition-colors";
  if (disabled)
    return `${base} cursor-not-allowed border border-neutral-800 text-neutral-700`;
  if (active) return `${base} ${activeBg} text-white`;
  return `${base} border border-neutral-700 text-neutral-400 hover:text-neutral-100`;
}

export default function ChatPage() {
  const [input, setInput] = useState("");
  const [aiBackend, setAiBackend] = useState<AiBackend>("langgraph");
  const [topology, setTopology] = useState<Topology>("react");
  const [pythonBackend, setPythonBackend] = useState<PythonBackend>("fastapi");
  const [availableBackends, setAvailableBackends] = useState<
    Record<PythonBackend, boolean>
  >({ django: false, fastapi: false });
  const [tools, setTools] = useState<WsTool[]>([]);
  const [mcps, setMcps] = useState<string[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Which topologies this (rung, runtime) pair can actually serve, per
  // rungs.json. Derived, not hardcoded: deep-research exists in exactly one
  // cell (deepagents x fastapi), so a hardcoded list offers it on django too
  // and the user gets a backend error for a button we told them was live.
  const allowedTopologies = useMemo(
    () => topologiesFor(aiBackend, pythonBackend),
    [aiBackend, pythonBackend]
  );

  // Selected mode may become unserviceable when either axis changes.
  useEffect(() => {
    if (!allowedTopologies.includes(topology)) {
      setTopology(allowedTopologies[0] ?? "react");
    }
  }, [allowedTopologies, topology]);

  // Which runtimes this deployment actually has URLs for. From the server, so
  // an unconfigured runtime renders disabled instead of failing on send.
  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((cfg: { backends?: Record<PythonBackend, boolean> }) => {
        if (cfg.backends) setAvailableBackends(cfg.backends);
      })
      .catch(() => {});
  }, []);

  // Load the agent's live tools + MCP servers for the current (backend, mode).
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/chat/tools?aiBackend=${aiBackend}&topology=${topology}`)
      .then((r) => r.json())
      .then((d: { tools?: WsTool[]; mcps?: string[] }) => {
        if (cancelled) return;
        setTools(d.tools ?? []);
        setMcps(d.mcps ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [aiBackend, topology]);

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
    sessionId: "lang-nextjs-chat",
    endpoint: "/api/chat/stream",
    body: { aiBackend, pythonBackend, topology },
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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const busy = status !== "idle" && status !== "error";

  // Collect the workspace from the stream: files (dedup by path, latest wins),
  // the latest todo list, and sub-agents (dedup by id, latest status).
  const { wsFiles, wsTodos, wsSubAgents } = useMemo(() => {
    const fileMap = new Map<string, WsFile>();
    const subMap = new Map<string, WsSubAgent>();
    let todos: WsTodo[] = [];
    for (const m of messages) {
      const d = (m as unknown as { data?: Record<string, unknown> }).data;
      if (m.type === "data-file" && d) {
        const path = String(d.path ?? "");
        fileMap.set(path, {
          id: String(d.id ?? path),
          path,
          name: String(d.name ?? path),
          language: (d.language as string | null) ?? null,
          content: (d.content as string | null) ?? null,
        });
      } else if (m.type === "data-todo" && d && Array.isArray(d.items)) {
        todos = (d.items as Array<Record<string, unknown>>).map((it) => ({
          id: String(it.id),
          text: String(it.text ?? ""),
          status: (it.status as WsTodo["status"]) ?? "pending",
        }));
      } else if (m.type === "data-sub-agent" && d) {
        subMap.set(String(d.id), {
          id: String(d.id),
          name: String(d.name ?? "subagent"),
          status: String(d.status ?? "starting"),
        });
      }
    }
    return {
      wsFiles: [...fileMap.values()],
      wsTodos: todos,
      wsSubAgents: [...subMap.values()],
    };
  }, [messages]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    sendMessage(text);
    setInput("");
  }

  return (
    <div className="flex h-[calc(100vh-53px)] flex-col">
      {/* Framework selector */}
      <div className="flex items-center gap-2 border-b border-neutral-800/80 px-5 py-2.5">
        <span className="text-xs text-neutral-500">Framework</span>
        {FRAMEWORKS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setAiBackend(f.id)}
            data-testid={`framework-${f.id}`}
            className={toggleClass(aiBackend === f.id, false, "bg-emerald-600")}
          >
            {f.label}
          </button>
        ))}

        <span className="mx-1 h-4 w-px bg-neutral-800" />
        <span className="text-xs text-neutral-500">Runtime</span>
        {PYTHON_BACKENDS.map((rt) => {
          const configured = availableBackends[rt];
          return (
            <button
              key={rt}
              type="button"
              // aria-pressed so the active runtime is exposed to a screen
              // reader, and so an e2e assertion can read state rather than
              // colour.
              aria-pressed={pythonBackend === rt}
              onClick={() => configured && setPythonBackend(rt)}
              disabled={!configured}
              data-testid={`runtime-${rt}`}
              title={configured ? rt : `${rt} — not configured in .env.local`}
              className={toggleClass(pythonBackend === rt, !configured)}
            >
              {rt}
            </button>
          );
        })}

        <span className="mx-1 h-4 w-px bg-neutral-800" />
        <span className="text-xs text-neutral-500">Mode</span>
        {TOPOLOGIES.map((t) => {
          // Manifest-derived, so it follows BOTH axes. This replaced a
          // `deepagentsOnly` flag on each entry, which knew nothing about the
          // runtime and would offer deep-research on deepagents x django,
          // where it does not exist. The flag is gone rather than left unread:
          // a second, staler source of truth is how these drift apart.
          const disabled = !allowedTopologies.includes(t.id);
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => !disabled && setTopology(t.id)}
              disabled={disabled}
              data-testid={`topology-${t.id}`}
              title={
                disabled
                  ? `${t.label} is not available on ${aiBackend} x ${pythonBackend}`
                  : t.title
              }
              className={toggleClass(topology === t.id, disabled)}
            >
              {t.label}
            </button>
          );
        })}

        <span
          data-testid="chat-status"
          className="ml-auto flex items-center gap-1.5 text-xs text-neutral-500"
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              status === "error"
                ? "bg-red-400"
                : busy
                ? "bg-blue-400 animate-pulse"
                : "bg-emerald-400"
            }`}
          />
          {status}
        </span>
      </div>

      {error && (
        <div className="border-b border-red-900/50 bg-red-950/40 px-5 py-2 text-sm text-red-300">
          {error.message}
        </div>
      )}

      {/* Chat column + workspace panel */}
      <div className="flex flex-1 overflow-hidden">
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Messages */}
          <div className="mx-auto w-full max-w-2xl flex-1 space-y-3 overflow-y-auto px-5 py-6">
            {messages.length === 0 && (
              <div className="mt-12 text-center text-sm text-neutral-500">
                Ask {FRAMEWORKS.find((f) => f.id === aiBackend)?.label}{" "}
                anything.
              </div>
            )}
            {messages.map((msg, idx) => {
              if (msg.type === "user") {
                const m = msg as UserMessage;
                return (
                  <div key={msg.id} className="flex justify-end">
                    <div className="max-w-md rounded-2xl bg-emerald-600 px-4 py-2 text-sm text-white">
                      {m.content}
                    </div>
                  </div>
                );
              }
              if (msg.type === "ai") {
                const m = msg as AIMessage;
                return (
                  <div
                    key={msg.id}
                    data-role="assistant"
                    className="flex justify-start"
                  >
                    <div className="max-w-md rounded-2xl border border-neutral-800 bg-neutral-900 px-4 py-2 text-sm text-neutral-100">
                      {m.content}
                      {m.isStreaming && (
                        <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-neutral-500 align-middle" />
                      )}
                    </div>
                  </div>
                );
              }
              if (msg.type === "tool-call") {
                const m = msg as ToolCallMessage;
                const hasArgs =
                  m.arguments && Object.keys(m.arguments).length > 0;
                const hasResult = m.result !== undefined && m.result !== null;
                const resultText =
                  typeof m.result === "string"
                    ? m.result
                    : hasResult
                    ? JSON.stringify(m.result, null, 2)
                    : "";
                return (
                  <div
                    key={msg.id}
                    data-testid="tool-card"
                    className="flex justify-start"
                  >
                    <details className="w-full max-w-md overflow-hidden rounded-xl border border-amber-500/20 bg-amber-500/10 text-sm">
                      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2">
                        <span
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                            m.status === "complete"
                              ? "bg-emerald-400"
                              : "bg-amber-400 animate-pulse"
                          }`}
                        />
                        <span className="font-mono text-amber-300">
                          {m.toolName}
                        </span>
                        {hasResult && !/^error/i.test(resultText) && (
                          <span className="truncate font-mono text-[11px] text-neutral-400">
                            → {resultText.split("\n")[0]}
                          </span>
                        )}
                        <span className="ml-auto text-[10px] text-neutral-500">
                          {m.status}
                        </span>
                      </summary>
                      <div className="space-y-2 border-t border-amber-500/20 px-3 py-2">
                        {hasArgs && (
                          <div>
                            <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">
                              Arguments
                            </div>
                            <pre className="overflow-x-auto rounded bg-black/30 p-2 font-mono text-[11px] text-neutral-300">
                              {JSON.stringify(m.arguments, null, 2)}
                            </pre>
                          </div>
                        )}
                        <div>
                          <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">
                            Result
                          </div>
                          <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded bg-black/30 p-2 font-mono text-[11px] text-neutral-300">
                            {hasResult ? resultText : "(running…)"}
                          </pre>
                        </div>
                      </div>
                    </details>
                  </div>
                );
              }
              const data = (msg as unknown as { data: unknown }).data;
              const row = (node: React.ReactNode) => (
                <div key={`${msg.type}-${idx}`} className="flex justify-start">
                  {node}
                </div>
              );
              if (msg.type === "data-plan")
                return row(<PlanCard plan={data as never} className={CARD} />);
              if (msg.type === "data-task")
                return row(<TaskCard task={data as never} className={CARD} />);
              if (msg.type === "data-file")
                return row(<FileCard file={data as never} className={CARD} />);
              if (msg.type === "data-todo")
                return row(<TodoCard todo={data as never} className={CARD} />);
              if (msg.type === "data-sub-agent")
                return row(
                  <SubAgentCard subAgent={data as never} className={CARD} />
                );
              if (msg.type === "data-approval") {
                const a = data as { actionName: string };
                return row(
                  <ApprovalCard
                    approval={data as never}
                    className={CARD}
                    onApprove={() => sendMessage(`Approved: ${a.actionName}`)}
                    onReject={() => sendMessage(`Rejected: ${a.actionName}`)}
                  />
                );
              }
              if (msg.type === "error" || msg.type === "data-error") {
                const errText =
                  (msg as unknown as { message?: string }).message ??
                  (data as { message?: string })?.message ??
                  "An error occurred";
                return (
                  <div key={`err-${idx}`} className="flex justify-start">
                    <div
                      data-testid="chat-error"
                      className="max-w-md rounded-xl border border-red-500/30 bg-red-950/40 px-4 py-2 text-sm text-red-300"
                    >
                      {errText}
                    </div>
                  </div>
                );
              }
              return null;
            })}
            <div ref={bottomRef} />
          </div>

          {/* Composer */}
          <form
            onSubmit={submit}
            className="mx-auto w-full max-w-2xl px-5 pb-6 pt-2"
          >
            <div className="flex gap-2 rounded-2xl border border-neutral-800 bg-neutral-900/60 p-2 focus-within:border-neutral-700">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Type a message…"
                disabled={busy}
                data-testid="chat-input"
                className="flex-1 bg-transparent px-3 py-1.5 text-sm text-neutral-100 placeholder:text-neutral-500 outline-none disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={busy || !input.trim()}
                data-testid="chat-send"
                className="rounded-xl bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
              >
                Send
              </button>
            </div>
          </form>
        </div>
        <ChatWorkspace
          files={wsFiles}
          todos={wsTodos}
          subAgents={wsSubAgents}
          tools={tools}
          mcps={mcps}
        />
      </div>
    </div>
  );
}
