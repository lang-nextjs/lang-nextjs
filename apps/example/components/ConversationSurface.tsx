"use client";

import { useState, useRef, useEffect } from "react";
import { newSessionId } from "../lib/session-id";
import {
  conversationBoundaries,
  type Cell,
} from "../lib/conversation-boundaries";
import {
  useDeepAgentsChat,
  // Shared cards only. The rung-owned ones (PlanCard, FileCard, SubAgentCard,
  // TodoCard) come from @/lib/rungs/cards instead — naming them here is what
  // made `eject deepagents` fail to build, on this exact import list.
  TaskCard,
  ApprovalCard,
  HumanResponseCard,
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
  type DataTask,
  type DataApproval,
  type DataAgentsMd,
  type DataHumanResponse,
  type DataError,
} from "@deepagents-nextjs/react";
import type {
  AIMessage,
  ToolCallMessage,
  UserMessage,
} from "@deepagents-nextjs/react";
import { RUNG_BY_ID } from "@deepagents-nextjs/rungs";
import { renderPart } from "@/lib/rungs/cards";
import { adapterIds, defaultRungId } from "@/lib/rungs/adapters";

/**
 * Matrix axes: runtime × aiBackend × topology.
 *
 * `aiBackend` is a conversation-shaped RUNG ID and `Topology` a plain string, both on
 * purpose. The union literals they replace were a second list of rung names beside
 * rungs.json, and a second list goes stale silently — a rung-1 fork kept offering three
 * backend buttons, two of which had no adapter and whose Python modules eject had already
 * deleted. It built, and it lied. See severability.test.ts.
 */
type AiBackend = string;
/*
 * #360 — the axis is no longer all-Python. See the note in
 * app/api/chat/stream/route.ts about this being a second copy; the behaviour is
 * aligned here, the extraction is filed rather than smuggled in.
 */
const RUNTIMES = ["django", "fastapi", "node"] as const;
type Runtime = (typeof RUNTIMES)[number];

/** How each runtime is labelled. "Python:" was the group label and is now false. */
const RUNTIME_LABEL: Record<Runtime, string> = {
  django: "django",
  fastapi: "fastapi",
  node: "node",
};
type Topology = string;

/**
 * Topologies for one (rung, runtime) pair, from the manifest.
 *
 * PER PAIR, NOT PER RUNG. The ladder is ragged: deep-research exists only in
 * deepagents × fastapi, and the flat `Record<AiBackend, Topology[]>` this replaces could not
 * express that — it claimed all three rungs served the same two topologies, which silently
 * dropped fastapi × deepagents' third.
 *
 * Falls back to ["react"] rather than [] so the axis is never empty: a pair with no declared
 * topologies would otherwise render zero buttons and strand the surface with no way to send.
 */
function topologiesFor(rungId: string, runtime: Runtime): readonly Topology[] {
  const declared =
    RUNG_BY_ID[rungId as keyof typeof RUNG_BY_ID]?.runtimes?.[runtime]
      ?.topologies;
  return declared && declared.length > 0 ? declared : ["react"];
}

export interface ConversationSurfaceProps {
  /**
   * Rung to open on. Unknown or absent falls back to this build's default, so a caller can
   * pass a route param straight through without validating it first.
   */
  initialRung?: string;
}

type DataTaskMsg = { type: "data-task"; data: DataTask };
type DataApprovalMsg = { type: "data-approval"; data: DataApproval };
type DataHumanResponseMsg = {
  type: "data-human-response";
  data: DataHumanResponse;
};
type DataErrorMsg = { type: "data-error"; data: DataError };
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
          <div className="mt-1 text-[10px] text-muted-foreground font-mono">
            {via}
          </div>
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
          {/*
           * A FAILED TOOL IS NOT A COMPLETE ONE. This was a two-way ternary
           * on `complete`, and the converter mapped `output-error` and
           * `output-denied` to `complete` — so a tool that threw rendered in
           * the success colour with the word "complete" beside it.
           */}
          <span
            data-testid="tool-status"
            data-tool-status={msg.status}
            className={
              msg.status === "complete"
                ? "rounded-full bg-success/15 text-foreground px-2 py-0.5 text-xs"
                : msg.status === "error"
                ? "rounded-full bg-destructive/15 text-foreground px-2 py-0.5 text-xs"
                : msg.status === "denied"
                ? "rounded-full bg-muted/40 text-foreground px-2 py-0.5 text-xs"
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

export function ConversationSurface({ initialRung }: ConversationSurfaceProps) {
  const [input, setInput] = useState("");
  // Seeded once, then local state. It deliberately does NOT navigate on change: /r/[rung]
  // seeds this, and 40 goto("/") calls plus matrix.spec.ts's click-then-fill sequence
  // depend on the surface not remounting mid-interaction. The URL is the route's to write.
  const [aiBackend, setAiBackend] = useState<AiBackend>(() =>
    initialRung && adapterIds().includes(initialRung)
      ? initialRung
      : defaultRungId()
  );
  const [topology, setTopology] = useState<Topology>("react");
  /*
   * THE NAME NO LONGER LIES (#360). This was `pythonBackend`, holding a value
   * that can be "node". open-swe's copy was renamed when the window closed and
   * this one was missed — the same contradiction, in the second surface.
   */
  const [runtime, setRuntime] = useState<Runtime>("fastapi");
  const [availableBackends, setAvailableBackends] = useState<
    Record<Runtime, boolean>
  >({ django: true, fastapi: true, node: true });

  // When the user switches AI backend, ensure the current topology is still
  // valid for that backend. If not, reset to "react" (always supported).
  useEffect(() => {
    if (!topologiesFor(aiBackend, runtime).includes(topology)) {
      setTopology("react");
    }
  }, [aiBackend, runtime, topology]);
  // Track which (python, ai) pair was active when each request was sent.
  // pendingVia is stamped at submit time; assigned to AI messages as they appear.
  /*
   * A REAL SESSION, NOT A CONSTANT (#171).
   *
   * This was the literal "example-session" — the same value for every visitor
   * and every conversation — while the route stripped it anyway. Both halves of
   * the defect #171 removed from open-swe survived here, in the app the audit
   * did not look at.
   *
   * `newSessionId` ALREADY EXISTS IN THIS APP, is tested, and is used by
   * hitl-demo. Its own header explains why a timestamp cannot be an identity;
   * the chat surface simply never adopted it. Minted once per mount because the
   * playground has no conversation record to key on — one visit is one session,
   * which is the honest granularity available here.
   */
  const [sessionId] = useState(() => newSessionId("example"));
  const pendingViaRef = useRef<string>("");
  const viaMapRef = useRef<Map<string, string>>(new Map());
  // THE CELL AS DATA, not only as the `via` string (#253). A separator has to
  // compare cells to each other, and comparing rendered labels would make the
  // boundary depend on how the label happens to be formatted.
  const pendingCellRef = useRef<Cell | undefined>(undefined);
  const cellMapRef = useRef<Map<string, Cell>>(new Map());
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((cfg: { backends: Record<Runtime, boolean> }) =>
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
    sessionId,
    endpoint: "/api/chat/stream",
    /*
     * RECONNECT ON THE SHIPPED SURFACE (#376), not only in the harness.
     *
     * `enableReconnect` / `resumeEndpoint` used to appear in exactly one file in
     * this repository — `app/reconnect-test/page.tsx`, a bare test target with
     * raw `status` / `messages` testids and none of this app's composition. So
     * the reference implementation demonstrated reconnect only where nobody
     * copies from, and someone opening the chat surface to see how it is wired
     * found nothing and could reasonably conclude the library does not do it.
     *
     * It also cost a real defect. The harness's spec STUBS the resume endpoint,
     * so the only page with reconnect enabled never talked to the real route —
     * and the hook's URL and the handler's route disagreed for the entire life
     * of the feature with nothing able to notice (#372). A capability
     * demonstrated only in a harness is a capability nothing exercises end to
     * end.
     *
     * `resumeId` is the CONVERSATION id. The hook asks for "a stable
     * per-conversation ID" and `sessionId` is exactly that, so there is no
     * second identifier to keep in step with it — the same choice open-swe
     * makes.
     *
     * INERT WITHOUT `ENABLE_STREAM_RECONNECT=true` on the server -- but only
     * since the hook learned to read a 503 that way. Before that, enabling
     * reconnect here put this surface into ERROR STATE on first paint whenever
     * the flag was unset, which is the default: red status dot, "Error:"
     * banner, nothing touched. Three CI jobs caught it. See the 503 boundary in
     * packages/react/src/hook.ts for why 503 is inert and 404 is not.
     *
     * `.env.example` now ships the flag on, and e2e.yml sets it in every job
     * that renders this surface, so the spec exercises the live route rather
     * than the disabled one -- and asserts it is live rather than assuming it.
     */
    enableReconnect: true,
    resumeId: sessionId,
    resumeEndpoint: "/api/chat/stream/resume",

    // `runtime`, the new name (#360). The routes still accept `runtime`
    // for one transition, but a client that keeps sending the old key means the
    // transition never starts and the deletion commit never becomes possible.
    body: { runtime: runtime, aiBackend, topology },
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
    pendingViaRef.current = `via ${runtime} · ${aiBackend} · ${topology}`;
    pendingCellRef.current = {
      runtime: runtime,
      framework: aiBackend,
      topology,
    };
    sendMessage(text);
    setInput("");
  }

  // WHERE THE TRANSCRIPT CHANGED HANDS (#253).
  //
  // Stamp each AI message with the cell that was active when it was requested,
  // then compute boundaries over the WHOLE transcript. Both steps happen here
  // rather than inside the render loop below, because a boundary for message N
  // is a fact about N-1 and N together — computing it mid-map would read a
  // stamp map that does not yet contain the later messages.
  for (const m of messages) {
    if (m.type !== "ai") continue;
    if (!viaMapRef.current.has(m.id))
      viaMapRef.current.set(m.id, pendingViaRef.current);
    if (!cellMapRef.current.has(m.id) && pendingCellRef.current)
      cellMapRef.current.set(m.id, pendingCellRef.current);
  }
  const boundaryBefore = new Map(
    conversationBoundaries(
      // Only AI messages carry both an id and a cell. Data-part messages have
      // no id at all, so they get a synthetic one that no boundary can name —
      // they must appear in the sequence (a card between two turns is not a
      // change) without being able to open or close a section.
      messages.map((m, i) =>
        m.type === "ai"
          ? { id: m.id, cell: cellMapRef.current.get(m.id) }
          : { id: `nonagent-${i}`, cell: undefined }
      )
    ).map((b) => [b.beforeMessageId, b] as const)
  );

  return (
    // `h-full`, not `h-screen`: the shell owns the viewport now. This sits
    // inside SidebarInset, below a 56px header, so `h-screen` here made the
    // document exactly 56px taller than the window on every page rendering
    // this surface. Also a <div> rather than a <main> — SidebarInset already
    // renders <main>, and two main landmarks is a WCAG violation the a11y
    // suite scans for.
    /*
     * A CARD PANEL THAT FILLS THE INSET, not a centred strip.
     *
     * `h-full`, not `h-screen`: the shell owns the viewport. This sits inside
     * SidebarInset below a 56px header, so `h-screen` made the document
     * exactly 56px taller than the window on every page rendering this
     * surface. And a <div> rather than a <main>, because SidebarInset already
     * renders one and two main landmarks is a WCAG violation.
     *
     * FLUSH AND FULL-BLEED, matching apps/open-swe's chat surface so the two
     * apps read as one product. The stack of `border-b` bars was never the
     * problem — the `max-w-2xl` cap was, which rendered the whole surface as a
     * 672px ribbon adrift in a 1750px inset. Removing the cap fixes it without
     * a card wrapper, and a card here would have made this surface the odd one
     * out: open-swe's equivalent runs edge to edge under the shell header.
     */
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Header */}
        <header className="border-b border-border bg-card px-4 py-3 flex items-center gap-2">
          <div
            data-testid="header-status-dot"
            // The STATE, in the DOM. e2e asserted toHaveClass(/bg-red-500/) — a proxy that a
            // reskin breaks while the error state is perfectly intact, and a second assertion
            // of what the line above already checks by text. #60's theme swap broke five
            // specs this way without breaking a single behaviour.
            data-status={status}
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
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {messages.length === 0 && (
            <div className="text-center text-muted-foreground text-sm mt-8">
              Send a message to start the demo
            </div>
          )}
          {messages.map((msg, idx) => {
            if (msg.type === "user")
              return <UserBubble key={msg.id} msg={msg} />;
            if (msg.type === "ai") {
              // Only AI messages carry a cell, so only they can open a new
              // section — the separator never needs to attach anywhere else.
              const boundary = boundaryBefore.get(msg.id);
              const bubble = (
                <AIBubble
                  key={msg.id}
                  msg={msg}
                  via={viaMapRef.current.get(msg.id)}
                />
              );
              if (!boundary) return bubble;
              return (
                <div key={`sec-${msg.id}`}>
                  <div
                    data-testid="transcript-boundary"
                    data-to={`${boundary.to.runtime}·${boundary.to.framework}·${boundary.to.topology}`}
                    role="separator"
                    aria-label={boundary.label}
                    className="flex items-center gap-3 py-2 text-xs text-muted-foreground"
                  >
                    <span className="h-px flex-1 bg-border" />
                    <span className="whitespace-nowrap">{boundary.label}</span>
                    <span className="h-px flex-1 bg-border" />
                  </div>
                  {bubble}
                </div>
              );
            }
            if (msg.type === "tool-call")
              return <ToolCallCard key={msg.id} msg={msg} />;
            if (msg.type === "data-task")
              return (
                <CardRow key={`task-${idx}`}>
                  <TaskCard
                    task={(msg as unknown as DataTaskMsg).data}
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
            if (msg.type === "data-agents-md")
              return (
                <CardRow key={`agents-md-${idx}`}>
                  <AgentsMdCard
                    agentsMd={(msg as unknown as DataAgentsMdMsg).data}
                    className={`${BUBBLE} bg-card border-border`}
                  />
                </CardRow>
              );
            // Rung-owned cards resolve through the registry. Their renderers live in
            // modules eject deletes with the rung, so this file names none of them — which is
            // the whole point: `import { PlanCard }` here is what broke `eject deepagents`.
            // A part whose rung is gone renders nothing, exactly as an unknown part always
            // has, so a fork degrades to a smaller conversation rather than a broken page.
            if (typeof msg.type === "string" && msg.type.startsWith("data-")) {
              // ctx carries what a moved card would otherwise have lost: this
              // surface's approval decisions continue the conversation (#492).
              const card = renderPart(
                msg.type,
                (msg as unknown as { data: unknown }).data,
                { sendMessage: (text: string) => sendMessage(text) }
              );
              if (card)
                return <CardRow key={`${msg.type}-${idx}`}>{card}</CardRow>;
            }
            return null;
          })}
          <div ref={bottomRef} />
        </div>

        {/* Matrix selectors: Python framework × AI backend (adapter implied by AI choice) */}
        <div className="border-b border-border bg-muted px-4 py-2 flex gap-4 items-center">
          <div className="flex gap-2 items-center">
            <span className="text-xs text-muted-foreground font-medium">
              {/* Was "Python:" — accurate until the TypeScript plane shipped. */}
              Runtime:
            </span>
            {/*
             * RUNTIMES, not a literal pair. A hardcoded list here would have
             * reproduced #360's defect one value further along: the option the
             * user cannot see is indistinguishable from the option that does
             * not exist, and three rungs shipped unreachable behind exactly
             * that. Availability still governs whether each is SELECTABLE —
             * unconfigured entries stay listed and disabled, so the remedy in
             * the title is not hidden with them.
             */}
            {RUNTIMES.map((b) => {
              const configured = availableBackends[b];
              return (
                <button
                  key={b}
                  type="button"
                  // These three selector groups are toggle groups and exposed no pressed
                  // state at all — a screen reader could read the options and not which one
                  // was active. aria-pressed fixes that for real, and makes the e2e
                  // assertion theme-proof by construction rather than by convention.
                  aria-pressed={runtime === b}
                  onClick={() => configured && setRuntime(b)}
                  disabled={!configured}
                  title={
                    configured
                      ? RUNTIME_LABEL[b]
                      : `${RUNTIME_LABEL[b]} — not configured in .env.local`
                  }
                  className={`rounded px-2 py-0.5 text-xs font-mono ${
                    !configured
                      ? "bg-muted border border-border text-muted-foreground cursor-not-allowed"
                      : runtime === b
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
            <span className="text-xs text-muted-foreground font-medium">
              AI:
            </span>
            {adapterIds().map((a) => (
              <button
                key={a}
                type="button"
                aria-pressed={aiBackend === a}
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
            ))}
          </div>
          <div className="flex gap-2 items-center">
            <span className="text-xs text-muted-foreground font-medium">
              Topology:
            </span>
            {topologiesFor(aiBackend, runtime).map((t) => (
              <button
                key={t}
                type="button"
                aria-pressed={topology === t}
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
        {/*
         * Bar full-bleed, input measured — the same split apps/open-swe's chat
         * composer uses. An edge-to-edge text field on a wide monitor is a
         * worse target than a centred one, but a floating bar breaks the line
         * the header and toolbar establish, so the border spans and the
         * control does not.
         */}
        <form
          onSubmit={handleSubmit}
          className="border-border bg-card border-t p-4"
        >
          <div className="mx-auto flex w-full max-w-5xl gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Type a message…"
              aria-label="Chat message"
              disabled={status !== "idle" && status !== "error"}
              className="border-border focus:border-ring flex-1 rounded-xl border px-4 py-2 text-sm outline-none disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={
                (status !== "idle" && status !== "error") || !input.trim()
              }
              className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-xl px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50"
            >
              Send
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
