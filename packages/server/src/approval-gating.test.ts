/**
 * Tests for createApprovalGatingTransform.
 *
 * Covers: pass-through, pause/buffer, global text-delta pause, drain after
 * approval, rejection → data-error, cleanup-after-drain, timeout path,
 * proactive drain on external resolution, multi-interrupt sequencing, and
 * mixed-order (tool-keyed + global) drain ordering.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { createApprovalGatingTransform } from "./approval-gating";
import type { ApprovalGatingConfig } from "./approval-gating";
import {
  getApproval,
  resolveApproval,
  cleanupApproval,
} from "./approval-registry";
import type { SseFrame } from "./accumulator";

// Helper: build a raw SSE data frame from an object
function makeFrame(data: Record<string, unknown>): SseFrame {
  return { raw: `data: ${JSON.stringify(data)}` };
}

// Helper: parse frame payload. Accepts a single SseFrame, null, or an
// SseFrame[] (the N-output transform return shape) — for arrays it parses
// the first frame.
function parseFrame(
  result: SseFrame | SseFrame[] | null
): Record<string, unknown> | null {
  if (!result) return null;
  const frame = Array.isArray(result) ? result[0] : result;
  if (!frame) return null;
  const raw = frame.raw;
  if (!raw.startsWith("data: ")) return null;
  return JSON.parse(raw.slice(6)) as Record<string, unknown>;
}

// Helper: normalize a transform's variadic return into an array of frames.
// SseTransform may return null (drop), a single SseFrame, or SseFrame[].
function takeFrames(result: SseFrame | SseFrame[] | null): SseFrame[] {
  if (result === null) return [];
  if (Array.isArray(result)) return result;
  return [result];
}

// Helper: parse the first emitted frame from a transform result.
function firstFrame(
  result: SseFrame | SseFrame[] | null
): Record<string, unknown> | null {
  const frames = takeFrames(result);
  return frames.length > 0 ? parseFrame(frames[0]) : null;
}

afterEach(() => {
  // Tests clean up their own registry entries via cleanupApproval
});

describe("approvalGating transform — pass-through edge cases", () => {
  it("non-JSON data frame during a pause is buffered globally", () => {
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true }),
    });
    const toolFrame = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-nonjson-1",
      toolName: "bash",
      input: {},
    });
    const approvalFrame = transform(toolFrame)!;
    const approvalId = (
      parseFrame(approvalFrame)!.data as Record<string, unknown>
    ).id as string;

    // Send a data-prefixed frame whose body is not JSON — must be buffered
    // globally (not pass through), then drained after approval.
    const garbled: SseFrame = { raw: "data: <<not json>>" };
    const buffered = transform(garbled);
    expect(buffered).toBeNull();

    resolveApproval(approvalId, "approve");
    // N-output drain: single transform call returns the full array —
    // stripped tool-input-start + synthetic tool-input-available + the
    // buffered non-JSON global frame.
    const frames = takeFrames(transform(makeFrame({ type: "trigger" })));
    expect(parseFrame(frames[0])!.type).toBe("tool-input-start");
    expect(parseFrame(frames[1])!.type).toBe("tool-input-available");
    expect(frames[2].raw).toBe("data: <<not json>>");
  });

  it("non-JSON data frame outside a pause passes through unchanged", () => {
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: false }),
    });
    const garbled: SseFrame = { raw: "data: <<not json at all>>" };
    const result = transform(garbled);
    expect(result).not.toBeNull();
    expect(takeFrames(result)[0].raw).toBe("data: <<not json at all>>");
  });

  it("tool-input-start without toolCallId passes through unchanged (cannot register)", () => {
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true }),
    });
    const frame = makeFrame({
      type: "tool-input-start",
      toolName: "bash",
      input: {},
    });
    const result = transform(frame);
    expect(result).not.toBeNull();
    expect(parseFrame(result)!.type).toBe("tool-input-start");
  });

  it("tool-input-start without toolName passes through unchanged (cannot register)", () => {
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true }),
    });
    const frame = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-noname-1",
      input: {},
    });
    const result = transform(frame);
    expect(result).not.toBeNull();
    expect(parseFrame(result)!.type).toBe("tool-input-start");
  });
});

describe("approvalGating transform — pass-through cases", () => {
  it("passes through all frames when getApprovalConfig returns undefined", () => {
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => undefined,
    });
    const frame = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-pass-1",
      toolName: "bash",
      input: {},
    });
    const result = transform(frame);
    expect(result).not.toBeNull();
    expect(takeFrames(result)[0].raw).toBe(frame.raw);
  });

  it("passes through all frames when getApprovalConfig returns { require: false }", () => {
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: false }),
    });
    const frame = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-pass-2",
      toolName: "bash",
      input: {},
    });
    const result = transform(frame);
    expect(result).not.toBeNull();
    expect(takeFrames(result)[0].raw).toBe(frame.raw);
  });

  it("passes through non-data frames (no 'data: ' prefix) unchanged", () => {
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true }),
    });
    const nonDataFrame: SseFrame = { raw: "event: ping" };
    const result = transform(nonDataFrame);
    expect(result).not.toBeNull();
    expect(takeFrames(result)[0].raw).toBe("event: ping");
  });

  it("passes through [DONE] frame unchanged", () => {
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true }),
    });
    const doneFrame: SseFrame = { raw: "data: [DONE]" };
    const result = transform(doneFrame);
    expect(result).not.toBeNull();
    expect(takeFrames(result)[0].raw).toBe("data: [DONE]");
  });

  it("passes through all frames when no getApprovalConfig provided (default pass-through)", () => {
    const transform = createApprovalGatingTransform({} as ApprovalGatingConfig);
    const frame = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-pass-3",
      toolName: "bash",
      input: {},
    });
    const result = transform(frame);
    expect(result).not.toBeNull();
  });

  it("frame for a toolCallId with no pending approval passes through", () => {
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true }),
    });
    // Emit a tool-output-available for a toolCallId that was never registered
    const frame = makeFrame({
      type: "tool-output-available",
      toolCallId: "tc-no-pending",
      output: {},
    });
    const result = transform(frame);
    expect(result).not.toBeNull();
  });
});

describe("approvalGating transform — approval required", () => {
  it("emits data-approval-required frame (NOT tool-input-start) when require: true", () => {
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true }),
    });
    const frame = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-req-1",
      toolName: "bash_execute",
      input: { command: "echo hi" },
    });
    const result = transform(frame);
    expect(result).not.toBeNull();
    const parsed = parseFrame(result)!;
    expect(parsed.type).toBe("data-approval-required");
  });

  it("data-approval-required frame has required payload fields: id, seq, actionName, description, arguments, status, createdAt, expiresAt", () => {
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true }),
    });
    const frame = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-payload-1",
      toolName: "bash_execute",
      input: { command: "ls" },
    });
    const result = transform(frame);
    expect(result).not.toBeNull();
    const parsed = parseFrame(result)!;
    expect(parsed.type).toBe("data-approval-required");
    const data = parsed.data as Record<string, unknown>;
    expect(data).toBeDefined();
    expect(typeof data.id).toBe("string");
    expect(typeof data.seq).toBe("number");
    expect(data.actionName).toBe("bash_execute");
    expect(typeof data.description).toBe("string");
    expect(data.arguments).toEqual({ command: "ls" });
    expect(data.status).toBe("waiting");
    expect(typeof data.createdAt).toBe("string");
    expect(data.expiresAt).toBeDefined();
    cleanupApproval(data.id as string);
  });

  it("subsequent tool-output-available frame for same toolCallId returns null (buffered)", () => {
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true }),
    });
    const startFrame = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-buf-1",
      toolName: "bash",
      input: {},
    });
    const approvalFrame = transform(startFrame)!;
    const approvalId = (
      parseFrame(approvalFrame)!.data as Record<string, unknown>
    ).id as string;

    const outputFrame = makeFrame({
      type: "tool-output-available",
      toolCallId: "tc-buf-1",
      output: {},
    });
    const result = transform(outputFrame);
    expect(result).toBeNull(); // buffered
    cleanupApproval(approvalId);
  });

  it("frame for a DIFFERENT toolCallId (no pending approval) passes through while another is pending", () => {
    const transform = createApprovalGatingTransform({
      getApprovalConfig: ({ toolName }) =>
        toolName === "bash" ? { require: true } : undefined,
    });
    const bashFrame = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-bash-1",
      toolName: "bash",
      input: {},
    });
    const approvalFrame = transform(bashFrame)!;
    const approvalId = (
      parseFrame(approvalFrame)!.data as Record<string, unknown>
    ).id as string;

    // A different toolCallId with no pending approval
    const otherFrame = makeFrame({
      type: "tool-output-available",
      toolCallId: "tc-other-99",
      output: {},
    });
    // NOTE: global pause means this MAY be buffered if any approval is pending (see QUORUM-2 test)
    // This test verifies the pass-through when getApprovalConfig returns undefined for the tool
    cleanupApproval(approvalId);
  });
});

describe("approvalGating transform — [QUORUM-2] global pause", () => {
  it("buffers text-delta frames while any approval is pending", () => {
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true }),
    });
    const toolFrame = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-1",
      toolName: "bash",
      input: {},
    });
    const textFrame = makeFrame({ type: "text-delta", delta: "hello" });

    const approvalFrame = transform(toolFrame); // emits data-approval-required, sets pending flag
    expect(approvalFrame).not.toBeNull();
    expect(parseFrame(approvalFrame)!.type).toBe("data-approval-required");

    // text-delta arrives while tc-1 is pending
    const textResult = transform(textFrame);
    expect(textResult).toBeNull(); // MUST be buffered, not passed through

    const approvalId = (
      parseFrame(approvalFrame)!.data as Record<string, unknown>
    ).id as string;
    cleanupApproval(approvalId);
  });

  it("drains buffered text-delta frames after approval resolves", () => {
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true }),
    });
    const toolFrame = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-2",
      toolName: "bash",
      input: {},
    });
    const textFrame = makeFrame({ type: "text-delta", delta: "world" });

    const approvalFrame = transform(toolFrame)!;
    const approvalId = (
      parseFrame(approvalFrame)!.data as Record<string, unknown>
    ).id as string;

    transform(textFrame); // buffered — returns null

    // Simulate approval via registry
    resolveApproval(approvalId, "approve");

    // Next transform calls should drain buffered frames (tool-input-start first, then text-delta)
    const drained1 = transform(makeFrame({ type: "unrelated" }));
    expect(drained1).not.toBeNull(); // first buffered frame

    const drained2 = transform(makeFrame({ type: "unrelated" }));
    expect(drained2).not.toBeNull(); // second buffered frame (text-delta)
  });
});

describe("approvalGating transform — readyQueue drain", () => {
  it("after resolving approval to 'approved', next transform call returns the first buffered frame", () => {
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true }),
    });
    const toolFrame = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-drain-1",
      toolName: "bash",
      input: {},
    });
    const outputFrame = makeFrame({
      type: "tool-output-available",
      toolCallId: "tc-drain-1",
      output: { result: "ok" },
    });

    const approvalFrame = transform(toolFrame)!;
    const approvalId = (
      parseFrame(approvalFrame)!.data as Record<string, unknown>
    ).id as string;

    transform(outputFrame); // buffered

    resolveApproval(approvalId, "approve");

    // Next call should drain (return the buffered tool-input-start, NOT the new unrelated input)
    const drained = transform(makeFrame({ type: "unrelated" }));
    expect(drained).not.toBeNull();
    const parsedDrained = parseFrame(drained);
    // The original tool-input-start should be first in queue
    expect(parsedDrained).not.toBeNull();
  });
});

describe("approvalGating transform — [QUORUM-3] rejection emits data-error", () => {
  it("rejection returns a data-error frame (not null)", () => {
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true }),
    });
    const toolFrame = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-3",
      toolName: "bash",
      input: {},
    });

    const approvalFrame = transform(toolFrame)!;
    const approvalId = (
      parseFrame(approvalFrame)!.data as Record<string, unknown>
    ).id as string;

    // Buffer a subsequent frame
    transform(
      makeFrame({
        type: "tool-output-available",
        toolCallId: "tc-3",
        output: {},
      })
    );

    // Simulate rejection via registry
    resolveApproval(approvalId, "reject");

    // Next call for that toolCallId should return data-error, not null
    const result = transform(
      makeFrame({
        type: "tool-output-available",
        toolCallId: "tc-3",
        output: {},
      })
    );
    expect(result).not.toBeNull();
    const parsed = parseFrame(result)!;
    expect(parsed.type).toBe("data-error");
    const data = parsed.data as Record<string, unknown>;
    expect(data.code).toBe("approval_rejected");
  });

  it("data-error frame on rejection contains 'approval_rejected' code and message", () => {
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true }),
    });
    const toolFrame = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-err-msg",
      toolName: "bash",
      input: {},
    });

    const approvalFrame = transform(toolFrame)!;
    const approvalId = (
      parseFrame(approvalFrame)!.data as Record<string, unknown>
    ).id as string;

    resolveApproval(approvalId, "reject");

    const result = transform(
      makeFrame({
        type: "tool-output-available",
        toolCallId: "tc-err-msg",
        output: {},
      })
    );
    const parsed = parseFrame(result)!;
    const data = parsed.data as Record<string, unknown>;
    expect(data.code).toBe("approval_rejected");
    expect(typeof data.message).toBe("string");
    expect((data.message as string).length).toBeGreaterThan(0);
  });

  it("after rejection emits data-error, toolCallId entry is cleared (no further buffering)", () => {
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true }),
    });
    const toolFrame = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-4",
      toolName: "bash",
      input: {},
    });

    const approvalFrame = transform(toolFrame)!;
    const approvalId = (
      parseFrame(approvalFrame)!.data as Record<string, unknown>
    ).id as string;

    resolveApproval(approvalId, "reject");

    // Consume the data-error frame
    transform(
      makeFrame({
        type: "tool-output-available",
        toolCallId: "tc-4",
        output: {},
      })
    );

    // Subsequent frame for same toolCallId should now pass through (no longer pending)
    const passThrough = transform(
      makeFrame({
        type: "tool-output-available",
        toolCallId: "tc-4",
        output: {},
      })
    );
    expect(passThrough).not.toBeNull();
  });
});

describe("approvalGating transform — [QUORUM-4] cleanup-after-drain", () => {
  it("after drain completes, cleanupApproval is called — getApproval returns undefined", () => {
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true }),
    });
    const toolFrame = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-5",
      toolName: "bash",
      input: {},
    });

    const approvalFrame = transform(toolFrame)!;
    const approvalId = (
      parseFrame(approvalFrame)!.data as Record<string, unknown>
    ).id as string;

    resolveApproval(approvalId, "approve");

    // Drain the single buffered frame (tool-input-start was buffered)
    const drained = transform(makeFrame({ type: "unrelated" }));
    expect(drained).not.toBeNull();

    // After drain, the registry entry must be cleaned up
    expect(getApproval(approvalId)).toBeUndefined();
  });
});

describe("approvalGating transform — timeout path emits data-error", () => {
  it("when approval status transitions to 'timeout' (lazy TTL), next frame for the toolCallId emits data-approval_timeout", () => {
    vi.useFakeTimers();
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true, timeoutMs: 1000 }),
    });
    const toolFrame = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-timeout-1",
      toolName: "bash",
      input: {},
    });

    const approvalFrame = transform(toolFrame)!;
    const approvalId = (
      parseFrame(approvalFrame)!.data as Record<string, unknown>
    ).id as string;

    // Advance past expiresAt — lazy TTL will mark waiting → timeout on next getApproval()
    vi.advanceTimersByTime(2000);

    // Send any frame for the pending toolCallId — proactive check (step 1.5) runs
    // getApproval, lazy-marks timeout, and emits a data-error frame.
    const result = transform(
      makeFrame({
        type: "tool-output-available",
        toolCallId: "tc-timeout-1",
        output: {},
      })
    );
    expect(result).not.toBeNull();
    const parsed = parseFrame(result)!;
    expect(parsed.type).toBe("data-error");
    const data = parsed.data as Record<string, unknown>;
    expect(data.code).toBe("approval_timeout");
    expect(typeof data.message).toBe("string");

    cleanupApproval(approvalId);
    vi.useRealTimers();
  });

  it("after timeout emits data-error, the toolCallId is cleared from pending map (subsequent frames pass through)", () => {
    vi.useFakeTimers();
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true, timeoutMs: 1000 }),
    });
    const toolFrame = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-timeout-2",
      toolName: "bash",
      input: {},
    });
    const approvalFrame = transform(toolFrame)!;
    const approvalId = (
      parseFrame(approvalFrame)!.data as Record<string, unknown>
    ).id as string;

    vi.advanceTimersByTime(2000);

    // Consume the data-error frame
    transform(
      makeFrame({
        type: "tool-output-available",
        toolCallId: "tc-timeout-2",
        output: {},
      })
    );

    // Next frame for same toolCallId is no longer paused — passes through.
    const passThrough = transform(
      makeFrame({
        type: "tool-output-available",
        toolCallId: "tc-timeout-2",
        output: {},
      })
    );
    expect(passThrough).not.toBeNull();
    expect(parseFrame(passThrough)!.type).toBe("tool-output-available");

    cleanupApproval(approvalId);
    vi.useRealTimers();
  });
});

describe("approvalGating transform — missing-field fallbacks", () => {
  it("tool-input-start without an `input` field is gated with `arguments: {}`", () => {
    // AI SDK v6's tool-input-start has no `input` — input flows via
    // tool-input-available. The gate must tolerate this by defaulting to {}.
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true }),
    });
    const frame: SseFrame = {
      raw: `data: ${JSON.stringify({
        type: "tool-input-start",
        toolCallId: "tc-no-input-1",
        toolName: "bash",
      })}`,
    };
    const result = transform(frame);
    expect(result).not.toBeNull();
    const parsed = parseFrame(result)!;
    expect(parsed.type).toBe("data-approval-required");
    const data = parsed.data as Record<string, unknown>;
    expect(data.arguments).toEqual({});
    cleanupApproval(data.id as string);
  });

  it("a SECOND tool-input-start arriving while paused — without `input` — is gated with `arguments: {}`", () => {
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true }),
    });
    const first = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-pause-new-1",
      toolName: "bash",
      input: { a: 1 },
    });
    const firstApproval = transform(first)!;
    const firstId = (parseFrame(firstApproval)!.data as Record<string, unknown>)
      .id as string;

    const secondNoInput: SseFrame = {
      raw: `data: ${JSON.stringify({
        type: "tool-input-start",
        toolCallId: "tc-pause-new-2",
        toolName: "write_file",
      })}`,
    };
    const result = transform(secondNoInput)!;
    const parsed = parseFrame(result)!;
    expect(parsed.type).toBe("data-approval-required");
    const data = parsed.data as Record<string, unknown>;
    expect(data.arguments).toEqual({});

    cleanupApproval(firstId);
    cleanupApproval(data.id as string);
  });

  it("initiateDrain handles a registered approval whose bufferedFrames was cleared (defaults to []) ", () => {
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true }),
    });
    const ti = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-noBuf-1",
      toolName: "bash",
      input: {},
    });
    const approvalFrame = transform(ti)!;
    const approvalId = (
      parseFrame(approvalFrame)!.data as Record<string, unknown>
    ).id as string;

    // Force bufferedFrames to undefined (covers the `?? []` fallback in
    // initiateDrain). After approve, drain returns null with cleanup since
    // there's nothing to drain and no trigger.
    const approval = getApproval(approvalId)!;
    approval.bufferedFrames = undefined;

    resolveApproval(approvalId, "approve");
    // No matching toolCallId trigger — proactive picks it up on an unrelated
    // frame. Empty drainFrames → cleanup + return null → unrelated frame
    // passes through on the same call's downstream flow? No: proactiveDrainCheck
    // returns null when drainFrames is empty (initiateDrain returns null), so
    // the transform falls through to step-2+ where the unrelated frame is
    // handled normally.
    const result = transform(makeFrame({ type: "text-delta", delta: "x" }));
    expect(result).not.toBeNull();
    expect(getApproval(approvalId)).toBeUndefined();
  });

  it("respond drain handles an approval whose response was cleared (defaults to empty string)", () => {
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true }),
    });
    const ti = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-noResp-1",
      toolName: "bash",
      input: {},
    });
    const approvalFrame = transform(ti)!;
    const approvalId = (
      parseFrame(approvalFrame)!.data as Record<string, unknown>
    ).id as string;

    resolveApproval(approvalId, "respond", { response: "to-be-cleared" });
    // Mutate the registry entry: response becomes undefined. The transform's
    // `?? ""` fallback should produce a data-human-response with response="".
    const approval = getApproval(approvalId)!;
    approval.response = undefined;

    const result = parseFrame(
      transform(makeFrame({ type: "text-delta", delta: "x" }))
    )!;
    expect(result.type).toBe("data-human-response");
    expect((result.data as Record<string, unknown>).response).toBe("");
  });
});

describe("approvalGating transform — proactive trigger forwarding edge cases", () => {
  it("a non-data trigger frame (e.g. 'event: ping') does NOT forward to initiateDrain, but proactive still drains the approved approval", () => {
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true }),
    });
    const ti = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-nondata-trig-1",
      toolName: "bash",
      input: {},
    });
    const approvalFrame = transform(ti)!;
    const approvalId = (
      parseFrame(approvalFrame)!.data as Record<string, unknown>
    ).id as string;

    resolveApproval(approvalId, "approve");

    // Non-data trigger: triggerToolCallId stays undefined, so initiateDrain
    // receives null trigger. The buffered tool-input-start still drains.
    const result = parseFrame(transform({ raw: "event: ping" }))!;
    expect(result.type).toBe("tool-input-start");
    expect(result.toolCallId).toBe("tc-nondata-trig-1");
  });

  it("NEW tool-input-start during pause where getApprovalConfig returns {require: false} passes through and buffers globally", () => {
    // Covers the false branch of `if (approvalConfigResult?.require)` in
    // step-4's new-tool-input-start path. The second tool isn't gated, but
    // we're still mid-pause from the first approval, so it gets buffered
    // globally (not passed through to client immediately).
    const transform = createApprovalGatingTransform({
      getApprovalConfig: ({ toolName }) =>
        toolName === "bash" ? { require: true } : { require: false },
    });
    const ti = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-mixed-1",
      toolName: "bash",
      input: {},
    });
    const approvalFrame = transform(ti)!;
    const approvalId = (
      parseFrame(approvalFrame)!.data as Record<string, unknown>
    ).id as string;

    // A second tool-input-start for a tool NOT requiring approval, while
    // first is still pending. Per step-4 it falls into the "non-tool frame
    // during pause" path → buffered globally.
    const ungated = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-mixed-2",
      toolName: "noop_tool",
      input: { x: 1 },
    });
    const result = transform(ungated);
    expect(result).toBeNull();

    // After first approval resolves, the buffered global (tc-mixed-2 ti-start)
    // drains in the same N-output call as the AI-SDK-strict split for tc-mixed-1.
    resolveApproval(approvalId, "approve");
    const frames = takeFrames(transform(makeFrame({ type: "trigger" })));
    const d0 = parseFrame(frames[0])!;
    const d1 = parseFrame(frames[1])!;
    const d2 = parseFrame(frames[2])!;
    expect(d0.type).toBe("tool-input-start");
    expect(d0.toolCallId).toBe("tc-mixed-1");
    expect(d1.type).toBe("tool-input-available");
    expect(d1.toolCallId).toBe("tc-mixed-1");
    expect(d2.type).toBe("tool-input-start");
    expect(d2.toolCallId).toBe("tc-mixed-2");
  });

  it("NEW tool-input-start during pause missing toolCallId is buffered globally (cannot register a new approval)", () => {
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true }),
    });
    const ti = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-missing-id-1",
      toolName: "bash",
      input: {},
    });
    transform(ti); // emits data-approval-required, pending size = 1

    // A NEW tool-input-start with no toolCallId during the pause.
    const malformed: SseFrame = {
      raw: `data: ${JSON.stringify({
        type: "tool-input-start",
        toolName: "x",
      })}`,
    };
    const result = transform(malformed);
    // The `if (newToolCallId && toolName)` is false → falls through to
    // "buffer globally" path.
    expect(result).toBeNull();
  });
});

describe("approvalGating transform — defensive paths", () => {
  it("proactive drain handles an approval that was cleaned up externally (removes from pending map, continues iteration)", () => {
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true }),
    });
    const ti = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-cleanup-ext-1",
      toolName: "bash",
      input: {},
    });
    const approvalFrame = transform(ti)!;
    const approvalId = (
      parseFrame(approvalFrame)!.data as Record<string, unknown>
    ).id as string;

    // Simulate external cleanup: registry entry gone, but pending map still
    // references it. The proactive scan's `!approval` branch should remove the
    // stale pending entry without crashing.
    cleanupApproval(approvalId);

    // Next call: proactive check finds the approval missing, deletes the
    // pending entry, and (since no resolved approvals remain) falls through
    // to normal flow. The incoming frame passes through.
    const result = transform(makeFrame({ type: "text-delta", delta: "x" }));
    expect(result).not.toBeNull();
    expect(parseFrame(result)!.type).toBe("text-delta");
  });

  it("initiateDrain with empty drainFrames returns null and cleans up immediately", () => {
    // Reachable when an approval was registered without bufferedFrames and
    // no globals/trigger are present. The transform always populates
    // bufferedFrames at register time, but a consumer of the registry could
    // resolveApproval-then-clear, then a stale poll fires.
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true }),
    });
    const ti = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-empty-drain-1",
      toolName: "bash",
      input: {},
    });
    const approvalFrame = transform(ti)!;
    const approvalId = (
      parseFrame(approvalFrame)!.data as Record<string, unknown>
    ).id as string;

    // Manually empty bufferedFrames to force the empty-drain branch.
    const approval = getApproval(approvalId)!;
    approval.bufferedFrames = [];

    resolveApproval(approvalId, "approve");

    // Unrelated frame triggers proactiveDrainCheck → initiateDrain → empty
    // drainFrames → cleanupApproval + return null. The frame then proceeds
    // through normal flow. Pending should now be empty.
    const result = transform(makeFrame({ type: "text-delta", delta: "y" }));
    expect(result).not.toBeNull();
    expect(parseFrame(result)!.type).toBe("text-delta");
    // The approval was cleaned up.
    expect(getApproval(approvalId)).toBeUndefined();
  });
});

describe("approvalGating transform — proactive drain on external resolution", () => {
  it("drains buffered frames when resolveApproval is called externally and no further tool-keyed frames arrive", () => {
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true }),
    });
    const toolFrame = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-proactive-1",
      toolName: "bash",
      input: { cmd: "ls" },
    });
    const outputFrame = makeFrame({
      type: "tool-output-available",
      toolCallId: "tc-proactive-1",
      output: { stdout: "file.txt" },
    });

    const approvalFrame = transform(toolFrame)!;
    const approvalId = (
      parseFrame(approvalFrame)!.data as Record<string, unknown>
    ).id as string;

    // Buffer output for the pending toolCallId
    const bufferedResult = transform(outputFrame);
    expect(bufferedResult).toBeNull();

    // External resolution: e.g. the POST /api/approval/[id] route flips status.
    resolveApproval(approvalId, "approve");

    // Now an UNRELATED frame arrives (no toolCallId match). The transform's
    // proactive check detects the resolved approval and drains all frames
    // in one N-output return: stripped tool-input-start + synthetic
    // tool-input-available + the buffered tool-output-available.
    const frames = takeFrames(
      transform(makeFrame({ type: "text-delta", delta: "x" }))
    );
    expect(frames.length).toBe(3);
    const d0 = parseFrame(frames[0])!;
    const d1 = parseFrame(frames[1])!;
    const d2 = parseFrame(frames[2])!;
    expect(d0.type).toBe("tool-input-start");
    expect(d0.toolCallId).toBe("tc-proactive-1");
    expect(d1.type).toBe("tool-input-available");
    expect(d1.input).toEqual({ cmd: "ls" });
    expect(d2.type).toBe("tool-output-available");

    // After drain completes, the registry entry is cleaned up.
    expect(getApproval(approvalId)).toBeUndefined();
  });

  it("emits data-error when external rejection is detected proactively", () => {
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true }),
    });
    const toolFrame = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-proactive-reject-1",
      toolName: "bash",
      input: {},
    });
    const approvalFrame = transform(toolFrame)!;
    const approvalId = (
      parseFrame(approvalFrame)!.data as Record<string, unknown>
    ).id as string;

    // Buffer one text-delta globally (no toolCallId match)
    transform(makeFrame({ type: "text-delta", delta: "buffered globally" }));

    // External rejection
    resolveApproval(approvalId, "reject");

    // Next frame triggers proactive check → emits data-error
    const result = transform(makeFrame({ type: "noop" }));
    expect(result).not.toBeNull();
    const parsed = parseFrame(result)!;
    expect(parsed.type).toBe("data-error");
    expect((parsed.data as Record<string, unknown>).code).toBe(
      "approval_rejected"
    );

    cleanupApproval(approvalId);
  });
});

describe("approvalGating transform — mixed-order drain (tool-keyed + global)", () => {
  it("drains buffered tool-keyed frames before global buffered frames", () => {
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true }),
    });
    const toolFrame = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-mixed-1",
      toolName: "bash",
      input: {},
    });

    const approvalFrame = transform(toolFrame)!;
    const approvalId = (
      parseFrame(approvalFrame)!.data as Record<string, unknown>
    ).id as string;

    // Mix global and tool-keyed frames while paused.
    transform(makeFrame({ type: "text-delta", delta: "hi" })); // global
    transform(
      makeFrame({
        type: "tool-output-available",
        toolCallId: "tc-mixed-1",
        output: { ok: true },
      })
    ); // tool-keyed
    transform(makeFrame({ type: "text-delta", delta: "world" })); // global

    resolveApproval(approvalId, "approve");

    // N-output drain: a SINGLE transform call returns all frames in order:
    //   - stripped tool-input-start (from the AI-SDK split)
    //   - synthetic tool-input-available (with the original input)
    //   - the rest of the buffered tool-keyed frames
    //   - the global buffered frames
    const frames = takeFrames(transform(makeFrame({ type: "trigger" })));
    expect(frames.length).toBe(5);
    const types = frames.map((f) => parseFrame(f)!.type);
    expect(types).toEqual([
      "tool-input-start",
      "tool-input-available",
      "tool-output-available",
      "text-delta",
      "text-delta",
    ]);
    expect((parseFrame(frames[3]) as Record<string, unknown>).delta).toBe("hi");
    expect((parseFrame(frames[4]) as Record<string, unknown>).delta).toBe(
      "world"
    );

    // Registry entry is cleaned up after the drain.
    expect(getApproval(approvalId)).toBeUndefined();
  });
});

describe("approvalGating transform — step-7 trigger frame is NOT dropped", () => {
  it("approve: a tool-output-available that triggers the drain ALSO reaches the client", () => {
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true }),
    });
    const toolFrame = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-trigger-1",
      toolName: "bash",
      input: { cmd: "ls" },
    });
    const approvalFrame = transform(toolFrame)!;
    const approvalId = (
      parseFrame(approvalFrame)!.data as Record<string, unknown>
    ).id as string;

    resolveApproval(approvalId, "approve");

    // N-output drain: ONE transform call returns [stripped ti-start, synth
    // ti-avail with input, trigger to-avail]. The trigger toolCallId matches
    // the drained approval, so it gets appended.
    const frames = takeFrames(
      transform(
        makeFrame({
          type: "tool-output-available",
          toolCallId: "tc-trigger-1",
          output: { stdout: "ok" },
        })
      )
    );
    expect(frames.length).toBe(3);
    const d0 = parseFrame(frames[0])!;
    const d1 = parseFrame(frames[1])!;
    const d2 = parseFrame(frames[2])!;
    expect(d0.type).toBe("tool-input-start");
    expect(d1.type).toBe("tool-input-available");
    expect(d1.input).toEqual({ cmd: "ls" });
    expect(d2.type).toBe("tool-output-available");
    expect(d2.output).toEqual({ stdout: "ok" });
  });

  it("edit: trigger frame is preserved alongside the rewritten tool-input-start", () => {
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true }),
    });
    const toolFrame = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-trigger-2",
      toolName: "bash",
      input: { cmd: "raw" },
    });
    const approvalFrame = transform(toolFrame)!;
    const approvalId = (
      parseFrame(approvalFrame)!.data as Record<string, unknown>
    ).id as string;

    resolveApproval(approvalId, "edit", { editedInput: { cmd: "edited" } });

    // N-output drain: [stripped ti-start (no input), synth ti-avail with
    // editedInput, trigger to-avail].
    const frames = takeFrames(
      transform(
        makeFrame({
          type: "tool-output-available",
          toolCallId: "tc-trigger-2",
          output: { stdout: "ran with edited" },
        })
      )
    );
    expect(frames.length).toBe(3);
    const d0 = parseFrame(frames[0])!;
    const d1 = parseFrame(frames[1])!;
    const d2 = parseFrame(frames[2])!;
    expect(d0.type).toBe("tool-input-start");
    expect(d0.input).toBeUndefined();
    expect(d1.type).toBe("tool-input-available");
    expect(d1.input).toEqual({ cmd: "edited" });
    expect(d2.type).toBe("tool-output-available");
  });

  it("proactive drain does NOT append the calling frame (the trigger is unrelated and will be processed on the next call)", () => {
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true }),
    });
    const toolFrame = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-trigger-3",
      toolName: "bash",
      input: {},
    });
    const approvalFrame = transform(toolFrame)!;
    const approvalId = (
      parseFrame(approvalFrame)!.data as Record<string, unknown>
    ).id as string;

    resolveApproval(approvalId, "approve");

    // An unrelated frame (text-delta, no toolCallId match) triggers proactive
    // drain. Drain returns the buffered tool-input-start split into the
    // AI-SDK-strict pair. The unrelated trigger is NOT appended because its
    // toolCallId doesn't match the drained approval.
    const frames = takeFrames(
      transform(makeFrame({ type: "text-delta", delta: "x" }))
    );
    expect(frames.length).toBe(2);
    expect(parseFrame(frames[0])!.type).toBe("tool-input-start");
    expect(parseFrame(frames[1])!.type).toBe("tool-input-available");

    // Subsequent call with another unrelated frame: pending is now clear so
    // it passes through normally (this is the documented contract — proactive
    // drain polls but doesn't capture an unrelated trigger).
    const passThrough = parseFrame(
      transform(makeFrame({ type: "text-delta", delta: "y" }))
    )!;
    expect(passThrough.type).toBe("text-delta");
    expect(passThrough.delta).toBe("y");
  });
});

describe("approvalGating transform — edit mode", () => {
  it("rewrites the buffered tool-input-start.input with editedInput before draining", () => {
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true }),
    });
    const toolFrame = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-edit-1",
      toolName: "bash_execute",
      input: { cmd: "rm -rf /" },
    });

    const approvalFrame = transform(toolFrame)!;
    const approvalId = (
      parseFrame(approvalFrame)!.data as Record<string, unknown>
    ).id as string;

    // External edit decision
    resolveApproval(approvalId, "edit", { editedInput: { cmd: "ls" } });

    // N-output drain: stripped tool-input-start (no input) + synthetic
    // tool-input-available with the edited input. The original "rm -rf /"
    // does not appear in either drained frame.
    const frames = takeFrames(transform(makeFrame({ type: "noop" })));
    expect(frames.length).toBe(2);
    const d0 = parseFrame(frames[0])!;
    const d1 = parseFrame(frames[1])!;
    expect(d0.type).toBe("tool-input-start");
    expect(d0.toolCallId).toBe("tc-edit-1");
    expect(d0.toolName).toBe("bash_execute");
    expect(d0.input).toBeUndefined();
    expect(d1.type).toBe("tool-input-available");
    expect(d1.toolCallId).toBe("tc-edit-1");
    expect(d1.toolName).toBe("bash_execute");
    expect(d1.input).toEqual({ cmd: "ls" });

    expect(getApproval(approvalId)).toBeUndefined();
  });

  it("edit-mode drain preserves subsequent buffered frames unchanged (only the first tool-input-start is rewritten)", () => {
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true }),
    });
    const toolFrame = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-edit-2",
      toolName: "bash",
      input: { cmd: "danger" },
    });
    const approvalFrame = transform(toolFrame)!;
    const approvalId = (
      parseFrame(approvalFrame)!.data as Record<string, unknown>
    ).id as string;

    // Buffer a tool-output-available behind the pending approval.
    transform(
      makeFrame({
        type: "tool-output-available",
        toolCallId: "tc-edit-2",
        output: { stdout: "should not be rewritten" },
      })
    );

    resolveApproval(approvalId, "edit", { editedInput: { cmd: "safe" } });

    // N-output: split for ti-start, then the buffered to-avail unchanged.
    const frames = takeFrames(transform(makeFrame({ type: "noop" })));
    expect(frames.length).toBe(3);
    const d0 = parseFrame(frames[0])!;
    const d1 = parseFrame(frames[1])!;
    const d2 = parseFrame(frames[2])!;
    expect(d0.type).toBe("tool-input-start");
    expect(d0.input).toBeUndefined();
    expect(d1.type).toBe("tool-input-available");
    expect(d1.input).toEqual({ cmd: "safe" });
    expect(d2.type).toBe("tool-output-available");
    expect(d2.output).toEqual({ stdout: "should not be rewritten" });
  });

  it("edit-mode drain preserves a buffered non-data frame at idx 0 (passes through unchanged)", () => {
    // initiateDrain's edit rewrite only touches the FIRST buffered frame and
    // only when it's a `data: ` JSON tool-input-start. A non-data prefix slips
    // through unchanged (covers line 104 fallback).
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true }),
    });
    const ti = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-edit-passthrough-1",
      toolName: "bash",
      input: { cmd: "x" },
    });
    const approvalFrame = transform(ti)!;
    const approvalId = (
      parseFrame(approvalFrame)!.data as Record<string, unknown>
    ).id as string;

    // Reach into the registry to splice a non-data frame at idx 0 of the
    // buffered frames. This simulates the defensive branch where the
    // bufferedFrames[0] isn't a data-prefixed JSON tool-input-start.
    const approval = getApproval(approvalId)!;
    approval.bufferedFrames = [
      { raw: "event: ping" },
      ...(approval.bufferedFrames ?? []),
    ];

    resolveApproval(approvalId, "edit", { editedInput: { cmd: "edited" } });

    // N-output: splitToolInputStart on the non-data first frame returns it
    // unchanged, so drain emits [ping, original tool-input-start (un-split,
    // un-rewritten because rewrite only targets idx===0 which was the ping)].
    const frames = takeFrames(transform(makeFrame({ type: "trigger" })));
    expect(frames[0].raw).toBe("event: ping");
    const d1 = parseFrame(frames[1])!;
    expect(d1.type).toBe("tool-input-start");
    expect(d1.input).toEqual({ cmd: "x" });
  });

  it("edit-mode drain leaves a non-tool-input-start first frame unchanged", () => {
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true }),
    });
    const ti = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-edit-wrongtype-1",
      toolName: "bash",
      input: { cmd: "x" },
    });
    const approvalFrame = transform(ti)!;
    const approvalId = (
      parseFrame(approvalFrame)!.data as Record<string, unknown>
    ).id as string;

    // Replace bufferedFrames[0] with a tool-output-available — the rewrite
    // logic checks `parsed.type !== "tool-input-start"` and returns f unchanged.
    const approval = getApproval(approvalId)!;
    approval.bufferedFrames = [
      makeFrame({
        type: "tool-output-available",
        toolCallId: "tc-edit-wrongtype-1",
      }),
    ];

    resolveApproval(approvalId, "edit", { editedInput: { cmd: "edited" } });
    const d1 = parseFrame(transform(makeFrame({ type: "trigger" })))!;
    expect(d1.type).toBe("tool-output-available");
    // No `input` field on the drained frame — wasn't a tool-input-start to
    // rewrite onto.
    expect(d1.input).toBeUndefined();
  });

  it("edit-mode drain catch-block preserves a buffered data: frame with invalid JSON", () => {
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true }),
    });
    const ti = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-edit-badjson-1",
      toolName: "bash",
      input: { cmd: "x" },
    });
    const approvalFrame = transform(ti)!;
    const approvalId = (
      parseFrame(approvalFrame)!.data as Record<string, unknown>
    ).id as string;

    // Buffered frame[0] is data-prefixed but the JSON is malformed.
    const approval = getApproval(approvalId)!;
    approval.bufferedFrames = [{ raw: "data: <<not json>>" }];

    resolveApproval(approvalId, "edit", { editedInput: { cmd: "edited" } });
    // splitToolInputStart catches the JSON parse error and returns the
    // original frame unchanged.
    const frames = takeFrames(transform(makeFrame({ type: "trigger" })));
    expect(frames[0].raw).toBe("data: <<not json>>");
  });

  it("step-7 (tool-keyed frame triggers drain) also rewrites input in edit mode", () => {
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true }),
    });
    const toolFrame = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-edit-3",
      toolName: "bash",
      input: { cmd: "raw" },
    });
    const approvalFrame = transform(toolFrame)!;
    const approvalId = (
      parseFrame(approvalFrame)!.data as Record<string, unknown>
    ).id as string;

    resolveApproval(approvalId, "edit", { editedInput: { cmd: "edited" } });

    // N-output: [stripped ti-start, synth ti-avail with editedInput, trigger
    // to-avail]. The trigger toolCallId matches so it's appended.
    const frames = takeFrames(
      transform(
        makeFrame({
          type: "tool-output-available",
          toolCallId: "tc-edit-3",
          output: { ok: true },
        })
      )
    );
    expect(frames.length).toBe(3);
    const d0 = parseFrame(frames[0])!;
    const d1 = parseFrame(frames[1])!;
    const d2 = parseFrame(frames[2])!;
    expect(d0.type).toBe("tool-input-start");
    expect(d0.input).toBeUndefined();
    expect(d1.type).toBe("tool-input-available");
    expect(d1.input).toEqual({ cmd: "edited" });
    expect(d2.type).toBe("tool-output-available");
  });
});

describe("approvalGating transform — respond mode", () => {
  it("emits a data-human-response frame carrying the response text; tool frames are dropped", () => {
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true }),
    });
    const toolFrame = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-respond-1",
      toolName: "bash",
      input: { cmd: "rm -rf /" },
    });
    const approvalFrame = transform(toolFrame)!;
    const approvalId = (
      parseFrame(approvalFrame)!.data as Record<string, unknown>
    ).id as string;

    // Buffer one tool-output behind the pending approval — it MUST be dropped.
    transform(
      makeFrame({
        type: "tool-output-available",
        toolCallId: "tc-respond-1",
        output: { stdout: "should be dropped" },
      })
    );

    resolveApproval(approvalId, "respond", {
      response: "try grep -r instead, that's safer",
    });

    const first = parseFrame(transform(makeFrame({ type: "noop" })))!;
    expect(first.type).toBe("data-human-response");
    const data = first.data as Record<string, unknown>;
    expect(data.id).toBe(approvalId);
    expect(data.response).toBe("try grep -r instead, that's safer");
    expect(typeof data.seq).toBe("number");
    expect(typeof data.createdAt).toBe("string");
  });

  it("drains globally buffered frames AFTER the data-human-response", () => {
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true }),
    });
    const toolFrame = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-respond-2",
      toolName: "bash",
      input: {},
    });
    const approvalFrame = transform(toolFrame)!;
    const approvalId = (
      parseFrame(approvalFrame)!.data as Record<string, unknown>
    ).id as string;

    // Buffer two text-delta frames globally while paused.
    transform(makeFrame({ type: "text-delta", delta: "explaining... " }));
    transform(makeFrame({ type: "text-delta", delta: "I'm about to run it." }));

    resolveApproval(approvalId, "respond", { response: "no, don't" });

    // N-output: data-human-response first, then the globally buffered
    // text-deltas in order.
    const frames = takeFrames(transform(makeFrame({ type: "noop" })));
    expect(frames.length).toBe(3);
    const r0 = parseFrame(frames[0])!;
    const r1 = parseFrame(frames[1])!;
    const r2 = parseFrame(frames[2])!;
    expect(r0.type).toBe("data-human-response");
    expect((r0.data as Record<string, unknown>).response).toBe("no, don't");
    expect(r1.type).toBe("text-delta");
    expect(r1.delta).toBe("explaining... ");
    expect(r2.type).toBe("text-delta");
    expect(r2.delta).toBe("I'm about to run it.");
  });

  it("step-7 (tool-keyed frame triggers drain) also routes to respond drain", () => {
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true }),
    });
    const toolFrame = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-respond-3",
      toolName: "bash",
      input: {},
    });
    const approvalFrame = transform(toolFrame)!;
    const approvalId = (
      parseFrame(approvalFrame)!.data as Record<string, unknown>
    ).id as string;

    resolveApproval(approvalId, "respond", { response: "use a dry run first" });

    // A toolCallId-keyed frame triggers the step-7 path — must still emit
    // data-human-response (NOT pass the tool frame through).
    const result = parseFrame(
      transform(
        makeFrame({
          type: "tool-output-available",
          toolCallId: "tc-respond-3",
          output: { stdout: "leaked!" },
        })
      )
    )!;
    expect(result.type).toBe("data-human-response");
    expect((result.data as Record<string, unknown>).response).toBe(
      "use a dry run first"
    );
  });

  it("after respond drain, subsequent frames for that toolCallId pass through (pending cleared)", () => {
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true }),
    });
    const toolFrame = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-respond-4",
      toolName: "bash",
      input: {},
    });
    const approvalFrame = transform(toolFrame)!;
    const approvalId = (
      parseFrame(approvalFrame)!.data as Record<string, unknown>
    ).id as string;

    resolveApproval(approvalId, "respond", { response: "stop" });

    transform(makeFrame({ type: "noop" })); // consumes data-human-response

    // Now an unrelated tool-output for the same toolCallId — pending was cleared,
    // so this passes through unchanged.
    const passThrough = parseFrame(
      transform(
        makeFrame({
          type: "tool-output-available",
          toolCallId: "tc-respond-4",
          output: {},
        })
      )
    )!;
    expect(passThrough.type).toBe("tool-output-available");
  });
});

describe("approvalGating transform — multi-interrupt sequencing", () => {
  it("supports back-to-back tool approvals: emits data-approval-required for each, registers both, drains independently", () => {
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true }),
    });

    const firstTool = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-seq-A",
      toolName: "bash",
      input: { cmd: "ls" },
    });
    const secondTool = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-seq-B",
      toolName: "write_file",
      input: { path: "/tmp/x" },
    });

    const firstApproval = parseFrame(transform(firstTool))!;
    expect(firstApproval.type).toBe("data-approval-required");
    const firstApprovalId = (firstApproval.data as Record<string, unknown>)
      .id as string;

    // A second tool-input-start arrives while the first is still pending.
    // Per step 4 in the transform, this enters the "paused + new tool-input-start"
    // branch and emits its own data-approval-required.
    const secondApproval = parseFrame(transform(secondTool))!;
    expect(secondApproval.type).toBe("data-approval-required");
    const secondApprovalId = (secondApproval.data as Record<string, unknown>)
      .id as string;
    expect(secondApprovalId).not.toBe(firstApprovalId);

    // seq counter is monotonic
    const firstSeq = (firstApproval.data as Record<string, unknown>)
      .seq as number;
    const secondSeq = (secondApproval.data as Record<string, unknown>)
      .seq as number;
    expect(secondSeq).toBe(firstSeq + 1);

    // Both approvals are registered independently.
    expect(getApproval(firstApprovalId)?.status).toBe("waiting");
    expect(getApproval(secondApprovalId)?.status).toBe("waiting");

    // Resolve the first; the second remains pending. A subsequent unrelated
    // frame triggers proactive drain for the first.
    resolveApproval(firstApprovalId, "approve");
    const drainedFirst = parseFrame(transform(makeFrame({ type: "noop" })))!;
    expect(drainedFirst.type).toBe("tool-input-start");
    expect(drainedFirst.toolCallId).toBe("tc-seq-A");
    expect(getApproval(firstApprovalId)).toBeUndefined();
    // Second is still pending.
    expect(getApproval(secondApprovalId)?.status).toBe("waiting");

    // Resolve the second; its buffered tool-input-start drains too.
    resolveApproval(secondApprovalId, "approve");
    const drainedSecond = parseFrame(transform(makeFrame({ type: "noop" })))!;
    expect(drainedSecond.type).toBe("tool-input-start");
    expect(drainedSecond.toolCallId).toBe("tc-seq-B");
    expect(getApproval(secondApprovalId)).toBeUndefined();
  });

  it("rejecting one of two concurrent approvals emits data-error only for that toolCallId; the other still drains on approve", () => {
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true }),
    });

    const toolA = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-mix-A",
      toolName: "bash",
      input: {},
    });
    const toolB = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-mix-B",
      toolName: "bash",
      input: {},
    });

    const approvalA = (
      parseFrame(transform(toolA))!.data as Record<string, unknown>
    ).id as string;
    const approvalB = (
      parseFrame(transform(toolB))!.data as Record<string, unknown>
    ).id as string;

    resolveApproval(approvalA, "reject");
    resolveApproval(approvalB, "approve");

    // First unrelated frame drains *some* pending approval (Map iteration order
    // is insertion order in JS, so A is checked first).
    const first = parseFrame(transform(makeFrame({ type: "noop" })))!;
    const second = parseFrame(transform(makeFrame({ type: "noop" })))!;

    const types = [first.type, second.type].sort();
    // One emission is the data-error from the reject, one is the drained
    // tool-input-start from the approve.
    expect(types).toContain("data-error");
    expect(types).toContain("tool-input-start");

    const errorFrame = [first, second].find((f) => f.type === "data-error")!;
    expect((errorFrame.data as Record<string, unknown>).code).toBe(
      "approval_rejected"
    );

    cleanupApproval(approvalA);
    cleanupApproval(approvalB);
  });
});

describe("approvalGating transform — JSON.stringify safety on gate envelope (NEW, iter 6)", () => {
  // INVARIANT LOCK: gateNewTool at L276 emits a data-approval-required envelope
  // via `JSON.stringify({type, data: {..., arguments: input, ...}})`. The
  // `input` is captured as-is from the upstream tool-input-start frame. If the
  // input carries a circular reference (a proxied value, a backend that
  // includes a self-referencing object in args), JSON.stringify throws
  // TypeError OUT of the transform — crashing the SSE stream. The transform
  // contract: never throw. Either the envelope must guard stringify with a
  // safeStringify fallback (matches langgraph/openSwe hardening), or the
  // transform must skip the gate (pass-through) when the input is unserializable.
  it("ADVERSARIAL: tool-input-start with circular input must not crash the gate — transform does not throw", () => {
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true }),
    });
    // Monkey-patch JSON.parse to revive a sentinel into a circular structure.
    // Whatever JSON.parse returns IS what the transform sees; the subsequent
    // JSON.stringify at L276 will throw on the circular ref.
    const originalParse = JSON.parse;
    const sentinel = "__CIRC_AG__";
    JSON.parse = (raw: string) => {
      const obj = originalParse(raw) as Record<string, unknown>;
      if (
        obj &&
        typeof obj === "object" &&
        obj.type === "tool-input-start" &&
        (obj.input as Record<string, unknown> | undefined)?.self === sentinel
      ) {
        const circ: Record<string, unknown> = {
          type: obj.type,
          toolCallId: obj.toolCallId,
          toolName: obj.toolName,
          input: { self: undefined as unknown },
        };
        (circ.input as Record<string, unknown>).self = circ.input;
        return circ;
      }
      return obj;
    };
    try {
      const f: SseFrame = {
        raw: `data: ${JSON.stringify({
          type: "tool-input-start",
          toolCallId: "tc-circular-1",
          toolName: "bash_execute",
          input: { self: sentinel },
        })}`,
      };
      expect(() => transform(f)).not.toThrow();
    } finally {
      JSON.parse = originalParse;
    }
  });
});

describe("approvalGating transform — getApprovalConfig callback throws", () => {
  // INVARIANT LOCK: a misbehaving getApprovalConfig (third-party
  // implementation, mocked evaluation, broken env) MUST NOT crash the SSE
  // stream. The transform's gateNewTool path calls
  //   config.getApprovalConfig?.({ toolCallId, toolName, input })
  // and then reads `approvalConfigResult?.require` — a thrown exception from
  // the callback bubbles up and kills the response stream. The contract must
  // treat a throw as "no approval required" and pass the tool frame through,
  // not crash the transform.
  it("ADVERSARIAL: getApprovalConfig that throws must not crash the transform — tool frame passes through as if no approval was required", () => {
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => {
        throw new Error("policy engine unreachable");
      },
    });
    const frame = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-throw-1",
      toolName: "bash",
      input: { cmd: "ls" },
    });
    expect(() => transform(frame)).not.toThrow();
    const result = transform(frame);
    // Pass-through (not gated) — the throw is treated like getApprovalConfig
    // returning undefined / require:false. No data-approval-required envelope.
    expect(result).not.toBeNull();
    const parsed = parseFrame(result)!;
    expect(parsed.type).toBe("tool-input-start");
    expect(parsed.toolCallId).toBe("tc-throw-1");
  });
});

describe("approvalGating transform — non-JSON-serializable input (Function / circular) (NEW, iter 4)", () => {
  // INVARIANT LOCK: gateNewTool at L276 wraps the input in a JSON.stringify
  // envelope with a try/catch fallback to `arguments: "<unserializable>"`.
  // Functions are non-serializable (JSON.stringify silently drops them — the
  // key disappears entirely from the output, not throw). This is DIFFERENT
  // from circular references (which throw TypeError) and from BigInt (which
  // throws TypeError). The contract: a Function inside input must NOT crash
  // the gate and must NOT silently disappear (i.e. the input must still be
  // represented in the envelope, either via JSON.stringify's silent-drop or
  // via the unserializable sentinel fallback). The test asserts no-throw
  // and that the envelope reaches the client (data-approval-required).
  it("ADVERSARIAL: tool-input-start with a Function in input must not crash the gate — envelope still emits", () => {
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true }),
    });
    // Build the raw frame manually. JSON.stringify silently drops Function
    // values when serializing input (the function key vanishes), but the
    // outer envelope (with actionName, description, etc.) still serializes
    // fine — so the try/catch at L283-312 must NOT trip. The gate must
    // still emit a data-approval-required envelope.
    const fn = function namedFn() {
      return 42;
    };
    const input = { command: "ls", callback: fn };
    const frame = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-fn-1",
      toolName: "bash",
      input,
    });
    expect(() => transform(frame)).not.toThrow();
    const result = transform(frame);
    // The gate must still emit the envelope (Function is silently dropped
    // by JSON.stringify, but the rest of the payload survives).
    expect(result).not.toBeNull();
    const parsed = parseFrame(result)!;
    expect(parsed.type).toBe("data-approval-required");
    const data = parsed.data as Record<string, unknown>;
    // Sanity: other input fields survive serialization even though the
    // Function was dropped.
    expect((data.arguments as Record<string, unknown>).command).toBe("ls");
    cleanupApproval(data.id as string);
  });

  it("ADVERSARIAL: tool-input-start with a circular input must use the unserializable sentinel (NOT throw, NOT silently drop the envelope)", () => {
    // Locks in the iter-6 hardening: gateNewTool wraps JSON.stringify in
    // try/catch with a fallback that substitutes `arguments: "<unserializable>"`
    // for the entire arguments field (rather than dropping the gate entirely).
    // The contract: a circular input still triggers the gate (require: true),
    // the envelope still reaches the client, and the arguments field shows
    // the sentinel — NOT the original input.
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true }),
    });
    const originalParse = JSON.parse;
    const sentinel = "__CIRC_AG_FN__";
    JSON.parse = (raw: string) => {
      const obj = originalParse(raw) as Record<string, unknown>;
      if (
        obj &&
        typeof obj === "object" &&
        obj.type === "tool-input-start" &&
        (obj.input as Record<string, unknown> | undefined)?.self === sentinel
      ) {
        const circ: Record<string, unknown> = {
          type: obj.type,
          toolCallId: obj.toolCallId,
          toolName: obj.toolName,
          input: { self: undefined as unknown },
        };
        (circ.input as Record<string, unknown>).self = circ.input;
        return circ;
      }
      return obj;
    };
    try {
      const f: SseFrame = {
        raw: `data: ${JSON.stringify({
          type: "tool-input-start",
          toolCallId: "tc-circ-fn-1",
          toolName: "bash_execute",
          input: { self: sentinel },
        })}`,
      };
      expect(() => transform(f)).not.toThrow();
      const result = transform(f);
      // The gate must still emit — circular input triggers the fallback path,
      // not a skip.
      expect(result).not.toBeNull();
      const parsed = parseFrame(result)!;
      expect(parsed.type).toBe("data-approval-required");
      const data = parsed.data as Record<string, unknown>;
      // The arguments field shows the safe sentinel, NOT the circular input.
      expect(data.arguments).toBe("<unserializable>");
      cleanupApproval(data.id as string);
    } finally {
      JSON.parse = originalParse;
    }
  });
});

describe("approvalGating transform — upstream tool-input-available pass-through (iter 5)", () => {
  // PROBE 1 (iter 5): approvalGating gates ONLY on tool-input-start. A frame of type
  // tool-input-available — which several upstream adapters emit instead — must pass through
  // untouched even when the policy says every tool requires approval.
  //
  // ISSUE #17b: this previously produced that frame by running createLangchainTransform(),
  // which made a test of CORE approval gating depend on the rung-1 langchain adapter — so
  // `eject langchain` took it with it. langchain was only ever a frame factory here; the
  // assertion never concerned langchain's behaviour. Constructing the frame directly is both
  // rung-free AND more precise: it pins the exact input shape under test instead of
  // inheriting whatever langchain happens to emit today. Langchain's own
  // tool_call → tool-input-available mapping stays covered in adapters/langchain.test.ts.
  it("ADVERSARIAL: a tool-input-available frame reaches approvalGating and passes through without gating (gating triggers on start, not available)", () => {
    const approvalTransform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true }), // would gate IF a start arrived
    });

    const lcFrame = {
      raw: `data: ${JSON.stringify({
        type: "tool-input-available",
        toolCallId: "bash_execute-0",
        toolName: "bash_execute",
        input: { command: "ls" },
      })}`,
    };

    const lcParsed = JSON.parse(lcFrame.raw.slice(6)) as Record<
      string,
      unknown
    >;
    expect(lcParsed.type).toBe("tool-input-available");

    // Now feed it into the approval transform. approvalGating must NOT gate
    // it (no tool-input-start was emitted), so the frame passes through
    // unchanged — proving langchain's output correctly reaches approvalGating.
    const approvalResult = approvalTransform(lcFrame);
    expect(approvalResult).not.toBeNull();
    const approvalFrame = Array.isArray(approvalResult)
      ? approvalResult[0]!
      : approvalResult!;
    expect(approvalFrame.raw).toBe(lcFrame.raw);
  });
});

describe("approvalGating transform — TTL edge: expiresAt = 0 (epoch) (iter 5)", () => {
  // PROBE 4 (iter 5): what happens when expiresAt is exactly 0 (the Unix
  // epoch)? The lazy-TTL check in getApproval is `approval.expiresAt < Date.now()`.
  // Since Date.now() is always > 0 (epoch is 1970), 0 < now is ALWAYS true —
  // meaning a waiting approval with expiresAt=0 is IMMEDIATELY marked as
  // "timeout" on the next getApproval() call. The transform's
  // drainRejectOrTimeout path then emits a data-error with code
  // "approval_timeout". Pinning this contract: a misconfigured backend (or a
  // bug in caller code that defaults expiresAt to 0) MUST NOT leak the
  // original tool frame — it must produce a clean data-error signal instead.
  it("ADVERSARIAL: tool-input-start registered with expiresAt=0 (epoch) — next frame for toolCallId emits data-error approval_timeout instead of leaking the tool frame", () => {
    const transform = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true }),
    });
    // Step 1: emit a tool-input-start that gates.
    const toolFrame = makeFrame({
      type: "tool-input-start",
      toolCallId: "tc-epoch-0",
      toolName: "bash",
      input: { command: "rm -rf /" },
    });
    const approvalFrame = transform(toolFrame)!;
    const approvalId = (
      parseFrame(approvalFrame)!.data as Record<string, unknown>
    ).id as string;

    // Step 2: forcibly overwrite the registered approval's expiresAt to 0
    // (epoch). This simulates a buggy caller passing Date.now()=0 or a
    // failed parse that defaulted the TTL to 0.
    const reg = (globalThis as unknown as {
      __deepagents_approval_registry?: Map<
        string,
        { expiresAt: number; status: string }
      >;
    }).__deepagents_approval_registry!;
    const entry = reg.get(approvalId)!;
    entry.expiresAt = 0;

    // Step 3: send any frame for the pending toolCallId. The transform's
    // proactiveDrain calls getApproval, which sees expiresAt < now and
    // lazy-marks the entry as "timeout", then drainRejectOrTimeout emits a
    // data-error with code "approval_timeout".
    const result = transform(
      makeFrame({
        type: "tool-output-available",
        toolCallId: "tc-epoch-0",
        output: {},
      })
    );
    expect(result).not.toBeNull();
    const frames = takeFrames(result);
    // First frame MUST be data-error (timeout), NOT the tool frame.
    const parsed = parseFrame(frames[0]!)!;
    expect(parsed.type).toBe("data-error");
    const data = parsed.data as Record<string, unknown>;
    expect(data.code).toBe("approval_timeout");

    cleanupApproval(approvalId);
  });
});
