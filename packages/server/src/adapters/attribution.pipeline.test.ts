/**
 * FRAME ATTRIBUTION through the open-swe pipeline (issue #38).
 *
 * A sub-agent's `write_file` and the main agent's `write_file` must not render as
 * indistinguishable cards. Nothing was ever dropped — `on_tool_start`/`on_tool_end` DO fire
 * inside unregistered subgraphs with no opt-in — but `checkpoint_ns` was discarded at the
 * adapter boundary, so depth was unrecoverable downstream.
 *
 * THE VACUOUS-PASS TRAP, which is the default failure here.
 * An attribution test over a stream with no nesting passes while proving nothing: every
 * assertion about depth holds trivially when everything is depth 0 or undefined. Worse, the
 * loss happens in openSwe.ts (stage 1) rather than openSweEnrich.ts (stage 2), so a test that
 * exercised only the enrich stage would read `undefined` everywhere and still go green.
 *
 * So this file runs the REAL two-stage pipeline over a fixture that genuinely nests, and
 * pairs every positive assertion with a NEGATIVE CONTROL over the same fixture with
 * `checkpoint_ns` stripped — reproducing the pre-fix collapse on demand. If the fixture ever
 * stops nesting, the control fails rather than the positives quietly becoming meaningless.
 */
import { describe, it, expect } from "vitest";
import { openSweAdapter } from "./openSwe";
import type { SseFrame, SseMultiTransform } from "../accumulator";

const MAIN_NS = "parent_node:aaaa";
const SUB_NS = "call_sub:bbbb|sub_tool_node:cccc";
const SIBLING_NS = "call_sub:dddd|sub_tool_node:eeee";

/** One LangGraph astream_events frame. `ns === null` omits metadata entirely. */
function ev(
  event: string,
  name: string,
  runId: string,
  data: Record<string, unknown>,
  ns: string | null
): SseFrame {
  const payload: Record<string, unknown> = { event, name, run_id: runId, data };
  if (ns !== null) payload.metadata = { checkpoint_ns: ns };
  return { raw: `data: ${JSON.stringify(payload)}` };
}

/**
 * Drive the real openSwe pipeline.
 *
 * `openSweAdapter.transforms` ALREADY contains both stages — stage 1 normalizes LangGraph
 * events to AI SDK frames, stage 2 fans out the `data-*` parts. Appending a second enrich
 * stage emitted every part twice, which the GUARD test caught on the first run (4 data-file
 * parts instead of 2). Left as a comment because "add the enrich transform" is the obvious
 * wrong move for the next person reading this.
 *
 * The getter returns a FRESH array per access, so the closures are per-run — read it once.
 */
function runPipeline(frames: SseFrame[]): SseFrame[] {
  const all = openSweAdapter.transforms as unknown as SseMultiTransform[];
  let current = frames;
  for (const stage of all) {
    const next: SseFrame[] = [];
    for (const f of current) {
      const r = stage(f);
      if (r === null) continue;
      if (Array.isArray(r)) next.push(...r);
      else next.push(r);
    }
    current = next;
  }
  return current;
}

/** Every `data-file` part emitted, parsed. */
function dataFiles(frames: SseFrame[]): Record<string, unknown>[] {
  return frames
    .filter((f) => f.raw.startsWith("data: ") && f.raw.includes('"data-file"'))
    .map((f) => JSON.parse(f.raw.slice(6)).data as Record<string, unknown>);
}

/** The scenario the issue describes: main agent writes a file, so does a sub-agent. */
function nestedWriteFixture(ns: { main: string | null; sub: string | null }) {
  return [
    ev(
      "on_tool_start",
      "write_file",
      "run-1",
      { input: { file_path: "/main.ts", content: "main" } },
      ns.main
    ),
    ev(
      "on_tool_start",
      "write_file",
      "run-1",
      { input: { file_path: "/sub.ts", content: "sub" } },
      ns.sub
    ),
  ];
}

describe("frame attribution — open-swe pipeline", () => {
  it("GUARD: the fixture really does nest, and really does emit two data-file parts", () => {
    // Defeats the vacuous pass. If gating/enrichment stopped producing parts, or the fixture
    // stopped distinguishing the two writes, every assertion below would hold for free.
    const files = dataFiles(
      runPipeline(nestedWriteFixture({ main: MAIN_NS, sub: SUB_NS }))
    );
    expect(files).toHaveLength(2);
    expect(files.map((f) => f.path)).toEqual(["/main.ts", "/sub.ts"]);
  });

  it("a sub-agent's write_file is distinguishable from the main agent's", () => {
    const files = dataFiles(
      runPipeline(nestedWriteFixture({ main: MAIN_NS, sub: SUB_NS }))
    );
    const [main, sub] = files.map(
      (f) => f.attribution as Record<string, unknown>
    );

    expect(main).toBeDefined();
    expect(sub).toBeDefined();
    expect(main.depth).toBe(0);
    expect(sub.depth).toBe(1);
    // THE PROPERTY: not merely different depths, but different SCOPES — this is what lets a
    // renderer nest the card rather than only indent it.
    expect(sub.scopeId).not.toBe(main.scopeId);
    expect(sub.parentScopeId).not.toBeNull();
    expect(main.parentScopeId).toBeNull();
  });

  it("labels are uuid-free and path.length === depth + 1", () => {
    const files = dataFiles(
      runPipeline(nestedWriteFixture({ main: MAIN_NS, sub: SUB_NS }))
    );
    for (const f of files) {
      const a = f.attribution as { depth: number; path: string[] };
      expect(a.path).toHaveLength(a.depth + 1);
      for (const label of a.path) expect(label).not.toMatch(/[0-9a-f]{4,}/);
    }
    const sub = files[1].attribution as { path: string[] };
    expect(sub.path).toEqual(["call_sub", "sub_tool_node"]);
  });

  it("two concurrent sub-agents at the SAME depth get different scopeIds", () => {
    // The case a bare integer depth cannot express: rung 3 delegates to a planner AND an
    // executor. Both sit at depth 1; without distinct scopes their frames are one
    // undifferentiated pool and interleave into a single mislabelled card.
    const files = dataFiles(
      runPipeline(nestedWriteFixture({ main: SUB_NS, sub: SIBLING_NS }))
    );
    const [a, b] = files.map((f) => f.attribution as Record<string, unknown>);
    expect(a.depth).toBe(1);
    expect(b.depth).toBe(1);
    expect(a.scopeId).not.toBe(b.scopeId);
  });

  it("NEGATIVE CONTROL: with checkpoint_ns absent, the two writes collapse — today's bug", () => {
    // Same fixture, same pipeline, metadata removed. Reproduces the defect on demand. If this
    // ever starts failing, attribution is being invented from something other than the
    // namespace, and the positive tests above are no longer measuring what they claim.
    const files = dataFiles(
      runPipeline(nestedWriteFixture({ main: null, sub: null }))
    );
    expect(files).toHaveLength(2);
    expect(files[0].attribution).toBeUndefined();
    expect(files[1].attribution).toBeUndefined();
  });
});
