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
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
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
  // `data-approval` joined rung 4 in #492: its emitter is openSweEnrich, which is
  // rung-4-owned, while the ApprovalCard that renders it stays shared. Ownership is per
  // PART TYPE, not per card — reasoning per card is what left the branch inline while its
  // emitter was pruned.
  "open-swe": ["data-plan", "data-approval"],
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

  /*
   * THE PAYLOAD'S OWN CONTENT REACHES THE DOM, AND THE CONTEXT IS WIRED (#492).
   *
   * `data-approval` moved out of this surface's inline branch and into rung 4's pack. Two
   * things had to survive that move and neither is implied by the registry's parity guard,
   * which reads presence-of-a-reference and cannot tell `() => null` from a renderer: the
   * card must still show its own payload, and its decisions must still continue the
   * conversation — the behaviour that lived in a closure the pack cannot see.
   */
  it("renders the approval's own payload and wires its decisions", () => {
    if (!presentRungs.has("open-swe")) return;
    const marker = "tool__unique_to_this_fixture";
    const sent: string[] = [];
    render(
      <>
        {renderPart(
          "data-approval",
          { id: "a1", status: "waiting", actionName: marker },
          { sendMessage: (t: string) => sent.push(t) }
        )}
      </>
    );
    expect(document.body.textContent ?? "").toContain(marker);

    // The handler, exercised rather than assumed present: a card rendered inert
    // would pass the content assertion above and silently drop the interaction.
    const approve = document.querySelector<HTMLButtonElement>(
      'button[data-testid="approve-button"]'
    );
    expect(approve, "no approve control rendered").not.toBeNull();
    approve!.click();
    expect(sent).toEqual([`Approved: ${marker}`]);
    cleanup();
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

/**
 * NO PACK MAY IMPORT A RUNTIME VALUE FROM THE REGISTRY (#492).
 *
 * `registry.tsx` re-exports the packs, so anything a pack imports BACK from it is a cycle.
 * That cycle was harmless while every pack touched `CARD` only inside a renderer body, where
 * evaluation is deferred — and the first module-level use of it broke Next's production build
 * with "Cannot access 'w' before initialization", a minified temporal-dead-zone error on a
 * page whose source had not changed.
 *
 * NO SUITE IN THIS REPO COULD SEE IT. Vitest resolves modules through its own transform and
 * never runs a production export; typecheck sees types, not evaluation order. So this asserts
 * the STRUCTURE that made the build fail rather than waiting for the build to fail again — a
 * two-minute bundle is not a feedback loop.
 *
 * THE PACKS ARE DISCOVERED, NOT NAMED, AND THE FIRST VERSION OF THIS GUARD GOT THAT WRONG.
 * It read `deepagents.tsx` and `open-swe.tsx` from disk by name. Those files are RUNG-OWNED
 * and this test file is not, so in a rung-1/2/3 fork they are pruned, the readFileSync throws,
 * and three eject cells go red — a check in a shared file asserting about rung-owned files,
 * outliving its own subject. That is the defect this very PR exists to fix, reproduced inside
 * the fix for it. Iterating what is PRESENT is correct in every configuration: in a fork with
 * no packs there is nothing that can cycle, and the guard has nothing to say.
 *
 * Type-only imports are fine and are why this checks the form rather than the module: they
 * erase, so they create no edge at runtime.
 */
describe("the card packs cannot cycle through the registry", () => {
  /**
   * Which rung owns which pack. Same shape as PARTS_BY_RUNG above and for the same reason:
   * a literal, filtered by what the manifest says is present, so the expectation SHRINKS with
   * a fork instead of demanding files that were correctly deleted.
   */
  const PACK_BY_RUNG: Record<string, string> = {
    deepagents: "deepagents.tsx",
    "open-swe": "open-swe.tsx",
  };

  /** Everything in the cards directory that is a pack: not the plumbing, not this file. */
  const NOT_A_PACK = /^(registry|index|card-class|cards\.test)\./;
  const discovered = readdirSync(__dirname)
    .filter((f) => /\.tsx?$/.test(f) && !NOT_A_PACK.test(f))
    .sort();

  /*
   * THE FLOOR, for the reason an empty directory would otherwise pass: iterating nothing
   * proves nothing, and this guard would go quiet in exactly the configuration where someone
   * might add a pack back. Derived from the manifest rather than asserted flat, so it is a
   * real expectation on the full tree and silent in a fork that legitimately has no packs.
   */
  it("every present rung's pack is on disk", () => {
    const expected = Object.entries(PACK_BY_RUNG)
      .filter(([rung]) => presentRungs.has(rung))
      .map(([, file]) => file)
      .sort();
    expect(
      expected.filter((f) => !discovered.includes(f)),
      "a rung is present but its card pack is missing — the fork is inconsistent, or this map is stale"
    ).toEqual([]);
  });

  it("no discovered pack belongs to an absent rung", () => {
    // The other direction: a pack that survived an eject its rung did not is the same class
    // of defect as the one this PR fixes, one file over.
    const orphans = discovered.filter((f) => {
      const rung = Object.entries(PACK_BY_RUNG).find(
        ([, file]) => file === f
      )?.[0];
      return rung !== undefined && !presentRungs.has(rung);
    });
    expect(orphans, "a card pack outlived its rung").toEqual([]);
  });

  for (const f of discovered) {
    it(`${f} imports no runtime value from ./registry`, () => {
      const src = readFileSync(join(__dirname, f), "utf-8");
      const offending = [
        ...src.matchAll(/^import\s+(?!type\b)([^;]*?)from\s+"\.\/registry"/gm),
      ].map((m) => m[0].replace(/\s+/g, " "));
      expect(
        offending,
        `${f} imports a value from ./registry, which re-exports this pack — that is a cycle, ` +
          `and the first module-level use of the imported binding will fail the production ` +
          `build in a way no test here can see. Import values from a leaf instead.`
      ).toEqual([]);
    });
  }
});
