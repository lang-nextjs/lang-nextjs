"use client";

import {
  Fragment,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ChatWorkspace,
  type WsFile,
  type WsTodo,
  type WsSubAgent,
  type WsTool,
  type WsUnreadable,
} from "../components/ChatWorkspace";
import {
  useWorkspaceSettings,
  effectiveSystemPrompt,
} from "../lib/workspace-settings";
import {
  newConversationId,
  titleFromMessage,
  useConversations,
} from "../lib/conversations";
import { ChatTranscriptRecord } from "../components/ChatTranscriptRecord";
import { ChatSelectors } from "../components/ChatSelectors";
import { useTranscript } from "../lib/transcript";
import { computeReadiness, toneForReadiness, canSend } from "../lib/readiness";
import { toneDotClass } from "../lib/dependency-status";
import {
  FRAMEWORKS,
  DEFAULT_FRAMEWORK,
  RUNTIMES,
  isKnownFramework,
  resolveFramework,
  topologiesFor,
  type AiBackend,
  type Runtime,
  type Topology,
} from "../lib/frameworks";
import {
  axisTrail,
  boundariesFor,
  type Cell as TranscriptCell,
} from "../lib/transcript-boundaries";
import { userFacingError } from "../lib/error-copy";
import {
  ProcessingRow,
  deriveProcessingSignals,
} from "@deepagents-nextjs/react";
import { CARD, renderPart } from "../lib/rungs/cards";
import {
  useDeepAgentsChat,
  TaskCard,
  ApprovalCard,
  ApprovalPauseCard,
  HumanResponseCard,
  AgentsMdCard,
  PlanSchema,
  TaskSchema,
  FileSchema,
  ApprovalSchema,
  useApprovalCardController,
  useApprovalPauseController,
  TodoSchema,
  AgentsMdSchema,
  DataSubAgentSchema,
  DataHumanResponseSchema,
  ApprovalPauseSchema,
  DataErrorSchema,
  type AIMessage,
  type UserMessage,
  type ToolCallMessage,
  getBrowserOwnerKey,
} from "@deepagents-nextjs/react";

// CARD lives in lib/rungs/cards/registry.tsx so the rung-owned packs and this file cannot
// drift apart on the bubble they draw. Re-exported from there, not redeclared here.

/**
 * STYLES FOR A HEADLESS CARD, supplied by the consumer that is supposed to
 * supply them.
 *
 * `ApprovalCard` is deliberately unstyled — its own docblock says "no opinions
 * about layout, colors", and that is the right call for a component five rungs
 * share. What it means is that a consumer passing only an outer `className`
 * gets bare spans and buttons with nothing between them. Rendered, that read:
 *
 *   incrementwaiting
 *   Approval required for increment
 *   {}
 *   ApproveRejectEditRespond
 *
 * Two labels fused into a non-word, and four buttons fused into another. Not a
 * broken component — an unfinished integration, and the failure mode of headless
 * libraries generally: the default is not "plain", it is "wrong", and it looks
 * like a rendering bug rather than a missing stylesheet.
 *
 * Targeted through the card's `data-slot` attributes — the repo convention,
 * used by 17 components in packages/ui, and the reason it exists is exactly
 * this: styling and testing must not share an identifier.
 *
 * The first version of this block styled through `data-testid`. That made a
 * TEST identifier load-bearing for PRODUCTION appearance, which inverts the
 * usual direction — normally a testid can be renamed or deleted freely. Nothing
 * would have caught it either: no type checker sees inside a Tailwind class
 * string, so a rename in the package would have silently collapsed the layout
 * again.
 */
const APPROVAL_CARD = [
  CARD,
  "flex flex-col gap-2",
  // Name and status are two facts, not one word.
  "[&_[data-slot=approval-action-name]]:font-mono",
  "[&_[data-slot=approval-action-name]]:font-medium",
  "[&_[data-slot=approval-status]]:ml-2",
  "[&_[data-slot=approval-status]]:rounded",
  "[&_[data-slot=approval-status]]:border",
  "[&_[data-slot=approval-status]]:border-warning/30",
  "[&_[data-slot=approval-status]]:bg-warning/10",
  "[&_[data-slot=approval-status]]:px-1.5",
  "[&_[data-slot=approval-status]]:py-0.5",
  "[&_[data-slot=approval-status]]:text-[11px]",
  "[&_[data-slot=approval-status]]:uppercase",
  "[&_[data-slot=approval-status]]:tracking-wide",
  // The arguments are a payload; `{}` should read as empty, not as debris.
  "[&_[data-slot=approval-arguments]]:font-mono",
  "[&_[data-slot=approval-arguments]]:text-xs",
  "[&_[data-slot=approval-arguments]]:text-muted-foreground",
  "[&_[data-slot=approval-arguments]]:overflow-x-auto",
  // Four verbs need to be four buttons.
  "[&_[data-slot=approval-actions]]:flex",
  "[&_[data-slot=approval-actions]]:flex-wrap",
  "[&_[data-slot=approval-actions]]:gap-2",
  "[&_[data-slot=approval-actions]]:pt-1",
  "[&_[data-slot=approval-actions]>button]:rounded-lg",
  "[&_[data-slot=approval-actions]>button]:border",
  "[&_[data-slot=approval-actions]>button]:border-border",
  "[&_[data-slot=approval-actions]>button]:px-3",
  "[&_[data-slot=approval-actions]>button]:py-1",
  "[&_[data-slot=approval-actions]>button]:text-xs",
  // Approve is the consequential one and should not look like Cancel.
  "[&_[data-slot=approve-button]]:border-success/40",
  "[&_[data-slot=approve-button]]:bg-success/10",
  "[&_[data-slot=approve-button]]:text-success",
  "[&_[data-slot=reject-button]]:border-destructive/40",
  "[&_[data-slot=reject-button]]:text-destructive-ink",
  // The edit and respond panels are forms, not runs of text.
  "[&_[data-slot=approval-edit-panel]]:flex",
  "[&_[data-slot=approval-edit-panel]]:flex-col",
  "[&_[data-slot=approval-edit-panel]]:gap-2",
  "[&_[data-slot=approval-edit-panel]]:pt-2",
  "[&_[data-slot=approval-respond-panel]]:flex",
  "[&_[data-slot=approval-respond-panel]]:flex-col",
  "[&_[data-slot=approval-respond-panel]]:gap-2",
  "[&_[data-slot=approval-respond-panel]]:pt-2",
  "[&_textarea]:rounded-lg",
  "[&_textarea]:border",
  "[&_textarea]:border-border",
  "[&_textarea]:bg-background",
  "[&_textarea]:p-2",
  "[&_textarea]:text-xs",
].join(" ");

function ChatPageContent() {
  // Per-browser approval owner key. Minted once and kept in localStorage, so only THIS
  // browser can resolve approvals its own streams raised. useState so it is read once on
  // mount rather than on every render — getBrowserOwnerKey touches localStorage. (#170)
  const [ownerKey] = useState(() => getBrowserOwnerKey());
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
  /*
   * THE PATHNAME IS PART OF THE ANSWER (#154).
   *
   * This surface is served at BOTH `/` and `/chat` — the second is the address
   * it used to live at, kept routable for conversation links already written
   * into browsers' localStorage. Rebuilding the URL from a literal `/` would
   * be a ROUTE change for anyone who arrived at `/chat`, not a query change,
   * and Next remounts across routes. The conversation dies on the first
   * framework switch — the one thing the comment on selectFramework promises
   * cannot happen.
   *
   * Worth stating because it is invisible locally: the page renders correctly
   * either way, and the loss only shows up once there is a conversation to
   * lose. This shipped to CI and the switch-separator suite caught it.
   */
  const pathname = usePathname() ?? "/";
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
   * A REAL SESSION, NOT A CONSTANT (#171).
   *
   * This was the literal "lang-nextjs-chat" — the same value for every user,
   * every browser and every conversation. A field that exists at every layer
   * and identifies nothing is worse than an absent one: #160 proposed binding
   * approvals to the creating session, and against a constant that is a check
   * which passes for everybody — theatre in the shape of a constraint.
   *
   * THE CONVERSATION ID IS THE SESSION. It already exists, it is already in the
   * URL, and it is already what the transcript is keyed on. Using it means a
   * conversation's turns group together and two conversations are
   * distinguishable, which is the property that was missing end to end.
   *
   * A chat with no `?c=` yet is still ONE conversation, so it gets an id minted
   * once per mount rather than falling back to a shared constant. Keeping the
   * constant for that case would leave the defect intact on the default path,
   * which is the one most requests take.
   */
  const fallbackSessionRef = useRef<string | null>(null);
  if (fallbackSessionRef.current === null)
    fallbackSessionRef.current = newConversationId();
  const sessionId = conversationParam ?? fallbackSessionRef.current;

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

  /*
   * #160 gap 1 — resolving an approval POSTs a DECISION that resumes the
   * paused run. It does NOT send a chat message: the previous code called
   * sendMessage(`Approved: X`), which the agent had to interpret and could
   * ignore, because nothing had paused it.
   *
   * Approvals are accepted only from this machine — see
   * lib/approval-local-only.ts for the exact (narrow) guarantee.
   */
  const {
    cardPropsFor: approvalCardProps,
    status: approvalStatus,
    error: approvalError,
  } = useApprovalCardController({
    endpoint: "/api/approval",
    ownerKey,
  });

  /*
   * THE UPSTREAM GATE'S CONTROLLER (#420), MOUNTED BESIDE THE OTHER ONE.
   *
   * Not a replacement. `useApprovalCardController` above answers
   * `data-approval-required`, which the PROXY transform raises after the backend
   * has already run the tool — it withholds the report, not the effect. This one
   * answers `data-approval-pause`, which an UPSTREAM interrupt raises before the
   * call runs. Ungated topologies still use the first and it is correct for
   * them, so both are wired until #449 settles which layer owns the gate.
   *
   * The honest gate was built end to end — withholding measured, frame emitted,
   * schema defined, card and controller written — and mounted by nothing. This
   * is the composition nobody's issue covered.
   *
   * `baseBody` mirrors the chat body above, because a resumed turn IS an
   * ordinary chat turn: `parse_approval_decisions` reads the decisions off the
   * dispatch body rather than from a separate approval route.
   */
  const { cardPropsFor: pauseCardProps } = useApprovalPauseController({
    endpoint: "/api/chat/stream",
    baseBody: () => ({ aiBackend, runtime, topology, systemPrompt }),
  });

  // The stream carries no follow-up status for a resolved approval, so the card
  // is dismissed client-side once its POST succeeds.
  const [resolvedApprovals, setResolvedApprovals] = useState<Set<string>>(
    () => new Set()
  );
  // #211: resolveFramework distinguishes ABSENT from PRESENT-BUT-UNKNOWN. Both used to fall
  // through to DEFAULT_FRAMEWORK identically, so a typo'd or ejected-rung bookmark landed on
  // langchain with nothing said about it.
  const resolution = resolveFramework(frameworkParam);
  const paramIsValid = resolution.kind === "honoured";

  const [aiBackend, setAiBackend] = useState<AiBackend>(() => resolution.id);

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
    // `pathname`, not a literal — see the note where it is read. Staying on the
    // address the user arrived at is what keeps this a query change.
    router.replace(`${pathname}?${q.toString()}`, { scroll: false });
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
  const { conversations, upsert } = useConversations();
  const activeConversation = conversationParam
    ? conversations.find((c) => c.id === conversationParam)
    : undefined;
  const systemPrompt = effectiveSystemPrompt(
    wsSettings.systemPrompt,
    activeConversation?.systemPrompt
  );

  // Is a model reachable at all? Probed once; `null` while in flight so the
  // indicator can say "checking" rather than guessing green.
  /*
   * WHY THE CONFIG PROBE HAS AN OUTCOME AND NOT JUST A RESULT (#360).
   *
   * Three things can go wrong with this probe and they used to be one thing:
   * nothing rendered. The fetch can fail; the route can answer about a runtime
   * nobody asked for; and — new here — the route can report that it could not
   * resolve the runtime it was given. All three previously left
   * `llmConfigured` at null, which the indicator renders as "checking…", so a
   * permanent failure was displayed as a probe still in flight.
   *
   * That is the same convergence this issue removed one layer down: separating
   * missing from unknown in the parser and then re-merging every failure here
   * would be a poor trade. Each outcome is named, and each renders distinctly.
   */
  const [configNotice, setConfigNotice] = useState<{
    kind:
      | "runtime-unresolved"
      | "answered-about-another-runtime"
      | "probe-failed";
    text: string;
  } | null>(null);
  const [llmConfigured, setLlmConfigured] = useState<boolean | null>(null);
  // WHO answered, so a `false` can be read correctly. /api/config has always
  // reported this and nothing consumed it — which is how a stopped backend
  // came to be reported as a missing API key.
  const [llmSource, setLlmSource] = useState<"backend" | "local-env" | null>(
    null
  );
  const [topology, setTopology] = useState<Topology>("react");

  /*
   * WHICH RUNTIME. django and fastapi host the same three rungs, and they do
   * not serve the same topologies — so this is an axis of the surface, not a
   * deployment constant. `availableBackends` starts all-false and is filled
   * from the server: an unconfigured runtime must render unselectable rather
   * than fail on send with a 502 naming an env var the user never saw.
   */
  /*
   * THE NAME NO LONGER LIES (#360). This was `pythonBackend`, holding a value
   * that can be "node" — the same contradiction the wire key had, one layer in.
   * Renamed on the commit that closed the transition window, so the field, the
   * type, the env vars and the local all say the same word.
   */
  const [runtime, setRuntime] = useState<Runtime>("fastapi");
  const [availableBackends, setAvailableBackends] = useState<
    Record<Runtime, boolean>
  >({ django: false, fastapi: false, node: false });

  /*
   * THE PROBE FOLLOWS THE SELECTED RUNTIME (#333).
   *
   * This was `fetch("/api/config")` with `[]` deps — asked once, about whichever runtime the
   * route happened to name, and never asked again. django and fastapi are an axis of this
   * surface, not a deployment constant, so switching runtime left the indicator reporting a
   * process the user was no longer talking to: green dot, enabled composer, 502 on send if
   * only the other runtime had a key. Exactly what readiness.ts exists to prevent, one axis
   * over.
   *
   * THE RESET TO `null` IS HALF THE FIX. Naming the runtime in the request and leaving the
   * previous answer on screen while the new one is in flight would still show a verdict about
   * the runtime the user just LEFT. `null` is "checking…", which is the only honest thing to
   * say in that window — and it is deliberately not `false`, which would claim a probe came
   * back saying no.
   */
  useEffect(() => {
    let cancelled = false;
    setLlmConfigured(null);
    setLlmSource(null);
    fetch(`/api/config?runtime=${encodeURIComponent(runtime)}`)
      .then(
        (r) =>
          r.json() as Promise<{
            runtime?: Runtime;
            runtimeUnresolved?: string | null;
            activeLlm: string | null;
            llmSource?: "backend" | "local-env";
            backends?: Record<Runtime, boolean>;
          }>
      )
      .then((c) => {
        if (cancelled) return;
        // THE ROUTE NAMES ITS SUBJECT, SO CHECK IT. `cancelled` already handles the ordinary
        // switch, but this is the cheap guard against the case it cannot see: a response that
        // answers about a runtime nobody asked about — a proxy or cache serving a stale
        // payload, or a future caller passing the parameter wrong. `llmSource` sat in this
        // payload unconsumed for months and a stopped backend was reported as a missing API
        // key; a field nobody reads is a field that cannot protect anything.
        if (c.runtime && c.runtime !== runtime) {
          // Was a bare `return`, which left the indicator on "checking…"
          // forever — a permanent wrong answer wearing the look of one still
          // arriving.
          setConfigNotice({
            kind: "answered-about-another-runtime",
            text: `the config probe answered about ${c.runtime}, not ${runtime}`,
          });
          return;
        }
        if (c.runtimeUnresolved) {
          // The route answered 200 and told us it could not resolve what we
          // named — so it probed something else. Adopting that answer is
          // exactly the silent fallback #360 exists to remove.
          setConfigNotice({
            kind: "runtime-unresolved",
            text: c.runtimeUnresolved,
          });
          return;
        }
        setConfigNotice(null);
        setLlmConfigured(!!c.activeLlm);
        setLlmSource(
          c.llmSource === "backend" || c.llmSource === "local-env"
            ? c.llmSource
            : null
        );
        // Same endpoint, same round trip: a second fetch for the runtime list
        // would let the two answers arrive out of order and disagree.
        if (c.backends) setAvailableBackends(c.backends);
      })
      .catch(() => {
        // A failed probe is not proof of absence. Leave it unknown rather than
        // blocking a surface that may be perfectly fine.
        if (!cancelled) {
          setLlmConfigured(null);
          setLlmSource(null);
          // DISTINCT FROM THE TWO ABOVE. "We could not reach the probe" and
          // "the probe answered about something else" call for different
          // repairs, and rendering both as silence is what made the second
          // invisible.
          setConfigNotice({
            kind: "probe-failed",
            text: "the config probe could not be reached",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [runtime]);

  const [tools, setTools] = useState<WsTool[]>([]);
  const [mcps, setMcps] = useState<string[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  /*
   * WHEN THIS TURN WAS SUBMITTED (#231). The processing row measures from here,
   * and nowhere else knows it: `status` tells you the turn is in flight, not
   * when it started. Cleared on a terminal state so the row cannot resurrect a
   * stale origin on the next turn.
   */
  const [submittedAt, setSubmittedAt] = useState<number | null>(null);

  // Keep the selected topology valid for the chosen (framework, runtime) pair.
  // Unavailable modes are not rendered at all, so without this a mode selected
  // under one pair would stay selected — and keep being sent — after switching
  // to a pair whose button list no longer contains it.
  const availableTopologies = useMemo(
    () => topologiesFor(aiBackend, runtime),
    [aiBackend, runtime]
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

  /**
   * WHICH CELL ANSWERED EACH MESSAGE.
   *
   * STATE WRITTEN FROM AN EFFECT, not a ref written during render. The first
   * version did the latter, which React forbids: under concurrent rendering a
   * render can be discarded while the ref write is not, and because this list is
   * append-only and never re-tags, a torn write would be PERMANENT rather than
   * self-healing. The append-only rule and render-time mutation are individually
   * defensible and together are a bug.
   *
   * A message is tagged ONCE. Re-tagging on every change would rewrite history:
   * switch framework and every earlier message would claim to have been answered
   * by the new one, erasing exactly what the separator exists to show.
   *
   * BY POSITION, because the message union exposes no stable id at this level and
   * messages are only appended. A newly arrived message is untagged for one
   * frame; `boundariesFor` skips untagged entries, so it simply has no separator
   * until the effect lands — never a wrong one.
   */
  const [cells, setCells] = useState<Array<TranscriptCell | undefined>>([]);

  const { messages, sendMessage, status, error, stop, retry } =
    useDeepAgentsChat<{
      "data-plan": typeof PlanSchema;
      "data-task": typeof TaskSchema;
      "data-file": typeof FileSchema;
      "data-approval": typeof ApprovalSchema;
      "data-approval-required": typeof ApprovalSchema;
      "data-approval-pause": typeof ApprovalPauseSchema;
      "data-sub-agent": typeof DataSubAgentSchema;
      "data-human-response": typeof DataHumanResponseSchema;
      "data-error": typeof DataErrorSchema;
      "data-todo": typeof TodoSchema;
      "data-agents-md": typeof AgentsMdSchema;
    }>({
      sessionId,
      ownerKey,
      endpoint: "/api/chat/stream",
      /*
       * RECONNECT (#361). Until now open-swe passed none of these, so a socket
       * that died mid-answer lost the reply outright — and `retry()` was a no-op,
       * because the hook makes it one unless `enableReconnect` is set.
       *
       * `resumeId` is the CONVERSATION id, which is what the hook asks for: "a
       * stable per-conversation ID". `sessionId` is exactly that since #171, so
       * there is no second identifier to keep in step with it. The server's
       * registry only refuses a resumeId whose stream is still ACTIVE, so
       * successive turns in one conversation re-register cleanly.
       *
       * This is inert without ENABLE_STREAM_RECONNECT=true on the server: the
       * resume route answers 503 and the hook's auto-GET finds nothing. e2e.yml
       * sets it on open-swe's server, and open-swe-reconnect.spec.ts asserts the
       * route is live rather than assuming it.
       */
      enableReconnect: true,
      resumeId: sessionId,
      resumeEndpoint: "/api/chat/stream/resume",
      // The workspace system prompt travels with every message. Empty string
      // means "leave the backend's own prompt alone" — the route drops it rather
      // than injecting a blank system message.
      body: {
        aiBackend,
        // `runtime`, the new name (#360); routes accept the old key for one
        // transition, but the client has to move or the transition never starts.
        runtime: runtime,
        topology,
        systemPrompt,
      },
      schemas: {
        "data-plan": PlanSchema,
        "data-task": TaskSchema,
        "data-file": FileSchema,
        "data-approval": ApprovalSchema,
        "data-approval-required": ApprovalSchema,
        // #420: the UPSTREAM gate's pause. Emitted by adapters/langchain.ts
        // since #428 and declared nowhere until now — partsToMessages DROPS a
        // data-* part with no registered schema, so the frame reached the
        // browser and was discarded before any component could see it.
        "data-approval-pause": ApprovalPauseSchema,
        "data-sub-agent": DataSubAgentSchema,
        "data-human-response": DataHumanResponseSchema,
        "data-error": DataErrorSchema,
        "data-todo": TodoSchema,
        "data-agents-md": AgentsMdSchema,
      },
    });

  useEffect(() => {
    setCells((prev) => {
      if (prev.length >= messages.length) return prev;
      const next = prev.slice();
      for (let n = prev.length; n < messages.length; n++) {
        next[n] = { framework: aiBackend, runtime: runtime, topology };
      }
      return next;
    });
  }, [messages.length, aiBackend, runtime, topology]);

  const boundaries = useMemo(
    // `cells` is the only input. The previous version listed aiBackend /
    // runtime / topology, none of which this expression reads — a
    // decorative dependency list, which is worse than a wrong one because it
    // looks considered.
    () =>
      new Map(
        boundariesFor(cells.slice(0, messages.length)).map((b) => [b.index, b])
      ),
    [cells, messages.length]
  );

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
    llmSource,
    sandboxRequired: false,
    sandboxAvailable: null,
    streamStatus: status,
  });
  const sendable = canSend(readiness);

  /*
   * AN ERROR MUST NOT BE A DEAD END (#336).
   *
   * `computeReadiness` returns `error` for a failed stream, on the sound
   * principle that a surface which just failed should not claim to be ready.
   * The consequence was not sound: `canSend` requires `ready`, both composer
   * controls follow `sendable`, and NOTHING clears the state — the error
   * renders as a bare banner with no retry and no dismiss, and `chat-blocked`,
   * the one panel that tells a person what to DO, only renders for `blocked`.
   * So the app disabled the single action that would clear the error and left
   * a page reload as the only exit.
   *
   * `useChat` clears its own error on the next send. The disabled composer was
   * precisely what prevented that from ever happening, which is why this is
   * one predicate and not a Retry button: the recovery path already existed
   * and was unreachable.
   *
   * NOT the same as widening `canSend`. Readiness still reports `error`, the
   * banner still shows, and every other not-ready state — unknown, checking,
   * blocked — stays blocked, because those describe a surface that cannot
   * work rather than one that just failed and might.
   */
  const recoverable = readiness.state === "error";
  const composerUsable = sendable || recoverable;

  // Collect the workspace from the stream: files (dedup by path, latest wins),
  // the latest todo list, and sub-agents (dedup by id, latest status).
  const { wsFiles, wsTodos, wsSubAgents, wsUnreadable } = useMemo(() => {
    const fileMap = new Map<string, WsFile>();
    const subMap = new Map<string, WsSubAgent>();
    let todos: WsTodo[] = [];
    // #140: parts we received and could not read. Collected rather than
    // discarded, because "we could not parse this" and "nothing was produced"
    // call for opposite responses and used to render identically.
    const unreadable: WsUnreadable[] = [];
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
      } else if (m.type === "unreadable") {
        const u = m as unknown as {
          id: string;
          partType: string;
          reason: string;
          detail?: string;
        };
        unreadable.push({
          id: u.id,
          partType: u.partType,
          reason: u.reason,
          detail: u.detail,
        });
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
      wsUnreadable: unreadable,
    };
  }, [messages]);

  /**
   * Accepts a keyboard event as well as a form event: the textarea calls this
   * directly on Enter, because a textarea has no implicit submission to rely
   * on. Both carry preventDefault, which is all this needs from them.
   */
  function submit(e: React.FormEvent | React.KeyboardEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;

    // The timer's origin (#231). Stamped here rather than derived from a status
    // transition, because `status` says a turn is in flight, not when it began.
    setSubmittedAt(Date.now());

    /*
     * TITLE THE CONVERSATION FROM ITS FIRST MESSAGE (#151).
     *
     * `titleFromMessage` existed with six passing tests and NO caller, so every
     * row in History read "New chat" forever. Dead tested code is not a smaller
     * defect than missing code — the tests make it look finished.
     *
     * Only while the title is still the placeholder: once a message has titled
     * it, or the user has renamed it by hand, later messages must not overwrite
     * that. A rename the next message silently undoes is worse than no rename.
     */
    if (activeConversation && activeConversation.title === "New chat") {
      upsert({
        ...activeConversation,
        title: titleFromMessage(text),
        updatedAt: new Date().toISOString(),
      });
    }

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
      {/*
       * THE ONLY THING A PERSON SEES WHEN THE SOCKET DIES, and until #330 it
       * could not be asserted: this banner had no testid, so every spec that
       * wanted to prove "the reader is told" had to reach for `chat-error`,
       * which renders a `data-error` PART from the stream. A transport death
       * produces no part — the stream simply stops — so the two are not
       * interchangeable and the difference is invisible in a screenshot.
       *
       * Note this path prints `error.message` raw, while the part path runs
       * through userFacingError(). Left alone here: making them consistent is a
       * copy decision, not a coverage one.
       */}
      {error && (
        <div
          data-testid="chat-stream-error"
          className="border-b border-destructive/50 bg-destructive/15 px-5 py-2 text-sm text-destructive-ink"
        >
          <span>{error.message}</span>
          {/*
           * RETRY LIVES WITH THE ERROR, not in the composer row (#361).
           *
           * This banner is the only thing a person sees when the socket dies,
           * and until now it told them what happened and offered nothing to do
           * about it — the reply was simply gone. `retry()` has existed on the
           * hook throughout and was a NO-OP here, because the hook makes it one
           * unless `enableReconnect` is set, which open-swe never passed.
           *
           * Placed here rather than beside Send because it is only meaningful
           * in this state: a retry control that is always visible invites a
           * second identical request while the first is still streaming. Same
           * reasoning as `chat-stop`, which renders only while a reply is in
           * flight.
           */}
          <button
            type="button"
            data-testid="chat-retry"
            onClick={() => retry()}
            className="border-destructive/40 hover:bg-destructive/20 ml-3 rounded-md border px-2 py-0.5 text-xs transition-colors"
          >
            Retry
          </button>
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

            {/* #211: a requested framework this build cannot serve is SUBSTITUTED, never
                silently. Naming what was asked for is the point — after `pnpm eject`, this is
                how a fork says "deepagents is not in this build" instead of quietly answering
                as langchain. */}
            {resolution.kind === "substituted" && (
              <p
                data-testid="framework-substituted"
                data-requested={resolution.requested}
                role="status"
                className="border-warning/30 bg-warning/10 text-foreground mx-auto mb-4 w-full max-w-5xl rounded-lg border px-4 py-2 text-xs"
              >
                <strong>{resolution.requested}</strong> is not available in this
                build — showing <strong>{resolution.id}</strong> instead.
              </p>
            )}

            {transcriptWriteError && (
              <p
                data-testid="transcript-write-error"
                role="alert"
                className="border-destructive/30 bg-destructive/15 text-destructive-ink mx-auto mb-4 w-full max-w-5xl rounded-lg border px-4 py-2 text-xs"
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
              const boundary = boundaries.get(idx);
              const separator = boundary ? (
                <div
                  data-testid="framework-switch-separator"
                  data-from={axisTrail(boundary.from)}
                  data-to={axisTrail(boundary.to)}
                  role="separator"
                  className="text-muted-foreground my-3 flex items-center gap-3 text-xs"
                >
                  <span className="bg-border h-px flex-1" />
                  <span>{boundary.label}</span>
                  <span className="bg-border h-px flex-1" />
                </div>
              ) : null;
              if (msg.type === "user") {
                const m = msg as UserMessage;
                return (
                  <Fragment key={msg.id}>
                    {separator}
                    <div className="flex justify-end">
                      <div className="max-w-md rounded-2xl bg-success px-4 py-2 text-sm text-white">
                        {m.content}
                      </div>
                    </div>
                  </Fragment>
                );
              }
              if (msg.type === "ai") {
                const m = msg as AIMessage;
                return (
                  <Fragment key={msg.id}>
                    {separator}
                    <div data-role="assistant" className="flex justify-start">
                      <div className="max-w-md rounded-2xl border border-border bg-card px-4 py-2 text-sm text-foreground">
                        {m.content}
                        {m.isStreaming && (
                          <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-muted-foreground align-middle" />
                        )}
                      </div>
                    </div>
                  </Fragment>
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
                  <Fragment key={msg.id}>
                    {separator}
                    <div data-testid="tool-card" className="flex justify-start">
                      <details className="w-full max-w-md overflow-hidden rounded-xl border border-warning/20 bg-warning/10 text-sm">
                        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2">
                          {/*
                           * FOUR STATES, NOT TWO. This read
                           * `m.status === "complete" ? success : pulsing` — so a
                           * tool that THREW and one a human REFUSED both showed
                           * a green dot, because the converter filed them both
                           * under `complete`. The line below still carries the
                           * fingerprint of someone noticing: a regex on the
                           * RESULT TEXT to stop the error message leaking into a
                           * summary that claimed success.
                           */}
                          <span
                            data-tool-status={m.status}
                            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                              m.status === "complete"
                                ? "bg-success"
                                : m.status === "error"
                                ? "bg-destructive"
                                : m.status === "denied"
                                ? "bg-muted-foreground"
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
                  </Fragment>
                );
              }
              const data = (msg as unknown as { data: unknown }).data;
              const row = (node: React.ReactNode) => (
                <div key={`${msg.type}-${idx}`} className="flex justify-start">
                  {node}
                </div>
              );
              /*
               * RUNG-OWNED CARDS COME FROM THE REGISTRY (#154).
               *
               * data-plan (rung 4) and data-file / data-todo / data-sub-agent (rung 3) were
               * four named imports of rung-owned components in this file. `pnpm eject
               * langchain` prunes every one out of `@deepagents-nextjs/react`, so this page
               * could not compile in a fork below rung 3 — the reason the whole app was rung 4
               * and a lower fork threw the chat away.
               *
               * FIRST, and deliberately: `renderPart` returns null for a type no present rung
               * claims, so the shared branches below still run. Checking it before them means
               * a rung card and a core card can never both answer for one part type without
               * the registry's collision check seeing it.
               */
              const rungCard = renderPart(msg.type, data);
              if (rungCard) return row(rungCard);
              if (msg.type === "data-task")
                return row(<TaskCard task={data as never} className={CARD} />);
              // data-agents-md was REGISTERED here and never rendered: the schema parsed the
              // part, the dispatch had no branch for it, and the frame vanished silently.
              // Nothing failed, which is why nothing caught it — a part that is dropped and a
              // part that never arrived produce the same screen.
              if (msg.type === "data-agents-md")
                return row(
                  <AgentsMdCard agentsMd={data as never} className={CARD} />
                );
              /*
               * THE SECOND PART THIS FILE PARSED AND THREW AWAY (#330).
               *
               * Registered in the schema map above and dispatched nowhere — the
               * identical state `data-agents-md` was in, in this file, when the
               * comment above it was written. That comment diagnosed the
               * instance; nothing checked the shape, so it happened again.
               *
               * Not hypothetical. `onRespond` is wired by
               * useApprovalCardController, so ApprovalCard shows Respond;
               * answering it resolves the approval as `responded` and the
               * gating transform emits this frame. A person typed a reply to
               * the agent and the screen did not change.
               *
               * schema-dispatch-parity.test.ts now compares the two lists, so a
               * third one fails a test instead of vanishing.
               */
              if (msg.type === "data-human-response")
                return row(
                  <HumanResponseCard
                    response={data as never}
                    className={CARD}
                  />
                );
              if (msg.type === "data-approval-pause") {
                /*
                 * THE GATE THAT ACTUALLY WITHHOLDS (#420).
                 *
                 * The call has NOT run and will not until a decision arrives.
                 * That is the difference from `data-approval-required` directly
                 * below, which the proxy raises AFTER the backend already ran
                 * the tool — that card withholds the report, not the effect.
                 *
                 * ONE CARD PER ACTION IN THE PAUSE. `action_requests` is a list
                 * and `approvalDecisions` is matched to it POSITIONALLY, so the
                 * controller collects a decision per action and resumes once
                 * every one is answered; a short list is a ValueError upstream,
                 * not a partial answer.
                 */
                const pause = data as never;
                return row(
                  <div data-testid="approval-pause-group">
                    {pauseCardProps(pause).map((props, i) => (
                      <ApprovalPauseCard
                        key={`pause-${idx}-${i}`}
                        {...props}
                        className={APPROVAL_CARD}
                      />
                    ))}
                  </div>
                );
              }
              if (msg.type === "data-approval-required") {
                /*
                 * THE REAL GATE (#160 gap 1). The proxy PAUSED the run on a mutating
                 * tool call and is holding its frames; this decision releases them.
                 *
                 * NOTE THE FRAME TYPE, not just the callbacks. The old code handled
                 * `data-approval` and called sendMessage(`Approved: X`). This handles
                 * `data-approval-required` — the frame the gating transform emits when
                 * it actually stops the stream — and POSTs a decision that resumes it.
                 * A reviewer diffing only the callbacks would read the rename as
                 * cosmetic; it is the difference between a control and a message.
                 */
                const approval = data as { id: string };
                if (resolvedApprovals.has(approval.id)) return null;
                const wired = approvalCardProps(data as never);
                const settle = () =>
                  setResolvedApprovals((s) => new Set(s).add(approval.id));
                return row(
                  <ApprovalCard
                    {...wired}
                    className={APPROVAL_CARD}
                    onApprove={async () => {
                      await wired.onApprove();
                      settle();
                    }}
                    onReject={async () => {
                      await wired.onReject();
                      settle();
                    }}
                  />
                );
              }
              if (msg.type === "error" || msg.type === "data-error") {
                /*
                 * THE RAW MESSAGE DOES NOT REACH THE DOM (#262). It used to:
                 * "Upstream ended while an approval was still pending;
                 * releasing buffered frames" was shown to a person, in red, in
                 * the thread. A sentence about buffer management, where they
                 * expect to be told what went wrong with their request.
                 *
                 * The detail is not discarded — it goes to the console, which
                 * is where it was useful all along.
                 */
                const raw =
                  (msg as unknown as { message?: string }).message ??
                  (data as { message?: string })?.message ??
                  null;
                const code =
                  (msg as unknown as { code?: string }).code ??
                  (data as { code?: string })?.code ??
                  null;
                const friendly = userFacingError(code, raw);
                if (friendly.detail)
                  console.error(
                    `[open-swe] stream error${code ? ` (${code})` : ""}: ${
                      friendly.detail
                    }`
                  );
                const errText = friendly.text;
                // This union member carries no id, so it keeps the positional
                // key it already had rather than inventing one.
                return (
                  <Fragment key={`err-${idx}`}>
                    {separator}
                    <div className="flex justify-start">
                      <div
                        data-testid="chat-error"
                        className="max-w-md rounded-xl border border-destructive/30 bg-destructive/15 px-4 py-2 text-sm text-destructive-ink"
                      >
                        {errText}
                      </div>
                    </div>
                  </Fragment>
                );
              }
              // A message type this switch does not render still owes its
              // separator: the boundary belongs to the POSITION, not to the
              // element that happens to occupy it. Returning null here dropped
              // the marker entirely, and no test could see it because every
              // case in the spec uses a type that renders.
              return separator ? (
                <Fragment key={`sep-only-${idx}`}>{separator}</Fragment>
              ) : null;
            })}
            {/*
             * AT THE ASSISTANT'S POSITION, inside the list — which is the
             * whole point of #231. The pre-existing signal was a caret rendered
             * INSIDE an assistant bubble, and during `submitted` no such bubble
             * exists, so the one window a person needs feedback in had none.
             *
             * The row is replaced by the reply rather than stacking above it:
             * it sits after the last message and unmounts when the status
             * leaves submitted/streaming.
             */}
            {/*
             * SIGNALS DERIVED BY THE LIBRARY, NOT SPELLED OUT HERE (#790).
             *
             * This read `hasText={messages.some((m) => m.type === "ai")}` — EXISTENCE, not
             * content. The converter emits a caret bubble (`content: ""`) for a turn that has
             * produced only tool parts, so that proxy went true with no token having arrived
             * and the row said "Writing…" while a tool was running. `deriveProcessingSignals`
             * asks about content, and supplies the running tool so the row can say the more
             * specific true thing instead of falling through to the text branch.
             */}
            <ProcessingRow
              status={status}
              startedAt={submittedAt}
              {...deriveProcessingSignals(messages)}
            />
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

          {/*
           * STOP — the only one of #262's three gaps a person cannot work
           * around. A long or looping reply had to be waited out or the tab
           * closed, and nothing failed to say so: `useChat` has always
           * returned `stop`, the wrapper just never passed it on.
           *
           * PLACED AFTER THE THREAD AND BEFORE THE COMPOSER, matching the
           * canonical SDK example. Inside a message bubble is wrong for the
           * `submitted` half of the window — there is no assistant bubble yet,
           * which is the same reason the caret indicator misses that state
           * (#231).
           */}
          {(status === "submitted" || status === "streaming") && (
            <div className="mx-auto flex w-full max-w-5xl justify-end px-4 pt-2 lg:px-6">
              <button
                type="button"
                data-testid="chat-stop"
                onClick={() => stop()}
                className="border-border bg-card/60 text-muted-foreground hover:text-foreground rounded-lg border px-3 py-1 text-xs transition-colors"
              >
                Stop
              </button>
            </div>
          )}

          {/* Composer */}
          <form
            onSubmit={submit}
            className="mx-auto w-full max-w-5xl px-4 pt-2 lg:px-6"
          >
            <div className="flex gap-2 rounded-2xl border border-border bg-card/60 p-2 focus-within:border-border">
              {/*
               * A TEXTAREA, NOT AN INPUT — and Shift+Enter is why.
               *
               * This was an <input>, which cannot hold a newline. Pressing
               * Shift+Enter in it did not insert one; it triggered the form's
               * implicit submission and DISPATCHED THE MESSAGE. So the
               * keystroke everyone uses to add a line to a prompt sent the
               * half-written thought instead — unrecoverable, and it costs an
               * inference call.
               *
               * A single-line composer is also the wrong shape for the job.
               * This is an agent chat: prompts carry pasted stack traces, file
               * paths and numbered requirements, and a one-line box hides all
               * but the tail of them while you type.
               *
               * Enter still sends, because that is what the rest of the app
               * and the muscle memory expect. The two are now distinguished
               * explicitly rather than by which element happens to be here.
               */}
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  // Shift, and also the IME composition guard: an Enter that
                  // confirms a candidate in a Japanese or Chinese input method
                  // must not send the message. `isComposing` is the only
                  // reliable signal for that, and omitting it makes the
                  // composer unusable in those languages.
                  if (e.shiftKey || e.nativeEvent.isComposing) return;
                  e.preventDefault();
                  submit(e);
                }}
                rows={1}
                placeholder="Type a message…  (Shift+Enter for a new line)"
                disabled={!composerUsable}
                data-testid="chat-input"
                className="max-h-40 min-h-[2.25rem] flex-1 resize-none bg-transparent px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground outline-none disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={!composerUsable || !input.trim()}
                data-testid="chat-send"
                className="rounded-xl bg-success px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-success disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
              >
                Send
              </button>
            </div>
          </form>
          {/*
           * #158 — the three axes are DROPDOWNS, and `idle` is not one of them.
           * It trailed the eight buttons in the same flex row and read as a
           * fourth option; it is a status, so it now sits outside the control
           * group with `ml-auto` between them.
           *
           * The two opposite availability rules — runtime disabled-and-present,
           * mode absent — live in ChatSelectors and are documented there.
           */}
          <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-2 px-4 pb-6 pt-3 lg:px-6">
            <ChatSelectors
              frameworks={FRAMEWORKS}
              framework={aiBackend}
              onFramework={selectFramework}
              runtimes={RUNTIMES}
              runtime={runtime}
              availableRuntimes={availableBackends}
              onRuntime={setRuntime}
              modes={availableTopologies}
              mode={topology}
              onMode={setTopology}
            />

            {configNotice && (
              /*
               * RENDERED, because a field nobody displays is prose in a route.
               * `data-kind` carries WHICH outcome, so the three cannot be
               * asserted as one — separating them upstream and collapsing them
               * on screen would put the defect back where a user meets it.
               */
              <span
                data-testid="config-notice"
                data-kind={configNotice.kind}
                role="status"
                className="border-warning/30 bg-warning/10 text-foreground rounded-lg border px-2 py-1 text-xs"
              >
                {configNotice.text}
              </span>
            )}

            <span
              data-testid="chat-status"
              data-readiness={readiness.state}
              title={readiness.reasons.join("\n") || undefined}
              className="text-muted-foreground ml-auto flex items-center gap-1.5 text-xs"
            >
              <span
                // Was a ternary chain ending `: "bg-success"` — safe only while
                // ReadinessState had five members. A sixth shipped GREEN. Now exhaustive:
                // a new state fails to COMPILE rather than defaulting to healthy.
                className={`h-1.5 w-1.5 rounded-full ${toneDotClass(
                  toneForReadiness(readiness.state)
                )}${readiness.state === "busy" ? " animate-pulse" : ""}`}
              />
              {readiness.label}
            </span>
          </div>
        </div>
        <ChatWorkspace
          files={wsFiles}
          todos={wsTodos}
          subAgents={wsSubAgents}
          unreadable={wsUnreadable}
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
