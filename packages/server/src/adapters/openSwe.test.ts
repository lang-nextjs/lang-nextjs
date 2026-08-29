/**
 * TDD RED tests for openSweAdapter.
 *
 * openSweAdapter maps LangGraph Platform events (on_tool_start, on_tool_end) to AI SDK v6
 * tool event frames (tool-input-start, tool-output-available), implements a reorder buffer
 * to emit end events in the order start events arrived, and maintains a FIFO queue for
 * pairing end events to their toolCallId without counter reconstruction.
 *
 * This test file is intentionally RED — openSwe.ts does not exist yet.
 * Plan 02 will create the implementation to make these tests GREEN.
 */

import { describe, it, expect, expectTypeOf } from "vitest";
import { openSweAdapter, createOpenSweTransform } from "./openSwe";

// Helper: build a raw SSE data frame from an object
function toSseFrame(obj: unknown): { raw: string } {
  return { raw: `data: ${JSON.stringify(obj)}` };
}

// The transform returns SseFrame | SseFrame[] | null (multi-frame on drains).
// `one()` asserts a single-frame result and returns it; `many()` normalizes any
// result to an array (used by the reorder/FIFO drain tests).
type R = { raw: string } | { raw: string }[] | null;
function one(r: R): { raw: string } {
  if (r === null) throw new Error("expected a frame, got null");
  if (Array.isArray(r)) {
    if (r.length !== 1) throw new Error(`expected 1 frame, got ${r.length}`);
    return r[0]!;
  }
  return r;
}
function many(r: R): { raw: string }[] {
  return r === null ? [] : Array.isArray(r) ? r : [r];
}

describe("openSweAdapter — adapter contract", () => {
  it('has name "open-swe"', () => {
    expect(openSweAdapter.name).toBe("open-swe");
  });

  it("has at least one transform", () => {
    expect(openSweAdapter.transforms.length).toBeGreaterThan(0);
  });

  it("transforms property is a getter returning fresh instances (no inter-request state leakage)", () => {
    // Two accesses to openSweAdapter.transforms must return different function references
    // This ensures each request gets a fresh transform with clean state.
    const transforms1 = openSweAdapter.transforms;
    const transforms2 = openSweAdapter.transforms;
    expect(transforms1[0]).not.toBe(transforms2[0]);
  });
});

describe("openSweAdapter transform — on_tool_start → tool-input-start", () => {
  it("maps on_tool_start event to tool-input-start with correct fields", () => {
    const transform = createOpenSweTransform();
    const input = toSseFrame({
      event: "on_tool_start",
      name: "bash_execute",
      run_id: "run-abc",
      data: { input: { command: "git status" } },
    });
    const result = transform(input);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(one(result).raw.slice(6));
    expect(parsed.type).toBe("tool-input-start");
    expect(parsed.toolName).toBe("bash_execute");
    expect(parsed.input).toEqual({ command: "git status" });
    expect(parsed.toolCallId).toBeDefined();
  });

  it("generates toolCallId in format ${run_id}--${toolName}-0 for first call", () => {
    const transform = createOpenSweTransform();
    const input = toSseFrame({
      event: "on_tool_start",
      name: "bash_execute",
      run_id: "run-abc",
      data: { input: { command: "ls -la" } },
    });
    const result = transform(input);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(one(result).raw.slice(6));
    expect(parsed.toolCallId).toBe("run-abc--bash_execute-0");
  });

  it("increments counter per (run_id, toolName) pair — second call for same tool gets -1", () => {
    const transform = createOpenSweTransform();
    // First on_tool_start for bash_execute
    const input1 = toSseFrame({
      event: "on_tool_start",
      name: "bash_execute",
      run_id: "run-abc",
      data: { input: { command: "git status" } },
    });
    const result1 = transform(input1);
    const parsed1 = JSON.parse(one(result1).raw.slice(6));
    expect(parsed1.toolCallId).toBe("run-abc--bash_execute-0");

    // Second on_tool_start for bash_execute (same run, same tool)
    const input2 = toSseFrame({
      event: "on_tool_start",
      name: "bash_execute",
      run_id: "run-abc",
      data: { input: { command: "git log" } },
    });
    const result2 = transform(input2);
    const parsed2 = JSON.parse(one(result2).raw.slice(6));
    expect(parsed2.toolCallId).toBe("run-abc--bash_execute-1");
  });

  it("tool-input-start output contains only type, toolCallId, toolName, input fields", () => {
    const transform = createOpenSweTransform();
    const input = toSseFrame({
      event: "on_tool_start",
      name: "bash_execute",
      run_id: "run-abc",
      data: { input: { command: "echo hello" } },
    });
    const result = transform(input);
    const parsed = JSON.parse(one(result).raw.slice(6));
    expect(Object.keys(parsed).sort()).toEqual(
      ["type", "toolCallId", "toolName", "input"].sort()
    );
  });
});

describe("openSweAdapter transform — on_tool_end → tool-output-available", () => {
  it("maps on_tool_end event to tool-output-available after matching start", () => {
    const transform = createOpenSweTransform();
    // First, emit a start event
    const startInput = toSseFrame({
      event: "on_tool_start",
      name: "bash_execute",
      run_id: "run-abc",
      data: { input: { command: "git status" } },
    });
    const startResult = transform(startInput);
    const startParsed = JSON.parse(one(startResult).raw.slice(6));

    // Now emit the corresponding end event
    const endInput = toSseFrame({
      event: "on_tool_end",
      name: "bash_execute",
      run_id: "run-abc",
      data: { output: "On branch main" },
    });
    const endResult = transform(endInput);
    expect(endResult).not.toBeNull();
    const endParsed = JSON.parse(one(endResult).raw.slice(6));
    expect(endParsed.type).toBe("tool-output-available");
    expect(endParsed.output).toBe("On branch main");
  });

  it("tool-output-available contains type, toolCallId, output fields", () => {
    const transform = createOpenSweTransform();
    // Start
    transform(
      toSseFrame({
        event: "on_tool_start",
        name: "bash_execute",
        run_id: "run-abc",
        data: { input: { command: "git status" } },
      })
    );
    // End
    const endResult = transform(
      toSseFrame({
        event: "on_tool_end",
        name: "bash_execute",
        run_id: "run-abc",
        data: { output: "On branch main" },
      })
    );
    const parsed = JSON.parse(one(endResult).raw.slice(6));
    expect(Object.keys(parsed).sort()).toEqual(
      ["type", "toolCallId", "output"].sort()
    );
  });

  it("toolCallId in end event matches the toolCallId from paired start event", () => {
    const transform = createOpenSweTransform();
    // Start event
    const startResult = transform(
      toSseFrame({
        event: "on_tool_start",
        name: "bash_execute",
        run_id: "run-xyz",
        data: { input: { command: "pwd" } },
      })
    );
    const startParsed = JSON.parse(one(startResult).raw.slice(6));
    const startToolCallId = startParsed.toolCallId;

    // End event
    const endResult = transform(
      toSseFrame({
        event: "on_tool_end",
        name: "bash_execute",
        run_id: "run-xyz",
        data: { output: "/home/user" },
      })
    );
    const endParsed = JSON.parse(one(endResult).raw.slice(6));
    const endToolCallId = endParsed.toolCallId;

    // Both must have the same toolCallId
    expect(endToolCallId).toBe(startToolCallId);
  });
});

describe("openSweAdapter transform — reorder buffer (different tools out-of-order)", () => {
  it("buffers out-of-order end events and emits in start order when prerequisite end arrives", () => {
    const transform = createOpenSweTransform();

    // Step 1: Send on_tool_start for tool_a
    const startA = transform(
      toSseFrame({
        event: "on_tool_start",
        name: "tool_a",
        run_id: "run-1",
        data: { input: { arg: "a" } },
      })
    );
    expect(startA).not.toBeNull();
    const parsedStartA = JSON.parse(one(startA).raw.slice(6));
    const toolCallIdA = parsedStartA.toolCallId;

    // Step 2: Send on_tool_start for tool_b
    const startB = transform(
      toSseFrame({
        event: "on_tool_start",
        name: "tool_b",
        run_id: "run-1",
        data: { input: { arg: "b" } },
      })
    );
    expect(startB).not.toBeNull();
    const parsedStartB = JSON.parse(one(startB).raw.slice(6));
    const toolCallIdB = parsedStartB.toolCallId;

    // Step 3: Send on_tool_end for tool_b (arrives BEFORE tool_a end — reversed order)
    // This should return null (buffered, not emitted yet)
    const endBBeforeA = transform(
      toSseFrame({
        event: "on_tool_end",
        name: "tool_b",
        run_id: "run-1",
        data: { output: "b result" },
      })
    );
    expect(endBBeforeA).toBeNull(); // Buffered

    // Step 4: Send on_tool_end for tool_a (unblocks the buffer). The transform
    // now returns BOTH ends in one call as an array, in start order:
    // tool_a (the unblocking end) first, then the buffered tool_b.
    const endFrames = many(
      transform(
        toSseFrame({
          event: "on_tool_end",
          name: "tool_a",
          run_id: "run-1",
          data: { output: "a result" },
        })
      )
    );
    expect(endFrames).toHaveLength(2);
    const e0 = JSON.parse(endFrames[0]!.raw.slice(6));
    const e1 = JSON.parse(endFrames[1]!.raw.slice(6));
    expect(e0.toolCallId).toBe(toolCallIdA);
    expect(e0.output).toBe("a result");
    expect(e1.toolCallId).toBe(toolCallIdB);
    expect(e1.output).toBe("b result");
  });
});

describe("openSweAdapter transform — FIFO queue pairing (same tool, reversed end arrival)", () => {
  it("pairs end events via FIFO queue shift, not reconstructed counter, when ends arrive out-of-order", () => {
    const transform = createOpenSweTransform();

    // Step 1: Send first on_tool_start for bash_execute (gets toolCallId_0)
    const start0 = transform(
      toSseFrame({
        event: "on_tool_start",
        name: "bash_execute",
        run_id: "run-2",
        data: { input: { command: "first" } },
      })
    );
    expect(start0).not.toBeNull();
    const parsedStart0 = JSON.parse(one(start0).raw.slice(6));
    const toolCallId0 = parsedStart0.toolCallId;
    expect(toolCallId0).toMatch(/-0$/); // Ends in -0

    // Step 2: Send second on_tool_start for bash_execute (gets toolCallId_1)
    const start1 = transform(
      toSseFrame({
        event: "on_tool_start",
        name: "bash_execute",
        run_id: "run-2",
        data: { input: { command: "second" } },
      })
    );
    expect(start1).not.toBeNull();
    const parsedStart1 = JSON.parse(one(start1).raw.slice(6));
    const toolCallId1 = parsedStart1.toolCallId;
    expect(toolCallId1).toMatch(/-1$/); // Ends in -1

    // Step 3: Send on_tool_end for the SECOND call (toolCallId_1)
    // but it arrives FIRST (reversed order) — should be buffered
    const endReverseArrival = transform(
      toSseFrame({
        event: "on_tool_end",
        name: "bash_execute",
        run_id: "run-2",
        data: { output: "second result" },
      })
    );
    expect(endReverseArrival).toBeNull(); // Buffered because toolCallId_0 is still waiting

    // Step 4: Send on_tool_end for the FIRST call (toolCallId_0). This unblocks
    // the sequence and returns BOTH ends in one call, in FIFO start order:
    // end_0 (paired via queue.shift, not counter reconstruction) then end_1.
    const endFrames = many(
      transform(
        toSseFrame({
          event: "on_tool_end",
          name: "bash_execute",
          run_id: "run-2",
          data: { output: "first result" },
        })
      )
    );
    expect(endFrames).toHaveLength(2);
    const parsedEnd0 = JSON.parse(endFrames[0]!.raw.slice(6));
    const parsedEnd1 = JSON.parse(endFrames[1]!.raw.slice(6));
    expect(parsedEnd0.toolCallId).toBe(toolCallId0); // -0 first
    expect(parsedEnd0.output).toBe("first result");
    expect(parsedEnd1.toolCallId).toBe(toolCallId1); // -1 second
    expect(parsedEnd1.output).toBe("second result");
  });
});

describe("openSweAdapter transform — pass-through cases", () => {
  const transform = createOpenSweTransform();

  it("passes through [DONE] frame unchanged", () => {
    const frame = { raw: "data: [DONE]" };
    const result = transform(frame);
    expect(result).toEqual(frame);
  });

  it("passes through non-JSON data frame unchanged (never throws)", () => {
    const frame = { raw: "data: not-valid-json" };
    expect(() => transform(frame)).not.toThrow();
    const result = transform(frame);
    expect(result).toEqual(frame);
  });

  it('passes through frame that does not start with "data: " unchanged', () => {
    const frame = { raw: "event: ping" };
    const result = transform(frame);
    expect(result).toEqual(frame);
  });

  it("passes through JSON frame with no event field unchanged", () => {
    const frame = { raw: 'data: {"someOtherField":"value"}' };
    const result = transform(frame);
    expect(result).toEqual(frame);
  });

  it("maps on_chat_model_stream with text content to text-delta (inherited behavior)", () => {
    const frame = toSseFrame({
      event: "on_chat_model_stream",
      name: "model",
      run_id: "run-xyz",
      data: { chunk: { content: "Hello world" } },
    });
    const result = transform(frame);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(one(result).raw.slice(6));
    expect(parsed.type).toBe("text-delta");
    expect(parsed.delta).toBe("Hello world");
  });

  it("drops on_chain_start event (not mapped)", () => {
    const frame = toSseFrame({
      event: "on_chain_start",
      name: "chain",
      run_id: "run-xyz",
      data: {},
    });
    const result = transform(frame);
    expect(result).toBeNull();
  });

  it("drops unknown event type (not mapped)", () => {
    const frame = toSseFrame({
      event: "on_unknown_event",
      name: "unknown",
      run_id: "run-xyz",
      data: {},
    });
    const result = transform(frame);
    expect(result).toBeNull();
  });
});

describe("openSweAdapter transform — adversarial robustness", () => {
  // GAP: `JSON.parse("null")` succeeds (null is valid JSON), so it does NOT
  // hit the try/catch. The very next line does `!parsed.event`, a property
  // access on `null`, which throws a TypeError OUT of the transform — exactly
  // the "a frame must never crash the stream" contract this code claims to hold.
  it("does not throw on a `data: null` frame (valid-JSON null escapes the parse try/catch)", () => {
    const transform = createOpenSweTransform();
    expect(() => transform({ raw: "data: null" })).not.toThrow();
  });

  // GAP: the readyQueue early-return ignores the incoming `frame`. When a
  // multi-frame reorder drain leaves frames queued, the next live input frames
  // are SILENTLY DROPPED (their content lost) — the queued frames are returned
  // in their place. Here three real text frames arrive after a 2-frame drain;
  // two of their text-deltas vanish.
  // GAP (NEW, iter 2): a spec-valid SSE frame may carry trailing field lines
  // (id:/retry:) AFTER the data: line. The join-stream path (event:\ndata:) uses
  // split("\n").find(startsWith "data: ") and handles this, but the create-stream
  // path — frame begins with "data: " — does `dataLine = line` (the WHOLE frame),
  // so slice(6) includes the trailing line, JSON.parse throws, and the raw
  // multi-line frame leaks through UNTRANSFORMED instead of being mapped.
  it("parses the data line of a frame that starts with `data:` but has a trailing SSE field line (id:)", () => {
    const transform = createOpenSweTransform();
    const json = JSON.stringify({
      event: "on_tool_start",
      name: "bash_execute",
      run_id: "run-id",
      data: { input: { command: "ls" } },
    });
    const result = one(transform({ raw: `data: ${json}\nid: 7` }));
    // Guard the parse so the assertion (not a thrown SyntaxError) reports the gap.
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(result.raw.slice(6));
    } catch {
      /* leaked raw multi-line frame — parsed stays {} */
    }
    expect(parsed.type).toBe("tool-input-start");
    expect(parsed.toolName).toBe("bash_execute");
  });

  // INVARIANT LOCK (NEW, iter 3): three parallel calls of the SAME
  // (run_id, toolName) whose ends ALL arrive fully reversed. Stresses the
  // reorder buffer beyond the 2-frame drain the existing tests cover: the final
  // (head-matching) end must drain all three buffered ends in a single array,
  // in START order — not arrival order.
  it("drains three reversed same-tool ends in one array, in start order (reorder beyond 2)", () => {
    const transform = createOpenSweTransform();
    const start = () =>
      toSseFrame({
        event: "on_tool_start",
        name: "bash_execute",
        run_id: "r3p",
        data: { input: {} },
      });
    const end = (output: string) =>
      toSseFrame({
        event: "on_tool_end",
        name: "bash_execute",
        run_id: "r3p",
        data: { output },
      });
    const id0 = JSON.parse(one(transform(start())).raw.slice(6)).toolCallId;
    const id1 = JSON.parse(one(transform(start())).raw.slice(6)).toolCallId;
    const id2 = JSON.parse(one(transform(start())).raw.slice(6)).toolCallId;

    // Ends arrive fully reversed: pop() pairs them to id2, id1, id0.
    expect(transform(end("first"))).toBeNull(); // → id2, buffered
    expect(transform(end("second"))).toBeNull(); // → id1, buffered
    const frames = many(transform(end("third"))); // → id0, unblocks all three
    expect(frames).toHaveLength(3);
    const ids = frames.map((f) => JSON.parse(f.raw.slice(6)).toolCallId);
    expect(ids).toEqual([id0, id1, id2]); // emitted in start order
  });

  // INVARIANT LOCK (NEW, iter 3): on_chat_model_stream with a malformed/missing
  // chunk shape must never throw. data:null, missing chunk, and array content
  // (LangChain content-block form) all flow through the `typeof content !==
  // "string"` guard → null, no property-access crash.
  it("does not throw on on_chat_model_stream with data:null, missing chunk, or array content", () => {
    const transform = createOpenSweTransform();
    const ev = (data: unknown) =>
      ({
        raw: `data: ${JSON.stringify({
          event: "on_chat_model_stream",
          name: "m",
          run_id: "r",
          data,
        })}`,
      } as { raw: string });
    expect(() => transform(ev(null))).not.toThrow();
    expect(() => transform(ev({}))).not.toThrow();
    expect(
      transform(ev({ chunk: { content: [{ type: "text", text: "hi" }] } }))
    ).toBeNull();
  });

  // NEW DEFECT (iter 4): startOrder/endBuffer are GLOBAL to the transform
  // instance, NOT per-run. on_tool_* events from independent runs (e.g. a
  // sub-agent `task` spawns child tool calls under a DIFFERENT run_id) share one
  // reorder buffer. So an unrelated run A sitting at the head of startOrder
  // BLOCKS run B's already-arrived end. The reorder buffer's purpose — keep ends
  // in start order — is only meaningful WITHIN a run; cross-run there is no
  // causal ordering, so run B's completed output must NOT wait on run A.
  it("does not block an independent run's completed end behind another run's still-open start (cross-run head-of-line)", () => {
    const transform = createOpenSweTransform();
    const start = (run: string, name: string) =>
      toSseFrame({
        event: "on_tool_start",
        name,
        run_id: run,
        data: { input: {} },
      });
    const end = (run: string, name: string, output: string) =>
      toSseFrame({
        event: "on_tool_end",
        name,
        run_id: run,
        data: { output },
      });

    transform(start("run-A", "tool_a")); // startOrder = [A--tool_a-0]
    transform(start("run-B", "tool_b")); // startOrder = [A--tool_a-0, B--tool_b-0]

    // Run B's tool finishes. It belongs to a different run than the head of
    // startOrder, so it should emit immediately — there is no ordering relation
    // between run A and run B. Currently it is buffered (returns null) and
    // re-ordered behind run A.
    const emitted = many(transform(end("run-B", "tool_b", "b-out")))
      .map((f) => JSON.parse(f.raw.slice(6)))
      .filter((p) => p.type === "tool-output-available")
      .map((p) => p.output);
    expect(emitted).toEqual(["b-out"]);
  });

  // INVARIANT LOCK (iter 5): the POSITIVE complement of iter-4's cross-run fix.
  // TWO independent runs interleave, EACH with its own out-of-order ends. Per-run
  // startOrder must (a) emit each run's ends in that run's OWN start order, and
  // (b) keep the two runs' reorder state fully isolated — run A's buffered end is
  // never drained by run B's loop (endBuffer keys carry run_id) and neither run
  // blocks the other. Distinct tool names per call so output→id pairing is exact.
  it("interleaves two runs with out-of-order ends; each emits in its own start order, neither blocks the other", () => {
    const transform = createOpenSweTransform();
    const start = (run: string, name: string) =>
      toSseFrame({
        event: "on_tool_start",
        name,
        run_id: run,
        data: { input: {} },
      });
    const end = (run: string, name: string, output: string) =>
      toSseFrame({
        event: "on_tool_end",
        name,
        run_id: run,
        data: { output },
      });
    const idOf = (r: R) => JSON.parse(one(r).raw.slice(6)).toolCallId;

    const A1 = idOf(transform(start("run-A", "a_tool1")));
    const B1 = idOf(transform(start("run-B", "b_tool1")));
    const A2 = idOf(transform(start("run-A", "a_tool2")));
    const B2 = idOf(transform(start("run-B", "b_tool2")));

    // Each run's SECOND tool ends first → buffered (out-of-order within its run).
    expect(transform(end("run-A", "a_tool2", "A2out"))).toBeNull();
    expect(transform(end("run-B", "b_tool2", "B2out"))).toBeNull();

    // run-A's first tool ends → unblocks A's drain ONLY (A1 then buffered A2),
    // and must NOT drain run-B's buffered B2 (cross-run isolation).
    const aFrames = many(transform(end("run-A", "a_tool1", "A1out"))).map((f) =>
      JSON.parse(f.raw.slice(6))
    );
    expect(aFrames.map((p) => p.toolCallId)).toEqual([A1, A2]);
    expect(aFrames.map((p) => p.output)).toEqual(["A1out", "A2out"]);

    // run-B's first tool ends → unblocks B's drain ONLY (B1 then buffered B2).
    const bFrames = many(transform(end("run-B", "b_tool1", "B1out"))).map((f) =>
      JSON.parse(f.raw.slice(6))
    );
    expect(bFrames.map((p) => p.toolCallId)).toEqual([B1, B2]);
    expect(bFrames.map((p) => p.output)).toEqual(["B1out", "B2out"]);
  });

  // INVARIANT LOCK (NEW, iter 6): on_tool_end's output is serialized via
  // `JSON.stringify({type,toolCallId,output})` at L179 — UNWRAPPED. A circular
  // reference in output (a proxied self-referencing object, or a tool that
  // returns a result containing itself) throws `TypeError: Converting circular
  // structure to JSON` OUT of the transform. The langgraph sibling has a
  // safeStringify helper for exactly this case (and the iter-1 fix added it);
  // openSwe was never given the same hardening. The transform's "never throw"
  // contract MUST apply to on_tool_end too — a bad tool result must produce a
  // tool-output-available frame with a string output, never kill the stream.
  it("ADVERSARIAL: on_tool_end with circular output must not throw — must emit a tool-output-available frame with a string output", () => {
    const transform = createOpenSweTransform();
    // Establish a paired start so the end event reaches the stringify path.
    transform(
      toSseFrame({
        event: "on_tool_start",
        name: "circ_tool",
        run_id: "r-circ-os",
        data: { input: {} },
      })
    );
    // Monkey-patch JSON.parse to revive a sentinel into a self-referencing
    // structure. JSON.parse is what the transform calls on the raw frame, so
    // whatever it returns IS what the transform sees — and what JSON.stringify
    // (L179) will then choke on.
    const originalParse = JSON.parse;
    const sentinel = "__CIRC_OS__";
    JSON.parse = (raw: string) => {
      const obj = originalParse(raw) as Record<string, unknown>;
      if (
        obj &&
        typeof obj === "object" &&
        (obj.data as Record<string, unknown> | undefined)?.output === sentinel
      ) {
        const circ: Record<string, unknown> = {
          event: obj.event,
          name: obj.name,
          run_id: obj.run_id,
          data: { output: undefined as unknown },
        };
        (circ.data as Record<string, unknown>).output = circ.data;
        return circ;
      }
      return obj;
    };
    try {
      const frame = toSseFrame({
        event: "on_tool_end",
        name: "circ_tool",
        run_id: "r-circ-os",
        data: { output: sentinel },
      });
      expect(() => transform(frame)).not.toThrow();
      const result = transform(frame);
      expect(result).not.toBeNull();
      const parsed = originalParse(
        (Array.isArray(result) ? result[0]! : result!).raw.slice(6)
      ) as Record<string, unknown>;
      expect(parsed.type).toBe("tool-output-available");
      // output must be a string, never undefined, never an object — even with
      // a circular source value.
      expect(typeof parsed.output).toBe("string");
    } finally {
      JSON.parse = originalParse;
    }
  });

  // INVARIANT LOCK (iter 5): within ONE run, three DIFFERENT tools whose ends
  // arrive in a NON-fully-reversed permutation [c, a, b] for starts a,b,c. The
  // per-run reorder must still emit strictly in start order a,b,c — the drain is
  // partial (c is buffered when a unblocks; b then unblocks c) rather than a
  // single 3-frame drain, exercising the multi-step drain path.
  it("drains a [c,a,b] arrival permutation of three different tools in start order a,b,c", () => {
    const transform = createOpenSweTransform();
    const start = (name: string) =>
      toSseFrame({
        event: "on_tool_start",
        name,
        run_id: "rperm",
        data: { input: {} },
      });
    const end = (name: string, output: string) =>
      toSseFrame({
        event: "on_tool_end",
        name,
        run_id: "rperm",
        data: { output },
      });
    const idOf = (r: R) => JSON.parse(one(r).raw.slice(6)).toolCallId;

    const a = idOf(transform(start("tool_a")));
    const b = idOf(transform(start("tool_b")));
    const c = idOf(transform(start("tool_c")));

    // c ends first → buffered (head is a).
    expect(transform(end("tool_c", "c-out"))).toBeNull();
    // a ends → emits a; b not yet buffered so c stays buffered (partial drain).
    const afterA = many(transform(end("tool_a", "a-out"))).map((f) =>
      JSON.parse(f.raw.slice(6))
    );
    expect(afterA.map((p) => p.toolCallId)).toEqual([a]);
    // b ends → emits b, then drains the still-buffered c.
    const afterB = many(transform(end("tool_b", "b-out"))).map((f) =>
      JSON.parse(f.raw.slice(6))
    );
    expect(afterB.map((p) => p.toolCallId)).toEqual([b, c]);
    expect(afterB.map((p) => p.output)).toEqual(["b-out", "c-out"]);
  });

  /*
   * WHITESPACE IS CONTENT; ONLY AN EMPTY DELTA IS DROPPED (#347).
   *
   * This case required " " to be dropped, and it is where the `.trim()` guard was introduced
   * before being mirrored into langchain and langgraph. Its argument was that a whitespace
   * delta is "functionally empty" and "pads the message" with something "the user sees as
   * nothing". True of a LEADING space; false of the one between two words — which is the case
   * a streaming model produces constantly, and which the transport cannot distinguish, because
   * position is a property of the assembled message and not of a frame.
   *
   * Reassembly is asserted first: the per-frame version of this test passed for years while
   * "Hi there" was reaching users as "Hithere".
   */
  it("THE HEADLINE: 'Hi' / ' ' / 'there' reassembles as 'Hi there', not 'Hithere'", () => {
    const transform = createOpenSweTransform();
    const deltas: string[] = [];
    for (const content of ["Hi", " ", "there"]) {
      const out = transform({
        raw: `data: ${JSON.stringify({
          event: "on_chat_model_stream",
          name: "model",
          run_id: "rjoin",
          data: { chunk: { content } },
        })}`,
      });
      if (!out) continue;
      // The openSwe transform may return one frame or several (the reorder queue), so both
      // shapes are normalised rather than assumed — an assumption here would make this test
      // depend on how many frames a chunk happens to produce.
      for (const f of Array.isArray(out) ? out : [out])
        for (const line of f.raw.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const parsed = JSON.parse(line.slice(6));
          if (parsed.type === "text-delta") deltas.push(parsed.delta);
        }
    }
    expect(deltas.join("")).toBe("Hi there");
  });

  it("a whitespace-only content SURVIVES as its own text-delta", () => {
    const transform = createOpenSweTransform();
    const result = transform({
      raw: `data: ${JSON.stringify({
        event: "on_chat_model_stream",
        name: "model",
        run_id: "rws",
        data: { chunk: { content: " " } },
      })}`,
    });
    expect(result).not.toBeNull();
    const only = Array.isArray(result) ? result[0]! : result!;
    expect(only.raw).toContain('"delta":" "');
  });

  it("an EMPTY content is still dropped — the half of the guard that was right", () => {
    // Without this, deleting the guard satisfies both cases above. The pair is what pins the
    // behaviour between "drop nothing" and "drop anything blank".
    const transform = createOpenSweTransform();
    const result = transform({
      raw: `data: ${JSON.stringify({
        event: "on_chat_model_stream",
        name: "model",
        run_id: "rempty",
        data: { chunk: { content: "" } },
      })}`,
    });
    expect(result).toBeNull();
  });

  it("does not silently drop live input frames while draining the reorder readyQueue", () => {
    const transform = createOpenSweTransform();
    const start = (name: string) =>
      toSseFrame({
        event: "on_tool_start",
        name,
        run_id: "run-r",
        data: { input: {} },
      });
    const end = (name: string) =>
      toSseFrame({
        event: "on_tool_end",
        name,
        run_id: "run-r",
        data: { output: `${name}-out` },
      });
    const text = (delta: string) =>
      toSseFrame({
        event: "on_chat_model_stream",
        name: "model",
        run_id: "run-r",
        data: { chunk: { content: delta } },
      });

    // Start three distinct tools; finish them out of order so the final end
    // unblocks a 2-frame drain that lands in readyQueue.
    transform(start("tool_a"));
    transform(start("tool_b"));
    transform(start("tool_c"));
    expect(transform(end("tool_b"))).toBeNull(); // buffered
    expect(transform(end("tool_c"))).toBeNull(); // buffered
    transform(end("tool_a")); // emits A, queues B and C into readyQueue

    // Each real text frame must produce its own text-delta; none may be eaten.
    const outputs = [text("t1"), text("t2"), text("t3")].map((f) =>
      transform(f)
    );
    const deltas = outputs
      .filter((r): r is { raw: string } => r !== null)
      .map((r) => JSON.parse(r.raw.slice(6)))
      .filter((p) => p.type === "text-delta")
      .map((p) => p.delta);
    expect(deltas).toEqual(["t1", "t2", "t3"]);
  });

  // INVARIANT LOCK (NEW, iter 2): if a misbehaving LangGraph backend (or a
  // mock / proxy / shim that strips type coercion) sends run_id as a NUMBER
  // rather than a string, the toolCallId constructor
  //   `${run_id}--${toolName}-${count}`
  // coerces it to a string for the output but KEYS the internal
  // toolCallCounters Map with the raw number. JS Map keys are by reference,
  // so the numeric 1 and string "1" are DIFFERENT keys — meaning two distinct
  // runs (one with run_id: 1 and one with run_id: "1") would maintain
  // independent counters AND the streamed toolCallIds would be different
  // ("1--tool-0" vs "1--tool-0" — visually the same!). Worse, two numeric
  // runs 1 and 2 would collide if they used string IDs of "1" and "2" in
  // some other request, because the keys don't match. The contract must be:
  // toolCallIds across N start events for the SAME (run_id, toolName) pair
  // are unique within a single run, regardless of run_id's JS type. The
  // counter must advance monotonically per (run_id, toolName) even when
  // run_id is a number.
  it("ADVERSARIAL: numeric run_id must not lose counter increments — toolCallIds stay unique across 50 sequential starts for the same numeric run", () => {
    const transform = createOpenSweTransform();
    const seen = new Set<string>();
    const counters: number[] = [];
    for (let i = 0; i < 50; i++) {
      const f = toSseFrame({
        event: "on_tool_start",
        name: "bash_execute",
        run_id: 42, // number, not string!
        data: { input: { cmd: `iter-${i}` } },
      });
      const r = transform(f);
      expect(r).not.toBeNull();
      const parsed = JSON.parse(one(r).raw.slice(6)) as Record<string, unknown>;
      const id = parsed.toolCallId as string;
      expect(seen.has(id)).toBe(false);
      seen.add(id);
      // Parse the trailing counter suffix and record its numeric value.
      const match = /-(\d+)$/.exec(id);
      expect(match).not.toBeNull();
      counters.push(Number(match![1]));
    }
    expect(seen.size).toBe(50);
    // Every counter suffix from 0 to 49 must appear exactly once — no skips,
    // no duplicates. This catches Map key-type collisions (number vs string)
    // and lost updates.
    expect(counters.sort((a, b) => a - b)).toEqual(
      Array.from({ length: 50 }, (_, i) => i)
    );
  });
});

describe("openSwe transform — counter map stability under high-volume frame stream (iter 5)", () => {
  // PROBE 2 (iter 5): the `toolCallCounters` Map in openSwe is a per-closure
  // structure keyed by `${run_id}--${toolName}` and accumulates monotonically.
  // This test feeds 1000 tool-call frames in rapid succession (alternating
  // start/end pairs across two tools in one run) and asserts:
  //   1. The transform never throws on any of the 1000 frames
  //   2. Every emitted toolCallId is unique (no collisions)
  //   3. The counter increments correctly across tool names (each tool's
  //      counter is independent)
  // If toolCallCounters grew unboundedly but lost entries, the test would
  // surface collisions; if it OOM'd, vitest would surface a hang.
  it("ADVERSARIAL: 1000 interleaved tool-call frames produce 1000 unique toolCallIds across two tools in one run", () => {
    const transform = createOpenSweTransform();
    const seen = new Set<string>();
    const countByTool = new Map<string, number>();

    for (let i = 0; i < 1000; i++) {
      const toolName = i % 2 === 0 ? "bash_execute" : "edit_file";
      const f = toSseFrame({
        event: "on_tool_start",
        name: toolName,
        run_id: "run-stress",
        data: { input: { idx: i } },
      });
      const r = transform(f);
      expect(r).not.toBeNull();
      const parsed = JSON.parse(one(r).raw.slice(6)) as Record<string, unknown>;
      const id = parsed.toolCallId as string;
      expect(seen.has(id)).toBe(false);
      seen.add(id);
      countByTool.set(toolName, (countByTool.get(toolName) ?? 0) + 1);
    }
    // All 1000 frames produced unique IDs.
    expect(seen.size).toBe(1000);
    // Each tool was hit 500 times.
    expect(countByTool.get("bash_execute")).toBe(500);
    expect(countByTool.get("edit_file")).toBe(500);

    // Spot-check the LAST few IDs — counter should reach 499 for bash and 499 for edit.
    const lastBash = Array.from(seen)
      .filter((id) => id.startsWith("run-stress--bash_execute-"))
      .map((id) => Number(id.split("-").pop()))
      .sort((a, b) => a - b);
    expect(lastBash[lastBash.length - 1]).toBe(499);
    const lastEdit = Array.from(seen)
      .filter((id) => id.startsWith("run-stress--edit_file-"))
      .map((id) => Number(id.split("-").pop()))
      .sort((a, b) => a - b);
    expect(lastEdit[lastEdit.length - 1]).toBe(499);
  });
});

import type { SseAdapter } from "../adapter-contract";

// --- rung contract conformance (moved from public-api.test.ts) -----------------------------
describe("open-swe rung — adapter contract", () => {
  it("openSweAdapter implements SseAdapter", () => {
    expectTypeOf(openSweAdapter).toMatchTypeOf<SseAdapter>();
    expectTypeOf(createOpenSweTransform).toBeFunction();
  });
});
