import { describe, expect, it } from "vitest";
import { abbreviate, fact, runFacts } from "./run-identity";

/**
 * THE TECHNICAL FACTS ABOUT A RUN.
 *
 * The run page stated one of them, and stated it wrongly:
 *
 *   run {runId.slice(0, 18)}…
 *
 * `slice(0, 18)` on `run-1` returns `run-1`, and the ellipsis is appended
 * unconditionally — so a five-character id rendered as `run run-1…`, which is
 * what was reported. An ellipsis is a CLAIM that there is more; here there was
 * not, and a person copying that string takes away a character belonging to no
 * id.
 *
 * The thread id was never shown at all, though it is in the URL, required for
 * the page to function, and the first thing you need when the board and the
 * detail page disagree — which they did twice this week.
 *
 * And the line sat inside `{task && (…)}`, so a run whose task failed to load
 * showed no identifiers whatever. That is precisely the run you need to
 * identify.
 */

describe("the ellipsis must be earned", () => {
  it("A SHORT VALUE IS RETURNED WHOLE, with no marker", () => {
    // The reported bug, at the rule.
    expect(abbreviate("run-1")).toBe("run-1");
    expect(abbreviate("run-1")).not.toContain("…");
  });

  it("a long value is shortened AND marked", () => {
    const long = `run-${"x".repeat(60)}`;
    const out = abbreviate(long, 24);
    expect(out.length).toBe(25); // 24 + the marker
    expect(out.endsWith("…")).toBe(true);
  });

  it("a value exactly at the limit is not marked", () => {
    // Off-by-one at the boundary is how a marker creeps back onto values that
    // fit. `>` not `>=`.
    const exact = "x".repeat(24);
    expect(abbreviate(exact, 24)).toBe(exact);
    expect(abbreviate(`${exact}y`, 24)).toContain("…");
  });

  it("`truncated` tracks what actually happened, not the intent", () => {
    // The flag the renderer keys its marker off. If it could disagree with
    // `display`, the original bug returns by another route.
    expect(fact("Run", "run-1")!.truncated).toBe(false);
    expect(fact("Run", "r".repeat(50))!.truncated).toBe(true);
  });

  it("THE FULL VALUE SURVIVES ABBREVIATION", () => {
    // What a person copies, and what a test reads. Only the pixels shorten.
    const long = `run-${"x".repeat(60)}`;
    const f = fact("Run", long)!;
    expect(f.value).toBe(long);
    expect(f.display.length).toBeLessThan(long.length);
  });
});

describe("what is stated, and what is left out", () => {
  it("states the run AND the thread — the pair that was missing", () => {
    const labels = runFacts({ runId: "run-1", threadId: "th-1" }).map(
      (f) => f.label
    );
    expect(labels).toContain("Run");
    expect(labels).toContain("Thread");
  });

  it("AN ABSENT ID IS OMITTED, not rendered blank", () => {
    // A label above an empty value reads as "this run has no id", which is a
    // different and more alarming claim than "we do not know it yet".
    for (const missing of [undefined, "", "   "]) {
      const labels = runFacts({ runId: "run-1", threadId: missing }).map(
        (f) => f.label
      );
      expect(labels, String(missing)).not.toContain("Thread");
    }
  });

  it("the panel grows as facts arrive", () => {
    // Rendering placeholders for unknown values makes a loading page look
    // like a broken one.
    expect(runFacts({ runId: "run-1" })).toHaveLength(1);
    expect(
      runFacts({ runId: "run-1", threadId: "th-1", status: "idle" })
    ).toHaveLength(3);
  });

  it("prefers the agent REASON over the bare mode", () => {
    // `live` alone does not say which framework answered; the reason carries
    // framework/topology for a live run and the blocker for a scripted one.
    const f = runFacts({
      runId: "r",
      agentMode: "live",
      agentReason: "deepagents/react",
    }).find((x) => x.label === "Agent");
    expect(f?.value).toBe("deepagents/react");
  });

  it("falls back to the mode when there is no reason", () => {
    const f = runFacts({ runId: "r", agentMode: "canned" }).find(
      (x) => x.label === "Agent"
    );
    expect(f?.value).toBe("canned");
  });

  it("says nothing about the agent when nothing is known", () => {
    expect(runFacts({ runId: "r" }).some((f) => f.label === "Agent")).toBe(
      false
    );
  });

  it("survives non-string junk without throwing", () => {
    // These come from a network payload and a URL param.
    for (const junk of [null, 42, {}, []] as unknown[]) {
      expect(() => runFacts({ runId: junk as string })).not.toThrow();
      expect(runFacts({ runId: junk as string })).toEqual([]);
    }
  });
});
