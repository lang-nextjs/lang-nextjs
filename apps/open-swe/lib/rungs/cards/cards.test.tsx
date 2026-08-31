// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { render, cleanup } from "@testing-library/react";
import { RUNGS } from "@deepagents-nextjs/rungs";
import { cardRenderers, renderPart } from "./index";

/**
 * WHAT THIS APP'S REGISTRY CLAIMS, AND WHAT IT MUST NOT (#492).
 *
 * apps/example had this pairing and apps/open-swe did not — which is how the same change was
 * caught on one side and silent on the other. Adding `data-approval` to the packs turned the
 * example's suite red immediately and this app's not at all, and the asymmetry was the tell:
 * a registry with no assertion about its contents cannot notice gaining or losing one.
 *
 * WHY IT MATTERS HERE SPECIFICALLY. `data-approval` is emitted only by openSweEnrich, which is
 * rung-4-owned. Its renderer used to be an inline branch in app/page.tsx — a file no rung owns,
 * so ejection could not touch it. Every fork below rung 4 therefore shipped a renderer for a
 * frame it could never receive: the declaration pruned, the consumer surviving.
 *
 * Ejection cannot produce that pairing by itself, because it prunes a declaration and its
 * renderer together. Producing it requires a renderer in a file ejection does not touch, which
 * is exactly what an inline branch in a shared surface is.
 */

/**
 * The EXPECTED side, as a literal on purpose — deriving it from the registry would compare it
 * to itself. Plain strings so a fork that dropped these rungs still compiles; the presence
 * filter is what makes the expectation shrink with the manifest.
 */
const PARTS_BY_RUNG: Record<string, readonly string[]> = {
  deepagents: ["data-file", "data-sub-agent", "data-todo"],
  "open-swe": ["data-plan", "data-approval"],
};

const presentRungs = new Set(RUNGS.map((r) => String(r.id)));

describe("open-swe card registry", () => {
  it("registers exactly the parts whose rungs are present", () => {
    const expected = Object.entries(PARTS_BY_RUNG)
      .filter(([rung]) => presentRungs.has(rung))
      .flatMap(([, parts]) => parts);
    expect(Object.keys(cardRenderers()).sort()).toEqual([...expected].sort());
  });

  it("claims data-approval while rung 4 is present", () => {
    // The positive half. Asserted separately from the equality above so that a
    // failure says WHICH direction broke — a part gained, or this one lost.
    if (!presentRungs.has("open-swe")) return;
    expect(renderPart("data-approval", { actionName: "x" })).not.toBeNull();
  });

  /*
   * THE PAYLOAD'S OWN CONTENT REACHES THE DOM (#492).
   *
   * `renderPart(...) !== null` is presence-of-a-node, and the registry's parity guard reads
   * presence-of-a-reference: `"data-approval": () => null` satisfies both. Neither can tell a
   * real renderer from a stub, so neither is evidence that moving this branch preserved the
   * rendering — which is the only thing #492 changed and the only thing worth asserting.
   *
   * A value the fixture invents, asserted in the output, is what distinguishes them: a stub
   * cannot produce it, and a renderer that ignored its argument cannot either.
   */
  it("renders the approval's OWN payload, not merely a non-null node", () => {
    if (!presentRungs.has("open-swe")) return;
    const marker = "tool__unique_to_this_fixture";
    render(
      <>
        {renderPart("data-approval", {
          id: "a1",
          status: "waiting",
          actionName: marker,
        })}
      </>
    );
    expect(document.body.textContent ?? "").toContain(marker);
    cleanup();
  });

  it("renders nothing for a part no present rung claims", () => {
    // The behaviour a fork depends on: a part whose rung left renders nothing
    // rather than throwing, so the page degrades instead of breaking.
    expect(renderPart("data-nobody-claims-this", {})).toBeNull();
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
