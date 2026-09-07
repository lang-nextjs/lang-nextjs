import { describe, expect, it } from "vitest";
import { UNSERIALIZABLE, dataFrameRaw, serialisableData } from "./frame-data";

/**
 * TESTED AT THE HELPER, NOT THROUGH THE ADAPTER, AND THAT IS A FINDING RATHER THAN A SHORTCUT.
 *
 * #971 says the fallback "fires when JSON.stringify throws — a circular reference, or a BigInt
 * — not hypothetical for an agent framework". Measured, it cannot fire through either adapter's
 * public entry: the transform reaches its payload via `JSON.parse`, so every value in `data` is
 * plain JSON, and the only constructed values are string literals and `new Date().toISOString()`.
 * The `Set`s and `Map`s in those files are lookup tables and per-run state; none reaches a frame.
 *
 * An end-to-end test would therefore have to fabricate an input the transform cannot receive,
 * which proves the fixture rather than the code. So this is where the contract is asserted, and
 * the reachability claim is recorded here instead of being quietly relied on.
 *
 * IT IS STILL WORTH FIXING. The wrong fallback is COPIED between the two adapters as a shared
 * "hardening pattern", so the next one inherits it, and both comments claim it leaves "a valid
 * frame" — which is false for all twelve `data-*` variants, every one of which requires `data`.
 */
describe("frame-data — the unserializable fallback keeps `data` (#971)", () => {
  const circular = () => {
    const o: Record<string, unknown> = { name: "loop" };
    o.self = o;
    return o;
  };

  it("a payload that cannot be stringified still yields a frame WITH a data key", () => {
    const raw = dataFrameRaw("data-plan", { id: "p1", body: circular() });
    const frame = JSON.parse(raw.slice(6)) as Record<string, unknown>;
    // The whole point: `required: ["type","data"]` holds on all twelve data-* variants.
    expect(Object.keys(frame)).toContain("data");
    expect(frame).not.toHaveProperty("error");
  });

  it("...and the SIBLING keys survive, which is what the old fallback destroyed", () => {
    const raw = dataFrameRaw("data-approval-required", {
      id: "a1",
      seq: 3,
      actionName: "request_human_help",
      status: "waiting",
      arguments: circular(),
    });
    const data = (JSON.parse(raw.slice(6)) as { data: Record<string, unknown> })
      .data;
    expect(data.id).toBe("a1");
    expect(data.seq).toBe(3);
    expect(data.actionName).toBe("request_human_help");
    expect(data.status).toBe("waiting");
    // Only the offending value degrades — this is what approval-gating.ts already does.
    expect(data.arguments).toBe(UNSERIALIZABLE);
  });

  it("a BigInt degrades the same way rather than throwing", () => {
    const out = serialisableData({ ok: 1, big: BigInt(9) });
    expect(out.ok).toBe(1);
    expect(out.big).toBe(UNSERIALIZABLE);
  });

  it("a serialisable payload is passed through untouched", () => {
    const raw = dataFrameRaw("data-todo", { id: "t1", items: [1, 2] });
    expect(raw).toBe(
      `data: ${JSON.stringify({
        type: "data-todo",
        data: { id: "t1", items: [1, 2] },
      })}`
    );
  });
});
