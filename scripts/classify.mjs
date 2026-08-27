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
 *   6. The manifest CLAIMS a set of topologies per (rung, runtime) that nothing verifies, so
 *      it rots: add a topology to a backend and the matrix never grows a cell for it.
 *      >>> C8 checks the claim against the Python module that defines it.
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
import { execFileSync, spawnSync } from "node:child_process";
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

/**
 * UNTRACKED FILES A RUNG'S `owns` GLOBS WOULD CLAIM (#224).
 *
 * `pnpm rungs` enumerates with `git ls-files`, so a file that exists but is not yet added is
 * INVISIBLE to it. That is correct for the artifact — `ownedFileCount` is a claim about the
 * repository, and untracked scratch is not in the repository — but it makes the check answer
 * PASS about a tree that does not include your work.
 *
 * WHICH IS EXACTLY WHEN PEOPLE RUN IT. `pnpm rungs` is the pre-commit check; the moment it is
 * most used is the moment the new file is still untracked, and in that window it cannot see the
 * thing it is checking for. It said PASS on a branch adding a rung-owned e2e helper, and ten CI
 * jobs went red on the freeze that PASS implied was unnecessary.
 *
 * THE ENUMERATION IS NOT WIDENED, DELIBERATELY — the same ruling as #210 made for census.mjs.
 * Counting untracked files would churn ownedFileCount on every stray scratch file. The fix is
 * not to see more; it is to STOP REPORTING A CLEAN CLASSIFICATION OVER SOMETHING UNSEEN.
 *
 * This is the third file to need this guard, after severability.test.ts and census.mjs. The
 * lesson has now failed to travel twice, which is why it is written out rather than assumed.
 */
function untrackedRungOwned(cwd, m) {
  let others;
  try {
    others = execFileSync(
      "git",
      ["ls-files", "-z", "--others", "--exclude-standard"],
      { cwd, encoding: "utf8", maxBuffer: 64 << 20 }
    )
      .split("\0")
      .filter(Boolean);
  } catch {
    // Not a git tree, or git unavailable. Returning [] is right: this guard reports a
    // condition it has OBSERVED, and it has observed nothing. It must not invent one.
    return [];
  }
  const tests = [];
  for (const rung of m.rungs) {
    for (const globs of Object.values(rung.owns ?? {})) {
      if (!Array.isArray(globs)) continue;
      for (const g of globs) tests.push({ rung: rung.id, test: matcher(g) });
    }
  }
  const hits = [];
  for (const f of others) {
    const hit = tests.find(({ test }) => test(f));
    if (hit) hits.push({ file: f, rung: hit.rung });
  }
  return hits;
}

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
    if (!f.startsWith("docs/"))
      srcCountByRung.set(id, srcCountByRung.get(id) + 1);
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
        `C6 census is STALE — run \`pnpm rungs:freeze\`. Rung "${rung.id}" owns ${n} files but ` +
          `ownedFileCount says ${rung.ownedFileCount}. ` +
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
  const allowGlobs = (m.shared.knownRungNamedSharedPaths || []).map((g) => [
    g,
    matcher(g),
  ]);
  const rungIds = m.rungs.map((r) => r.id);
  const kebab = (x) => x.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  const segmentsOf = (f) =>
    f.split("/").map((seg) => kebab(seg.split(".")[0].replace(/^\d+[-_]/, "")));
  for (const f of shared) {
    if (allowGlobs.some(([, t]) => t(f))) continue;
    const segs = segmentsOf(f);
    const named = rungIds.filter((id) =>
      segs.some(
        (g) => g === id || g.startsWith(`${id}-`) || g.startsWith(`${id}_`)
      )
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

  // --- C8: declared topologies must match the runtime's actual source -----------------------
  //
  // The manifest CLAIMS which topologies each (rung, runtime) pair serves, and three consumers
  // derive matrix arity from that claim. An unverified claim rots: add deep-research to django
  // and the manifest silently keeps saying two, so the matrix never grows a cell for it and the
  // new topology ships untested. So the claim is checked against the source that defines it.
  //
  // Fail-closed by construction: a runtime declaring topologies MUST name a topologiesSource,
  // and that file must exist and agree. A runtime with an empty topologies list has no axis and
  // nothing to verify — that is an absence of a claim, not an unverified claim.
  for (const rung of m.rungs) {
    for (const [runtime, cfg] of Object.entries(rung.runtimes || {})) {
      const declared = cfg.topologies || [];
      if (declared.length === 0) continue;
      if (!cfg.topologiesSource) {
        errors.push(
          `C8 topology: ${rung.id} x ${runtime} declares ${declared.length} topologies but no ` +
            `topologiesSource — an unverifiable claim the matrix would still trust.`
        );
        continue;
      }
      let src;
      try {
        src = readFileSync(join(cwd, cfg.topologiesSource), "utf8");
      } catch {
        errors.push(
          `C8 topology: ${rung.id} x ${runtime} names topologiesSource ` +
            `"${cfg.topologiesSource}", which does not exist.`
        );
        continue;
      }
      const block = src.match(/^TOPOLOGIES[^=]*=\s*\{([\s\S]*?)^\}/m);
      if (!block) {
        errors.push(
          `C8 topology: no TOPOLOGIES mapping found in "${cfg.topologiesSource}" — the manifest ` +
            `claims ${declared.length} topologies against a file that declares none.`
        );
        continue;
      }
      const actual = [...block[1].matchAll(/^\s{4}"([a-z0-9-]+)"\s*:/gm)].map(
        (x) => x[1]
      );
      const missing = declared.filter((t) => !actual.includes(t));
      const extra = actual.filter((t) => !declared.includes(t));
      if (missing.length || extra.length) {
        errors.push(
          `C8 topology: ${rung.id} x ${runtime} manifest/source disagree. ` +
            `manifest=[${declared.join(", ")}] source=[${actual.join(", ")}]` +
            (missing.length
              ? ` missing-from-source=[${missing.join(", ")}]`
              : "") +
            (extra.length ? ` missing-from-manifest=[${extra.join(", ")}]` : "")
        );
      }
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
    // The per-file verdict, exposed so other gates can ask "does this file
    // survive every eject?" without reimplementing the glob matcher. A second
    // implementation is a second answer, and the two drift silently.
    // Consumed by scripts/budgeted-routes.mjs.
    owner: new Map(owner),
    sharedFiles: new Set(shared),
  };
}

// ---------------------------------------------------------------------------------------- //
const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const result = classify();

  if (process.argv.includes("--freeze")) {
    /*
     * THE OTHER FREEZE MUST BE CURRENT FIRST (#145).
     *
     * `rungs:freeze` and `census:freeze` write DIFFERENT artifacts — rungs.json's
     * ownedFileCount here, scripts/shared-census.json there — and people reach for
     * the wrong one, which is a signal the split is not meaningful to them. The
     * cost is not the wasted command: whoever runs one reads ITS green as the
     * answer and commits a half-consistent tree.
     *
     * Deliberately NOT merged into a single `pnpm freeze` that writes both. That
     * would let someone re-freeze an artifact they had no business touching, and
     * silently adopting a count nobody measured is the whole of #145. Refusing
     * makes them look at the other one; writing it for them does not.
     *
     * The ordering is not arbitrary either. An unclassified file may belong to a
     * rung's `owns` rather than to the shared set — and if it does, THIS count
     * changes too, so freezing now would bake in a number that is about to be
     * wrong.
     */
    const census = spawnSync(process.execPath, [join(ROOT, "scripts", "census.mjs")], {
      encoding: "utf8",
    });
    if (census.status !== 0) {
      console.error(
        "REFUSING TO FREEZE — the shared census is stale, and these are different artifacts.\n"
      );
      console.error(`${census.stdout ?? ""}${census.stderr ?? ""}`.trimEnd());
      console.error(
        "\n  You ran `pnpm rungs:freeze`, which writes rungs.json's ownedFileCount.\n" +
          "  The output above is `pnpm census`, which reads scripts/shared-census.json.\n" +
          "  Freezing one over a stale other commits a half-consistent tree whose green\n" +
          "  comes from whichever half you happened to run.\n\n" +
          "  Settle the census first: if that file belongs to a rung's `owns` rather than\n" +
          "  to the shared set, this count changes too and freezing now bakes in the\n" +
          "  wrong number.\n\n" +
          "  IF BOTH ARE STALE, there is no ordering that works and each refuses because\n" +
          "  the other does (#275). Run `pnpm freeze:all`, which measures both in one\n" +
          "  process and writes both — or refuses, if anything other than a stale count\n" +
          "  is wrong.\n"
      );
      process.exit(1);
    }
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
  const unseen = untrackedRungOwned(process.env.RUNGS_CWD || ROOT, manifest);
  if (unseen.length > 0) {
    // INCONCLUSIVE, not PASS and not FAIL. Nothing is wrong with the classification — it is
    // simply not a statement about this working tree. Reporting PASS here is the defect this
    // repository has spent days removing: a verdict about a subject the check never saw.
    //
    // Exit 2 rather than 1, matching census.mjs and check-visual-baselines: a script must be
    // able to tell "the manifest is wrong" from "I could not answer".
    console.error(
      `\nINCONCLUSIVE: the classification is clean over TRACKED files, but ${unseen.length} ` +
        `untracked file(s) would be claimed by a rung and were NOT counted:\n`
    );
    for (const { file, rung } of unseen) console.error(`    ? ${file}  -> ${rung}`);
    console.error(
      `\n  ownedFileCount does not include them, so this PASS does not cover your change.\n` +
        `  \`git add\` them and re-run — then \`pnpm rungs:freeze\` if the count moved.`
    );
    process.exit(2);
  }

  console.log("PASS: classification is total and disjoint.");
}
