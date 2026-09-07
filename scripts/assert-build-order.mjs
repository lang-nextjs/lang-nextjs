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
function refuse(what, err) {
  const detail =
    `${err?.stdout ?? ""}${err?.stderr ?? ""}`.trim() ||
    String(err?.message ?? err);
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

/**
 * A PARSE FAILURE IS NOT A SPAWN FAILURE, AND THEY MUST NOT SHARE A MESSAGE (#851).
 *
 * `refuse` above reports what a FAILED COMMAND said — its stdout/stderr. A command that
 * SUCCEEDED and printed something unparseable has no error to report: the useful evidence is
 * what it actually printed, which `refuse` would render as an empty detail followed by a
 * JSON.parse message naming a character offset in a string the reader cannot see.
 *
 * Both exit 2, because both are "the question could not be asked". They differ in what a
 * reader must do next — install a binary, or look at what the binary emitted — and a single
 * message serving both sends half of them to the wrong place.
 */
function refuseParse(what, err, printed) {
  const text = String(printed ?? "");
  const shown =
    text.length > 400
      ? `${text.slice(0, 400)}\n  …(${text.length} chars total)`
      : text;
  console.error(
    `\nCOULD NOT CHECK: ${what}\n\n  ${String(err?.message ?? err)}\n\n` +
      `  what it actually printed:\n  ${shown || "(nothing)"}\n\n` +
      `  Exiting 2: the question could not be asked, not answered. The command RAN — this is\n` +
      `  not a missing binary — but its output could not be read, so nothing about the\n` +
      `  ordering was observed.\n`
  );
  process.exit(2);
}

/**
 * A GUARD WRITTEN AGAINST SYNTAX DOES NOT COVER SHAPE (#916).
 *
 * #851 fixed the case where a command printed something unparseable: that now REFUSES
 * rather than reporting a violation. Valid JSON of the WRONG SHAPE satisfies the parse
 * and arrives downstream anyway, and the three consumers here fail three different ways —
 * which is the argument for guarding all of them rather than the one that crashed:
 *
 *   `pnpm ls` -> null      `for (const p of list)` throws, exit 1. A checker that could
 *                          not see its subject, reporting the subject as broken.
 *   turbo     -> {}        `dryRun.tasks ?? []` yields ZERO edges, so every expected edge
 *                          is reported missing — a FALSE VIOLATION rather than a crash.
 *   package.json -> null   `json?.scripts?.build` is undefined, the package silently
 *                          leaves the buildable set and THE EXPECTED EDGE SET IS SHORT.
 *                          No error at all. This is the one the parse guard's own comment
 *                          already names as the hazard; shape reaches it by another door.
 *
 * All three are "I could not read this", not "the property is violated", so they belong
 * beside `refuseParse` and exit 2 with it. Downstream they are indistinguishable — every
 * one arrives as "the checker exited non-zero" — which is why the distinction has to be
 * made here or not at all.
 */
function refuseShape(what, got, printed) {
  const shown =
    got === null ? "null" : Array.isArray(got) ? "an array" : typeof got;
  refuseParse(what, new Error(`parsed to ${shown}`), printed);
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
    refuse("the workspace package list could not be read from pnpm.", err);
  }
  let list;
  try {
    list = JSON.parse(out);
  } catch (err) {
    refuseParse(
      "`pnpm ls` ran and printed something that is not JSON, so the workspace package " +
        "list could not be read.",
      err,
      out
    );
  }
  if (!Array.isArray(list))
    refuseShape(
      "`pnpm ls` ran and printed valid JSON that is not an array, so the workspace " +
        "package list could not be read.",
      list,
      out
    );
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
    if (!existsSync(p)) return null;
    let text;
    try {
      text = readFileSync(p, "utf8");
    } catch (err) {
      refuse(`${p} exists but could not be read.`, err);
    }
    try {
      const parsed = JSON.parse(text);
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      )
        refuseShape(
          `${p} is valid JSON but not an object, so this package's dependencies are ` +
            "unknown. This one is SILENT if unguarded: `json?.scripts?.build` is simply " +
            "undefined, the package leaves the buildable set, and the expected edge set " +
            "is short with nothing reported.",
          parsed,
          text
        );
      return parsed;
    } catch (err) {
      refuseParse(
        `${p} is not parseable JSON, so this package's dependencies are unknown and the ` +
          "expected edge set would be silently short.",
        err,
        text
      );
    }
  };
  const expected = expectedEdges(pkgs, readPkgJson);

  let dryOut;
  try {
    dryOut = execFileSync(
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
    // "Absent subject is never a pass" was already right here; the disposition was not. Not a
    // pass and not a failure — the third one. See `refuse` above.
    refuse("turbo's task graph could not be obtained.", err);
  }
  let dry;
  try {
    dry = JSON.parse(dryOut);
  } catch (err) {
    refuseParse(
      "turbo ran and printed something that is not JSON, so its task graph could not be read.",
      err,
      dryOut
    );
  }

  /*
   * `tasks` MISSING IS NOT `tasks` EMPTY, and `observedEdges` cannot tell them apart:
   * `dryRun.tasks ?? []` turns both into zero edges, so a turbo that printed the wrong
   * object shape would report every expected edge as unordered — exit 1, a confident
   * accusation, from a run that observed nothing.
   */
  if (dry === null || typeof dry !== "object" || !Array.isArray(dry.tasks))
    refuseShape(
      "turbo ran and printed valid JSON with no `tasks` array, so its task graph could " +
        "not be read. An empty task list and an unreadable one are the same zero here.",
      dry === null || typeof dry !== "object" ? dry : dry.tasks,
      dryOut
    );

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
