import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RUNGS, RUNG_SHAPES, byShape } from "@deepagents-nextjs/rungs";

/**
 * A THIRD `shape` FAILS LOUDLY AT EVERY CONSUMER (#425).
 *
 * This is the witness the discriminant census points at. Until it existed, the
 * registry recorded `shape` as a KNOWN GAP; the entry now names this file, and
 * check-discriminant-guards.mjs fails if the path stops existing — which is what
 * stops the claim being cosmetic.
 *
 * WHAT WAS WRONG. `shape` was exhaustive at the type level and unguarded at every
 * consumer. `assertNever` and the derived union catch "a value the TYPE does not
 * know"; they cannot catch "a value a CALL SITE does not handle", because an
 * if/else over a wider union still typechecks. So a third shape was
 * simultaneously:
 *
 *   given run navigation   by the sidebar's `!== "conversation"`   (absorbed)
 *   dropped entirely       by the selector's `=== "conversation"`  (excluded)
 *
 * Opposite directions, same value, nothing objecting. Both are now
 * `byShape(...)` over a `Record<RungShape, T>`, which is total by construction.
 *
 * TWO HALVES, AND THE SECOND IS THE ONE THAT COULD REGRESS.
 *
 * The REJECT half proves a new value cannot pass silently. The ACCEPT half
 * proves the conversion did not change what the two EXISTING shapes do — which
 * is the actual risk here, because this refactored live navigation. A guard that
 * makes a third shape loud while quietly moving `run` into the wrong nav group
 * would be a bad trade, and nothing about the reject cases would notice.
 *
 * THE COMPILE-TIME HALF IS NOT TESTED HERE, DELIBERATELY. A new key missing from
 * a `Record<RungShape, T>` is a tsc error, and asserting it from inside a passing
 * test suite would mean asserting that something does not compile — which vitest
 * cannot do honestly. `pnpm typecheck` is that half. What IS testable is the
 * runtime throw, which is not redundant: shapes arrive as DATA from a JSON
 * manifest a fork can edit, so a value tsc never saw can reach a call site.
 */

const THIRD = "workflow" as unknown as (typeof RUNG_SHAPES)[number];

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("@deepagents-nextjs/rungs");
});

describe("REJECT — a shape no call site handles", () => {
  it("byShape throws rather than returning undefined", () => {
    expect(() => byShape(THIRD, { conversation: 1, run: 2 })).toThrow(
      /no branch for shape "workflow"/
    );
  });

  it("  ...and the message says what to do, not just what happened", () => {
    expect(() => byShape(THIRD, { conversation: 1, run: 2 })).toThrow(
      /Add the branch here/
    );
  });

  /*
   * THE DIRECTION THAT USED TO ABSORB IT. `.filter(r => r.shape !== "conversation")`
   * silently handed a third shape run navigation. The replacement cannot: it has
   * to be told what a third shape is before it can filter on it.
   */
  it("the framework selector REFUSES a third shape instead of dropping it", async () => {
    vi.doMock("@deepagents-nextjs/rungs", async () => {
      const real = await vi.importActual<
        typeof import("@deepagents-nextjs/rungs")
      >("@deepagents-nextjs/rungs");
      return {
        ...real,
        RUNGS: [...real.RUNGS, { ...real.RUNGS[0], id: "wf", shape: THIRD }],
      };
    });
    // FRAMEWORKS is built at module scope, so the throw happens on import —
    // which is the point: there is no way to consume this module and not decide.
    await expect(import("./frameworks")).rejects.toThrow(
      /no branch for shape "workflow"/
    );
  });

  it("  ...and it is the SHAPE that fails it, not merely an unknown rung id", async () => {
    // The presence companion for the case above. An extra rung with a KNOWN
    // shape must import cleanly — otherwise the rejection above would be
    // explained by "the fixture added a rung", and would prove nothing about
    // shape at all.
    vi.doMock("@deepagents-nextjs/rungs", async () => {
      const real = await vi.importActual<
        typeof import("@deepagents-nextjs/rungs")
      >("@deepagents-nextjs/rungs");
      return {
        ...real,
        RUNGS: [
          ...real.RUNGS,
          { ...real.RUNGS[0], id: "extra", shape: "conversation" },
        ],
      };
    });
    await expect(import("./frameworks")).resolves.toBeDefined();
  });
});

describe("ACCEPT — the two shapes that exist keep their exact treatment", () => {
  it("byShape returns each branch, including falsy values", () => {
    expect(byShape("conversation", { conversation: "c", run: "r" })).toBe("c");
    expect(byShape("run", { conversation: "c", run: "r" })).toBe("r");
    // `false` and `undefined` are legitimate handler VALUES — the converted
    // filters map shapes to booleans — so a missing-branch check that tested the
    // value rather than the key would read a deliberate `false` as absent.
    expect(byShape("run", { conversation: true, run: false })).toBe(false);
    expect(byShape("run", { conversation: 1, run: undefined })).toBeUndefined();
  });

  it("the framework selector still lists exactly the conversation rungs, in order", async () => {
    const { FRAMEWORKS } = await import("./frameworks");
    const expected = [...RUNGS]
      .filter((r) => r.shape === "conversation")
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((r) => r.id);
    // Stated against the manifest rather than a hardcoded list: a literal here
    // would pass while describing a ladder this repo no longer has.
    expect(FRAMEWORKS.map((f) => f.id)).toEqual(expected);
    expect(expected.length).toBeGreaterThan(0);
  });

  it("every declared shape is still reachable through the converted branches", () => {
    // The census's own lesson: a check that never runs is worse than none. If
    // RUNG_SHAPES ever collapsed to one member, every reject case above would
    // still pass and mean nothing.
    expect(RUNG_SHAPES.length).toBeGreaterThan(1);
    for (const s of RUNG_SHAPES) {
      expect(() => byShape(s, { conversation: "c", run: "r" })).not.toThrow();
    }
  });
});

/**
 * THE WIRING, AND THE LIMIT OF WHAT IS PROVEN ABOVE.
 *
 * The cases above prove two things: that `byShape` refuses an unknown shape, and
 * that importing the framework selector propagates that refusal. They do NOT
 * drive the sidebar — `hrefFor` is not exported, no AppSidebar render test
 * exists, and building one with its providers is a separate piece of work with
 * its own risk. So the chain has a link that runtime tests do not cover.
 *
 * This closes it from the other end, at the level the gap actually lives:
 * EVERY converted consumer dispatches rather than comparing. Combined with the
 * refusal proven above, that gives the whole claim — all sites dispatch, and
 * dispatch rejects what it does not handle.
 *
 * IT IS A SOURCE ASSERTION AND THAT IS A REAL WEAKNESS, stated rather than left
 * for a reader to discover: it would not notice a NEW file comparing `.shape`
 * directly, only a regression in these two. The census
 * (scripts/check-discriminant-guards.mjs) is what watches the wider tree, and it
 * counts sites across every app. The two are complementary and neither is
 * sufficient: this one knows which files should be clean, that one knows where
 * to look.
 */
describe("the conversion is complete in the files it covers", () => {
  const files = [
    "components/shell/AppSidebar.tsx",
    "lib/frameworks.ts",
  ];

  for (const rel of files) {
    it(`${rel} compares no shape literal directly`, () => {
      const src = readFileSync(join(__dirname, "..", rel), "utf8");
      const raw = src
        .split("\n")
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => /\.shape\s*[=!]==\s*"/.test(line));
      expect(
        raw.map((r) => `${rel}:${r.n} ${r.line.trim()}`),
        "a direct comparison on .shape is exactly what a third value walks past — " +
          "route it through byShape so the compiler names this site instead"
      ).toEqual([]);
    });
  }

  it("  ...and they do dispatch — the assertion above is not satisfied by an empty file", () => {
    // The presence companion. "No raw comparisons" is trivially true of a file
    // that reads `shape` not at all, which is what a bad refactor produces.
    for (const rel of files) {
      const src = readFileSync(join(__dirname, "..", rel), "utf8");
      expect(src, `${rel} no longer dispatches on shape at all`).toMatch(/byShape\(/);
    }
  });
});
