#!/usr/bin/env node
/**
 * PKG-01: BUILD ORDER IS ENFORCED, NOT MERELY DECLARED.
 *
 * `turbo.json` says `build: { dependsOn: ["^build"] }`. Until now nothing asserted that it
 * has any effect — which is how PKG-01 was classified UNPROVEN in #36's audit: a ✓ resting
 * on a declaration nobody checked.
 *
 * WHY THIS DOES NOT READ turbo.json. A test asserting the file CONTAINS `dependsOn` would
 * assert the declaration, not the behaviour — the same defect as ADAPT-01, whose test
 * asserted its own construction and passed with the pipeline reversed. Reading the config to
 * prove the config is honoured is circular: it cannot distinguish "turbo respects this" from
 * "this string is present".
 *
 * THE TWO SIDES COME FROM DIFFERENT SOURCES, and that is the whole design:
 *
 *   EXPECTED   derived from each package.json's own `dependencies`/`devDependencies` —
 *              which packages actually depend on which, stated by the packages themselves.
 *   OBSERVED   `turbo run build --dry=json` — turbo's RESOLVED task graph, its own answer
 *              to "what must run before what", computed from turbo.json plus the workspace.
 *
 * A missing edge means turbo will not order those two builds, whatever turbo.json says.
 * Delete `^build` and every edge disappears from the observed side while the expected side
 * is untouched — so this fails, loudly, naming the pairs.
 *
 * WHAT WOULD MAKE THIS VACUOUS, and what stops it: a repo where the expected set is empty
 * would pass trivially, asserting nothing. So the count is floored — see MIN_EDGES. That is
 * the same non-vacuity guard the other checkers here carry, for the same reason: a check
 * that cannot fail on an empty subject is not a check.
 *
 * WHAT THIS DOES NOT PROVE: that turbo's executor honours its own graph. That is turbo's
 * core contract and testing it would mean timing real builds — expensive, flaky, and a test
 * of a third-party scheduler rather than of this repository's configuration. The seam here
 * is the graph; the claim is scoped to it.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { invokedAsProgram } from "./lib/is-main.mjs";
import { reportSubject } from "./lib/subject.mjs";
/** Resolved from THIS FILE, never cwd — a checker that cannot find its root reports nothing. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The floor. Chosen well below the real count (13 build tasks today) so ordinary growth does
 * not trip it, but above zero so an empty or broken enumeration cannot pass as success.
 */
export const MIN_EDGES = 6;

/**
 * The comparison key, defined ONCE. Both sides of this check build it, and an earlier draft
 * had the two spellings drift — the observed side and the verdict agreed with each other, so
 * the real run passed while the selftest failed against a third spelling. A shared function
 * makes that class of disagreement impossible rather than merely unlikely.
 */
export const edgeKey = (from, to) => `${from}\u0000${to}`;

/** Every workspace package: name -> directory, from pnpm's own workspace globs. */
function workspacePackages(root = ROOT) {
  const out = execFileSync("pnpm", ["ls", "-r", "--depth", "-1", "--json"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 << 20,
  });
  const list = JSON.parse(out);
  const map = new Map();
  for (const p of list) {
    if (!p.name || !p.path) continue;
    if (p.path === root) continue; // the workspace root is not a package we build
    map.set(p.name, p.path);
  }
  return map;
}

/**
 * EXPECTED edges, from the packages themselves: `A -> B` when A declares a dependency on
 * workspace package B and both have a `build` script. Deveps count — a build-time dependency
 * is exactly the kind that must be ordered.
 */
export function expectedEdges(pkgs, readPkgJson) {
  const buildable = new Set();
  for (const [name, dir] of pkgs) {
    const json = readPkgJson(dir);
    if (json?.scripts?.build) buildable.add(name);
  }
  const edges = [];
  for (const [name, dir] of pkgs) {
    if (!buildable.has(name)) continue;
    const json = readPkgJson(dir) ?? {};
    const deps = {
      ...(json.dependencies ?? {}),
      ...(json.devDependencies ?? {}),
    };
    for (const dep of Object.keys(deps)) {
      if (dep === name || !buildable.has(dep)) continue;
      edges.push({ from: name, to: dep });
    }
  }
  return edges;
}

/** OBSERVED edges, from turbo's resolved graph. */
export function observedEdges(dryRun) {
  const edges = new Set();
  for (const t of dryRun.tasks ?? []) {
    if (t.task !== "build") continue;
    for (const d of t.dependencies ?? []) {
      const dep = String(d).replace(/#build$/, "");
      edges.add(edgeKey(t.package, dep));
    }
  }
  return edges;
}

/**
 * The verdict, pure so the selftest can plant every failure mode without invoking turbo.
 *
 * @returns {{ok: boolean, missing: {from: string, to: string}[], problems: string[]}}
 */
export function verdict(expected, observed, { minEdges = MIN_EDGES } = {}) {
  const problems = [];
  const missing = expected.filter((e) => !observed.has(edgeKey(e.from, e.to)));

  if (expected.length < minEdges) {
    problems.push(
      `only ${expected.length} workspace build dependencies were found, expected at least ` +
        `${minEdges}. The enumeration is broken — a check over an empty subject would ` +
        `"pass" while asserting nothing.`
    );
  }
  for (const m of missing) {
    problems.push(
      `turbo will not order ${m.from} after ${m.to}, but ${m.from} depends on it. ` +
        `\`dependsOn: ["^build"]\` is declared in turbo.json and is not taking effect.`
    );
  }
  return { ok: problems.length === 0, missing, problems };
}

function main() {
  const pkgs = workspacePackages();
  const readPkgJson = (dir) => {
    const p = join(dir, "package.json");
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
  };
  const expected = expectedEdges(pkgs, readPkgJson);

  let dry;
  try {
    dry = JSON.parse(
      execFileSync("pnpm", ["exec", "turbo", "run", "build", "--dry=json"], {
        cwd: ROOT,
        encoding: "utf8",
        maxBuffer: 64 << 20,
        stdio: ["ignore", "pipe", "pipe"],
      })
    );
  } catch (err) {
    // A turbo that cannot produce a graph has told us nothing about ordering. That is a hard
    // failure, not "no edges missing" — absent subject is never a pass.
    console.error(
      `\nFAIL: could not obtain turbo's task graph.\n\n${`${err.stdout ?? ""}${
        err.stderr ?? ""
      }`
        .trim()
        .split("\n")
        .slice(-15)
        .join("\n")}\n`
    );
    process.exit(1);
  }

  const observed = observedEdges(dry);
  const { ok, problems } = verdict(expected, observed);

  console.log(
    `build order — ${expected.length} workspace dependencies, ${observed.size} ordered by turbo\n`
  );

  if (!ok) {
    console.error(
      "FAIL: turbo's build graph does not order every workspace dependency.\n"
    );
    for (const p of problems) console.error(`  · ${p}`);
    console.error(
      `\n  This is the difference between build order being DECLARED and being ENFORCED.\n` +
        `  turbo.json can say \`dependsOn\` and still order nothing.\n`
    );
    process.exit(1);
  }

  reportSubject(
    expected.length,
    "workspace build dependencies declared in package.json manifests"
  );
  console.log(
    `PASS: every one of the ${expected.length} workspace build dependencies appears as an\n` +
      `      edge in turbo's resolved graph, so a dependent cannot build before its\n` +
      `      dependency. Derived from package.json manifests and checked against turbo's own\n` +
      `      answer — neither side reads turbo.json.`
  );
}

if (invokedAsProgram(import.meta.url)) {
  main();
}
