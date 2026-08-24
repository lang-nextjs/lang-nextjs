/**
 * SEVERABILITY — the transport core must not depend on any rung, at any hop.
 *
 * WHY THIS IS NOT A GREP.
 * Issue #17's stated close condition was:
 *
 *   grep -n 'from "./adapters/' src/*.ts   (excluding index.ts and *.test.ts)  → 0
 *
 * Apply the question that matters to any check: what would have to be true for it to pass
 * while the core still structurally depends on a rung? It has at least six answers, and
 * they are not exotic — three of them already occur in this repository:
 *
 *  1. RE-EXPORT LAUNDERING. Core imports "./adapter-contract"; that file does
 *     `export * from "./adapters/deepagents"`. Grep sees nothing; the dependency is intact
 *     one hop away. Step 2 of this very issue invited exactly this ("re-export from
 *     wherever preserves the public API").
 *  2. TYPE-ONLY LAUNDERING. Same, via `import type`. Erased at runtime, but delete the rung
 *     and tsc still breaks — so the coupling is real for every purpose that matters here.
 *  3. THE BARREL. `from "./adapters"` pulls in every rung and does NOT match the pattern
 *     `from "./adapters/` — no trailing slash.
 *  4. QUOTE STYLE. `from './adapters/x'` is invisible to a double-quote grep.
 *     adapters/deepagents.ts is single-quoted, so this file mixes both conventions.
 *  5. DYNAMIC IMPORT. `await import("./adapters/langchain")` matches nothing.
 *     handler.test.ts:1181 and :1227 already do this.
 *  6. THE EXCLUSION LIST IS THE DEFINITION. `src/*.ts` does not recurse, and "core" is
 *     defined by hand-listing filenames to skip. Adding the legitimate rung-owned entry
 *     point deepagents-handler.ts made the grep report a violation that is by design; a new
 *     core file in a subdirectory would be missed entirely.
 *
 * So the grep is a proxy. The PROPERTY is severability: delete adapters/ and the transport
 * core still stands. This test asserts that property directly by walking the transitive
 * import closure of every core module — following re-export hops, type-only imports, both
 * quote styles, barrels, and dynamic imports — and requiring that it never reaches a rung.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const SRC = __dirname;
const RUNG_DIR = join(SRC, "adapters");

/**
 * Files permitted to import a rung. This list IS the architecture: the public barrel, and
 * rung-owned convenience entry points. Everything else is core and must be severable.
 * Growing this list is a deliberate, reviewable act — which is the point.
 */
const RUNG_ENTRY_POINTS = new Set(["index.ts", "deepagents-handler.ts"]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

/** Every relative specifier in a file: static, `import type`, `export ... from`, dynamic. */
function specifiersOf(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const out: string[] = [];
  // `from "x"` / `from 'x'` — covers import, import type, export-from, export * from.
  for (const m of src.matchAll(/\bfrom\s+["']([^"']+)["']/g)) out.push(m[1]);
  // `import("x")` — dynamic, and `require("x")`.
  for (const m of src.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g))
    out.push(m[1]);
  return out.filter((s) => s.startsWith("."));
}

/** Resolve a relative specifier to a real file, mirroring TS/node resolution. */
function resolveSpec(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  for (const cand of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    // A ".js" specifier in TS source resolves to the ".ts" sibling.
    base.replace(/\.js$/, ".ts"),
  ]) {
    try {
      if (statSync(cand).isFile()) return cand;
    } catch {
      /* not this candidate */
    }
  }
  return null;
}

/** Transitive closure of relative imports reachable from `entry`. */
function closureOf(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of specifiersOf(file)) {
      const target = resolveSpec(file, spec);
      if (target && !seen.has(target)) queue.push(target);
    }
  }
  seen.delete(entry);
  return seen;
}

const isRung = (file: string) => file.startsWith(RUNG_DIR + "/");
const rel = (file: string) => relative(SRC, file);

const CORE_FILES = walk(SRC)
  .filter((f) => !f.endsWith(".test.ts"))
  .filter((f) => !isRung(f))
  .filter((f) => !f.includes("/__fixtures__/"))
  .filter((f) => !f.includes("/benchmark/"))
  .filter((f) => !RUNG_ENTRY_POINTS.has(rel(f)));

describe("transport core is severable from every rung", () => {
  it("finds core modules to check (guards against the walk silently matching nothing)", () => {
    // Without this, a broken walk makes every assertion below vacuously true — the exact
    // shape of failure this suite exists to prevent.
    expect(CORE_FILES.length).toBeGreaterThan(10);
    expect(CORE_FILES.map(rel)).toContain("handler.ts");
    expect(CORE_FILES.map(rel)).toContain("adapter-contract.ts");
  });

  it.each(["handler.ts", "adapter-contract.ts", "approval-gating.ts", "accumulator.ts"])(
    "%s reaches no rung, at any hop",
    (name) => {
      const offenders = [...closureOf(join(SRC, name))].filter(isRung).map(rel);
      expect(offenders).toEqual([]);
    }
  );

  it("NO core module reaches a rung, transitively", () => {
    const violations = CORE_FILES.flatMap((file) =>
      [...closureOf(file)].filter(isRung).map((hit) => `${rel(file)} → ${rel(hit)}`)
    );
    expect(violations).toEqual([]);
  });

  it("only the declared entry points import a rung", () => {
    // Catches a new rung-importing file being added without anyone deciding it should be
    // one. The allowlist is small on purpose.
    const importers = walk(SRC)
      .filter((f) => !f.endsWith(".test.ts") && !isRung(f))
      .filter((f) => [...closureOf(f)].some(isRung))
      .map(rel)
      .sort();
    expect(importers).toEqual([...RUNG_ENTRY_POINTS].sort());
  });

  it("no rung depends on another rung's module for the shared contract", () => {
    // The mirror of the core problem: langchain/langgraph/openSwe each imported SseAdapter
    // from ./deepagents, so ejecting the DeepAgents rung took down three siblings that had
    // nothing to do with DeepAgents. The contract now lives in core.
    const contract = join(SRC, "adapter-contract.ts");
    for (const rung of ["langchain.ts", "langgraph.ts", "openSwe.ts"]) {
      const closure = closureOf(join(RUNG_DIR, rung));
      expect(closure.has(contract)).toBe(true);
      expect([...closure].map(rel)).not.toContain("adapters/deepagents.ts");
    }
  });
});
