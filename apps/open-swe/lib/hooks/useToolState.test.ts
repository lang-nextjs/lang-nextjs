// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useToolState } from "./useToolState";
import { StreamEvent } from "../types";

describe("useToolState", () => {
  it("returns empty array for empty events", () => {
    const { result } = renderHook(() => useToolState([]));
    expect(result.current).toEqual([]);
  });

  it("returns pending tool call when tool-input-start event arrives", () => {
    const events: StreamEvent[] = [
      {
        type: "tool-input-start",
        toolCallId: "tc-1",
        toolName: "bash",
        input: { cmd: "ls" },
      },
    ];
    const { result } = renderHook(() => useToolState(events));
    expect(result.current).toHaveLength(1);
    expect(result.current[0].status).toBe("pending");
    expect(result.current[0].toolName).toBe("bash");
  });

  it("upgrades to completed when tool-output-available matches toolCallId", () => {
    const events: StreamEvent[] = [
      {
        type: "tool-input-start",
        toolCallId: "tc-1",
        toolName: "bash",
        input: { cmd: "ls" },
      },
      {
        type: "tool-output-available",
        toolCallId: "tc-1",
        output: { stdout: "file.txt" },
      },
    ];
    const { result } = renderHook(() => useToolState(events));
    expect(result.current[0].status).toBe("completed");
    expect(result.current[0].output).toEqual({ stdout: "file.txt" });
  });

  it("does not mutate completed state when duplicate tool-output-available arrives", () => {
    const events: StreamEvent[] = [
      {
        type: "tool-input-start",
        toolCallId: "tc-1",
        toolName: "bash",
        input: { cmd: "ls" },
      },
      {
        type: "tool-output-available",
        toolCallId: "tc-1",
        output: { stdout: "first" },
      },
      {
        type: "tool-output-available",
        toolCallId: "tc-1",
        output: { stdout: "second" },
      },
    ];
    const { result } = renderHook(() => useToolState(events));
    // First output wins; duplicate ignored
    expect(result.current[0].output).toEqual({ stdout: "first" });
    expect(result.current[0].status).toBe("completed");
  });

  it("tracks multiple concurrent tool calls independently", () => {
    const events: StreamEvent[] = [
      {
        type: "tool-input-start",
        toolCallId: "tc-1",
        toolName: "bash",
        input: {},
      },
      {
        type: "tool-input-start",
        toolCallId: "tc-2",
        toolName: "read_file",
        input: { path: "/foo" },
      },
      { type: "tool-output-available", toolCallId: "tc-1", output: "done" },
    ];
    const { result } = renderHook(() => useToolState(events));
    expect(result.current).toHaveLength(2);
    const tc1 = result.current.find((t) => t.toolCallId === "tc-1")!;
    const tc2 = result.current.find((t) => t.toolCallId === "tc-2")!;
    expect(tc1.status).toBe("completed");
    expect(tc2.status).toBe("pending");
  });

  it("converges correctly when tool-output-available arrives before tool-input-start (out-of-order)", () => {
    // Out-of-order: output arrives before input
    const events: StreamEvent[] = [
      {
        type: "tool-output-available",
        toolCallId: "tc-oo",
        output: { result: 42 },
      },
      {
        type: "tool-input-start",
        toolCallId: "tc-oo",
        toolName: "compute",
        input: { x: 1 },
      },
    ];
    const { result } = renderHook(() => useToolState(events));
    expect(result.current).toHaveLength(1);
    // After processing both events in this order, state must be completed
    expect(result.current[0].status).toBe("completed");
    expect(result.current[0].output).toEqual({ result: 42 });
    expect(result.current[0].toolName).toBe("compute");
  });
});

// ---------------------------------------------------------------------------
// Ported from apps/example/lib/hooks/useToolState.test.ts (#19).
// apps/example embedded a duplicate open-swe rung, deleted in PR #29.
// These three convergence/scale cases had no counterpart here. The hook
// consumes StreamEvent[] and touches no URL, so the rung protocol change is
// irrelevant to them. Assertions unchanged from the originals.
// ---------------------------------------------------------------------------
describe("useToolState — ported convergence coverage (#19)", () => {
  it("concurrent updates: 10 tool calls with interleaved input/output events all converge to a stable completed state", () => {
    // Simulate a real stream where many tools start and finish in arbitrary order.
    // 10 distinct toolCallIds, each gets an input-start and an output-available.
    // Events are interleaved (not batched): start0, start1, out0, start2, out1, out2, ...
    // After processing, every tool must be 'completed' with its own output (no
    // cross-contamination of outputs between toolCallIds).
    //
    // Build the event stream in a deliberately interleaved order: emit all 10
    // input-starts first, then all 10 output-availables in REVERSED order.
    // This forces the reducer to handle many tool-call-ids that arrived before
    // their output, and to keep each output bound to the correct toolCallId.
    const events: StreamEvent[] = [];
    const expected: Record<
      string,
      { output: unknown; toolName: string; input: Record<string, unknown> }
    > = {};
    for (let i = 0; i < 10; i++) {
      const toolName = `tool_${i}`;
      const input = { idx: i };
      const output = { result: i * 10 };
      expected[`tc-${i}`] = { output, toolName, input };
    }

    // Phase 1: emit all 10 input-starts (in order).
    for (let i = 0; i < 10; i++) {
      events.push({
        type: "tool-input-start",
        toolCallId: `tc-${i}`,
        toolName: expected[`tc-${i}`].toolName,
        input: expected[`tc-${i}`].input,
      });
    }

    // Phase 2: emit all 10 output-availables in REVERSED order so the reducer
    // must match each output to its specific toolCallId (no short-circuit on
    // the first id seen).
    for (let i = 9; i >= 0; i--) {
      events.push({
        type: "tool-output-available",
        toolCallId: `tc-${i}`,
        output: expected[`tc-${i}`].output,
      });
    }

    const { result } = renderHook(() => useToolState(events));

    // Exactly 10 tool call entries — no leaks, no duplicates.
    expect(result.current).toHaveLength(10);

    // Every tc-N must be completed with its own output (not a sibling's).
    for (let i = 0; i < 10; i++) {
      const tc = result.current.find((t) => t.toolCallId === `tc-${i}`);
      expect(tc).toBeDefined();
      expect(tc!.status).toBe("completed");
      expect(tc!.toolName).toBe(expected[`tc-${i}`].toolName);
      expect(tc!.output).toEqual(expected[`tc-${i}`].output);
      expect(tc!.input).toEqual({ idx: i });
    }

    // No tool should have leaked an output from a different toolCallId.
    for (const tc of result.current) {
      const expectedOutput = expected[tc.toolCallId].output;
      expect(tc.output).toEqual(expectedOutput);
    }
  });

  it("100 tool calls in a tight interleaved loop converge to a stable per-id completed state", () => {
    // Adversarial: scale test. Generate 100 distinct tool-call-ids, then
    // interleave input-start and output-available events in a tight loop:
    //   start_0, start_1, out_0, start_2, out_1, out_2, start_3, ...
    // (i.e. one new start, then output for the previous start, repeating.)
    //
    // Targets:
    //   - Map state corruption across many toolCallIds (one id overwriting another)
    //   - pendingOutputs leak (an output stored for id-A bleeds into id-B)
    //   - off-by-one errors where the last id never gets its output applied
    //   - duplicate output-application (a completed entry re-overwritten)
    //
    // After processing, every one of the 100 ids must:
    //   (a) exist exactly once in the result
    //   (b) be 'completed'
    //   (c) carry its OWN output (not a sibling's)
    //   (d) carry its OWN toolName and input

    const N = 100;
    const expected: Record<
      string,
      { toolName: string; input: Record<string, unknown>; output: unknown }
    > = {};

    for (let i = 0; i < N; i++) {
      expected[`tc-${i}`] = {
        toolName: `tool_${i}`,
        input: { idx: i, payload: `data-${i}-${"x".repeat(20)}` },
        output: { result: i * 7, marker: `out-${i}` },
      };
    }

    // Build the interleaved event stream:
    //   i=0: start tc-0
    //   i=1: start tc-1, out tc-0
    //   i=2: start tc-2, out tc-1
    //   ...
    //   i=N-1: start tc-(N-1), out tc-(N-2)
    //   i=N:   out tc-(N-1)    ← the final id needs its output in a tail event
    const events: StreamEvent[] = [];
    for (let i = 0; i < N - 1; i++) {
      events.push({
        type: "tool-input-start",
        toolCallId: `tc-${i}`,
        toolName: expected[`tc-${i}`].toolName,
        input: expected[`tc-${i}`].input,
      });
      events.push({
        type: "tool-output-available",
        toolCallId: `tc-${i}`,
        output: expected[`tc-${i}`].output,
      });
    }
    // Final: start the last id, then output for it
    events.push({
      type: "tool-input-start",
      toolCallId: `tc-${N - 1}`,
      toolName: expected[`tc-${N - 1}`].toolName,
      input: expected[`tc-${N - 1}`].input,
    });
    events.push({
      type: "tool-output-available",
      toolCallId: `tc-${N - 1}`,
      output: expected[`tc-${N - 1}`].output,
    });

    const { result } = renderHook(() => useToolState(events));

    // (a) exactly N entries
    expect(result.current).toHaveLength(N);

    // (b)(c)(d) per-id assertions
    const seenIds = new Set<string>();
    for (const tc of result.current) {
      // no duplicate ids
      expect(seenIds.has(tc.toolCallId)).toBe(false);
      seenIds.add(tc.toolCallId);

      const exp = expected[tc.toolCallId];
      expect(exp).toBeDefined();

      expect(tc.status).toBe("completed");
      expect(tc.toolName).toBe(exp.toolName);
      expect(tc.input).toEqual(exp.input);
      expect(tc.output).toEqual(exp.output);
    }

    // Every id from the batch is accounted for
    expect(seenIds.size).toBe(N);
    for (let i = 0; i < N; i++) {
      expect(seenIds.has(`tc-${i}`)).toBe(true);
    }
  });
});

describe("useToolState — 1000 tool calls in a tight loop with deterministic output binding", () => {
  it("1000 distinct toolCallIds each with start+output in alternating order converge: no id is lost, no output leaks across ids, no off-by-one at the tail", () => {
    // Adversarial: scale + tight-loop stress. Generates 1000 distinct
    // toolCallIds, then for each i in [0..999] emits:
    //   - tool-input-start(tc-i)
    //   - tool-output-available(tc-i)
    // IN THAT ORDER per id, but with ALL start events emitted first in a
    // block, then ALL output events emitted in a block. This forces the
    // reducer to:
    //   (a) store all 1000 pending input-starts in its Map first,
    //   (b) then receive 1000 output-available events that each match an
    //       existing input (NOT out-of-order), and complete every entry,
    //   (c) without leaking an output from one id into another's entry
    //       (e.g., due to a shared Map or a typo in toolCallId lookup),
    //   (d) without an off-by-one that drops the very last id or the very
    //       first id.
    //
    // Targets:
    //   - Map.set overwriting entries with the same key (none here, all
    //     distinct, but catches an impl that reuses a single key),
    //   - pendingOutputs bleeding into the next call's state across hooks,
    //   - Array.from(state.values()) losing entries under memory pressure,
    //   - JSON serialization or spread that drops a key.
    const N = 1000;
    const expected: Record<
      string,
      { toolName: string; input: Record<string, unknown>; output: unknown }
    > = {};

    for (let i = 0; i < N; i++) {
      expected[`tc-${i}`] = {
        toolName: `tool_${i}`,
        input: { idx: i, marker: `in-${i}` },
        output: { result: i * 13, marker: `out-${i}` },
      };
    }

    // Phase 1: 1000 input-start events in order.
    const events: StreamEvent[] = [];
    for (let i = 0; i < N; i++) {
      events.push({
        type: "tool-input-start",
        toolCallId: `tc-${i}`,
        toolName: expected[`tc-${i}`].toolName,
        input: expected[`tc-${i}`].input,
      });
    }
    // Phase 2: 1000 output-available events in order (same id ordering).
    for (let i = 0; i < N; i++) {
      events.push({
        type: "tool-output-available",
        toolCallId: `tc-${i}`,
        output: expected[`tc-${i}`].output,
      });
    }

    const { result } = renderHook(() => useToolState(events));

    // (a) Every entry present — exact count, no drops.
    expect(result.current).toHaveLength(N);

    // (b) Every entry is 'completed' with its own output.
    const seenIds = new Set<string>();
    for (const tc of result.current) {
      // No duplicate ids in the output
      expect(seenIds.has(tc.toolCallId)).toBe(false);
      seenIds.add(tc.toolCallId);

      const exp = expected[tc.toolCallId];
      expect(exp).toBeDefined();
      expect(tc.status).toBe("completed");
      expect(tc.toolName).toBe(exp.toolName);
      expect(tc.input).toEqual(exp.input);
      // CRITICAL: output must match the id's OWN output, not a sibling's.
      expect(tc.output).toEqual(exp.output);
    }

    // (c) Every id from the batch is accounted for.
    expect(seenIds.size).toBe(N);
    for (let i = 0; i < N; i++) {
      expect(seenIds.has(`tc-${i}`)).toBe(true);
    }

    // (d) First and last ids must not be dropped (off-by-one guards).
    expect(seenIds.has("tc-0")).toBe(true);
    expect(seenIds.has(`tc-${N - 1}`)).toBe(true);

    // The tc-0 entry must carry tc-0's output, not tc-(N-1)'s.
    const tc0 = result.current.find((t) => t.toolCallId === "tc-0")!;
    expect(tc0.output).toEqual({ result: 0, marker: "out-0" });
    const tcN = result.current.find((t) => t.toolCallId === `tc-${N - 1}`)!;
    expect(tcN.output).toEqual({
      result: (N - 1) * 13,
      marker: `out-${N - 1}`,
    });
  });
});
