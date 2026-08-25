"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ChatWorkspace,
  type WsFile,
  type WsTodo,
  type WsSubAgent,
  type WsTool,
} from "../../components/ChatWorkspace";
import {
  useWorkspaceSettings,
  effectiveSystemPrompt,
} from "../../lib/workspace-settings";
import { useConversations } from "../../lib/conversations";
import { ChatTranscriptRecord } from "../../components/ChatTranscriptRecord";
import { useTranscript } from "../../lib/transcript";
import { computeReadiness, canSend } from "../../lib/readiness";
import {
  FRAMEWORKS,
  DEFAULT_FRAMEWORK,
  PYTHON_BACKENDS,
  isKnownFramework,
  labelFor,
  topologiesFor,
  type AiBackend,
  type PythonBackend,
  type Topology,
} from "../../lib/frameworks";
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

const CARD =
  "max-w-md rounded-xl border border-border bg-card/60 px-4 py-2 text-sm text-foreground";

function ChatPageContent() {
  const [input, setInput] = useState("");
  /**
   * ?framework= IS THE SELECTION, in both directions.
   *
   * The sidebar deep-links a conversation rung here as ?framework=<id>. Both
   * links are the SAME ROUTE with a different query, so React does not remount
   * this component — which means a `useState` initializer reading the param
   * runs exactly once, on first mount, and every later sidebar click changed
   * the URL while the toolbar kept showing the framework you arrived with.
   * That was the bug: the seed was correct and the sync was missing.
   *
   * So the param is read every render and an effect follows it. The Framework
   * buttons write it back rather than only setting local state, which keeps
   * the sidebar's active row and the toolbar's selected button from disagreeing
   * about the same fact.
   */
  const router = useRouter();
  const search = useSearchParams();
  const frameworkParam = search?.get("framework") ?? null;

  /*
   * ?c= IS THE CONVERSATION, and it is what makes the per-conversation system
   * prompt reach the model.
   *
   * The sidebar has always linked `?framework=<id>&c=<conversation id>`, and
   * this page read only the framework half. So `Conversation.systemPrompt` was
   * stored, typed, and covered by ten tests while reaching NOTHING — the whole
   * chain existed except the one line that consumes it, which is the shape that
   * looks most finished from the outside.
   */
  const conversationParam = search?.get("c") ?? null;

  /*
   * #122 — the saved transcript for this conversation. A RECORD, not resumed
   * context: these entries come from localStorage while the agent's memory of
   * the session comes from sessionId on the backend, so the two can diverge.
   * Rendered as a labelled block rather than as messages for exactly that
   * reason — see ChatTranscriptRecord.
   */
  const {
    read: transcriptRead,
    append: appendTranscript,
    writeError: transcriptWriteError,
  } = useTranscript(conversationParam);
  const paramIsValid = isKnownFramework(frameworkParam);

  const [aiBackend, setAiBackend] = useState<AiBackend>(() =>
    paramIsValid ? (frameworkParam as AiBackend) : DEFAULT_FRAMEWORK
  );

  // Deliberately keyed on the PARAM alone. Depending on `aiBackend` too would
  // make this fight the button handler below: the click sets state, the effect
  // sees state != param for one render, and snaps it back before the URL
  // catches up.
  useEffect(() => {
    if (paramIsValid && frameworkParam !== aiBackend) {
      setAiBackend(frameworkParam as AiBackend);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameworkParam]);

  function selectFramework(id: AiBackend) {
    setAiBackend(id);
    // `replace`, not `push`: switching framework is changing a control, not
    // navigating, so it should not stack Back-button entries. Same route +
    // different query does not remount, so the conversation survives.
    //
    // ?c= IS CARRIED THROUGH. This used to rebuild the URL from the framework
    // alone, which silently dropped the conversation id — so changing framework
    // mid-conversation detached you from it and reverted the prompt to the
    // workspace default, with nothing in the UI saying so.
    const q = new URLSearchParams({ framework: id });
    if (conversationParam) q.set("c", conversationParam);
    router.replace(`/chat?${q.toString()}`, { scroll: false });
  }
  const { settings: wsSettings } = useWorkspaceSettings();

  /*
   * The prompt actually sent: the conversation's override if it has one, else
   * the workspace default. `effectiveSystemPrompt` decides — the override wins
   * WHOLE rather than being concatenated, and an empty or whitespace override
   * means "not set" rather than "send an empty prompt".
   *
   * Resolved here rather than in the route because the route has no idea which
   * conversation you are on; it receives one prompt and injects it as a leading
   * system message.
   */
  const { conversations } = useConversations();
  const activeConversation = conversationParam
    ? conversations.find((c) => c.id === conversationParam)
    : undefined;
  const systemPrompt = effectiveSystemPrompt(
    wsSettings.systemPrompt,
    activeConversation?.systemPrompt
  );

  // Is a model reachable at all? Probed once; `null` while in flight so the
  // indicator can say "checking" rather than guessing green.
  const [llmConfigured, setLlmConfigured] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/config")
      .then(
        (r) =>
          r.json() as Promise<{
            activeLlm: string | null;
            backends?: Record<PythonBackend, boolean>;
          }>
      )
      .then((c) => {
        if (cancelled) return;
        setLlmConfigured(!!c.activeLlm);
        // Same endpoint, same round trip: a second fetch for the runtime list
        // would let the two answers arrive out of order and disagree.
        if (c.backends) setAvailableBackends(c.backends);
      })
      .catch(() => {
        // A failed probe is not proof of absence. Leave it unknown rather than
        // blocking a surface that may be perfectly fine.
        if (!cancelled) setLlmConfigured(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const [topology, setTopology] = useState<Topology>("react");

  /*
   * WHICH RUNTIME. django and fastapi host the same three rungs, and they do
   * not serve the same topologies — so this is an axis of the surface, not a
   * deployment constant. `availableBackends` starts all-false and is filled
   * from the server: an unconfigured runtime must render unselectable rather
   * than fail on send with a 502 naming an env var the user never saw.
   */
  const [pythonBackend, setPythonBackend] = useState<PythonBackend>("fastapi");
  const [availableBackends, setAvailableBackends] = useState<
    Record<PythonBackend, boolean>
  >({ django: false, fastapi: false });

  const [tools, setTools] = useState<WsTool[]>([]);
  const [mcps, setMcps] = useState<string[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Keep the selected topology valid for the chosen (framework, runtime) pair.
  // Unavailable modes are not rendered at all, so without this a mode selected
  // under one pair would stay selected — and keep being sent — after switching
  // to a pair whose button list no longer contains it.
  const availableTopologies = useMemo(
    () => topologiesFor(aiBackend, pythonBackend),
    [aiBackend, pythonBackend]
  );
  useEffect(() => {
    // Falls back to the first mode this pair actually serves rather than a
    // hardcoded "react": a fork whose manifest drops react from a cell would
    // otherwise land on a mode that cell cannot run.
    if (!availableTopologies.includes(topology)) {
      setTopology(availableTopologies[0] ?? "react");
    }
  }, [availableTopologies, topology]);

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
    // The workspace system prompt travels with every message. Empty string
    // means "leave the backend's own prompt alone" — the route drops it rather
    // than injecting a blank system message.
    body: {
      aiBackend,
      pythonBackend,
      topology,
      systemPrompt,
    },
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

  /*
   * READINESS, NOT ACTIVITY. The old indicator was green whenever `status`
   * was "idle" — which means "not streaming", not "able to stream". With no
   * API key it showed green, enabled the composer, and let the first send be
   * the way you found out.
   *
   * The chat surface needs a model and does NOT need a sandbox: it talks to a
   * Python backend, it does not execute code. The queue surface is the one
   * that runs things.
   */
  const readiness = computeReadiness({
    llmConfigured,
    sandboxRequired: false,
    sandboxAvailable: null,
    streamStatus: status,
  });
  const sendable = canSend(readiness);

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
    // Record the turn. The return value is checked rather than discarded: a
    // save that silently did nothing is the lie this feature exists to avoid,
    // and it is exactly what a private window produces. `writeError` surfaces
    // it in the UI below.
    appendTranscript(
      { role: "user", text, at: new Date().toISOString() },
      conversations.map((c) => c.id)
    );
    setInput("");
  }

  return (
    <div className="flex h-full flex-col">
      {error && (
        <div className="border-b border-destructive/50 bg-destructive/15 px-5 py-2 text-sm text-destructive">
          {error.message}
        </div>
      )}

      {/* Chat column + workspace panel */}
      <div className="flex flex-1 overflow-hidden">
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Messages */}
          <div className="mx-auto w-full max-w-5xl flex-1 space-y-3 overflow-y-auto px-4 py-6 lg:px-6">
            {/*
             * #122 — the saved record sits ABOVE the live conversation and looks
             * different from it on purpose. It is what this browser stored, not
             * what the agent remembers.
             */}
            <ChatTranscriptRecord read={transcriptRead} />

            {transcriptWriteError && (
              <p
                data-testid="transcript-write-error"
                role="alert"
                className="border-destructive/30 bg-destructive/15 text-destructive mx-auto mb-4 w-full max-w-5xl rounded-lg border px-4 py-2 text-xs"
              >
                This conversation is not being saved — the browser refused to
                write to local storage. Everything still works; the history will
                be gone on reload.
              </p>
            )}

            {messages.length === 0 && (
              <div className="mt-12 text-center text-sm text-muted-foreground">
                Ask {FRAMEWORKS.find((f) => f.id === aiBackend)?.label}{" "}
                anything.
              </div>
            )}
            {messages.map((msg, idx) => {
              if (msg.type === "user") {
                const m = msg as UserMessage;
                return (
                  <div key={msg.id} className="flex justify-end">
                    <div className="max-w-md rounded-2xl bg-success px-4 py-2 text-sm text-white">
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
                    <div className="max-w-md rounded-2xl border border-border bg-card px-4 py-2 text-sm text-foreground">
                      {m.content}
                      {m.isStreaming && (
                        <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-muted-foreground align-middle" />
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
                    <details className="w-full max-w-md overflow-hidden rounded-xl border border-warning/20 bg-warning/10 text-sm">
                      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2">
                        <span
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                            m.status === "complete"
                              ? "bg-success"
                              : "bg-warning animate-pulse"
                          }`}
                        />
                        <span className="font-mono text-warning">
                          {m.toolName}
                        </span>
                        {hasResult && !/^error/i.test(resultText) && (
                          <span className="truncate font-mono text-[11px] text-muted-foreground">
                            → {resultText.split("\n")[0]}
                          </span>
                        )}
                        <span className="ml-auto text-[10px] text-muted-foreground">
                          {m.status}
                        </span>
                      </summary>
                      <div className="space-y-2 border-t border-warning/20 px-3 py-2">
                        {hasArgs && (
                          <div>
                            <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                              Arguments
                            </div>
                            <pre className="overflow-x-auto rounded bg-black/30 p-2 font-mono text-[11px] text-foreground">
                              {JSON.stringify(m.arguments, null, 2)}
                            </pre>
                          </div>
                        )}
                        <div>
                          <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                            Result
                          </div>
                          <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded bg-black/30 p-2 font-mono text-[11px] text-foreground">
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
                /*
                 * THE APPROVAL GATE DOES NOT EXIST HERE YET, so these buttons are
                 * disabled rather than left working (#160).
                 *
                 * They used to call sendMessage(`Approved: ${actionName}`) — a NEW CHAT
                 * MESSAGE containing that literal text. That is not an approval. In
                 * apps/example the decision POSTs to /api/approval/[approvalId] and
                 * RESUMES a run the proxy had paused. open-swe has no such endpoint and
                 * nothing here pauses anything, so the agent was never stopped, the text
                 * arrived as ordinary input it may simply ignore, and a user clicking
                 * Approve believed they had gated an action.
                 *
                 * A safety control that claims a guarantee it does not provide is worse
                 * than an absent one: it manufactures consent. Disabled-with-a-reason is
                 * the honest state until the gate is real.
                 *
                 * Remove this whole block when the gate lands — the card then takes real
                 * onApprove/onReject that POST a decision.
                 */
                return row(
                  <div>
                    <ApprovalCard
                      approval={data as never}
                      className={CARD}
                      disabled
                      onApprove={() => {}}
                      onReject={() => {}}
                    />
                    <p
                      data-testid="approval-not-wired"
                      role="status"
                      className="text-warning border-warning/30 bg-warning/10 mt-1 rounded border px-2 py-1 text-[11px]"
                    >
                      This run was not paused for approval — open-swe cannot gate tool
                      calls yet, so these buttons would not stop anything. Tracked in
                      #160.
                    </p>
                  </div>
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
                      className="max-w-md rounded-xl border border-destructive/30 bg-destructive/15 px-4 py-2 text-sm text-destructive"
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

          {/*
           * WHY, not just THAT. The indicator turns red on its own, but a
           * colour is not an instruction — a person still has to guess what to
           * fix. This states each unmet prerequisite in the place they are
           * about to try to type.
           */}
          {readiness.state === "blocked" && (
            <div
              data-testid="chat-blocked"
              role="status"
              className="border-destructive/40 bg-destructive/10 mx-auto w-full max-w-5xl rounded-lg border px-4 py-2 text-xs lg:px-6"
            >
              <p className="text-foreground font-medium">Not ready to send</p>
              <ul className="text-muted-foreground mt-1 list-disc space-y-0.5 pl-4">
                {readiness.reasons.map((why) => (
                  <li key={why}>{why}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Composer */}
          <form
            onSubmit={submit}
            className="mx-auto w-full max-w-5xl px-4 pt-2 lg:px-6"
          >
            <div className="flex gap-2 rounded-2xl border border-border bg-card/60 p-2 focus-within:border-border">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Type a message…"
                disabled={!sendable && readiness.state !== "ready"}
                data-testid="chat-input"
                className="flex-1 bg-transparent px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground outline-none disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={!sendable || !input.trim()}
                data-testid="chat-send"
                className="rounded-xl bg-success px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-success disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
              >
                Send
              </button>
            </div>
          </form>
          {/* Framework selector */}
          <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-2 px-4 pb-6 pt-3 lg:px-6">
            <span className="text-xs text-muted-foreground">Framework</span>
            {FRAMEWORKS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => selectFramework(f.id)}
                data-testid={`framework-${f.id}`}
                className={`rounded-lg px-3 py-1 text-xs font-medium transition-colors ${
                  aiBackend === f.id
                    ? "bg-success text-white"
                    : "border border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                {f.label}
              </button>
            ))}

            <span className="mx-1 h-4 w-px bg-muted" />
            <span className="text-xs text-muted-foreground">Runtime</span>
            {/*
             * Unconfigured runtimes are DISABLED here rather than hidden, which
             * is the opposite of the rule the Mode group follows below — and the
             * difference is deliberate. A mode a rung does not have is not a
             * thing the user can obtain, so advertising it is noise. A runtime
             * that exists but has no URL in this deployment IS obtainable: the
             * fix is a line in .env.local, and the title says so. Hiding it
             * would hide the remedy.
             */}
            {PYTHON_BACKENDS.map((rt) => {
              const configured = availableBackends[rt];
              return (
                <button
                  key={rt}
                  type="button"
                  // aria-pressed so the active runtime reaches a screen reader,
                  // and so an e2e assertion can read state rather than colour.
                  aria-pressed={pythonBackend === rt}
                  onClick={() => configured && setPythonBackend(rt)}
                  disabled={!configured}
                  data-testid={`runtime-${rt}`}
                  title={
                    configured
                      ? rt
                      : `${rt} — no ${
                          rt === "django" ? "DJANGO_URL" : "FASTAPI_URL"
                        } in .env.local`
                  }
                  className={`rounded-lg px-3 py-1 text-xs font-medium transition-colors ${
                    !configured
                      ? "cursor-not-allowed border border-border text-muted-foreground/50"
                      : pythonBackend === rt
                      ? "bg-primary text-white"
                      : "border border-border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {rt}
                </button>
              );
            })}

            <span className="mx-1 h-4 w-px bg-muted" />
            <span className="text-xs text-muted-foreground">Mode</span>
            {/*
             * Only what this framework actually has. A mode the manifest does
             * not declare for the selected rung is absent, not greyed out —
             * a disabled control still advertises a capability and invites a
             * click that cannot succeed.
             */}
            {availableTopologies.map((id) => {
              const { label, title } = labelFor(id);
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setTopology(id)}
                  data-testid={`topology-${id}`}
                  title={title}
                  className={`rounded-lg px-3 py-1 text-xs font-medium transition-colors ${
                    topology === id
                      ? "bg-primary text-white"
                      : "border-border text-muted-foreground hover:text-foreground border"
                  }`}
                >
                  {label}
                </button>
              );
            })}

            <span
              data-testid="chat-status"
              data-readiness={readiness.state}
              title={readiness.reasons.join("\n") || undefined}
              className="text-muted-foreground ml-auto flex items-center gap-1.5 text-xs"
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  readiness.state === "error" || readiness.state === "blocked"
                    ? "bg-destructive"
                    : readiness.state === "busy"
                    ? "bg-info animate-pulse"
                    : readiness.state === "unknown"
                    ? "bg-muted-foreground"
                    : "bg-success"
                }`}
              />
              {readiness.label}
            </span>
          </div>
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

/**
 * `useSearchParams()` inside ChatPageContent — the sidebar deep-links a rung in
 * as ?framework= — makes this page opt out of static prerender unless it is
 * behind a boundary. `tsc` is silent on it; `next build` fails the export.
 * Same wrapper the run detail page already uses, for the same reason.
 */
export default function ChatPage() {
  return (
    <Suspense fallback={null}>
      <ChatPageContent />
    </Suspense>
  );
}
