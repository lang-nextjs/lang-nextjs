import { describe, it, expect } from "vitest";
import { RUNGS } from "@deepagents-nextjs/rungs";
import {
  FRAMEWORKS,
  DEFAULT_FRAMEWORK,
  RUNTIME,
  isKnownFramework,
  labelFor,
  topologiesFor,
} from "./frameworks";

/**
 * These assert the DERIVATION, not a copy of today's manifest.
 *
 * Pinning the literal list — ["langchain","langgraph","deepagents"] — would
 * rebuild the second list this module exists to delete: the test would then
 * have to be edited whenever the ladder changed, which is exactly the
 * maintenance the manifest is supposed to absorb. So each case states a
 * PROPERTY that must hold for whatever the manifest says, and only the two
 * cases about ladder ORDER name rungs, because order is the claim being made.
 */
describe("FRAMEWORKS — derived from the manifest", () => {
  it("contains exactly the conversation-shaped rungs", () => {
    const expected = RUNGS.filter((r) => r.shape === "conversation").map(
      (r) => r.id
    );
    expect(FRAMEWORKS.map((f) => f.id).sort()).toEqual(expected.sort());
  });

  it("excludes run-shaped rungs — open-swe is not a chat framework", () => {
    const runIds = RUNGS.filter((r) => r.shape === "run").map((r) => r.id);
    expect(runIds.length).toBeGreaterThan(0); // the case is not vacuous
    for (const id of runIds) {
      expect(FRAMEWORKS.some((f) => f.id === id)).toBe(false);
    }
  });

  it("is ordered by ordinal — simple to complex, which is the ladder", () => {
    const ordinalOf = new Map<string, number>(
      RUNGS.map((r) => [r.id as string, r.ordinal])
    );
    const ordinals = FRAMEWORKS.map((f) => ordinalOf.get(f.id)!);
    expect(ordinals).toEqual([...ordinals].sort((a, b) => a - b));
  });

  it("puts langchain before langgraph before deepagents", () => {
    // The one case that names rungs, because THIS is the reported bug: the
    // hardcoded array read langgraph, langchain, deepagents.
    const ids = FRAMEWORKS.map((f) => f.id);
    expect(ids.indexOf("langchain")).toBeLessThan(ids.indexOf("langgraph"));
    expect(ids.indexOf("langgraph")).toBeLessThan(ids.indexOf("deepagents"));
  });

  it("defaults to the first rung on the ladder", () => {
    expect(DEFAULT_FRAMEWORK).toBe(FRAMEWORKS[0].id);
  });

  it("labels every framework with something non-empty", () => {
    for (const f of FRAMEWORKS)
      expect(f.label.trim().length).toBeGreaterThan(0);
  });
});

describe("isKnownFramework", () => {
  it("accepts every derived framework", () => {
    for (const f of FRAMEWORKS) expect(isKnownFramework(f.id)).toBe(true);
  });

  it("rejects null, empty and unknown ids", () => {
    expect(isKnownFramework(null)).toBe(false);
    expect(isKnownFramework(undefined)).toBe(false);
    expect(isKnownFramework("")).toBe(false);
    expect(isKnownFramework("not-a-rung")).toBe(false);
  });

  it("rejects a run-shaped rung — a real id that is still not a framework", () => {
    expect(isKnownFramework("open-swe")).toBe(false);
  });
});

describe("topologiesFor", () => {
  it("returns what the manifest declares for the active runtime", () => {
    for (const f of FRAMEWORKS) {
      const declared = RUNGS.find((r) => r.id === f.id)?.runtimes?.[RUNTIME]
        ?.topologies;
      if (declared && declared.length > 0) {
        expect([...topologiesFor(f.id)]).toEqual([...declared]);
      }
    }
  });

  it("offers deep-research only where the manifest declares it", () => {
    // The bug the `deepagentsOnly` flag encoded: it was right about fastapi and
    // would have been wrong the moment another pair gained the topology.
    for (const f of FRAMEWORKS) {
      const declared =
        RUNGS.find((r) => r.id === f.id)?.runtimes?.[RUNTIME]?.topologies ?? [];
      expect(topologiesFor(f.id).includes("deep-research")).toBe(
        declared.includes("deep-research")
      );
    }
  });

  it("at least one framework declares deep-research — the case is not vacuous", () => {
    expect(
      FRAMEWORKS.some((f) => topologiesFor(f.id).includes("deep-research"))
    ).toBe(true);
  });

  it("at least one framework does NOT — so filtering is observable", () => {
    expect(
      FRAMEWORKS.some((f) => !topologiesFor(f.id).includes("deep-research"))
    ).toBe(true);
  });

  it("never returns an empty axis, even for an unknown rung", () => {
    expect(topologiesFor("no-such-rung")).toEqual(["react"]);
    for (const f of FRAMEWORKS)
      expect(topologiesFor(f.id).length).toBeGreaterThan(0);
  });
});

describe("labelFor", () => {
  it("names the three known topologies", () => {
    expect(labelFor("react").label).toBe("ReAct");
    expect(labelFor("plan-execute").label).toBe("Plan-Execute");
    expect(labelFor("deep-research").label).toBe("DeepResearch");
  });

  it("falls back to the id rather than rendering nothing", () => {
    // A topology the manifest gains before this map does must still appear:
    // a copy gap is a smaller failure than silently hiding a real capability.
    expect(labelFor("brand-new-topology")).toEqual({
      label: "brand-new-topology",
      title: "brand-new-topology",
    });
  });
});
