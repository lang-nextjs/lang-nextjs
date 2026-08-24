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
 * core still stands.
 *
 * >>> AND THIS FILE HAD ITS OWN VERSION OF THE SAME MISTAKE (issue #17b). <<<
 * `CORE_FILES` below filters out `*.test.ts`. That proved the SOURCE severable and said
 * nothing whatever about the TESTS — so eleven core transport tests went on importing
 * `deepagents-handler`, the rung-3 wrapper, and `eject langchain` produced a fork whose core
 * transport had ZERO working tests while every check here stayed green. Proving a property of
 * the source is not proving it of the build. The manifest-driven suite at the bottom of this
 * file closes that, and it derives ownership from rungs.json rather than from a hardcoded
 * directory heuristic, so the two cannot drift apart. This test asserts that property directly by walking the transitive
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

/**
 * Every relative specifier in a file: static, `import type`, `export ... from`, dynamic.
 *
 * Comments are stripped first. This file's own header quotes `from "./adapters/…"` as PROSE
 * while explaining the pattern, and without stripping, the walker matched its own
 * documentation and reported six phantom violations against itself. A scanner that cannot
 * tell code from a comment about code will keep finding bugs in its own explanation.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")   // block comments
    .replace(/^\s*\/\/.*$/gm, "");       // whole-line comments (leaves URLs in strings alone)
}

function specifiersOf(file: string): string[] {
  const src = stripComments(readFileSync(file, "utf8"));
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

// ---------------------------------------------------------------------------
// MANIFEST-DRIVEN SEVERABILITY — covers TEST files, which the suite above excludes.
//
// Ownership comes from rungs.json, not from a path heuristic: `deepagents` owns
// `deepagents-handler.ts` and `open-swe` owns `adapters/openSwe.ts`, and only the manifest
// knows that. A hardcoded `adapters/` rule would have missed `deepagents-handler.ts` entirely
// — it sits in src/, not adapters/ — which is precisely the file the eleven tests imported.
// ---------------------------------------------------------------------------
import { existsSync } from "node:fs";

const REPO_ROOT = resolve(SRC, "..", "..", "..");
const MANIFEST = join(REPO_ROOT, "rungs.json");

/**
 * Files that are STILL rung-coupled and awaiting a rungs.json ownership change, which lives
 * outside packages/server and so outside this fix's scope.
 *
 * Both are open-swe end-to-end tests misfiled as `shared` — `stream-transform.test.ts`
 * declares itself "transformSseStream + openSweAdapter (end-to-end)" and
 * `attribution.pipeline.test.ts` drives the openSwe two-stage pipeline. They are not broken
 * tests; they are correctly-written RUNG tests that the manifest has not claimed. The fix is
 * to add them to open-swe's `owns.ts` so eject carries them along with the adapter they test.
 *
 * This list is load-bearing, not a mute button: the test below asserts every entry is
 * CURRENTLY a real violation, so once the manifest claims them the entry goes stale and this
 * suite tells you to delete it. An exception that has silently stopped applying is how a
 * suppression list rots into a lie.
 */
/**
 * The public barrel and the tests OF that barrel.
 *
 * `index.ts` re-exports every rung adapter by design — that is what a package front door is —
 * and `index.test.ts` / `public-api.test.ts` / `readme-quickstart.test.ts` assert the shape of
 * that full surface. `adapters/index.ts` is the same thing one level down. They are
 * legitimately rung-aware rather than accidentally rung-coupled, which is why the original
 * suite already allowlists `index.ts` via RUNG_ENTRY_POINTS.
 *
 * NOTE FOR EJECT (flagged to DEV6, not fixable here): eject must REGENERATE the barrel for
 * the surviving rungs, and these three tests assert against the full-ladder surface, so they
 * need regenerating or pruning too. Allowlisting them here records that they are out of scope
 * for the import-graph property — it does not claim eject handles them.
 */
const BARREL_SURFACE = new Set([
  "index.ts",
  "adapters/index.ts",
  "index.test.ts",
  "public-api.test.ts",
  "readme-quickstart.test.ts",
]);

const PENDING_RECLASSIFICATION = new Set([
  "stream-transform.test.ts",
  "adapters/attribution.pipeline.test.ts",
]);

/** Expand a manifest glob to the files it matches. Handles literals, `*` and `**`. */
function manifestMatches(glob: string, allRepoRelative: string[]): string[] {
  if (!glob.includes("*")) return allRepoRelative.filter((f) => f === glob);
  const rx = new RegExp(
    "^" +
      glob
        .split("**")
        .map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
        .join(".*") +
      "$"
  );
  return allRepoRelative.filter((f) => rx.test(f));
}

describe("severability of the TESTS, driven by rungs.json", () => {
  const manifestPresent = existsSync(MANIFEST);

  it("the manifest is readable and claims rung-owned files inside packages/server", () => {
    // C1-style guard: without this, a missing or restructured manifest makes every assertion
    // below vacuously true — the exact failure this whole file exists to prevent.
    expect(manifestPresent).toBe(true);
    const owned = rungOwnedFiles();
    expect(owned.size).toBeGreaterThan(5);
    // The two that actually caused #17b. If the manifest stops claiming these, the property
    // being tested has changed and someone must say so deliberately.
    expect([...owned].map(rel)).toContain("deepagents-handler.ts");
    expect([...owned].map(rel)).toContain("adapters/openSwe.ts");
  });

  /** Absolute paths of every file under packages/server/src that a rung OWNS. */
  function rungOwnedFiles(): Set<string> {
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
      rungs: { id: string; owns?: { ts?: string[] } }[];
    };
    const allRepoRelative = walk(SRC).map((f) => relative(REPO_ROOT, f));
    const owned = new Set<string>();
    for (const rung of manifest.rungs) {
      for (const glob of rung.owns?.ts ?? []) {
        for (const hit of manifestMatches(glob, allRepoRelative)) {
          owned.add(join(REPO_ROOT, hit));
        }
      }
    }
    return owned;
  }

  it("no SHARED file — test files included — reaches a rung-owned file", () => {
    const owned = rungOwnedFiles();
    const shared = walk(SRC).filter((f) => !owned.has(f));

    // Guard: the walk must actually find the migrated tests, or this proves nothing.
    expect(shared.map(rel)).toContain("handler.test.ts");
    expect(shared.length).toBeGreaterThan(20);

    const violations: string[] = [];
    for (const file of shared) {
      if (PENDING_RECLASSIFICATION.has(rel(file))) continue;
      if (BARREL_SURFACE.has(rel(file))) continue;
      for (const hit of closureOf(file)) {
        if (owned.has(hit)) violations.push(`${rel(file)} → ${rel(hit)}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("every PENDING_RECLASSIFICATION entry is still a real violation", () => {
    // Anti-rot. When the manifest claims one of these, it stops violating and this fails,
    // telling you to remove the entry rather than letting a stale suppression accumulate.
    const owned = rungOwnedFiles();
    for (const relPath of PENDING_RECLASSIFICATION) {
      const abs = join(SRC, relPath);
      const reaches = [...closureOf(abs)].some((hit) => owned.has(hit));
      expect(reaches, `${relPath} no longer reaches a rung — delete it from PENDING_RECLASSIFICATION`).toBe(true);
    }
  });
});
