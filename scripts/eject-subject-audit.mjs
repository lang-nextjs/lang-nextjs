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
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { classifyOne, STATIC, NON_TREE } from "./lib/eject-classify.mjs";
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
  /*
   * `not-tree-derived` IS EXCLUDED, AND THAT IS THE POINT OF THE VERDICT.
   * This guard reads a growing subject as "the one-eject assumption fails here".
   * For a checker whose subject is read over the network, growth means someone
   * filed an issue while the build ran — charging that to the eject would send
   * the reader hunting for a second eject target that does not exist. Excluded
   * because the premise does not hold, not because the complaint is inconvenient.
   */
  return Object.entries(classified)
    .filter(
      ([, r]) =>
        r.verdict !== NON_TREE &&
        r.ejected !== null &&
        r.full !== null &&
        r.ejected > r.full
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
/*
 * THE `lifts` A NEWLY-DISCOVERED STATIC STARTS WITH, AND IT MUST NAME AN OPEN ISSUE.
 * It was "#785", which has since CLOSED, so every new static was being stamped
 * "pending on" a resolved question.
 *
 * WHY THAT ROTTED UNNOTICED, AND WHY IT STILL MATTERS. The value never reaches a
 * merged tree on its own: a new static also gets `note: null`, and noteComplaints
 * fails the gate until a human writes one. So nothing ever failed because of it —
 * but the human who writes that note and leaves `lifts` alone ships the stale
 * premise, and the census then tells every later reader that a closed question is
 * still pending.
 *
 * THE SELFTEST CANNOT CHECK THIS. Asserting the number is open needs the network;
 * asserting the literal is what let it rot, because the test then only fails when
 * someone changes it deliberately. The test below asserts the SHAPE — pending, not
 * a silent null — and the requirement that it be open lives here, with the value,
 * in one place instead of three.
 */
export const DEFAULT_LIFTS = "#780";

/*
 * EXTRACTED SO IT CAN BE TESTED, because the bug lived exactly here and the
 * selftest could not see it. The first version sniffed for an array with
 * `Object.values(registry).find(Array.isArray)` — a shape borrowed from the run
 * record, which has one array and no ambiguity. checks.json has THREE: `$comment`
 * (prose), `checks` (the registered checkers), `unregistered`. Key order handed it
 * `$comment`: 13 plausible rows, every one a string with no `.name`, and an empty
 * needs map. The audit then refused with the identical message it gave before the
 * fix, and the selftest stayed green on both — a mutation restoring the sniff still
 * passes every case unless this function exists to be called directly.
 *
 * THROWS RATHER THAN RETURNING {}. An empty map and a misread array are the same
 * value, and they mean opposite things: "this repo declares no needs" versus "I
 * read the wrong array and every subject will now be treated as tree-derived".
 * The second silently reinstates the assumption this audit exists to question.
 */
export function needsFrom(registry) {
  if (!registry || !Array.isArray(registry.checks))
    throw new Error(
      "scripts/checks.json has no `checks` array, so no checker's `needs` " +
        "declaration could be read. Every subject would be treated as tree-derived, " +
        "which is the assumption this audit exists to avoid making silently."
    );
  return Object.fromEntries(
    registry.checks.filter((r) => r.needs).map((r) => [r.name, r.needs])
  );
}

/*
 * KEPT OUT OF `merge`, WHICH IS A PURE DATA FUNCTION. Shelling out to git from
 * inside merge would make every one of its cases depend on the ambient repo
 * resolving a hard-coded sha — a test that passes because the sha happens to
 * exist, and flips to `null` in a checkout where it does not. The reading is
 * taken once here, where the sha has already been resolved against a real tree,
 * and passed in as data.
 *
 * NULL MEANS "COULD NOT ASK", NOT "ZERO PARENTS". A root commit has zero; an
 * unresolvable sha has none to report. Those must not collapse.
 */
export function parentCountOf(sha, cwd = ROOT) {
  try {
    // stderr IGNORED, not inherited: an unresolvable sha is an expected input here
    // (it is the "could not ask" case), and git's `fatal: bad object` on the
    // checker's own stderr reads as the checker failing rather than answering.
    const out = execFileSync("git", ["rev-list", "--parents", "-n", "1", sha], {
      encoding: "utf8",
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out === "") return null;
    return out.split(/\s+/).length - 1;
  } catch {
    return null;
  }
}

export function merge(previous, fresh, sha, baseSha, shaParents) {
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
  /*
   * PARENT COUNT IS AN INPUT, NOT A SUBJECT PROPERTY, and that is the line.
   * Provenance describing the measurement's INPUTS gets a field; provenance
   * describing a SUBJECT's nature gets a note on that entry. The commit HAD two
   * parents — that is a fact about what was measured, in the same category as
   * which sha and which base.
   *
   * AND IT IS RECORDED BECAUSE IT DECIDES VERDICTS AND IS OTHERWISE UNRECOVERABLE.
   * `census-survives-the-merge` and `merge-keeps-registrations` refuse on a
   * non-merge HEAD by design, so they classify `static` when measured from a merge
   * commit and `no-baseline` when measured from a squash commit on main — both
   * correct, about different measurement commits. `measuredAt` does not survive the
   * squash and `base` is single-parent, so without this a reader cannot tell whether
   * their re-take is comparable. A fact that decides a verdict should not depend on
   * someone reading prose carefully.
   */
  const out = {
    measuredAt: sha,
    measuredAtParents: shaParents,
    base: baseSha,
    baseNote:
      "readings were taken on `base` WITH this change applied. `measuredAt` is a " +
      "pre-squash commit, so it is NOT in main's history once this lands — but it is " +
      "not lost either: it stays reachable via `refs/pull/N/head`, which GitHub retains " +
      "and which fetches over git protocol. An earlier version of this note claimed it " +
      "'does not survive the merge', which is false and shipped in fb24b13e; the true " +
      "statement is the narrower one, and recovery is awkward only because this file " +
      "names the sha without naming the PR to fetch it from. " +
      "`base` NAMES THE COMMIT THE READINGS WERE TAKEN AGAINST, NOT THE BRANCH'S CURRENT " +
      "BASE: a branch that merges main again afterwards is no longer based on it, and the " +
      "readings do not move when that happens. So a reader re-taking on the branch as it " +
      "stands today is measuring a DIFFERENT tree than this field names, and a difference " +
      "they find is not necessarily a change in what was measured. Re-take against `base` " +
      "itself, or record a new one. " +
      "`measuredAtParents` is recorded because two entries classify differently from a " +
      "merge commit than from a squash commit, and that fact is otherwise unrecoverable once " +
      "`measuredAt` is gone. A reading taken from a single-parent commit is the one a " +
      "re-take on main is comparable to, because main squash-merges and its commits have " +
      "one parent; a reading taken from a merge commit answers about a tree shape main " +
      "never has",
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
        ? {
            note: keep ? old.note : null,
            lifts: keep ? old.lifts : DEFAULT_LIFTS,
          }
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

  /*
   * THE KEY IS NAMED, NOT SNIFFED. The first version of this reused the
   * `Object.values(x).find(Array.isArray)` shape that works on a run record, whose
   * one array is unambiguous. checks.json has THREE — `$comment` (13 prose lines),
   * `checks` (the 49), `unregistered` (13) — and key order handed it `$comment`.
   * It produced 13 plausible rows, every one of them a string with no `.name`, and
   * an EMPTY needs map: the exclusion silently did nothing and the audit refused
   * exactly as it had before the fix. A wrong array that returns zero announces
   * itself; one that returns a confident 13 does not.
   *
   * AND THE FALLBACK IS GONE WITH IT. `?? []` cannot tell "this repo declares no
   * needs" from "I read the wrong array", and those must not look alike — the
   * second silently restores the bug this replaced.
   */
  const registry = JSON.parse(
    readFileSync(join(ROOT, "scripts/checks.json"), "utf8")
  );
  let needsOf;
  try {
    needsOf = needsFrom(registry);
  } catch (e) {
    console.error(`REFUSE: ${e.message}`);
    process.exit(2);
  }

  const fresh = {};
  for (const name of Object.keys(F))
    fresh[name] = classifyOne(F[name], E[name], needsOf[name] ?? null);

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
  const next = merge(previous, fresh, sha, baseSha, parentCountOf(sha));
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
