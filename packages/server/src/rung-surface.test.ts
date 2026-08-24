/**
 * The rung-owned half of this package's public surface, DERIVED FROM rungs.json.
 *
 * WHY THIS FILE EXISTS.
 * index.test.ts, public-api.test.ts and readme-quickstart.test.ts assert the public surface with
 * static named imports. That is right for exports which always exist and wrong for exports a
 * rung owns: after `pnpm eject langgraph` the rung-3 and rung-4 modules are deleted and the
 * barrel is regenerated without them, so `import { deepagentsAdapter } from "./index"` is a hard
 * TYPE error and the fork cannot typecheck. Measured: this was one of two independent causes
 * that failed 3 of the 5 ejected forks.
 *
 * The tempting fix — have `pnpm eject` rewrite these assertions — is the trap this issue exists
 * to remove, inverted: the tool built to stop hardcoded lists rotting would itself maintain a
 * hardcoded list of which assertions to delete.
 *
 * HOW THE LIST IS DERIVED, and why not from filenames.
 * In packages/react a filename maps to its export (PlanCard.tsx -> PlanCard). Here it does not:
 * adapters/deepagents.ts exports `deepagentsAdapter`, openSweHeartbeat.ts exports
 * `createHeartbeatStream`. So the rung-owned SOURCE FILES are read and their exported value
 * names extracted, then the barrel is required to re-export each one. The manifest says which
 * files a rung owns; the files say what they export; neither is a list anyone maintains.
 *
 * AND IT IS STRICTLY STRONGER THAN THE LITERAL VERSION.
 * A literal list passes as long as the list matches the exports — delete a rung's adapter on
 * main, edit the list to match, and the old test goes green over a silently shrunken public API.
 * This one cannot: the manifest still claims the rung owns the file, the file still exports the
 * symbol, so the barrel must carry it.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as api from "./index";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const PKG_PREFIX = "packages/server/src/";

interface Manifest {
  rungs: { id: string; owns: { ts: string[] } }[];
}
const manifest: Manifest = JSON.parse(readFileSync(join(REPO_ROOT, "rungs.json"), "utf8"));

/**
 * Value exports declared by a module. Types and interfaces are excluded deliberately — they are
 * erased at runtime, so `Object.keys(api)` can say nothing about them.
 */
function valueExportsOf(absPath: string): string[] {
  const src = readFileSync(absPath, "utf8")
    // Strip comments so prose about an export is not mistaken for one — the same mistake that
    // made eject's first post-check flag ARCHITECT's fix as the bug it fixed.
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
  const names = new Set<string>();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1]!);
  }
  // `export { a, b as c }` — take the exported (post-`as`) name, and skip `export type { … }`.
  for (const m of src.matchAll(/^export\s+(?!type\b)\{([^}]*)\}/gm)) {
    for (const part of m[1]!.split(",")) {
      const t = part.trim();
      if (!t || t.startsWith("type ")) continue;
      names.add((t.includes(" as ") ? t.split(" as ")[1]! : t).trim());
    }
  }
  return [...names];
}

/** Every value export this package owes to a rung the manifest declares. */
const owed: { symbol: string; rung: string; file: string }[] = manifest.rungs.flatMap((rung) =>
  rung.owns.ts
    .filter((p) => p.startsWith(PKG_PREFIX) && !p.includes(".test.") && p.endsWith(".ts"))
    .filter((p) => existsSync(join(REPO_ROOT, p)))
    .flatMap((p) =>
      valueExportsOf(join(REPO_ROOT, p)).map((symbol) => ({ symbol, rung: rung.id, file: p }))
    )
);

/**
 * Rung-owned modules that are deliberately NOT re-exported from the barrel.
 *
 * An allowlist, not a fallback: an internal module has to be written down here, so a symbol
 * silently dropped from the barrel fails instead of being assumed internal.
 */
const NOT_PUBLIC: Record<string, string> = {
  // symbol -> the rung that owns it, so an entry can be skipped in a fork that ejected that rung
  // rather than reported as stale. Keyed by rung because the anti-rot check below is right on
  // main and wrong in a fork: a rung-1 fork legitimately has no langgraph symbols at all.
  //
  // createLangGraphTransform is exported by adapters/langgraph.ts, re-exported by neither
  // barrel, and imported nowhere in the repo. Its langchain counterpart, createLangchainTransform,
  // IS public — the two rungs expose their transform factory differently for no stated reason.
  // Found by this test on its first run. Listed so the suite reflects the barrel as it IS;
  // whether the asymmetry is deliberate is a packages/server question, not an eject one.
  createLangGraphTransform: "langgraph",
};

describe("rung-owned public surface, derived from rungs.json", () => {
  it("finds rung-owned exports to check (guards against a vacuous pass)", () => {
    // Without this, a manifest claiming nothing — or a glob that stopped matching, or an export
    // parser that broke — would make every assertion below trivially true over an empty list,
    // and this suite would report a serene green while checking nothing. Same guard as
    // severability.test.ts's ">10 core modules".
    // The floor is DERIVED, not a full-ladder number. `>= 5` was itself a hardcoded
    // full-ladder fact and failed in a rung-1 fork, which legitimately owns only two exports
    // here — a guard that assumes the whole ladder breaks in exactly the trees it protects.
    // The real property: every rung that owns a non-test module in this package contributes at
    // least one export.
    const rungsOwningModulesHere = manifest.rungs.filter((r) =>
      r.owns.ts.some(
        (p) =>
          p.startsWith(PKG_PREFIX) &&
          !p.includes(".test.") &&
          p.endsWith(".ts") &&
          existsSync(join(REPO_ROOT, p))
      )
    );
    expect(rungsOwningModulesHere.length).toBeGreaterThan(0);
    expect(owed.length).toBeGreaterThanOrEqual(rungsOwningModulesHere.length);
    for (const rung of rungsOwningModulesHere) {
      expect(
        owed.filter((o) => o.rung === rung.id).length,
        `rung ${rung.id} owns a module here but contributes no export — parser broken?`
      ).toBeGreaterThan(0);
    }
    for (const { symbol, rung } of owed) {
      expect(symbol, `bad symbol parsed for rung ${rung}`).toMatch(/^[A-Za-z_$][\w$]*$/);
    }
  });

  it("every NOT_PUBLIC entry is still a real rung export (anti-rot)", () => {
    // An allowlist that can go stale is C4's defect in miniature: an entry naming a symbol that
    // no longer exists sits there suppressing nothing, and no one is told. Same device as
    // severability.test.ts's PENDING_RECLASSIFICATION check — when an entry stops being needed,
    // the suite says to delete it rather than letting suppressions accumulate.
    const owedSymbols = new Set(owed.map((o) => o.symbol));
    const declared = new Set(manifest.rungs.map((r) => r.id));
    for (const [symbol, rung] of Object.entries(NOT_PUBLIC)) {
      // A fork that ejected this symbol's rung has no opinion about it — the entry is not
      // stale there, it is simply out of scope. Checking anyway would make this guard fail in
      // every fork below the symbol's rung.
      if (!declared.has(rung)) continue;
      expect(
        owedSymbols.has(symbol),
        `${symbol} is in NOT_PUBLIC but no rung-owned module exports it — delete the entry`
      ).toBe(true);
    }
  });

  it.each(owed.filter((o) => !(o.symbol in NOT_PUBLIC)).map((o) => [o.symbol, o.rung, o.file]))(
    "%s is exported from the barrel (rung %s, %s)",
    (symbol) => {
      // In an ejected fork the rung is absent from the manifest, so no case is generated for it
      // — the asserted surface shrinks with the ladder, with no list for anyone to edit.
      expect(Object.keys(api)).toContain(symbol);
    }
  );

  it("exports nothing belonging to a rung this manifest does not declare", () => {
    // The mirror assertion, and the one that gives an eject meaning: a fork must not keep a
    // dropped rung's adapter alive in its public API. Stated over the full ladder so it has
    // something to say in a fork and nothing to say on main.
    const FULL_LADDER: Record<string, string> = {
      langchainAdapter: "langchain",
      createLangchainTransform: "langchain",
      langGraphAdapter: "langgraph",
      deepagentsAdapter: "deepagents",
      createDeepAgentsHandler: "deepagents",
      openSweAdapter: "open-swe",
      createOpenSweTransform: "open-swe",
      createHeartbeatStream: "open-swe",
    };
    const declared = new Set(manifest.rungs.map((r) => r.id));
    for (const [symbol, rung] of Object.entries(FULL_LADDER)) {
      if (declared.has(rung)) continue;
      expect(
        Object.keys(api),
        `${symbol} belongs to rung "${rung}", which this tree ejected — it must not still be exported`
      ).not.toContain(symbol);
    }
  });
});
