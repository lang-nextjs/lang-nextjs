#!/usr/bin/env node
/**
 * census.mjs — freeze WHICH FILES fall under a shared glob, so a new arrival needs a human.
 *
 * THE GAP. `rungs.json` records intent at GLOB granularity and the classifier consumes it at
 * FILE granularity. `packages/server/**` is one deliberate line covering ~65 files, and the
 * membership of any given file was decided by nobody. Classification stays total and disjoint,
 * every test passes, the fork builds — and a rung file sits in `shared` until someone notices.
 *
 * That is not hypothetical. `attribution.pipeline.test.ts` arrived in #45 with no manifest
 * edit, was matched by `packages/server/**`, and sat misclassified for TWENTY-NINE COMMITS
 * until #57 claimed it. In between, `pnpm eject` exited FAIL on main. This check fires on the
 * commit that introduces such a file, not twenty-nine later.
 *
 * WHY ONLY TWO GLOBS — the refusal is measured, and `rungs.json` `shared._censusNote` carries
 * the numbers. Short version: freezing all 23 shared globs means 760 files and a manifest edit
 * on 46% of commits, which is rubber-stamp-shaped, and a rubber-stamped freeze is worse than
 * nothing because it reads as review. Every misclassification in this repo's history landed in
 * these two globs; the other 498 files have produced none.
 *
 * FORK-STABLE BY CONSTRUCTION, and this was measured rather than assumed. `eject` deletes only
 * RUNG-OWNED paths, and a census member is by definition not rung-owned, so no eject can remove
 * one. Verified at the extreme: rung-1 fork, 96 members before and 96 after, zero delta. So
 * this needs no eject integration and asserts the same thing in a fork as in the monorepo —
 * unlike a count floor, which would have needed one.
 *
 * Usage:  node scripts/census.mjs [--freeze] [--cwd DIR]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const FREEZE = argv.includes("--freeze");
const cwdFlag = argv.indexOf("--cwd");
const CWD = cwdFlag >= 0 ? resolve(argv[cwdFlag + 1]) : ROOT;

const CENSUS_PATH = join(CWD, "scripts", "shared-census.json");

/** The globs whose membership is frozen. Changing this list is a deliberate, reviewable act. */
const FROZEN_GLOBS = ["packages/server/**", "packages/react/**"];

const die = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

/** Copied from classify.mjs. A second glob dialect would drift from the classifier's. */
function globToRegExp(glob) {
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

const manifest = JSON.parse(readFileSync(join(CWD, "rungs.json"), "utf8"));

// Rung ownership wins, exactly as rungs.json's `_sharedExceptions` says. A rung-owned file
// inside packages/server/** is NOT a census member, and counting it would make this check
// fire on every ordinary rung file — friction with no signal.
const rungMatchers = manifest.rungs.flatMap((r) =>
  Object.values(r.owns).filter(Array.isArray).flat().map(globToRegExp)
);
const frozenMatchers = FROZEN_GLOBS.map(globToRegExp);

const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: CWD,
  encoding: "utf8",
  maxBuffer: 64 << 20,
})
  .split("\0")
  .filter(Boolean)
  .filter((f) => existsSync(join(CWD, f)));

// --- G1: the walk must have found a real tree ------------------------------------------------
// Without this a broken `git ls-files` yields an empty census, `--freeze` writes it, and the
// check then passes forever over nothing. Same device as C1 in classify.mjs.
if (tracked.length < 100) {
  die(
    `found only ${tracked.length} tracked files — a broken walk would freeze an empty census ` +
      `and pass forever. Refusing.`
  );
}

const isRungOwned = (f) => rungMatchers.some((re) => re.test(f));
const observed = tracked
  .filter((f) => !isRungOwned(f) && frozenMatchers.some((re) => re.test(f)))
  .sort();

// --- G2: every frozen glob must still be declared shared -------------------------------------
// If someone removes `packages/react/**` from shared.paths, this check would silently stop
// covering it while continuing to pass. The census would then be frozen over a subset nobody
// chose. Fail instead.
for (const g of FROZEN_GLOBS) {
  if (!manifest.shared.paths.includes(g)) {
    die(
      `"${g}" is frozen here but no longer listed in rungs.json shared.paths. ` +
        `Either restore it, or remove it from FROZEN_GLOBS deliberately.`
    );
  }
}

// --- G3: a glob that matches nothing ----------------------------------------------------------
for (const g of FROZEN_GLOBS) {
  const re = globToRegExp(g);
  if (!observed.some((f) => re.test(f))) {
    die(
      `"${g}" matches zero census members — a stale glob freezes an empty list.`
    );
  }
}

if (FREEZE) {
  writeFileSync(
    CENSUS_PATH,
    `${JSON.stringify(
      {
        _readme: [
          "FROZEN MEMBERSHIP of the shared globs listed in `globs`. Generated by",
          "`pnpm census:freeze`; do not hand-edit.",
          "",
          "A diff here means a file started or stopped being SHARED. That is a question for a",
          "human: does this file belong to a rung? The check exists because the answer was",
          "silently 'nobody decided' for 29 commits once already (attribution.pipeline.test.ts,",
          "#45 -> #57), during which `pnpm eject` exited FAIL on main.",
          "",
          "Rung-owned files are NOT members — rung ownership wins, so this list moves only when",
          "SHARED membership moves. It is therefore unchanged by `pnpm eject`, which deletes",
          "only rung-owned paths.",
        ],
        globs: FROZEN_GLOBS,
        count: observed.length,
        members: observed,
      },
      null,
      2
    )}\n`
  );
  console.log(
    `froze ${observed.length} members across ${FROZEN_GLOBS.length} glob(s).`
  );
  process.exit(0);
}

if (!existsSync(CENSUS_PATH)) {
  die(
    `no frozen census at scripts/shared-census.json — run: pnpm census:freeze`
  );
}

let frozen;
try {
  frozen = JSON.parse(readFileSync(CENSUS_PATH, "utf8"));
} catch (e) {
  die(
    `scripts/shared-census.json is unparseable, so the census is unknown:\n       ${e.message}`
  );
}

// The frozen file records which globs it covers, so widening FROZEN_GLOBS without re-freezing
// cannot pass by comparing a new set against an old list.
const sameGlobs =
  Array.isArray(frozen.globs) &&
  frozen.globs.length === FROZEN_GLOBS.length &&
  frozen.globs.every((g, i) => g === FROZEN_GLOBS[i]);
if (!sameGlobs) {
  die(
    `frozen census covers [${frozen.globs?.join(", ")}] but this run covers ` +
      `[${FROZEN_GLOBS.join(", ")}] — re-freeze deliberately.`
  );
}

const frozenSet = new Set(frozen.members ?? []);
const observedSet = new Set(observed);
const added = observed.filter((f) => !frozenSet.has(f));
const removed = [...frozenSet].filter((f) => !observedSet.has(f)).sort();

if (added.length === 0 && removed.length === 0) {
  console.log(
    `PASS: shared census unchanged — ${observed.length} members across ` +
      `${FROZEN_GLOBS.join(", ")}.`
  );
  process.exit(0);
}

console.error(`FAIL: shared-glob membership changed.\n`);
if (added.length > 0) {
  console.error(
    `  ${added.length} file(s) are now SHARED that were not before. For each, answer:\n` +
      `  does it belong to a rung? If yes, add it to that rung's \`owns\` and re-freeze the\n` +
      `  census. If it is genuinely shared, re-freeze and say so in the commit message.\n`
  );
  for (const f of added) console.error(`    + ${f}`);
  console.error("");
}
if (removed.length > 0) {
  console.error(
    `  ${removed.length} file(s) are no longer shared — deleted, renamed, or newly claimed\n` +
      `  by a rung. Re-freeze once you have confirmed which.\n`
  );
  for (const f of removed) console.error(`    - ${f}`);
  console.error("");
}
console.error(`  Re-freeze with: pnpm census:freeze`);
process.exit(1);
