/**
 * The rung-owned half of this package's public surface, DERIVED FROM rungs.json.
 *
 * WHY THIS FILE EXISTS.
 * `public-api.test.ts` and `index.test.ts` assert the public surface with static named imports.
 * That is right for exports which always exist, and wrong for exports a rung owns: after
 * `pnpm eject langgraph` the rung-3 and rung-4 cards are deleted and the barrel is regenerated
 * without them, so a static `import { PlanCard } from "./index"` is a hard TYPE error and the
 * fork cannot typecheck. Measured: 3 of 5 ejected forks failed here, independently of any other
 * cause.
 *
 * The tempting fix — have `pnpm eject` rewrite these assertions — is the trap this whole issue
 * exists to remove, wearing the opposite hat: the tool built to stop hardcoded lists rotting
 * would itself maintain a hardcoded list of which assertions to delete.
 *
 * SO THE LIST IS DERIVED. rungs.json already says which files in this package a rung owns. A
 * filename maps to its export, the manifest says which rungs exist, and the assertion follows.
 * In a fork, the manifest lists fewer rungs and this test asserts a correspondingly smaller
 * surface — with no edit, because there is no list to edit.
 *
 * AND IT IS STRICTLY STRONGER THAN WHAT IT REPLACES, which is the real argument.
 * A literal list passes as long as the list matches the exports. Delete a rung's cards on main,
 * edit the list to match, and the old test goes green over a silently shrunken public API. This
 * one cannot: the manifest still claims the rung owns those files, so the export must be there.
 * It is not "same strength, less maintenance" — it catches a case the literal version cannot.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as api from "./index";

const PKG_PREFIX = "packages/react/src/";

interface Manifest {
  rungs: { id: string; owns: { ts: string[] } }[];
}
const manifest: Manifest = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "..", "rungs.json"), "utf8")
);

/**
 * Every export this package owes to a rung, as (symbol, rung) pairs.
 *
 * Derived from the manifest's `owns.ts` globs: a rung-owned `packages/react/src/Foo.tsx` means
 * the barrel must export `Foo`. Test files are skipped — they are owned too, but export nothing.
 */
const rungOwnedExports: { symbol: string; rung: string }[] = manifest.rungs.flatMap((rung) =>
  rung.owns.ts
    .filter((p) => p.startsWith(PKG_PREFIX) && !p.includes(".test."))
    .map((p) => ({
      symbol: p.slice(PKG_PREFIX.length).replace(/\.tsx?$/, ""),
      rung: rung.id,
    }))
);

describe("rung-owned public surface, derived from rungs.json", () => {
  it("finds rung-owned exports to check (guards against a vacuous pass)", () => {
    // NOT a count floor. `>= 3` was itself a full-ladder assumption and failed in a rung-1
    // fork, where the correct number of rung-owned components in this package is genuinely
    // ZERO — every card belongs to rung 3 or 4. A guard that cannot express "zero is right
    // here" fails in exactly the ejected trees it exists to protect.
    //
    // The real risk is a BROKEN DERIVATION silently yielding nothing: an unread manifest, or a
    // prefix that stopped matching. So the guard is stated over the machinery instead —
    // the manifest parsed, and every rung that owns a component here contributed one.
    expect(manifest.rungs.length).toBeGreaterThan(0);

    const rungsOwningComponentsHere = manifest.rungs.filter((r) =>
      r.owns.ts.some((p) => p.startsWith(PKG_PREFIX) && !p.includes(".test."))
    );
    for (const rung of rungsOwningComponentsHere) {
      expect(
        rungOwnedExports.filter((e) => e.rung === rung.id).length,
        `rung ${rung.id} owns a component here but derived no export — prefix or parser broken?`
      ).toBeGreaterThan(0);
    }

    // And the pairs must be real, not artefacts of a mangled glob.
    for (const { symbol, rung } of rungOwnedExports) {
      expect(symbol, `empty symbol derived for rung ${rung}`).toMatch(/^[A-Z][A-Za-z0-9]*$/);
      expect(manifest.rungs.map((r) => r.id)).toContain(rung);
    }
  });

  it.each(rungOwnedExports.map((e) => [e.symbol, e.rung]))(
    "%s is exported (owned by rung %s, which this manifest declares)",
    (symbol) => {
      // The manifest says a rung in THIS tree owns the file, so the barrel owes us the export.
      // In an ejected fork the rung is absent from the manifest, so this case is not generated
      // — the surface shrinks with the ladder, without anyone editing a list.
      expect(Object.keys(api)).toContain(symbol);
      expect((api as Record<string, unknown>)[symbol]).toBeTypeOf("function");
    }
  );

  it("exports nothing for a rung this manifest does not declare", () => {
    // The mirror assertion, and the one that makes an eject meaningful: a fork must not keep a
    // dropped rung's component alive in its public API. Checked against the full ladder rather
    // than the retained set, so it has something to say in a fork and nothing to say on main.
    const FULL_LADDER_COMPONENTS: Record<string, string> = {
      TodoCard: "deepagents",
      FileCard: "deepagents",
      SubAgentCard: "deepagents",
      PlanCard: "open-swe",
      PlanProgress: "open-swe",
    };
    const declared = new Set(manifest.rungs.map((r) => r.id));
    for (const [symbol, rung] of Object.entries(FULL_LADDER_COMPONENTS)) {
      if (declared.has(rung)) continue;
      expect(
        Object.keys(api),
        `${symbol} belongs to rung "${rung}", which this tree ejected — it must not still be exported`
      ).not.toContain(symbol);
    }
  });
});
