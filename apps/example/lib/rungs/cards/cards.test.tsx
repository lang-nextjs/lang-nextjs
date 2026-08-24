/**
 * The card registry maps a stream part type to the component that renders it, for parts
 * whose renderer DIES WITH A RUNG.
 *
 * Shared cards are deliberately not in here — ApprovalCard and HumanResponseCard render
 * parts emitted by approval-gating.ts, which #30 moved into core, and filing them under a
 * rung would make `eject langgraph` delete the UI for a core feature. rungs.json's
 * `shared._rendererNote` reasons that out per card; this registry only holds the ones it
 * assigns to a rung.
 *
 * THIS FILE HAS TO PASS IN EVERY FORK, WHICH IS SHARPER THAN IT SOUNDS.
 * Two things were wrong here until a real `eject langchain` found them, and neither was
 * visible in the full repo:
 *   - `r.id === "deepagents"` is a TYPE ERROR in a rung-1 fork, where `RungId` narrows to
 *     "langchain" and TS2367 rejects the comparison as having no overlap. A test that
 *     breaks the fork's typecheck is a severability defect like any other.
 *   - asserting the registry is non-empty is WRONG in a fork that dropped every
 *     card-owning rung. Empty is the correct answer there, and demanding otherwise would
 *     have forced the registry to keep a card whose component no longer exists.
 * Both were found by ejecting and building, not by reasoning about it.
 */
import { describe, it, expect } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { RUNGS } from "@deepagents-nextjs/rungs";
import { cardRenderers, mergePacks, renderPart } from "./index";
import type { CardPack } from "./registry";

/**
 * Which parts each rung's pack contributes — the EXPECTED side of the equality below.
 *
 * A literal on purpose: deriving both sides from the registry would compare it to itself.
 * Plain strings rather than imports, so a fork that dropped these rungs still compiles;
 * the presence filter is what makes the expectation shrink with the manifest.
 */
const PARTS_BY_RUNG: Record<string, readonly string[]> = {
  deepagents: ["data-file", "data-sub-agent", "data-todo"],
  "open-swe": ["data-plan"],
};

/** String-typed, because `RungId` narrows per fork and `===` on a literal is a TS2367. */
const presentRungs = new Set(RUNGS.map((r) => String(r.id)));

describe("card registry", () => {
  it("registers exactly the parts whose rungs are present", () => {
    const expected = Object.entries(PARTS_BY_RUNG)
      .filter(([rung]) => presentRungs.has(rung))
      .flatMap(([, parts]) => parts);

    expect(Object.keys(cardRenderers()).sort()).toEqual([...expected].sort());
  });

  it("renders a part whose rung is present", () => {
    // Skipped rather than asserted in a fork without rung 3 — there is no data-todo card to
    // render there, and that is the point of the fork.
    if (!presentRungs.has("deepagents")) return;

    const node = renderPart("data-todo", {
      id: "todo-1",
      seq: 0,
      items: [{ id: "i1", text: "write the test first", status: "pending" }],
    });
    expect(node).not.toBeNull();
    const { container } = render(<>{node}</>);
    expect(container.textContent).toContain("write the test first");
    cleanup();
  });

  it("returns null for a part type no present rung claims", () => {
    // THE FORK BEHAVIOUR. After `eject langchain` every card pack is gone; a backend that
    // still emits data-todo must render nothing, not throw. A crash here would turn a
    // dropped rung into a broken page rather than a smaller one.
    expect(renderPart("data-nonexistent", {})).toBeNull();
    expect(renderPart("data-todo", {})).not.toBeUndefined();
  });

  it("throws when two packs claim the same part type", () => {
    // Last-write-wins would silently pick one rung's rendering of a part two rungs both
    // claim, and the wrong card would look like a styling bug rather than a registry bug.
    const a: CardPack = { "data-x": () => null };
    const b: CardPack = { "data-x": () => null };
    expect(() => mergePacks([a, b])).toThrow(/data-x/);
  });

  it("merges disjoint packs without complaint", () => {
    const merged = mergePacks([
      { "data-x": () => null },
      { "data-y": () => null },
    ]);
    expect(Object.keys(merged).sort()).toEqual(["data-x", "data-y"]);
  });
});
