import { describe, it, expect } from "vitest";
import {
  streamKey,
  joinDiscovered,
  openRunSession,
  advanceRunSession,
  type StreamRef,
  type RunTopology,
} from "./shape";

const ref = (
  threadId: string,
  runId: string,
  role: "root" | "child" = "child",
  label?: string
): StreamRef => ({ threadId, runId, role, label });

/**
 * These tests exist to make ONE property falsifiable: a run is a parent stream
 * plus N children discovered at runtime, and a child is joined exactly once.
 *
 * "The shell subscribes to a run" is not that property — an implementation that
 * opens exactly one stream satisfies the sentence and violates the property.
 * Several tests below are written so that a one-stream-per-run implementation
 * fails them, rather than merely not exercising them.
 */
describe("streamKey", () => {
  it("distinguishes children that share a threadId", () => {
    expect(streamKey(ref("t1", "r1"))).not.toBe(streamKey(ref("t1", "r2")));
  });

  it("distinguishes runs that share a runId across threads", () => {
    // Open SWE dispatches each child as a new run on a NEW thread, so neither
    // id alone is an identity. Keying on either one collides.
    expect(streamKey(ref("t1", "r1"))).not.toBe(streamKey(ref("t2", "r1")));
  });
});

describe("joinDiscovered — the double-join guard", () => {
  it("joins a child that was not live", () => {
    const live = [ref("t0", "r0", "root")];
    expect(joinDiscovered(live, [ref("t1", "r1")])).toHaveLength(2);
  });

  it("does not re-join a child already live, however many times it is rediscovered", () => {
    const child = ref("t1", "r1");
    let live: readonly StreamRef[] = [ref("t0", "r0", "root")];
    for (let i = 0; i < 10; i++) live = joinDiscovered(live, [child]);
    expect(live).toHaveLength(2);
  });

  it("de-duplicates WITHIN a single discovery result", () => {
    // A parent state naming the same session twice must not open two streams.
    const live = [ref("t0", "r0", "root")];
    const out = joinDiscovered(live, [ref("t1", "r1"), ref("t1", "r1")]);
    expect(out).toHaveLength(2);
  });

  it("returns the SAME reference when nothing was added", () => {
    // So a caller can use it as a subscription dependency without churning.
    const live = [ref("t0", "r0", "root"), ref("t1", "r1")];
    expect(joinDiscovered(live, [ref("t1", "r1")])).toBe(live);
  });

  it("joins MORE THAN ONE child — a run is not one stream", () => {
    // Fails outright against any implementation that caps a run at one stream.
    const live = [ref("t0", "r0", "root")];
    const out = joinDiscovered(live, [
      ref("t1", "r1", "child", "planner"),
      ref("t2", "r2", "child", "programmer"),
    ]);
    expect(out).toHaveLength(3);
    expect(out.map((s) => s.label)).toContain("planner");
    expect(out.map((s) => s.label)).toContain("programmer");
  });

  it("never displaces the root", () => {
    const root = ref("t0", "r0", "root");
    const out = joinDiscovered([root], [ref("t1", "r1"), ref("t2", "r2")]);
    expect(out[0]).toBe(root);
    expect(out.filter((s) => s.role === "root")).toHaveLength(1);
  });
});

describe("run session — children discovered at runtime, not at t=0", () => {
  /** Mirrors Open SWE: children appear in parent state as the run progresses. */
  const topology: RunTopology = {
    root: ref("t0", "r0", "root", "manager"),
    discoverChildren(parentState) {
      const s = (parentState ?? {}) as {
        plannerSession?: { threadId: string; runId: string };
        programmerSession?: { threadId: string; runId: string };
      };
      const out: StreamRef[] = [];
      if (s.plannerSession)
        out.push({ ...s.plannerSession, role: "child", label: "planner" });
      if (s.programmerSession)
        out.push({
          ...s.programmerSession,
          role: "child",
          label: "programmer",
        });
      return out;
    },
  };

  it("opens with only the root live", () => {
    const s = openRunSession(topology);
    expect(s.streams).toHaveLength(1);
    expect(s.streams[0].role).toBe("root");
  });

  it("joins each child as it materialises, and only once", () => {
    let s = openRunSession(topology);

    s = advanceRunSession(s, {}); // nothing yet
    expect(s.streams).toHaveLength(1);

    s = advanceRunSession(s, {
      plannerSession: { threadId: "t1", runId: "r1" },
    });
    expect(s.streams).toHaveLength(2);

    // Same state again — the planner must not be joined twice.
    s = advanceRunSession(s, {
      plannerSession: { threadId: "t1", runId: "r1" },
    });
    expect(s.streams).toHaveLength(2);

    s = advanceRunSession(s, {
      plannerSession: { threadId: "t1", runId: "r1" },
      programmerSession: { threadId: "t2", runId: "r2" },
    });
    expect(s.streams).toHaveLength(3);
    expect(s.streams.map((x) => x.label)).toEqual([
      "manager",
      "planner",
      "programmer",
    ]);
  });

  it("is stable across a state tick that adds nothing", () => {
    let s = openRunSession(topology);
    s = advanceRunSession(s, {
      plannerSession: { threadId: "t1", runId: "r1" },
    });
    const before = s;
    s = advanceRunSession(s, {
      plannerSession: { threadId: "t1", runId: "r1" },
    });
    expect(s).toBe(before);
  });
});
