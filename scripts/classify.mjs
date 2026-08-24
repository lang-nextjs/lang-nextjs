#!/usr/bin/env node
/**
 * classify.mjs — CHECK-1: every tracked file is owned by exactly one rung, or is shared.
 *
 * This is the census `pnpm eject` and CHECK-2 are built on. If classification is incomplete,
 * eject leaves behind whatever nobody classified — which is how a close condition once went
 * green with nine rung files still shipping.
 *
 * Zero dependencies and plain .mjs on purpose: this must run on an EJECTED tree, which may
 * have no node_modules yet, and against a Python plane pnpm cannot see at all.
 *
 * WHAT WOULD HAVE TO BE TRUE FOR THIS CHECK TO PASS WHILE CLASSIFICATION IS STILL BROKEN?
 * Five answers, each with the gate that closes it:
 *
 *   1. The walk finds nothing -> "all zero files are classified" passes.
 *      >>> C1 asserts a plausible minimum, the device from severability.test.ts's
 *          "guards against the walk silently matching nothing".
 *   2. A file matches no pattern and is quietly skipped.
 *      >>> C2 totality: unclassified is a hard failure.
 *   3. Two rungs claim the same file, so eject has no defined behaviour and CHECK-2's
 *      deletion arithmetic silently stops being exact.
 *      >>> C3 disjointness.
 *   4. A manifest glob matches nothing — the manifest rots into decoration while every
 *      assertion over it stays green.
 *      >>> C4 every declared glob must match >= 1 file.
 *   5. A RUNG FILE IS WRONGLY MATCHED BY A BROAD `shared` GLOB. This is the residual the
 *      spec flagged, and it is not hypothetical: #40 added docs/rungs/4-open-swe.md, which a
 *      `docs/**` shared glob swallows silently. Totality does not catch it — the file IS
 *      classified, just wrongly.
 *      >>> C7 suspicion heuristic: a shared file whose PATH contains a rung id is a hard
 *          failure. Either it is rung-owned (fix `owns`) or it is genuinely shared (add it
 *          to `shared.knownRungNamedSharedPaths`, which is a visible, reviewable edit).
 *
 * Usage:  node scripts/classify.mjs [--json] [--freeze]
 *   --json    machine-readable output for CI and for eject
 *   --freeze  rewrite ownedFileCount in rungs.json from the measured census
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = process.env.RUNGS_MANIFEST || join(ROOT, "rungs.json");

/**
 * A tree this small is not the repo — it is a broken walk, a wrong cwd, or a git failure.
 * Without this floor, every assertion below is vacuously true over an empty set.
 */
const MIN_TRACKED_FILES = 100;

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));

/** git-tracked files only: never node_modules, never build output, never .gitignore'd. */
function trackedFiles(cwd) {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 << 20,
  })
    .split("\0")
    .filter(Boolean);
}

/**
 * Glob match supporting `**` (any depth), `*` (one segment), and literals.
 *
 * The two `**` cases are NOT the same and conflating them is a silent-no-match bug:
 *   `a/**`      -> `a/` plus at least one more segment, i.e. everything under a/  -> `.+`
 *   `a/**\/b.ts` -> zero or more intervening directories                          -> `(?:[^/]+/)*`
 * Getting this wrong is invisible without C4: every glob quietly matches nothing and every
 * assertion built on them stays green. That is exactly what C4 exists to catch, and it did.
 */
function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++; // consume the second `*`
        if (glob[i + 1] === "/") {
          i++; // `**/` -> any number of intervening segments
          re += "(?:[^/]+/)*";
        } else {
          // trailing `**` -> everything below this point, at any depth
          re += ".+";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
const matcher = (glob) => {
  const r = globToRegExp(glob);
  return (f) => r.test(f);
};

export function classify(cwd = process.env.RUNGS_CWD || ROOT, m = manifest) {
  const files = trackedFiles(cwd);
  const errors = [];
  const warnings = [];

  // --- C1: the walk must have found a real tree --------------------------------------------
  if (files.length < MIN_TRACKED_FILES) {
    errors.push(
      `C1 walk: found only ${files.length} tracked files (< ${MIN_TRACKED_FILES}). ` +
        `A broken walk makes every check below vacuously true, so this is a failure, not a pass.`
    );
  }

  // --- ownership ---------------------------------------------------------------------------
  const owner = new Map(); // file -> rungId
  const claims = new Map(); // file -> [rungId...]  (to report disjointness violations)
  const globHits = new Map(); // "rung:lang:glob" | "shared:glob" -> count

  for (const rung of m.rungs) {
    for (const [lang, globs] of Object.entries(rung.owns)) {
      if (!Array.isArray(globs)) continue;
      for (const g of globs) {
        const key = `${rung.id}:${lang}:${g}`;
        const test = matcher(g);
        let n = 0;
        for (const f of files) {
          if (!test(f)) continue;
          n++;
          owner.set(f, rung.id);
          claims.set(f, [...(claims.get(f) || []), rung.id]);
        }
        globHits.set(key, n);
      }
    }
  }

  // --- C3: disjointness --------------------------------------------------------------------
  for (const [f, ids] of claims) {
    const uniq = [...new Set(ids)];
    if (uniq.length > 1) {
      errors.push(
        `C3 disjoint: ${f} is claimed by ${uniq.length} rungs: ${uniq.join(
          ", "
        )}`
      );
    }
  }

  // --- shared (evaluated AFTER rung ownership: rung ownership always wins) ------------------
  const sharedGlobs = m.shared.paths.map((g) => [g, matcher(g)]);
  const shared = new Set();
  const unclassified = [];
  for (const f of files) {
    if (owner.has(f)) continue;
    const hit = sharedGlobs.find(([, t]) => t(f));
    if (hit) {
      shared.add(f);
      globHits.set(
        `shared:${hit[0]}`,
        (globHits.get(`shared:${hit[0]}`) || 0) + 1
      );
    } else {
      unclassified.push(f);
    }
  }

  // --- C2: totality ------------------------------------------------------------------------
  for (const f of unclassified.slice(0, 25)) {
    errors.push(
      `C2 total: ${f} is owned by no rung and matched by no shared path`
    );
  }
  if (unclassified.length > 25) {
    errors.push(
      `C2 total: ...and ${unclassified.length - 25} more unclassified files`
    );
  }

  // --- C4: no glob may match nothing -------------------------------------------------------
  for (const [key, n] of globHits) {
    if (n === 0) {
      errors.push(
        `C4 glob: "${key}" matches zero tracked files — stale manifest entry, or a typo. ` +
          `A glob that matches nothing lets every assertion over it stay green while meaning nothing.`
      );
    }
  }
  // A declared glob that never even got measured (rung with an empty owns list is fine; a
  // shared path that no file reached is not).
  for (const g of m.shared.paths) {
    if (!globHits.has(`shared:${g}`)) {
      errors.push(`C4 glob: shared path "${g}" matched zero tracked files`);
    }
  }

  // --- C5: a `planned` rung owns nothing ---------------------------------------------------
  const countByRung = new Map(m.rungs.map((r) => [r.id, 0]));
  for (const id of owner.values()) countByRung.set(id, countByRung.get(id) + 1);
  // A `planned` rung may own DOCS — the ladder documents rungs before they exist — but must own
  // no ts/py SOURCE. Counting docs would make this fire on docs/rungs/5-*.md and then get
  // "fixed" by weakening it, so the property is stated over implementation planes only.
  const srcCountByRung = new Map(m.rungs.map((r) => [r.id, 0]));
  for (const [f, id] of owner) {
    if (!f.startsWith("docs/")) srcCountByRung.set(id, srcCountByRung.get(id) + 1);
  }
  for (const rung of m.rungs) {
    const n = srcCountByRung.get(rung.id);
    if (rung.state === "planned" && n !== 0) {
      errors.push(
        `C5 planned: rung "${rung.id}" is state:"planned" but owns ${n} non-doc files. ` +
          `Implement it and set state, or fix owns — a planned rung must not have shipped.`
      );
    }
  }

  // --- C6: frozen census must still be true ------------------------------------------------
  for (const rung of m.rungs) {
    if (typeof rung.ownedFileCount !== "number") {
      warnings.push(
        `C6 census: rung "${rung.id}" has no frozen ownedFileCount (run --freeze)`
      );
      continue;
    }
    const n = countByRung.get(rung.id);
    if (n !== rung.ownedFileCount) {
      errors.push(
        `C6 census: rung "${rung.id}" owns ${n} files but ownedFileCount says ${rung.ownedFileCount}. ` +
          `CHECK-2 asserts deletions EQUAL this number, so a stale count silently weakens it.`
      );
    }
  }

  // --- C7: a shared file whose PATH names a rung is almost certainly misfiled ---------------
  //
  // Totality cannot catch this: the file IS classified, just wrongly. Real instance: #40 added
  // docs/rungs/4-open-swe.md, which a `docs/**` shared glob swallows without complaint, and
  // `pnpm eject deepagents` would then ship a fork documenting a rung it does not contain.
  //
  // Matched on PATH SEGMENTS, not substrings. A substring test flags Django's project package
  // `deepagents_backend` (which is not the deepagents rung); a bare equality test misses
  // `open-swe-dashboard.spec.ts` (which is rung 4). Segments, normalised for camelCase and a
  // leading ordinal, with an `<id>-` / `<id>_` prefix allowance, get both right.
  //
  // Biased to OVER-fire, same as assert-dist-clean.sh: a false positive costs one allowlist
  // line a reviewer can see; a false negative ships a rung file in a fork that ejected it.
  const allowGlobs = (m.shared.knownRungNamedSharedPaths || []).map((g) => [g, matcher(g)]);
  const rungIds = m.rungs.map((r) => r.id);
  const kebab = (x) => x.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  const segmentsOf = (f) =>
    f.split("/").map((seg) => kebab(seg.split(".")[0].replace(/^\d+[-_]/, "")));
  for (const f of shared) {
    if (allowGlobs.some(([, t]) => t(f))) continue;
    const segs = segmentsOf(f);
    const named = rungIds.filter((id) =>
      segs.some((g) => g === id || g.startsWith(`${id}-`) || g.startsWith(`${id}_`))
    );
    if (named.length > 0) {
      errors.push(
        `C7 misfiled: "${f}" is classified shared but its path names rung(s) ${named.join(
          ", "
        )}. ` +
          `Either add it to that rung's owns, or list it in shared.knownRungNamedSharedPaths ` +
          `(a visible, reviewable edit) if it is genuinely rung-agnostic.`
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats: {
      tracked: files.length,
      rungOwned: owner.size,
      shared: shared.size,
      unclassified: unclassified.length,
      byRung: Object.fromEntries(countByRung),
    },
  };
}

// ---------------------------------------------------------------------------------------- //
const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const result = classify();

  if (process.argv.includes("--freeze")) {
    const m = JSON.parse(readFileSync(MANIFEST, "utf8"));
    for (const rung of m.rungs)
      rung.ownedFileCount = result.stats.byRung[rung.id];
    writeFileSync(MANIFEST, JSON.stringify(m, null, 2) + "\n");
    console.log("froze ownedFileCount:", result.stats.byRung);
    process.exit(0);
  }

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }

  const { stats } = result;
  console.log(`Rung classification over ${stats.tracked} git-tracked files`);
  for (const [id, n] of Object.entries(stats.byRung)) {
    console.log(`  ${id.padEnd(26)} ${String(n).padStart(4)}`);
  }
  console.log(`  ${"(shared)".padEnd(26)} ${String(stats.shared).padStart(4)}`);
  console.log(
    `  ${"(unclassified)".padEnd(26)} ${String(stats.unclassified).padStart(4)}`
  );
  console.log();
  for (const w of result.warnings) console.log(`WARN: ${w}`);
  for (const e of result.errors) console.error(`FAIL: ${e}`);
  if (!result.ok) {
    console.error(`\n${result.errors.length} classification error(s).`);
    process.exit(1);
  }
  console.log("PASS: classification is total and disjoint.");
}
