#!/usr/bin/env node
/**
 * assert-git-subject-stances.mjs — every script that asks git which files exist or changed
 * has DECLARED what it does about untracked ones (#899).
 *
 * THE CLASS, AND WHY A GATE RATHER THAN TEN PATCHES. `git ls-files` and `git diff` answer
 * about the repository, so a branch that ADDS a file is invisible to them until it is
 * committed — which is exactly when someone runs the checker. You have just written the
 * file, you ask about your change, and the answer is about a tree that does not contain it.
 *
 * This was found and patched three times independently: census (#209), classify (#224),
 * assert-formatted (#856). census.mjs's own comment records that the lesson did not travel
 * between two files the SAME AUTHOR wrote back to back. Ten more individual repairs leave
 * the eleventh script, written next month, with the same hole and nothing to catch it.
 *
 * IT CANNOT GO RED IN CI, WHICH IS THE ARGUMENT FOR GATING IT. Measured: an
 * installed-and-built worktree produces ZERO untracked non-ignored files, so in a clean
 * checkout the gap never appears. A class that cannot fail where it is watched only ever
 * costs a human, and only at the moment they most need the answer.
 *
 * IT DOES NOT DEMAND A UNIFORM ANSWER, and that is what keeps it from being bureaucracy.
 * `eject.mjs`'s subject legitimately IS the committed tree — declaring that is correct and
 * complete. What is not acceptable is answering by omission.
 *
 * THE MODEL IS NOT_PUBLIC in public-api-completeness.test.ts: an exemption that cannot be
 * written without its reason stays a decision instead of becoming a reflex.
 *
 * THIS GATE IS INSIDE ITS OWN SUBJECT, DELIBERATELY AND NOT BY EXEMPTION. The detection
 * below matches the literal `"ls-files"` in CODE — this file's own `candidates()` passes it
 * to git — so this script is
 * a member of its own population and must carry a stance like everything else. That is
 * arranged rather than accidental: a gate exempt from its own rule by omission is the exact
 * shape this repo keeps finding, and the selftest asserts the self-entry is present.
 * A mention in a comment would no longer keep it there (#1156): the call is what counts.
 *
 * DETECTION IS INFERRED, SO THE DECLARED SET IS ITS POSITIVE CONTROL. Membership is decided
 * by scanning source for git subcommand literals, and a pattern-based partition can be
 * silently wrong — an earlier hand-run of this same idea classified `run-checks.mjs` as a
 * git-subject script on the strength of `spawnSync("gh", ["auth", "status"])`, which is not
 * git at all, and MISSED `assert-no-undeclared-reverts.mjs` because it uses `git diff --raw`
 * rather than `--name-only`. So rule 2 below is not tidiness: if the classifier ever stops
 * recognising a script that is declared here, that script falls out of the population and
 * the run FAILS. The declaration file is the control that catches the classifier drifting.
 *
 * OVER-INCLUSION IS THE DELIBERATE DIRECTION. A script that mentions a subcommand without
 * deriving a subject from it is asked for one honest line; a script wrongly left out is a
 * silent hole. The costs are not symmetric, so the pattern errs wide.
 *
 * Usage: node scripts/assert-git-subject-stances.mjs [--cwd DIR]
 *
 * Exit: 0 every member has declared · 1 one has not, or a claim is contradicted · 2 the
 *       question could not be asked
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { reportSubject } from "./lib/subject.mjs";
import { invokedAsProgram } from "./lib/is-main.mjs";
import { refuseUnanticipated } from "./lib/refusal.mjs";
import { blankComments } from "./lib/blank-comments.mjs";

const SELF_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/*
 * `--cwd` EXISTS SO THE PROOF CAN DRIVE PLANTED TREES. Without it every case would have to
 * mutate this repository to show the gate can fail, which is how a proof ends up leaving a
 * tree behind when it is interrupted.
 */
const ROOT = (() => {
  const i = process.argv.indexOf("--cwd");
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : SELF_ROOT;
})();
const STANCES = "scripts/git-subject-stances.json";

/** git subcommands that answer "which files exist or changed". */
const SUBJECT_SUBCOMMANDS = ["ls-files", "diff", "status"];

const VALID = new Set(["examined", "out-of-scope", "unexamined"]);

/** A reason short enough to be a placeholder is not a reason. */
const MIN_WHY = 40;

class Refusal extends Error {}

/*
 * THE PARSER IS LOADED HERE, AND ITS ABSENCE IS A REFUSAL, NOT A FALLBACK (#1156). Without it
 * comments cannot be told from code, and scanning the raw source instead is the defect this
 * removes. The error is held rather than thrown so that importing `population` has no side
 * effect; population() refuses when it is asked to decide.
 */
let ts = null;
let tsError = null;
try {
  ts = (await import("typescript")).default;
} catch (e) {
  tsError = e;
}

/**
 * THIS GATE EXAMINES UNTRACKED SCRIPTS, AND IT LEARNED THAT THE HARD WAY ON ITS FIRST RUN.
 *
 * Written with `git ls-files` alone, it reported PASS over 13 scripts — and the fourteenth
 * was ITSELF, uncommitted at the time, therefore invisible. A gate against exactly this
 * defect, committing exactly this defect, in the moment of being written. Nothing in its
 * output hinted at it: 13 is a plausible number and the verdict was green.
 *
 * So the union is not defensive tidiness, it is the only stance this particular script can
 * honestly declare. A NEW git-subject script is precisely what must not slip through, and a
 * new script is untracked at the moment its author would run this. `--exclude-standard`
 * keeps build output and local scratch out; it is the tracked set plus what a commit would
 * add, which is the set the gate is actually making a claim about.
 */
function candidates(cwd) {
  const run = (...args) =>
    execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      maxBuffer: 64 << 20,
    })
      .split("\0")
      .filter(Boolean);
  return [
    ...new Set([
      ...run("ls-files", "-z", "scripts/"),
      ...run("ls-files", "-z", "--others", "--exclude-standard", "scripts/"),
    ]),
  ];
}

/**
 * The population: non-proof scripts whose CODE names a subject subcommand.
 *
 * Selftests are excluded because their git calls belong to the fixtures they build, not to
 * a subject they assert over — a proof that plants a repo and runs `ls-files` inside it is
 * describing its own scaffolding.
 *
 * A COMMENT IS NOT A CALL (#1156). The scan ran over the raw source, so a docstring quoting
 * another file's `ls-files` call (#1153), or a captured GitHub payload containing `"status"`
 * (the review-coverage checker), made a script a member and demanded a stance about a
 * question it never asks. Comments are now blanked first, with offsets preserved. Blanking
 * only turns comment text into spaces, so it can remove a match and never add one: a file
 * whose raw source names no subcommand is not a member, and is not parsed at all.
 *
 * STILL TEXTUAL. A subcommand literal in CODE that is not a git argument (a string constant,
 * a payload inside a template literal) still counts, and "diff" and "status" are ordinary
 * words. Deciding by the argument position of a git call is the stronger repair; this is not
 * that one.
 */
export function population(cwd) {
  const members = [];
  for (const rel of candidates(cwd)) {
    if (!rel.endsWith(".mjs")) continue;
    if (rel.endsWith(".selftest.mjs")) continue;
    const src = readFileSync(join(cwd, rel), "utf8");
    if (!SUBJECT_SUBCOMMANDS.some((c) => src.includes(`"${c}"`))) continue;
    if (!ts)
      throw new Refusal(
        `typescript could not be imported (${tsError?.message}), so no source was ` +
          `parsed, comments cannot be told from code, and which scripts ask git is unknown.`
      );
    const code = blankComments(ts, src, rel);
    if (code === null)
      throw new Refusal(
        `${rel} names a git subcommand but does not parse, so its comments cannot be told ` +
          `from its code, and whether it asks git is unknown.`
      );
    const used = SUBJECT_SUBCOMMANDS.filter((c) => code.includes(`"${c}"`));
    if (used.length === 0) continue;
    // `--others` is read from CODE too: a comment naming it would corroborate a false "examined".
    members.push({ rel, used, passesOthers: code.includes('"--others"') });
  }
  return members.sort((a, b) => a.rel.localeCompare(b.rel));
}

export function analyse(cwd) {
  let declared;
  try {
    declared = JSON.parse(readFileSync(join(cwd, STANCES), "utf8")).stances;
  } catch (e) {
    throw new Refusal(`could not read ${STANCES}: ${e.message}`);
  }
  if (!declared || typeof declared !== "object")
    throw new Refusal(`${STANCES} has no \`stances\` object.`);

  const members = population(cwd);
  if (members.length === 0)
    throw new Refusal(
      `no script in scripts/ names any of ${SUBJECT_SUBCOMMANDS.join(", ")}, ` +
        `which cannot be true of this repository — the scan found nothing to check.`
    );

  const problems = [];
  const byPath = new Map(members.map((m) => [m.rel, m]));

  for (const m of members) {
    const d = declared[m.rel];
    if (!d) {
      problems.push(
        `${m.rel} asks git for ${m.used.join(
          "/"
        )} and declares NO stance on untracked ` +
          `files. Add an entry to ${STANCES}: "examined", "out-of-scope" or "unexamined", ` +
          `with a \`why\` saying what its subject actually is.`
      );
      continue;
    }
    if (!VALID.has(d.untracked))
      problems.push(
        `${m.rel} declares untracked="${d.untracked}", which is not one of ` +
          `${[...VALID].join(", ")}.`
      );
    if (typeof d.why !== "string" || d.why.trim().length < MIN_WHY)
      problems.push(
        `${m.rel} has no usable \`why\`. An exemption without its reason is how an ` +
          `exception list becomes a snapshot — say what the subject is, in a sentence.`
      );
    /*
     * "examined" IS CORROBORATED, NOT TAKEN ON TRUST. Passing `--others` is the only way to
     * see an untracked file, so a script claiming to examine them without it is claiming
     * something its source cannot do. This is the difference between a declaration and a
     * promise.
     */
    if (d.untracked === "examined" && !m.passesOthers)
      problems.push(
        `${m.rel} declares untracked="examined" but its source never passes ` +
          `\`--others\`, so it cannot see an untracked file at all. The declaration and ` +
          `the code disagree.`
      );
    // A GAP MUST POINT SOMEWHERE, the same convention checks.json uses for `lifts`.
    if (d.untracked === "unexamined" && !/^#\d+$/.test(d.lifts ?? ""))
      problems.push(
        `${m.rel} declares untracked="unexamined" — a known gap — but \`lifts\` is ` +
          `${JSON.stringify(
            d.lifts
          )} rather than an issue like "#899". A gap with no ` +
          `pointer is indistinguishable from a decision, and becomes one.`
      );
    if (d.untracked !== "unexamined" && d.lifts != null)
      problems.push(
        `${m.rel} declares untracked="${d.untracked}" but carries lifts=` +
          `${JSON.stringify(
            d.lifts
          )}. Only a gap is pending; a stated decision is not.`
      );
  }

  /*
   * RULE 2 IS THE CLASSIFIER'S POSITIVE CONTROL, not tidiness. Detection is a source scan
   * and a source scan can silently stop matching. If a declared script falls out of the
   * population, either it genuinely stopped using git — in which case delete the entry —
   * or the pattern broke, and this is the only thing that would say so.
   */
  for (const rel of Object.keys(declared)) {
    if (!byPath.has(rel))
      problems.push(
        `${STANCES} declares a stance for ${rel}, which is NOT in the population — it ` +
          `either no longer asks git which files exist (delete the entry) or the ` +
          `detection above has stopped recognising it, which would silently shrink this ` +
          `gate's subject. Do not delete the entry without checking which.`
      );
  }

  return { members, problems, declared };
}

function main() {
  let r;
  try {
    r = analyse(ROOT);
  } catch (e) {
    if (!(e instanceof Refusal)) refuseUnanticipated(e);
    console.error(`REFUSE: ${e.message}`);
    console.error(
      `        Nothing was compared, which is not the same as nothing being wrong.`
    );
    process.exit(2);
  }

  if (r.problems.length) {
    console.error(
      `FAIL: ${r.problems.length} problem(s) with untracked-file stances:`
    );
    r.problems.forEach((p) => console.error(`   - ${p}`));
    console.error(
      `\n  WHY THIS IS GATED: git ls-files and git diff answer about the repository, so a\n` +
        `  branch that ADDS a file is invisible to them until it is committed — which is the\n` +
        `  moment someone runs the checker. Found and patched three times independently\n` +
        `  (#209, #224, #856) before anyone gated it. The stance may be "out-of-scope"; it\n` +
        `  may not be silence.`
    );
    process.exit(1);
  }

  const counts = {};
  for (const m of r.members) {
    const s = r.declared[m.rel].untracked;
    counts[s] = (counts[s] ?? 0) + 1;
  }
  reportSubject(
    r.members.length,
    "script(s) that ask git which files exist or changed, each with a declared stance"
  );
  console.log(
    `PASS: every git-subject script declares what it does about untracked files ` +
      `(${Object.entries(counts)
        .sort()
        .map(([k, v]) => `${v} ${k}`)
        .join(", ")}).`
  );
}

if (invokedAsProgram(import.meta.url)) main();
