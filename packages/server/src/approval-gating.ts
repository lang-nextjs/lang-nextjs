/**
 * Approval gating transform. CORE, not an adapter.
 *
 * This lived under adapters/ until 2026-08-24 but was never rung-specific: it imports only
 * ./accumulator and ./approval-registry, and it gates ANY SSE pipeline regardless of which
 * backend produced the frames. Its only two backend references were prose in this comment.
 * Leaving it under adapters/ meant handler.ts had to reach INTO the adapter directory for a
 * core capability, which is half of why the transport core could not be severed from the
 * DeepAgents rung. See issue #17.
 *
 * When a tool-input-start frame arrives and getApprovalConfig returns
 * { require: true }, the transform:
 *   1. Emits a data-approval-required frame (NOT the original tool frame)
 *   2. Pauses the entire stream — non-tool frames buffer globally, frames
 *      keyed to the pending toolCallId buffer in approval.bufferedFrames
 *   3. When the approval resolves, drains buffered frames in a SINGLE
 *      transform call (the N-output return type — see SseMultiTransform)
 *   4. Calls cleanupApproval() immediately after the drain returns
 *
 * Decision modes (LangGraph HumanInterrupt parity):
 *   - approve  → drain tool frames + global frames + trigger
 *   - edit     → drain with the buffered tool-input-start's `input` rewritten
 *                to approval.editedInput; also split the drained
 *                tool-input-start into AI-SDK-strict pair (stripped + synth
 *                tool-input-available)
 *   - reject   → emit data-error approval_rejected; drain global frames;
 *                drop tool frames
 *   - respond  → emit data-human-response with approval.response; drain
 *                global frames; drop tool frames
 *   - timeout  → same shape as reject but code=approval_timeout
 *
 * "DROP TOOL FRAMES" IS NOT "THE ACTION DID NOT EXECUTE" (#256).
 *
 * Those three lines used to say it was, and this transform cannot know it.
 * It sits downstream of whatever ran the tool: against a Python agent the
 * backend executes autonomously and these frames arrive after the work is
 * done. Measured through open-swe on deepagents — the counter moved 65 -> 66
 * while nobody approved anything.
 *
 * So dropping the frames withholds the REPORT, not the effect. Where the
 * buffer proves execution — a `tool-output-available` is a result, and a
 * result implies the call ran — `drainOnClose` now says so rather than
 * implying a veto that was never available.
 *
 * The N-output transform contract (`SseFrame[]` return) is what makes
 * multi-frame drains compose cleanly with subsequent input — the legacy
 * one-out contract required an internal readyQueue that consumed
 * follow-up input frames as "shift triggers" and lost them.
 *
 * AI SDK v6 strict compatibility: the drained tool-input-start is split
 * into a stripped tool-input-start (no `input` field — AI SDK's
 * uiMessageChunkSchema uses strictObject and rejects unknown fields) plus
 * a synthetic tool-input-available carrying the (possibly edited) input.
 * useChat assembles the pair into a complete tool-call message.
 */

import type { SseFrame, SseMultiTransform } from "./accumulator";
import {
  registerApproval,
  getApproval,
  cleanupApproval,
} from "./approval-registry";

/**
 * How often drainOnClose re-checks the registry for a human decision. Small enough that a
 * decision feels immediate, large enough not to spin a CPU while someone reads a diff.
 */
const POLL_INTERVAL_MS = 25;

/**
 * Default ceiling on how long the proxy holds its response open after upstream ends while an
 * approval is pending.
 *
 * This is DELIBERATELY NOT the approval's own `timeoutMs`, and an earlier draft of this fix
 * got that wrong. The two answer different questions:
 *
 *   timeoutMs      — how long the APPROVAL stays valid. A business rule; 5 minutes by
 *                    default, because that is how long a human may reasonably take.
 *   drainGraceMs   — how long the PROXY holds an HTTP response open with no upstream behind
 *                    it. An infrastructure cost: a pinned worker and an open socket, against
 *                    platform response limits that are typically 60s or less.
 *
 * Binding the second to the first means a user who closes their tab pins a worker for five
 * minutes. 30s comfortably covers real decision latency (the reproduction cliff was at 4s)
 * while staying under those limits. When the grace expires, buffered frames are RELEASED
 * with an explanatory error rather than discarded — the data is never lost, only late.
 */
const DEFAULT_DRAIN_GRACE_MS = 30_000;

export interface ApprovalGatingConfig {
  getApprovalConfig?: (toolCall: {
    toolCallId: string;
    toolName: string;
    input: Record<string, unknown>;
  }) => { require: boolean; timeoutMs?: number } | undefined;
  /**
   * Ceiling on the post-upstream-close wait, in ms. Default 30_000. `0` closes immediately,
   * releasing any buffered frames with an `approval_pending_at_close` error — useful in
   * tests that assert on pre-approval state. The effective wait is
   * `min(drainGraceMs, time until the approval expires)`.
   */
  drainGraceMs?: number;
  /**
   * Opaque owner key stamped onto every approval this transform registers. The
   * handler reads it from the `x-approval-owner` header per request. Absent means
   * approvals are resolvable by id alone. See `PendingApproval.ownerKey`.
   */
  ownerKey?: string;
}

/**
 * The gating transform, plus the two capabilities the handler needs at upstream close.
 *
 * EXTENDS SseMultiTransform rather than replacing it, so the value is still callable as an
 * ordinary transform and every existing `transforms: [...]` call site is unaffected —
 * `createApprovalGatingTransform` is public API.
 */
export interface ApprovalGatingTransform extends SseMultiTransform {
  /** True while any approval is awaiting a decision, or any frame is still buffered. */
  hasPending(): boolean;
  /**
   * Called by the handler when UPSTREAM has ended but approvals are still pending.
   *
   * Waits for each pending approval to resolve or expire and returns every frame that must
   * still reach the client. Bounded by each approval's own `expiresAt`: `getApproval()`
   * flips an expired `waiting` to `timeout` on its lazy TTL check, and `proactiveDrain`
   * turns `timeout` into a drain that removes the entry — so the loop terminates by
   * construction, with no second timeout knob to drift out of sync with the one the feature
   * already promises.
   */
  drainOnClose(): Promise<SseFrame[]>;
}

export function createApprovalGatingTransform(
  config: ApprovalGatingConfig
): ApprovalGatingTransform {
  // toolCallId → approvalId for currently pending approvals.
  const pendingApprovalsByToolCallId = new Map<string, string>();

  // Non-tool frames buffered while any approval is pending. These are released
  // after the approval resolves (regardless of decision mode).
  const globalBufferedFrames: SseFrame[] = [];

  // Monotonically increasing sequence counter for emitted data-* frames.
  let seqCounter = 0;

  /** Parse a `data: {...}` frame, or null when it is not one. */
  function parseFrame(f: SseFrame): Record<string, unknown> | null {
    if (!f.raw.startsWith("data: ")) return null;
    try {
      return JSON.parse(f.raw.slice(6)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  const emit = (o: Record<string, unknown>): SseFrame => ({
    raw: `data: ${JSON.stringify(o)}`,
  });

  /**
   * The name of a tool the buffer PROVES already ran, or null.
   *
   * A buffered `tool-output-available` is a RESULT, and a result implies the
   * call ran. Three separate paths need that fact and each grew its own copy of
   * the scan; this is the one they share, because "did it run" must not be able
   * to answer differently depending on which drain asks.
   *
   * The output frame frequently omits the name — deepagents emits it without
   * one, seen on the wire — and "(unnamed) already executed" is not actionable.
   * The name was captured at `tool-input-start`, which is where the gate fired,
   * so fall back to the caller's record and then to the buffered start frame.
   */
  function executedToolName(
    frames: SseFrame[],
    fallbackName?: string
  ): string | null {
    let fromStart: string | null = null;
    let sawOutput = false;
    let outputName: string | null = null;
    for (const f of frames) {
      const p = parseFrame(f);
      if (!p) continue;
      if (p.type === "tool-input-start" && typeof p.toolName === "string") {
        fromStart = fromStart ?? p.toolName;
      }
      if (p.type === "tool-output-available" && !sawOutput) {
        sawOutput = true;
        outputName = typeof p.toolName === "string" ? p.toolName : null;
      }
    }
    if (!sawOutput) return null;
    return outputName || fallbackName || fromStart || "(unnamed)";
  }

  /** A data-error frame in the shape the client's DataErrorSchema requires. */
  function errorFrame(id: string, code: string, message: string): SseFrame {
    return emit({
      type: "data-error",
      data: { id, seq: seqCounter++, code, message, retryable: false },
    });
  }

  /**
   * ONE ANNOUNCEMENT PER TOOL CALL, IN A FORM THE CLIENT WILL ACCEPT (#256).
   *
   * Everything this transform buffers is eventually released — on approve, on
   * edit, and (since #311) on reject/timeout/close once the buffer proves the
   * call already ran. Every one of those releases must satisfy two properties
   * that used to hold on only one of them:
   *
   * 1. THE `tool-input-start` MUST NOT CARRY `input`. AI SDK v6 parses standard
   *    frames with `strictObject`, and `uiMessageChunkSchema` REJECTS a
   *    `tool-input-start` that has one — measured against the installed
   *    `ai@6.0.197`, not assumed. deepagents emits exactly that frame, so the
   *    release paths #311 added were handing the client a chunk it discards.
   *    "Released, not dropped" was true of this transform and false of the wire,
   *    and the test asserting it could not see the difference.
   *
   * 2. EXACTLY ONE `tool-input-available` MAY REACH THE CLIENT. The old split
   *    synthesised one from the buffered start AND passed the upstream's own
   *    through, so every approved call announced its input twice. Invisible
   *    while both copies agreed — and `edit` is precisely what makes them
   *    disagree.
   *
   * `overrideInput` rewrites that single announcement, and is passed only when
   * an edit may honestly be applied. See drainApproveOrEdit.
   *
   * Buffers that do not begin with a tool-input-start pass through untouched:
   * this reshapes a gated tool call, and anything else is not one.
   */
  function releaseToolFrames(
    buffered: SseFrame[],
    overrideInput?: Record<string, unknown>
  ): SseFrame[] {
    const start = buffered.length > 0 ? parseFrame(buffered[0]) : null;
    if (!start || start.type !== "tool-input-start") return [...buffered];

    const stripped: Record<string, unknown> = {
      type: "tool-input-start",
      toolCallId: start.toolCallId,
      toolName: start.toolName,
    };
    if (start.dynamic !== undefined) stripped.dynamic = start.dynamic;
    if (start.title !== undefined) stripped.title = start.title;
    if (start.providerExecuted !== undefined)
      stripped.providerExecuted = start.providerExecuted;

    const rest = buffered.slice(1);
    const upstreamAvailable = rest.findIndex((f) => {
      const p = parseFrame(f);
      return (
        p?.type === "tool-input-available" && p.toolCallId === start.toolCallId
      );
    });

    const out: SseFrame[] = [emit(stripped)];
    if (upstreamAvailable === -1) {
      // Nothing upstream announced the input, so this is the only announcement.
      const synth: Record<string, unknown> = {
        type: "tool-input-available",
        toolCallId: start.toolCallId,
        toolName: start.toolName,
        input:
          overrideInput ??
          (start.input as Record<string, unknown> | undefined) ??
          {},
      };
      if (start.dynamic !== undefined) synth.dynamic = start.dynamic;
      out.push(emit(synth));
    }
    rest.forEach((f, i) => {
      if (i !== upstreamAvailable) {
        out.push(f);
        return;
      }
      // Rewrite the upstream announcement in place rather than adding a second.
      const p = parseFrame(f);
      out.push(p && overrideInput ? emit({ ...p, input: overrideInput }) : f);
    });
    return out;
  }

  /**
   * Drain frames after an approve / edit resolution. Returns the full sequence
   * of frames that should reach the client — tool frames (with the first
   * tool-input-start split into the AI-SDK strict pair), global buffered
   * frames, then the optional trigger.
   */
  function drainApproveOrEdit(
    approvalId: string,
    toolCallId: string,
    triggerFrame: SseFrame | null
  ): SseFrame[] {
    const approval = getApproval(approvalId)!;
    const bufferedFrames = approval.bufferedFrames ?? [];

    const out: SseFrame[] = [];
    if (bufferedFrames.length > 0) {
      /*
       * AN EDIT CANNOT BE APPLIED TO A CALL THAT HAS ALREADY RUN (#256).
       *
       * `edit` is the one decision in this vocabulary that WRITES rather than
       * withholds: it replaces the announced input. Downstream of execution
       * that is not a veto with a smaller radius — it is a false record.
       *
       * Measured on the deepagents ordering before this changed. Editing
       * increment's input to `{by: 5}` produced, for one toolCallId:
       *
       *   tool-input-available  input {"by":5}   <- the edit
       *   tool-input-available  input {"by":1}   <- the upstream's own, also released
       *   tool-output-available "Counter incremented to 37"
       *
       * Two contradictory announcements and a result belonging to neither of
       * them in any way the client could tell. Whichever the assembler keeps,
       * the rendered record is a call the backend never made.
       *
       * Refusing the edit at the approval route would not cover this: the
       * result can arrive between the POST and the drain. The buffer is the
       * only thing that knows, so the check belongs here, where it is total.
       */
      const executedTool = executedToolName(bufferedFrames, approval.toolName);
      const editRequested = Boolean(
        approval.status === "edited" && approval.editedInput
      );
      if (editRequested && executedTool) {
        out.push(
          errorFrame(
            approvalId,
            "tool_executed_without_approval",
            `The upstream had already executed ${executedTool} when the edit ` +
              "arrived, so the edited input was NOT applied. The frames that " +
              "follow describe the call as it actually ran."
          )
        );
      }
      const override =
        editRequested && !executedTool ? approval.editedInput : undefined;
      out.push(...releaseToolFrames(bufferedFrames, override));
    }
    out.push(...globalBufferedFrames);
    globalBufferedFrames.length = 0;
    if (triggerFrame) out.push(triggerFrame);

    pendingApprovalsByToolCallId.delete(toolCallId);
    cleanupApproval(approvalId);
    return out;
  }

  /**
   * Drain frames after a respond resolution. Emits a data-human-response
   * frame carrying approval.response and drops the buffered tool frames.
   * Global buffered frames still drain.
   *
   * Dropping them withholds the REPORT, not the effect — see the note in
   * the module header (#256). Whether the tool ran is decided upstream.
   */
  function drainRespond(approvalId: string, toolCallId: string): SseFrame[] {
    const approval = getApproval(approvalId)!;
    const responseText = approval.response ?? "";

    pendingApprovalsByToolCallId.delete(toolCallId);

    const out: SseFrame[] = [
      {
        raw: `data: ${JSON.stringify({
          type: "data-human-response",
          data: {
            id: approvalId,
            seq: seqCounter++,
            response: responseText,
            createdAt: new Date().toISOString(),
          },
        })}`,
      },
      ...globalBufferedFrames,
    ];
    globalBufferedFrames.length = 0;

    cleanupApproval(approvalId);
    return out;
  }

  /**
   * Drain frames after a reject or timeout resolution. Emits a data-error
   * carrying the appropriate code and drops the buffered tool frames. Global
   * buffered frames still drain.
   *
   * cleanupApproval is NOT called here — cleanupExpiredApprovals (in the
   * handler finally block) eventually GCs the entry past TTL. This mirrors
   * the legacy behavior so route-handler tests stay deterministic.
   */
  function drainRejectOrTimeout(
    approvalId: string,
    toolCallId: string,
    status: "rejected" | "timeout"
  ): SseFrame[] {
    pendingApprovalsByToolCallId.delete(toolCallId);
    const approvalForDrain = getApproval(approvalId);

    /*
     * NEVER HIDE WORK THAT ALREADY HAPPENED (#256).
     *
     * Dropping the buffered tool frames is right when the decision actually
     * prevented the call. It is not right when the call already ran: this
     * transform sits downstream of execution, and against a Python agent the
     * backend runs autonomously — measured through open-swe on deepagents, the
     * counter moved 65 -> 66 while nobody approved anything.
     *
     * A buffered `tool-output-available` is a RESULT, and a result implies the
     * call ran. Dropping it then produces the worst combination the issue
     * describes: the action happened, the UI was told it needed approval, and
     * the frames describing it were discarded — so the effect is invisible and
     * the refusal looks decisive.
     *
     * When execution is proven the frames are RELEASED and the message says the
     * decision could not have prevented it. When it is not proven nothing
     * changes: dropping is still the honest outcome.
     */
    const executedTool = executedToolName(
      approvalForDrain?.bufferedFrames ?? [],
      approvalForDrain?.toolName
    );

    const decision =
      status === "rejected"
        ? "Tool execution was rejected"
        : "Tool approval expired";
    const code = executedTool
      ? "tool_executed_without_approval"
      : status === "rejected"
      ? "approval_rejected"
      : "approval_timeout";
    const message = executedTool
      ? `${decision}, but the upstream had already executed ${executedTool}; ` +
        "the decision could not have prevented it. Releasing the frames describing what ran."
      : decision;

    /*
     * RELEASED THROUGH THE SAME DOOR AS AN APPROVAL. These frames were buffered
     * with the upstream's `input` still on the `tool-input-start`, which AI SDK
     * v6 rejects — so pushing them raw released them from this transform and not
     * onto the wire. releaseToolFrames is what makes "released, not dropped"
     * true at the client. See its header.
     */
    const out: SseFrame[] = [
      errorFrame(approvalId, code, message),
      ...globalBufferedFrames,
      ...(executedTool
        ? releaseToolFrames(approvalForDrain?.bufferedFrames ?? [])
        : []),
    ];
    globalBufferedFrames.length = 0;
    return out;
  }

  /**
   * Build the data-approval-required envelope frame for a tool that's just
   * been gated. Also registers the approval in the global registry and
   * records the original tool-input-start as the first buffered frame.
   */
  function gateNewTool(
    parsed: Record<string, unknown>,
    originalFrame: SseFrame
  ): SseFrame | null {
    const toolCallId = parsed.toolCallId as string | undefined;
    const toolName = parsed.toolName as string | undefined;
    const input = (parsed.input as Record<string, unknown>) ?? {};
    if (!toolCallId || !toolName) return null;

    let approvalConfigResult:
      | { require: boolean; timeoutMs?: number }
      | undefined;
    try {
      approvalConfigResult = config.getApprovalConfig?.({
        toolCallId,
        toolName,
        input,
      });
    } catch (err) {
      // A misbehaving policy callback MUST NOT crash the SSE stream.
      // Treat a throw as "no approval required" (pass-through) and log
      // the error so it's visible to operators.
      // eslint-disable-next-line no-console
      console.error("approvalGating: getApprovalConfig threw", err);
      return null;
    }
    if (!approvalConfigResult?.require) return null;

    const approvalId = crypto.randomUUID();
    const now = Date.now();
    const timeoutMs = approvalConfigResult.timeoutMs ?? 300_000;
    const seq = seqCounter++;
    const createdAt = new Date(now).toISOString();
    const expiresAt = now + timeoutMs;

    registerApproval({
      approvalId,
      toolCallId,
      toolName,
      input,
      description: `Approval required for ${toolName}`,
      createdAt,
      expiresAt,
      bufferedFrames: [originalFrame],
      status: "waiting",
      ownerKey: config.ownerKey,
    });
    pendingApprovalsByToolCallId.set(toolCallId, approvalId);

    // `JSON.stringify` throws `TypeError: Converting circular structure to
    // JSON` if `input` (the tool's arguments, captured verbatim from the
    // upstream frame) carries a self-reference — a proxied value, a backend
    // that includes itself in args, etc. The approval gate's CORE INVARIANT
    // is that it NEVER crashes the SSE stream. Wrap stringify in try/catch
    // and fall back to a safe envelope that still carries every required
    // field; only `arguments` becomes the unserializable sentinel so the
    // approval UI can render with a placeholder.
    let envelopeRaw: string;
    try {
      envelopeRaw = `data: ${JSON.stringify({
        type: "data-approval-required",
        data: {
          id: approvalId,
          seq,
          actionName: toolName,
          description: `Approval required for ${toolName}`,
          arguments: input,
          status: "waiting",
          createdAt,
          expiresAt: new Date(expiresAt).toISOString(),
        },
      })}`;
    } catch {
      envelopeRaw = `data: ${JSON.stringify({
        type: "data-approval-required",
        data: {
          id: approvalId,
          seq,
          actionName: toolName,
          description: `Approval required for ${toolName}`,
          arguments: "<unserializable>",
          status: "waiting",
          createdAt,
          expiresAt: new Date(expiresAt).toISOString(),
        },
      })}`;
    }
    return { raw: envelopeRaw };
  }

  /**
   * Scan pending approvals for any resolved status. Returns the drained
   * SseFrame[] (or null when nothing is resolved). When the input frame's
   * toolCallId matches the drained approval AND status is approve/edit, the
   * trigger is appended to the drain output so it reaches the client.
   */
  function proactiveDrain(triggerFrame: SseFrame | null): SseFrame[] | null {
    let triggerToolCallId: string | undefined;
    if (triggerFrame && triggerFrame.raw.startsWith("data: ")) {
      try {
        const parsed = JSON.parse(triggerFrame.raw.slice(6)) as Record<
          string,
          unknown
        >;
        triggerToolCallId = parsed.toolCallId as string | undefined;
      } catch {
        // Non-JSON trigger — leave triggerToolCallId undefined.
      }
    }

    for (const [toolCallId, approvalId] of pendingApprovalsByToolCallId) {
      const approval = getApproval(approvalId);
      /* c8 ignore next 4 — defensive: external cleanup races */
      if (!approval) {
        pendingApprovalsByToolCallId.delete(toolCallId);
        continue;
      }
      if (approval.status === "approved" || approval.status === "edited") {
        const trigger = triggerToolCallId === toolCallId ? triggerFrame : null;
        return drainApproveOrEdit(approvalId, toolCallId, trigger);
      }
      if (approval.status === "responded") {
        return drainRespond(approvalId, toolCallId);
      }
      if (approval.status === "rejected" || approval.status === "timeout") {
        return drainRejectOrTimeout(approvalId, toolCallId, approval.status);
      }
    }
    return null;
  }

  const approvalGatingTransform = function approvalGatingTransform(
    frame: SseFrame
  ): SseFrame | SseFrame[] | null {
    // Step 1: proactively scan for resolved approvals before doing anything
    // else. This drains in a single shot — no readyQueue, no input-frame
    // dropping. An empty array means the approval resolved but produced no
    // frames to emit (edge case: bufferedFrames cleared externally and no
    // globals/trigger) — fall through so the current input frame still
    // processes normally.
    if (pendingApprovalsByToolCallId.size > 0) {
      const drained = proactiveDrain(frame);
      if (drained !== null && drained.length > 0) {
        return drained;
      }
    }

    // Step 2: non-data and [DONE] frames pass through.
    if (!frame.raw.startsWith("data: ")) return frame;
    const rawData = frame.raw.slice(6);
    if (rawData === "[DONE]") return frame;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawData) as Record<string, unknown>;
    } catch {
      // Non-JSON data frame. While paused: buffer globally. Otherwise: pass.
      if (pendingApprovalsByToolCallId.size > 0) {
        globalBufferedFrames.push(frame);
        return null;
      }
      return frame;
    }

    // Step 3: tool-input-start gating.
    if (parsed.type === "tool-input-start") {
      const gateFrame = gateNewTool(parsed, frame);
      if (gateFrame !== null) {
        return gateFrame;
      }
      // No gating required (config returned undefined / require:false, or the
      // frame was missing toolCallId/toolName).
      // While paused, buffer globally so the un-gated tool still arrives in
      // order relative to other paused output.
      if (pendingApprovalsByToolCallId.size > 0) {
        globalBufferedFrames.push(frame);
        return null;
      }
      return frame;
    }

    // Step 4: while paused, frames keyed to a pending toolCallId buffer per-
    // approval; other frames buffer globally. (Resolved-status branches are
    // unreachable here because proactiveDrain in step 1 would have caught
    // them — single-threaded JS.)
    if (pendingApprovalsByToolCallId.size > 0) {
      const toolCallId = parsed.toolCallId as string | undefined;
      if (toolCallId && pendingApprovalsByToolCallId.has(toolCallId)) {
        const approvalId = pendingApprovalsByToolCallId.get(toolCallId)!;
        const approval = getApproval(approvalId);
        /* c8 ignore next 3 — defensive: external cleanup races */
        if (!approval) {
          return frame;
        }
        if (!approval.bufferedFrames) approval.bufferedFrames = [];
        approval.bufferedFrames.push(frame);
        return null;
      }
      // Unrelated frame during pause — buffer globally.
      globalBufferedFrames.push(frame);
      return null;
    }

    // Step 5: not paused, not gated — pass through.
    return frame;
  };

  /** Sleep helper — bounded, and simply stops being scheduled when the loop exits. */
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  /** Latest `expiresAt` across pending approvals; 0 when none are pending. */
  function latestExpiry(): number {
    let latest = 0;
    for (const approvalId of pendingApprovalsByToolCallId.values()) {
      const approval = getApproval(approvalId);
      if (approval && approval.expiresAt > latest) latest = approval.expiresAt;
    }
    return latest;
  }

  const drainOnClose = async function drainOnClose(): Promise<SseFrame[]> {
    const out: SseFrame[] = [];
    const graceMs = config.drainGraceMs ?? DEFAULT_DRAIN_GRACE_MS;
    const graceDeadline = Date.now() + graceMs;

    while (pendingApprovalsByToolCallId.size > 0) {
      // proactiveDrain resolves ONE approval per call and deletes it from the pending map,
      // so this loop is what handles multiple concurrent approvals. The per-frame path only
      // ever needed a single drain because another frame was always coming. Here nothing is
      // coming — that is the whole defect — so the looping has to live here.
      const drained = proactiveDrain(null);
      if (drained !== null) {
        out.push(...drained);
        continue;
      }

      // Nothing resolved yet: the human is still deciding. Wait, bounded by the latest
      // expiry. getApproval()'s lazy TTL converts an expired approval to "timeout", which the
      // next proactiveDrain turns into an approval_timeout drain — so this terminates without
      // a timer of its own.
      // Bounded by BOTH the approval's own validity and the proxy's grace budget, whichever
      // comes first. Past either, stop waiting and fall through to the release sweep.
      const remaining = Math.min(latestExpiry(), graceDeadline) - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(POLL_INTERVAL_MS, remaining + 1));
    }

    // Defensive sweep. Reaching here with frames still buffered would be the original defect
    // wearing a new hat, so release them rather than dropping them — and say so in-band,
    // because a client receiving frames outside their approval envelope needs to know why.
    const stranded: SseFrame[] = [];
    // PER APPROVAL, not over the concatenation. Each approval's buffer is one
    // gated tool call, and releaseToolFrames reshapes exactly one — running it
    // over a flattened list of several would treat the first call's start frame
    // as the header for all of them.
    let strandedExecutedTool: string | null = null;
    for (const approvalId of pendingApprovalsByToolCallId.values()) {
      const approval = getApproval(approvalId);
      if (approval?.bufferedFrames?.length) {
        strandedExecutedTool =
          strandedExecutedTool ??
          executedToolName(approval.bufferedFrames, approval.toolName);
        stranded.push(...releaseToolFrames(approval.bufferedFrames));
        approval.bufferedFrames = [];
      }
    }
    if (globalBufferedFrames.length > 0) {
      stranded.push(...globalBufferedFrames);
      globalBufferedFrames.length = 0;
    }
    if (stranded.length > 0) {
      /*
       * DID THE TOOL ALREADY RUN? THE BUFFER KNOWS, AND IT CHANGES THE CLAIM.
       *
       * This gate sits DOWNSTREAM of whatever executed the tool. Against a
       * Python agent the backend runs autonomously and the proxy sees frames
       * after the work is done — measured through open-swe on deepagents: the
       * counter moved 65 -> 66 while nobody approved anything (#256).
       *
       * A buffered `tool-output-available` is proof of that: a result exists,
       * so the action happened. Reporting it as "an approval was still pending"
       * describes a veto that was never available, which is worse than no gate
       * — it tells a person their refusal would have mattered.
       *
       * When no output was buffered the original wording is accurate and stays:
       * the call may genuinely not have run.
       */
      // Computed while collecting, from each approval's OWN buffer — see the
      // note there. Reading it back off the flattened list would attribute one
      // call's result to another call's name.
      const executedTool = strandedExecutedTool;
      out.push(
        errorFrame(
          // `id` is required by DataErrorSchema and was once missing here, so
          // this frame was rejected by the client exactly like handler.ts's
          // was. The sibling emitter uses the approvalId; this frame covers
          // SEVERAL stranded approvals at once, so it is identified by the
          // event rather than by any one of them.
          `approval_pending_at_close_${seqCounter}`,
          executedTool
            ? "tool_executed_without_approval"
            : "approval_pending_at_close",
          executedTool
            ? `The upstream already executed ${executedTool} before this gate could apply, ` +
                "so the approval could not have prevented it. Releasing the buffered " +
                "frames describing what ran."
            : "Upstream ended while an approval was still pending; releasing buffered frames"
        )
      );
      out.push(...stranded);
    }
    pendingApprovalsByToolCallId.clear();
    return out;
  };

  return Object.assign(approvalGatingTransform, {
    hasPending: () =>
      pendingApprovalsByToolCallId.size > 0 || globalBufferedFrames.length > 0,
    drainOnClose,
  });
}
