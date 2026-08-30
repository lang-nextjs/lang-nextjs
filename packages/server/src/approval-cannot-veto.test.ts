import { describe, it, expect, vi } from "vitest";
import { createApprovalGatingTransform } from "./approval-gating";
import type { SseFrame } from "./accumulator";

vi.mock("./stream-registry", () => ({
  atomicRegisterIfAbsent: vi.fn(),
  markStreamDone: vi.fn(),
  deleteStream: vi.fn(),
  lookupStream: vi.fn(),
}));
vi.mock("./reconnect", () => ({
  isStreamReconnectEnabled: vi.fn(() => false),
}));

/**
 * A GATE DOWNSTREAM OF EXECUTION MUST NOT CLAIM A VETO (#256).
 *
 * This transform sits after whatever ran the tool. Against a Python agent the
 * backend executes autonomously and these frames arrive once the work is done —
 * measured through open-swe on deepagents: the counter moved 65 -> 66 while
 * nobody approved anything, and the client was told
 *
 *   data-approval-required   status=waiting
 *   data-error               approval_pending_at_close
 *
 * "an approval was still pending" describes a refusal that would have mattered.
 * It would not have. That is worse than no gate.
 *
 * THE BUFFER ALREADY CARRIES THE ANSWER, which is why this is fixable without
 * new plumbing: a `tool-output-available` is a RESULT, and a result implies the
 * call ran. The two cases are distinguishable and must be reported differently.
 *
 * The second describe block covers the other half of #256 — the two adapter
 * families disagree about emitting `tool-input-start`, so the same policy
 * produces different behaviour per rung. Nothing compared them before, which is
 * why the divergence was invisible.
 */

const frame = (o: Record<string, unknown>): SseFrame => ({
  raw: `data: ${JSON.stringify(o)}`,
});

/*
 * Gate everything, with a short expiry.
 *
 * `drainOnClose` waits for each pending approval to resolve or expire, bounded
 * by that approval's own `expiresAt`. The production route uses 60s; these
 * tests need the expiry to be the thing that ends the wait, not the runner's
 * patience, so they use a few milliseconds and then let it lapse.
 */
const gateAll = () => ({ require: true, timeoutMs: 20 });

const lapse = () => new Promise((r) => setTimeout(r, 80));

function feed(
  t: ReturnType<typeof createApprovalGatingTransform>,
  frames: SseFrame[]
) {
  const out: SseFrame[] = [];
  for (const f of frames) {
    const r = t(f);
    if (Array.isArray(r)) out.push(...r);
    else if (r) out.push(r);
  }
  return out;
}

function errorFrames(frames: SseFrame[]) {
  return frames
    .map((f) => {
      try {
        return JSON.parse(f.raw.slice(6)) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((p): p is Record<string, unknown> => p?.type === "data-error")
    .map((p) => p.data as Record<string, unknown>);
}

describe("the gate reports what actually happened at close", () => {
  it("a buffered tool RESULT means it already ran — and the error says so", async () => {
    const t = createApprovalGatingTransform({ getApprovalConfig: gateAll });

    // The deepagents ordering: start, then input, then a RESULT. The result is
    // the proof — the backend ran the tool without waiting for anyone.
    feed(t, [
      frame({
        type: "tool-input-start",
        toolCallId: "tc1",
        toolName: "increment",
        input: {},
      }),
      frame({
        type: "tool-input-available",
        toolCallId: "tc1",
        toolName: "increment",
        input: {},
      }),
      frame({
        type: "tool-output-available",
        toolCallId: "tc1",
        toolName: "increment",
        output: { ok: true },
      }),
    ]);

    await lapse();
    const errs = errorFrames(await t.drainOnClose());
    expect(errs.length).toBeGreaterThan(0);
    const err = errs[errs.length - 1];

    expect(err.code).toBe("tool_executed_without_approval");
    // The tool is named, because "something ran" is not actionable.
    expect(String(err.message)).toContain("increment");
    // And it must not imply the approval could have stopped it.
    expect(String(err.message)).not.toContain("still pending");
  });

  it("no buffered result — reported as the plain decision, never as executed", async () => {
    /*
     * THE CONTROL, AND IT IS THE HALF THAT KEEPS THE FIX HONEST. Reporting
     * "already executed" unconditionally would satisfy the case above while
     * being wrong whenever the tool genuinely had not run. Without a result in
     * the buffer, this transform does not know either way, and `pending` is the
     * accurate claim.
     */
    const t = createApprovalGatingTransform({ getApprovalConfig: gateAll });

    feed(t, [
      frame({
        type: "tool-input-start",
        toolCallId: "tc1",
        toolName: "increment",
        input: {},
      }),
      frame({
        type: "tool-input-available",
        toolCallId: "tc1",
        toolName: "increment",
        input: {},
      }),
    ]);

    await lapse();
    const errs = errorFrames(await t.drainOnClose());
    expect(errs.length).toBeGreaterThan(0);
    const err = errs[errs.length - 1];

    // The decision stands on its own terms — nothing here proves the tool ran.
    expect(err.code).toBe("approval_timeout");
    expect(err.code).not.toBe("tool_executed_without_approval");
  });

  it("the frames describing completed work are RELEASED, not dropped", async () => {
    /*
     * The issue's title is "silently drops the frames describing it". Saying so
     * in the message is only half a fix — the result itself has to reach the
     * client, or the effect stays invisible while the refusal looks decisive.
     */
    const t = createApprovalGatingTransform({ getApprovalConfig: gateAll });
    feed(t, [
      frame({
        type: "tool-input-start",
        toolCallId: "tc1",
        toolName: "increment",
        input: {},
      }),
      frame({
        type: "tool-input-available",
        toolCallId: "tc1",
        toolName: "increment",
        input: {},
      }),
      frame({
        type: "tool-output-available",
        toolCallId: "tc1",
        toolName: "increment",
        output: { ok: true },
      }),
    ]);
    await lapse();
    const kinds = (await t.drainOnClose()).map((f) => {
      try {
        return (JSON.parse(f.raw.slice(6)) as { type?: string }).type;
      } catch {
        return null;
      }
    });
    expect(kinds).toContain("tool-output-available");
  });
});

describe("the two adapter orderings, compared for the first time (#256)", () => {
  it("deepagents ordering (tool-input-start present) IS gated", () => {
    const t = createApprovalGatingTransform({ getApprovalConfig: gateAll });
    const out = feed(t, [
      frame({
        type: "tool-input-start",
        toolCallId: "tc1",
        toolName: "increment",
        input: {},
      }),
    ]);
    const kinds = out.map((f) => {
      try {
        return (JSON.parse(f.raw.slice(6)) as { type?: string }).type;
      } catch {
        return null;
      }
    });
    expect(kinds).toContain("data-approval-required");
  });

  it("langchain/langgraph ordering (no tool-input-start) is NOT gated — the tool call flows straight through", () => {
    /*
     * NOT AN ASPIRATION — A RECORD OF THE DIVERGENCE.
     *
     * Those adapters synthesise `tool-input-available` with no preceding
     * `tool-input-start`, and the gate keys on the latter. So the SAME policy
     * gates deepagents and does nothing on the other two rungs.
     *
     * Asserting the current behaviour rather than the desired one is deliberate:
     * unifying the orderings is the open design question in #256, and this test
     * is what makes any future change to it deliberate rather than accidental.
     */
    const t = createApprovalGatingTransform({ getApprovalConfig: gateAll });
    const out = feed(t, [
      frame({
        type: "tool-input-available",
        toolCallId: "tc1",
        toolName: "increment",
        input: {},
      }),
    ]);
    const kinds = out.map((f) => {
      try {
        return (JSON.parse(f.raw.slice(6)) as { type?: string }).type;
      } catch {
        return null;
      }
    });
    expect(kinds).not.toContain("data-approval-required");
    expect(kinds).toContain("tool-input-available");
  });
});
