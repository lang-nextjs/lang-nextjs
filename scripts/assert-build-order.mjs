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

/**
 * THE QUESTION COULD NOT BE ASKED — exit 2, never 1 (#842, the shape #784 named).
 *
 * This checker asks one thing: does turbo's RESOLVED graph order every workspace dependency?
 * Answering it needs two readings from the environment — the workspace package list, and the
 * task graph. If either cannot be obtained, that question was not answered, and exit 1 would
 * claim the specific positive finding "the graph does not order every dependency" on evidence
 * nobody has.
 *
 * BOTH CALLS, NOT JUST THE ONE #842 NAMED. The issue cited the turbo catch below, whose own
 * comment already got halfway there — "absent subject is never a pass" is right, and then it
 * picked the wrong one of the two remaining options. The `pnpm ls` above it had NO catch at
 * all and threw ENOENT uncaught, so node exited 1 with a stack trace before the turbo call ran.
 * Found by planting a stripped PATH rather than by reading: the trace named workspacePackages,
 * not the branch the issue was about.
 *
 * WHY THE REASON DOES NOT CHANGE THE DISPOSITION. A broken turbo.json lands here too, and that
 * is a real repo defect rather than an environment fact. It still refuses, because this checker
 * cannot tell the two apart and claiming an ordering defect it never observed would be worse
 * than declining. Nothing is let through: run-checks records exit 2 as REFUSED, which is not a
 * pass and does not go green. The underlying output is printed either way, so a reader can see
 * whether a binary was missing or a config was wrong.
 */
/**
 * What a failed SPAWN has to say for itself: whatever the process wrote before dying, or
 * the spawn error when it never started.
 */
function spawnDetail(err) {
  return (
    `${err?.stdout ?? ""}${err?.stderr ?? ""}`.trim() ||
    String(err?.message ?? err)
  );
}

/**
 * What an UNPARSEABLE READING has to say: the bytes themselves. Node's SyntaxError carries a
 * short snippet, and the snippet is usually the answer — "WARN Unsupported engine" on stdout
 * is a pnpm configuration problem, not a broken pnpm — but it is truncated and the parse error
 * is not what a reader acts on. The output is.
 */
function readDetail(out, err) {
  const text = String(out ?? "");
  return (
    `${
      err?.message ?? err
    }\n\n  what it actually printed (first 400 chars):\n  ` +
    (text.length > 400 ? `${text.slice(0, 400)}…` : text || "(nothing)")
  );
}

function refuse(what, detail) {
  console.error(
    `\nCOULD NOT CHECK: ${what}\n\n${detail
      .split("\n")
      .slice(-15)
      .join("\n")}\n\n` +
      `  Exiting 2: the question could not be asked, not answered. This is NOT a claim that\n` +
      `  the build graph is wrong — nothing about the ordering was observed.\n`
  );
  process.exit(2);
}

/** Every workspace package: name -> directory, from pnpm's own workspace globs. */
function workspacePackages(root = ROOT) {
  let out;
  try {
    out = execFileSync("pnpm", ["ls", "-r", "--depth", "-1", "--json"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 << 20,
    });
  } catch (err) {
    refuse(
      "`pnpm ls` could not be run, so the workspace package list was never obtained.",
      spawnDetail(err)
    );
  }
  /*
   * THE READ IS NOT THE SPAWN, AND THIS PARSE USED TO SIT OUTSIDE THE TRY (#851).
   *
   * `try { spawn() } catch { refuse() }` GUARDS THE PROCESS, NOT THE READING OF ITS OUTPUT.
   * A call that succeeds and returns unparseable bytes walks straight past that catch — so a
   * pnpm printing "WARN Unsupported engine" onto stdout gave exit 1 and a raw SyntaxError
   * stack, which is the code reserved for a property being VIOLATED, for a question nobody
   * managed to ask.
   *
   * The channel that found this file's other two class-B paths — "wrapped external calls" —
   * is STRUCTURALLY BLIND to it, because the call IS wrapped. That is why it was invisible
   * rather than overlooked, and why the correct pattern sitting one function away in this same
   * file did not prevent it: I restructured away from that pattern while adding a guard whose
   * whole point was that failure modes must be distinguishable.
   *
   * SPLIT RATHER THAN SHARED, AND THE REASON IS THE READER'S NEXT ACTION rather than taxonomy.
   * Both are exit 2 — the question could not be asked — but "pnpm did not run" sends someone
   * to their install and PATH, while "pnpm ran and printed this" sends them to the output,
   * where a warning polluting stdout is a configuration fix. One sentence covering both would
   * be honest and would not tell either reader where to go.
   */
  let list;
  try {
    list = JSON.parse(out);
  } catch (err) {
    refuse(
      "`pnpm ls` ran and printed something that is not JSON, so the package list could not be read.",
      readDetail(out, err)
    );
  }
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

  /*
   * THE SAME SPLIT ON THIS PATH, WHERE THE DEFECT WAS MILDER AND REAL. Spawn and parse were
   * wrapped together here, so the disposition was already right — exit 2 — and the DIAGNOSIS
   * was not: turbo printing a warning onto stdout reported as "the task graph could not be
   * obtained", which is true of a turbo that never ran and of one that ran and answered
   * unusably. Driven, not assumed: a shim making `pnpm exec turbo` exit 0 with non-JSON
   * produced exactly that sentence.
   *
   * "Absent subject is never a pass" was already right in the old note; the disposition was
   * not. Not a pass and not a failure — the third one.
   */
  let graph;
  try {
    graph = execFileSync(
      "pnpm",
      ["exec", "turbo", "run", "build", "--dry=json"],
      {
        cwd: ROOT,
        encoding: "utf8",
        maxBuffer: 64 << 20,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
  } catch (err) {
    refuse(
      "`pnpm exec turbo` could not be run, so the task graph was never obtained.",
      spawnDetail(err)
    );
  }
  let dry;
  try {
    dry = JSON.parse(graph);
  } catch (err) {
    refuse(
      "turbo ran and printed something that is not JSON, so the task graph could not be read.",
      readDetail(graph, err)
    );
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
