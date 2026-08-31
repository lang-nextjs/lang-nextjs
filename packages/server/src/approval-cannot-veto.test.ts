import { afterEach, describe, it, expect, vi } from "vitest";
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

/*
 * WHICH CASES STILL USE `gateAll`, AND WHY THAT IS DELIBERATE (#488).
 *
 * A 20ms expiry only races something that can still be running when it lapses. The remaining
 * `gateAll` cases are the two adapter-ordering ones at the bottom of this file, and they are
 * NOT async: they feed frames synchronously, read `feed()`'s own return value, and never call
 * `drainOnClose`. No wall-clock time passes inside them and there is no second channel for a
 * report to arrive on, so the expiry cannot change what they observe.
 *
 * CONVERTING THEM WOULD BE A CHANGE TO TESTS THAT WERE NEVER AT RISK, and it would erase the
 * distinction that makes the split legible. The precondition for the flake is all three of:
 * async, a short expiry, and a close-time drain. Check for those three before converting a
 * case, rather than for "uses gateAll" — and rather than for "is currently red", which is how
 * the control below was missed the first time (#418 fixed what was failing; #488 is what
 * shared the mechanism).
 */

/*
 * A CLOSE-TIME SCENARIO THAT CANNOT BE DECIDED DURING `feed()` (#418).
 *
 * The two cases below describe what the gate reports AT CLOSE when a result was
 * buffered. Built on `gateAll` they were flaky under parallel load — measured on
 * main, not introduced by any branch: 3/15 at load 178-238, 0/10 at low load.
 *
 * THE MECHANISM, MEASURED RATHER THAN INFERRED. The failure recorded
 * `entryPending: 0` — the pending map was ALREADY EMPTY when `drainOnClose` ran,
 * so the drain never had anything to report and returning nothing was correct.
 * The report had already been emitted, one layer earlier. With a 20ms expiry,
 * if more than 20ms elapses between the gated `tool-input-start` and the
 * `tool-output-available`, the approval expires first and the transform's
 * per-frame `proactiveDrain` drains it right there — into `feed()`'s RETURN
 * VALUE, which these cases discard. Measured directly:
 *
 *     gap 0ms, 5ms   feed []                     drain [tool_executed_without_approval]
 *     gap 25ms, 40ms feed [approval_timeout]     drain []
 *
 * So this was never "the drain reports nothing". It was an assertion naming
 * WHERE the report is emitted, in a scenario whose emission point depends on how
 * busy the machine is. On a loaded runner `feed()` alone can exceed 20ms.
 *
 * The fix removes the race rather than outrunning it, and does NOT touch the
 * assertions:
 *
 *   timeoutMs 60_000  the approval cannot expire while frames are being fed, so
 *                     the decision is still pending when the stream closes —
 *                     which is the scenario these cases actually describe.
 *   drainGraceMs 0    the drain's own wait is then what ends it, and it ends
 *                     IMMEDIATELY: `remaining <= 0` on the first pass, no sleep,
 *                     no wall clock. The sweep reports from the buffered frames.
 *
 * Verified stable across gaps of 0ms and 40ms, which is the span that used to
 * decide the outcome.
 */
const gateUntilClose = () => ({ require: true, timeoutMs: 60_000 });
const CLOSES_IMMEDIATELY = { drainGraceMs: 0 } as const;

/*
 * `lapse()` USED TO LIVE HERE and is gone (#488). It slept 80ms against a 20ms expiry, so the
 * approval lapsed while the runner was busy rather than when the test said so. Every case that
 * called it now either cannot expire (`gateUntilClose`) or expires on a clock it controls, and
 * a helper whose only purpose was to wait out a race would invite the race back.
 */

/* A frozen clock must not outlive the case that froze it. */
afterEach(() => vi.restoreAllMocks());

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
    const t = createApprovalGatingTransform({
      getApprovalConfig: gateUntilClose,
      ...CLOSES_IMMEDIATELY,
    });

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

    const errs = errorFrames(await t.drainOnClose());
    expect(errs.length).toBeGreaterThan(0);
    const err = errs[errs.length - 1];

    expect(err.code).toBe("tool_executed_without_approval");
    // The tool is named, because "something ran" is not actionable.
    expect(String(err.message)).toContain("increment");
    // And it must not imply the approval could have stopped it.
    expect(String(err.message)).not.toContain("still pending");
  });

  it("AN EMPTY DRAIN IS STILL CORRECT WHEN NOTHING IS OWED (#418)", async () => {
    /*
     * THE PRESENCE COMPANION FOR THE FIX ABOVE, and the reason it is not
     * satisfied by making the drain always emit something.
     *
     * #418 was reported as "the drain took an exit that reports nothing". It
     * does have such an exit and it is CORRECT: a stream that closes with no
     * gated call pending owes the client nothing, and inventing a frame there
     * would be a different lie from the one being fixed. So the empty return has
     * to stay reachable, and this pins it — otherwise a future change that
     * guarantees a frame at close would pass every other case in this file.
     */
    const t = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: false }),
      ...CLOSES_IMMEDIATELY,
    });

    // An ordinary ungated call: nothing is withheld, so nothing is owed at close.
    feed(t, [
      frame({
        type: "tool-input-start",
        toolCallId: "tc-ungated",
        toolName: "read_file",
        input: {},
      }),
      frame({
        type: "tool-output-available",
        toolCallId: "tc-ungated",
        toolName: "read_file",
        output: { ok: true },
      }),
    ]);

    expect(await t.drainOnClose()).toEqual([]);
  });

  it("no buffered result — reported as the plain decision, never as executed", async () => {
    /*
     * THE CONTROL, AND IT IS THE HALF THAT KEEPS THE FIX HONEST. Reporting
     * "already executed" unconditionally would satisfy the case above while
     * being wrong whenever the tool genuinely had not run. Without a result in
     * the buffer, this transform does not know either way, and `pending` is the
     * accurate claim.
     *
     * ── WHY THIS ONE FREEZES THE CLOCK INSTEAD OF USING `gateUntilClose` (#488) ───────────
     *
     * It shares the flake mechanism with the two cases above — async, a short expiry, a
     * close-time drain — but NOT their remedy, and the difference is measurable rather than a
     * matter of taste. The 80ms wait this case used to do was LOAD-BEARING: it asserts
     * `approval_timeout`, and that code is only produced when the approval has ALREADY EXPIRED
     * by the time `drainOnClose` runs. Measured, same frames, three configs:
     *
     *     as-is, gateAll + 80ms wait     drain=[approval_timeout]
     *     gateUntilClose + drainGraceMs 0 drain=[approval_pending_at_close]   <- different claim
     *     frozen clock                    drain=[approval_timeout]
     *
     * So converting it the way the others were converted would have left a GREEN test asserting
     * something its own name does not say. Under a 60s expiry nothing lapses during the wait,
     * the drain falls through to the close sweep, and `pending_at_close` is what comes out.
     *
     * Freezing removes the race at its source instead. With `Date.now()` pinned, no expiry can
     * occur while frames are being fed however slow the runner is; moving the clock past the
     * expiry immediately before the drain makes the timeout happen ON PURPOSE. Verified by
     * forcing the race — a real 40ms gap between the two frames, which is what a loaded runner
     * does:
     *
     *     as-is + forced gap      feed=[approval_timeout]  drain=[]   <- `expected 0 to be > 0`
     *     frozen + forced gap     feed=[]  drain=[approval_timeout]   <- unchanged
     *
     * Freezing is safe HERE for the same reason as in approval-drain-boundary.test.ts: at an
     * offset past the expiry the drain loop breaks on its first iteration without sleeping, so
     * there is no timer left to starve.
     */
    const T0 = 5_000_000;
    let clock = T0;
    vi.spyOn(Date, "now").mockImplementation(() => clock);

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

    // The window lapses HERE, deliberately, rather than whenever the runner gets round to it.
    clock = T0 + 21;
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
    const t = createApprovalGatingTransform({
      getApprovalConfig: gateUntilClose,
      ...CLOSES_IMMEDIATELY,
    });
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
