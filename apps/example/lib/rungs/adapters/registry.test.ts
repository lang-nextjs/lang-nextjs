/**
 * The adapter registry must agree with the manifest — in this repo AND in every fork.
 *
 * WHY THIS TEST AND NOT "the registry has three entries"
 *   A count is satisfied by a fork that kept a hardcoded table and lost the adapters behind
 *   it. The property that matters is an equality against `rungs.json`: every rung that is
 *   selectable must have an adapter, and nothing else may. After `eject langchain` the
 *   manifest names one conversation rung, so the registry must offer exactly one — and the
 *   selector built on it then offers one button instead of three that 404.
 *
 *   That is the difference between a fork that builds and a fork that works. A hardcoded
 *   table still compiles after eject; it just lies.
 */
import { describe, it, expect } from "vitest";
import { RUNGS } from "@deepagents-nextjs/rungs";
import { adapterIds, resolveAdapter, defaultRungId } from "./index";

/** Rungs a user can actually pick in this app: conversation-shaped and really here. */
const selectable = RUNGS.filter(
  (r) => r.shape === "conversation" && r.state === "implemented"
).map((r) => r.id);

describe("rung adapter registry", () => {
  it("has an entry for every selectable rung the manifest declares", () => {
    // Guard first: if the manifest yielded nothing, every assertion below is vacuous.
    expect(selectable.length).toBeGreaterThan(0);
    expect([...adapterIds()].sort()).toEqual([...selectable].sort());
  });

  it("resolves each declared id to an adapter with transforms", () => {
    for (const id of selectable) {
      const adapter = resolveAdapter(id);
      expect(adapter, `no adapter resolved for ${id}`).toBeTruthy();
      expect(Array.isArray(adapter.transforms), `${id}.transforms`).toBe(true);
    }
  });

  it("defaults to the highest-ordinal rung this build actually has", () => {
    // Highest ordinal, because a demo should open on the most capable rung present. Derived,
    // because the current default ("deepagents") is hardcoded today and would survive
    // `eject langchain` as a default pointing at a rung the fork does not contain — it would
    // build, then open on nothing. In a rung-1 fork this must be "langchain".
    const highest = RUNGS.filter(
      (r) => r.shape === "conversation" && r.state === "implemented"
    ).reduce((a, b) => (b.ordinal > a.ordinal ? b : a));
    expect(defaultRungId()).toBe(highest.id);
  });

  it("has an adapter for whatever it defaults to", () => {
    // The two could drift apart independently, and the failure would be a demo that opens on
    // a rung it cannot serve. Cheap to assert, so assert it rather than reason about it.
    expect(adapterIds()).toContain(defaultRungId());
    expect(() => resolveAdapter(defaultRungId())).not.toThrow();
  });

  it("throws on an id the manifest does not declare", () => {
    // Returning undefined would flow a handler with no adapter, which streams the backend's
    // raw wire format through unchanged — a silent wrong answer rather than a failure.
    expect(() => resolveAdapter("no-such-rung")).toThrow(/no-such-rung/);
  });
});
