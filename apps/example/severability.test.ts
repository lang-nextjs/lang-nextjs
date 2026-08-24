/**
 * apps/example is classified `shared` in rungs.json — a claim that nothing rung-specific
 * depends on it. This file is the check that the claim is true.
 *
 * THE PROPERTY
 *   A file under apps/example may import a rung-owned symbol only if that file is ITSELF
 *   owned by a rung that would still be present when the symbol is — i.e. the symbol's rung
 *   is in the file's own rung's `requires` closure. A SHARED file may import none at all.
 *
 *   "No rung-owned symbols anywhere under apps/example" would be the easier rule and it is
 *   the wrong one: it forbids the very leaf modules that make the app severable. A rung-3
 *   leaf importing `TodoCard` is correct — eject deletes the leaf and the card together. The
 *   same import from a shared file is the bug. The distinction is the whole design, so the
 *   check has to encode it rather than round it off.
 *
 *   The closure matters in the other direction too: a rung-3 leaf importing a rung-4 symbol
 *   passes a naive same-file-is-owned check and still breaks `eject deepagents`, because
 *   rung 3 survives and rung 4 does not.
 *
 * WHY THE OBVIOUS CHECK IS A PROXY
 *   `pnpm eject <rung>` exits 0 and reports "no dangling imports" while apps/example is
 *   broken, because eject's leak check covers dangling RELATIVE imports and config
 *   references to deleted apps. It does not cover importing a name that eject pruned out of
 *   a workspace BARREL — which is 100% of how apps/example breaks. "eject succeeded" and
 *   "example#build failed" were both true simultaneously for exactly this reason.
 *   So the check has to be written against the import graph, not against eject's exit code.
 *
 * WHAT WOULD HAVE TO BE TRUE FOR THIS TO PASS WHILE THE PROPERTY IS VIOLATED
 *   Every answer to that question is a guard below, because each one is a way for this file
 *   to go green while meaning nothing:
 *     - the owned-symbol census comes back empty (bad glob, moved file, wrong root)
 *     - the file walk finds nothing, or finds only .ts and misses page.tsx
 *     - the symbol extractor matches inside a comment, inflating the census with names like
 *       `POST` so the census looks healthy while the real symbols are missing
 *   A census that is silently empty makes the main assertion vacuously true. That failure
 *   mode is not hypothetical: it is C1/C4 in scripts/classify.mjs, which exist because it
 *   already happened here.
 *
 * FORK-SAFE BY CONSTRUCTION
 *   Everything is derived from whatever rungs.json says NOW. In a rung-1 fork the census is
 *   just rung 1's symbols and the assertions still mean something, so this file keeps
 *   working in the forks it exists to protect. Nothing here names a rung.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const ROOT = resolve(__dirname, "..", "..");

/**
 * Copied from scripts/classify.mjs rather than re-invented. A second glob dialect would
 * drift from the classifier's, and the drift would show up as this test disagreeing with
 * CI about which files a rung owns — silently, and in the direction of passing.
 */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:[^/]+/)*";
        } else re += ".+";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/**
 * Prose about an import is not an import. Without this, a doc comment reading
 * `export const POST = createDeepAgentsHandler(...)` puts `POST` in the census, and then
 * every Next.js route file looks like it depends on a rung.
 */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

/**
 * Files in the WORKING TREE — tracked plus untracked-and-not-ignored.
 *
 * `git ls-files` alone reads the index, and that is a real hole rather than a nicety: this
 * test went green while four brand-new files under apps/example imported rung-owned symbols,
 * purely because they had not been `git add`ed yet. A check that cannot see the file it is
 * about is the same failure as a glob that matches nothing — it reports clean about a
 * subject it never looked at.
 *
 * `--others --exclude-standard` adds untracked files while still honouring .gitignore, so
 * node_modules and .next stay out.
 */
const trackedFiles = (): string[] =>
  execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 }
  )
    .split("\0")
    .filter(Boolean)
    // eject deletes from the worktree without committing, so the index still lists files
    // that are gone. Post-eject those must not count as owned, or a fork's census is wrong.
    .filter((f) => existsSync(join(ROOT, f)));

type Manifest = {
  rungs: { id: string; requires?: string[]; owns: { ts?: string[] } }[];
};

const manifest: Manifest = JSON.parse(
  readFileSync(join(ROOT, "rungs.json"), "utf8")
);

const EXPORT_RE =
  /export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z0-9_$]+)|export\s+(?:type|interface)\s+([A-Za-z0-9_$]+)/g;

/** symbol -> owning rung id, for every symbol a rung-owned module exports. */
function ownedSymbols(files: string[]): Map<string, string> {
  const owned = new Map<string, string>();
  for (const rung of manifest.rungs) {
    const res = (rung.owns.ts ?? []).map(globToRegExp);
    for (const f of files) {
      if (!/^packages\/(react|server)\/src\/.*\.tsx?$/.test(f)) continue;
      if (/\.test\.tsx?$/.test(f)) continue;
      if (!res.some((re) => re.test(f))) continue;
      const src = stripComments(readFileSync(join(ROOT, f), "utf8"));
      for (const m of src.matchAll(EXPORT_RE)) owned.set(m[1] ?? m[2], rung.id);
    }
  }
  return owned;
}

const IMPORT_RE = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;

/** Every named import binding in a file, with `type` and `as` stripped. */
function importedNames(src: string): string[] {
  const names: string[] = [];
  for (const m of stripComments(src).matchAll(IMPORT_RE)) {
    for (const raw of m[1].split(",")) {
      const n = raw
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)[0]
        .trim();
      if (n) names.push(n);
    }
  }
  return names;
}

const tracked = trackedFiles();
const exampleSources = tracked.filter((f) =>
  /^apps\/example\/.*\.tsx?$/.test(f)
);
const census = ownedSymbols(tracked);

/** Which rung, if any, claims a given apps/example file. Absent = shared. */
const exampleFileOwner = new Map<string, string>();
for (const rung of manifest.rungs) {
  const res = (rung.owns.ts ?? []).map(globToRegExp);
  for (const f of exampleSources) {
    if (res.some((re) => re.test(f))) exampleFileOwner.set(f, rung.id);
  }
}

/** A rung plus everything it requires — the set that survives whenever it does. */
function requiresClosure(id: string): Set<string> {
  const byId = new Map(manifest.rungs.map((r) => [r.id, r]));
  const out = new Set<string>();
  const walk = (x: string) => {
    if (out.has(x)) return;
    out.add(x);
    for (const dep of byId.get(x)?.requires ?? []) walk(dep);
  };
  walk(id);
  return out;
}

describe("apps/example is severable from every rung", () => {
  // --- guards: without these, the assertion below can pass by measuring nothing ----------
  it("found a real tree to scan", () => {
    // A broken walk makes every check below vacuously true, so it is a failure, not a pass.
    expect(tracked.length).toBeGreaterThan(100);
    expect(exampleSources.length).toBeGreaterThan(0);
  });

  it("scans .tsx, not just .ts", () => {
    // page.tsx holds the card rendering. A scan that missed .tsx would report a clean app
    // while the single largest violation sat in the file it skipped.
    expect(exampleSources.some((f) => f.endsWith(".tsx"))).toBe(true);
  });

  it("built a non-empty owned-symbol census", () => {
    expect(census.size).toBeGreaterThan(0);
  });

  it("credits every rung that owns TS modules with at least one symbol", () => {
    // C4's rule, applied to symbols: a rung whose owned modules yield zero exports means the
    // extractor silently stopped working for that rung, and every import of its symbols
    // would then read as clean. Derived from the manifest, so a fork checks only its own
    // rungs and this stays true after eject.
    const rungsWithModules = manifest.rungs
      .filter((r) =>
        (r.owns.ts ?? []).some((g) => {
          const re = globToRegExp(g);
          return tracked.some(
            (f) =>
              re.test(f) &&
              /^packages\/(react|server)\/src\/.*\.tsx?$/.test(f) &&
              !/\.test\.tsx?$/.test(f)
          );
        })
      )
      .map((r) => r.id);

    const credited = new Set(census.values());
    expect(rungsWithModules.length).toBeGreaterThan(0);
    for (const id of rungsWithModules) expect(credited).toContain(id);
  });

  // --- the property ----------------------------------------------------------------------
  it("imports a rung-owned symbol only from a file that dies with it", () => {
    const violations: string[] = [];
    for (const f of exampleSources) {
      const fileRung = exampleFileOwner.get(f) ?? null;
      // A shared file survives every eject, so NOTHING rung-owned is reachable from it.
      // A rung-owned leaf survives exactly when its rung does, and its `requires` closure
      // survives alongside it — so those symbols, and only those, are reachable.
      const reachable = fileRung
        ? requiresClosure(fileRung)
        : new Set<string>();
      for (const name of importedNames(readFileSync(join(ROOT, f), "utf8"))) {
        const symbolRung = census.get(name);
        if (!symbolRung || reachable.has(symbolRung)) continue;
        violations.push(
          fileRung
            ? `${f} (rung ${fileRung}) imports ${name} (rung ${symbolRung}) — outlives its dependency`
            : `${f} (shared) imports ${name} (rung ${symbolRung})`
        );
      }
    }
    expect(violations).toEqual([]);
  });
});
