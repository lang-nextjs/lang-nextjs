/**
 * `pnpm eject-audit` — takes both readings and records what an eject does to
 * every registered checker's subject (#755).
 *
 * THE EXPENSIVE HALF, ON DEMAND. Measured: 178s full + 150s ejected + 2s eject +
 * 5s install + ~30s build, each side. That is why it is not registered in
 * checks.json — `scripts/assert-eject-subjects-classified.mjs` is the cheap gate
 * that runs per PR and tells you to run this.
 *
 * BOTH READINGS COME FROM ONE SHA. A full-tree reading at one commit compared
 * against an ejected reading at another produces differences that look like
 * ejection and are merge — measured: #769 changed the selftests for
 * `check-doc-claims` and `assert-formatted`, and `formatted` is one of the
 * checkers that changes class across an eject. The sha is recorded IN the census
 * so a reader can tell what the classification is about.
 *
 * AND BOTH TREES ARE BUILT. An unbuilt tree makes `readme-quickstart` report
 * "published types entry does not exist" and exit 1, which classifies as
 * `no-baseline` — an artefact, not a finding. The install AND build exit codes
 * are checked DIRECTLY rather than inferred from what the checkers say
 * afterwards: an unprepared tree does not announce itself, it produces a
 * plausible short list naming real checkers.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { classifyOne, STATIC } from "./lib/eject-classify.mjs";
import { reportSubject } from "./lib/subject.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CENSUS = join(ROOT, "scripts/eject-subject-census.json");

/** Checker-phase entries from a run record, by check name. */
export function checkersOf(record) {
  const rows = Array.isArray(record)
    ? record
    : Object.values(record).find(Array.isArray) ?? [];
  return Object.fromEntries(
    rows.filter((r) => r.phase === "checker").map((r) => [r.name, r])
  );
}

/**
 * THE NON-VACUITY GUARD, AND IT IS A REFUSAL RATHER THAN A COMMENT.
 *
 * If nothing moved, the eject did not take, or an install failed, or the readings
 * were never gathered — none of which is a verdict about rung-scoping. A census
 * recorded from that would be a clean-looking file asserting that no checker
 * responds to the tree.
 *
 * The named movers come from THE READING THIS GUARD WAS BUILT FOR. An earlier
 * draft cited two checkers measured at a different sha against a different eject
 * target; both are `absent` here, so the message would have sent a reader to two
 * files with nothing to say.
 */
export function vacuityComplaint(classified) {
  const movers = Object.entries(classified).filter(
    ([, r]) => r.verdict === "moved"
  );
  if (movers.length > 0) return null;
  return (
    `no checker's subject moved under the eject. That is not a finding about\n` +
    `        rung-scoping — it is what a failed eject, a failed install or an\n` +
    `        ungathered reading looks like. Checks known to move at d41664ca:\n` +
    `          child-process-argv-form   968 -> 599\n` +
    `          no-silent-skips           296 -> 200\n` +
    `          sibling-tests-are-owned    53 -> 1\n` +
    `        If those three did not move, the trees are the problem, not the checkers.`
  );
}

/**
 * ONE EJECT SUFFICES ONLY IF SUBJECTS ARE MONOTONE UNDER FILE REMOVAL.
 *
 * `eject langchain` is the maximal strip — eject.mjs deletes every rung ABOVE its
 * argument, so the argument is a RETAIN point and `langchain` retains the fewest.
 * (`eject software-developer-agent` retains all 435 and deletes 0: a no-op that
 * produces a perfectly clean audit saying nothing, reachable by a plausible
 * reading of the interface.)
 *
 * If subjects only shrink when files vanish, a classification under the maximal
 * strip holds under every smaller one and one eject covers the ladder. That is
 * PLAUSIBLE, not proven — it would fail for a subject counting MISMATCHES or
 * DECLARED-BUT-MISSING, which can GROW as files disappear. So the audit asserts
 * it rather than assuming it, and says which checker broke it.
 */
export function monotonicityComplaints(classified) {
  return Object.entries(classified)
    .filter(
      ([, r]) => r.ejected !== null && r.full !== null && r.ejected > r.full
    )
    .map(
      ([n, r]) =>
        `${n}: subject GREW under ejection, ${r.full} -> ${r.ejected}. The one-eject ` +
        `assumption does not hold for this checker, so a classification from the ` +
        `maximal strip alone does not cover the smaller ones. More eject targets are needed.`
    );
}

/**
 * Merge fresh classifications over the existing census, preserving human notes
 * ONLY where the verdict is unchanged.
 *
 * A note explains why a `static` is legitimate. If the verdict moved, the note
 * describes a state that no longer exists — and the repair for `static -> moved`
 * is to DELETE the note, not to keep it beside a contradicting verdict.
 */
export function merge(previous, fresh, sha, baseSha) {
  /*
   * PROVENANCE THAT SURVIVES A SQUASH. `measuredAt` is the sha the readings were
   * actually taken at, which on a PR branch is a pre-merge commit that does NOT
   * exist in main's history afterwards — this repo squash-merges, and a branch
   * sha resolves to "unknown revision" from main. So `base` records the commit on
   * main the branch was cut from, which is durable, and the two together say what
   * tree was measured: that base with this change applied.
   *
   * Recording only `measuredAt` would leave the census pointing at nothing the
   * day it merges, which is the stale-pointer shape (#760, #782) one file over.
   */
  const out = {
    measuredAt: sha,
    base: baseSha,
    baseNote:
      "readings were taken on `base` WITH this change applied; `measuredAt` is a " +
      "pre-squash commit and does not survive the merge, so `base` is the durable half",
    ejectTarget: "langchain",
    checkers: {},
  };
  for (const [name, r] of Object.entries(fresh)) {
    const old = previous?.checkers?.[name];
    const keep = old && old.verdict === r.verdict && r.verdict === STATIC;
    out.checkers[name] = {
      verdict: r.verdict,
      full: r.full,
      ejected: r.ejected,
      why: r.why,
      ...(r.verdict === STATIC
        ? { note: keep ? old.note : null, lifts: keep ? old.lifts : "#785" }
        : {}),
    };
  }
  return out;
}

function main() {
  const arg = (f) => {
    const i = process.argv.indexOf(f);
    return i !== -1 ? process.argv[i + 1] : null;
  };
  const fullPath = arg("--full");
  const ejectedPath = arg("--ejected");
  const sha = arg("--sha");
  const baseSha = arg("--base");
  if (!fullPath || !ejectedPath || !sha || !baseSha) {
    console.error(
      `REFUSE: needs --full <record> --ejected <record> --sha <sha> --base <sha on main>.\n` +
        `        Both records must come from ONE sha and from BUILT trees. Nothing was\n` +
        `        compared, which is not the same as nothing being wrong.`
    );
    process.exit(2);
  }
  const F = checkersOf(JSON.parse(readFileSync(fullPath, "utf8")));
  const E = checkersOf(JSON.parse(readFileSync(ejectedPath, "utf8")));

  const fresh = {};
  for (const name of Object.keys(F))
    fresh[name] = classifyOne(F[name], E[name]);

  const vacuity = vacuityComplaint(fresh);
  if (vacuity) {
    console.error(`REFUSE: ${vacuity}`);
    process.exit(2);
  }
  const mono = monotonicityComplaints(fresh);
  if (mono.length > 0) {
    console.error(`FAIL: ${mono.length} monotonicity violation(s):`);
    mono.forEach((m) => console.error(`   - ${m}`));
    process.exit(1);
  }

  const previous = existsSync(CENSUS)
    ? JSON.parse(readFileSync(CENSUS, "utf8"))
    : null;
  const next = merge(previous, fresh, sha, baseSha);
  writeFileSync(CENSUS, JSON.stringify(next, null, 2) + "\n");

  const tally = {};
  for (const e of Object.values(next.checkers))
    tally[e.verdict] = (tally[e.verdict] ?? 0) + 1;
  // PER-CHECKER IS THE FINDING. No aggregate subject-count is computed: an
  // aggregate inherits its noisiest component's variance, so a real change in a
  // small-subject checker vanishes inside it.
  reportSubject(
    Object.keys(next.checkers).length,
    "checker(s) compared across the eject boundary"
  );
  console.log(`PASS: census written for ${sha}. ${JSON.stringify(tally)}`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  main();
}
