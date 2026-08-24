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
 *                drop tool frames (the action did not execute)
 *   - respond  → emit data-human-response with approval.response; drain
 *                global frames; drop tool frames (action did not execute)
 *   - timeout  → same shape as reject but code=approval_timeout
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

  /**
   * Split a buffered tool-input-start that carries an `input` field into the
   * AI SDK v6 strict-compatible pair:
   *   1. tool-input-start (no input — only the AI-SDK strictObject fields)
   *   2. tool-input-available (with input, possibly edited)
   *
   * Frames that aren't a JSON tool-input-start pass through unchanged.
   */
  function splitToolInputStart(
    frame: SseFrame,
    overrideInput?: Record<string, unknown>
  ): SseFrame[] {
    if (!frame.raw.startsWith("data: ")) return [frame];
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(frame.raw.slice(6)) as Record<string, unknown>;
    } catch {
      return [frame];
    }
    if (parsed.type !== "tool-input-start") return [frame];

    const input =
      overrideInput ??
      (parsed.input as Record<string, unknown> | undefined) ??
      {};
    const stripped: Record<string, unknown> = {
      type: "tool-input-start",
      toolCallId: parsed.toolCallId,
      toolName: parsed.toolName,
    };
    if (parsed.dynamic !== undefined) stripped.dynamic = parsed.dynamic;
    if (parsed.title !== undefined) stripped.title = parsed.title;
    if (parsed.providerExecuted !== undefined)
      stripped.providerExecuted = parsed.providerExecuted;
    const synthAvailable: Record<string, unknown> = {
      type: "tool-input-available",
      toolCallId: parsed.toolCallId,
      toolName: parsed.toolName,
      input,
    };
    if (parsed.dynamic !== undefined) synthAvailable.dynamic = parsed.dynamic;

    return [
      { raw: `data: ${JSON.stringify(stripped)}` },
      { raw: `data: ${JSON.stringify(synthAvailable)}` },
    ];
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
      const override =
        approval.status === "edited" && approval.editedInput
          ? approval.editedInput
          : undefined;
      out.push(...splitToolInputStart(bufferedFrames[0], override));
      // Subsequent buffered frames (e.g. tool-output-available that arrived
      // while paused) pass through unchanged.
      for (let i = 1; i < bufferedFrames.length; i++) {
        out.push(bufferedFrames[i]);
      }
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
   * frame carrying approval.response and drops the buffered tool frames (the
   * tool action did not execute). Global buffered frames still drain.
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

    const code =
      status === "rejected" ? "approval_rejected" : "approval_timeout";
    const message =
      status === "rejected"
        ? "Tool execution was rejected"
        : "Tool approval expired";

    const out: SseFrame[] = [
      {
        raw: `data: ${JSON.stringify({
          type: "data-error",
          data: {
            id: approvalId,
            seq: seqCounter++,
            code,
            message,
            retryable: false,
          },
        })}`,
      },
      ...globalBufferedFrames,
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
    for (const approvalId of pendingApprovalsByToolCallId.values()) {
      const approval = getApproval(approvalId);
      if (approval?.bufferedFrames?.length) {
        stranded.push(...approval.bufferedFrames);
        approval.bufferedFrames = [];
      }
    }
    if (globalBufferedFrames.length > 0) {
      stranded.push(...globalBufferedFrames);
      globalBufferedFrames.length = 0;
    }
    if (stranded.length > 0) {
      out.push({
        raw: `data: ${JSON.stringify({
          type: "data-error",
          data: {
            seq: seqCounter++,
            code: "approval_pending_at_close",
            message:
              "Upstream ended while an approval was still pending; releasing buffered frames",
            retryable: false,
          },
        })}`,
      });
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
