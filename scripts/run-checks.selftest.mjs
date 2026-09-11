#!/usr/bin/env node
/**
 * Proof for run-checks.mjs.
 *
 * The case that matters most is the ANNOTATION one, and it is watched rather than assumed.
 *
 * Consolidating 55 named steps into one costs the step name that told you what broke before
 * you opened a log. `::error title=…::` is the replacement. A runner that ran the checks, saw
 * one fail, and reported it only in a printed summary would look identical from the outside —
 * green step names gone, no annotation, a failure discoverable only by reading a log — and
 * that is precisely the regression this refactor exists to prevent. So a check is made to
 * fail for real and the annotation is read off stdout, in the shape check-github-reporter's
 * live half established.
 *
 * The second is the hole case: a check declared in the list that the runner does not execute
 * must be visible as an absence in the record, because that is the only thing keeping the
 * declaration from being self-certifying.
 *
 * Usage: node scripts/run-checks.selftest.mjs
 */
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { firstMeaningfulLine, treeProvenance } from "./run-checks.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, "run-checks.mjs");
const TMP = mkdtempSync(join(tmpdir(), "runchecks-"));

let pass = 0;
let fail = 0;

/** A tree with a check list and whatever scripts the case declares. */
function sandbox(checks, files) {
  const dir = mkdtempSync(join(TMP, "case-"));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  /*
   * `floor` is MANDATORY in production (#741), so every case would otherwise be
   * refused for a reason it is not about. The harness supplies what a real
   * checks.json must declare — `floor: 0`, the reviewable "an empty domain is
   * correct here" — and the cases that are ABOUT the floor state their own.
   * Defaulted here rather than in the runner on purpose: a runner default is an
   * invisible one, which is the thing #741 refuses.
   */
  const declared = checks.map((c) =>
    Object.prototype.hasOwnProperty.call(c, "floor") ? c : { ...c, floor: 0 }
  );
  writeFileSync(
    join(dir, "scripts", "checks.json"),
    JSON.stringify({ checks: declared }, null, 2)
  );
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}

function run(dir, envOverride = {}) {
  // The channel cases pin GITHUB_ACTIONS on purpose: satisfiability is derived from the
  // environment, so leaving it to whatever this machine happens to be would make the cases
  // depend on the tester's `gh` login rather than on the runner.
  const env = { ...process.env, ...envOverride };
  for (const k of Object.keys(envOverride))
    if (envOverride[k] === undefined) delete env[k];
  try {
    return {
      rc: 0,
      out: execFileSync("node", [RUNNER, "--cwd", dir], {
        encoding: "utf8",
        env,
      }),
    };
  } catch (e) {
    return { rc: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

/** Actions, with a credential the repo-settings channel accepts. */
const WITH_TOKEN = {
  GITHUB_ACTIONS: "true",
  PROTECTION_READ_TOKEN: "fake-token-for-the-proof",
  GITHUB_EVENT_NAME: "push",
  GITHUB_EVENT_PATH: undefined,
};
/** Actions, with none. This is the repository as it stands today. */
const WITHOUT_TOKEN = {
  GITHUB_ACTIONS: "true",
  PROTECTION_READ_TOKEN: undefined,
  GITHUB_EVENT_NAME: "push",
  GITHUB_EVENT_PATH: undefined,
};

const OK =
  // A passing CHECKER must report what it examined (#741); a proof need not,
  // and this body is used as both. Emitting it here keeps every case that is
  // not about subjects testing what it was written to test.
  'console.log("SUBJECT: 7 thing(s) examined");\n' + "process.exit(0);\n";
const BAD =
  'console.error("FAIL: the planted defect, said out loud");\nprocess.exit(1);\n';
// A checker that REFUSES: it could not ask its question. Exit 2 is the split 37 scripts in
// this directory use, and before #684 the record spelled it the same as BAD.
const REFUSES =
  'console.error("COULD NOT COMPUTE: no token, so nothing was compared");\nprocess.exit(2);\n';

function record(dir) {
  const p = join(dir, ".checks-run.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")).ran : null;
}

function ok(label, cond, note) {
  if (cond) {
    console.log(`  ok   ${label.padEnd(56)} (${note})`);
    pass++;
  } else {
    console.error(`  FAIL ${label}`);
    fail++;
  }
}

console.log("\nrun-checks.mjs self-test\n");

{
  /*
   * THE LIVE HALF. A real failure, and the annotation is read off stdout — not "the code
   * contains an ::error:: template", which is a claim about source rather than behaviour.
   */
  const dir = sandbox(
    [
      {
        name: "planted",
        proof: "scripts/p.mjs",
        checker: "scripts/c.mjs",
        why: "x",
      },
    ],
    { "scripts/p.mjs": OK, "scripts/c.mjs": BAD }
  );
  const { rc, out } = run(dir);
  const line = out.split("\n").find((l) => l.startsWith("::error"));
  ok(
    "a real failure EMITS ::error naming the checker",
    rc !== 0 &&
      Boolean(line) &&
      line.includes("title=planted") &&
      line.includes("checker"),
    line ? line.slice(0, 62) : "no annotation emitted"
  );
  ok(
    "...and the annotation carries the reason, not just the name",
    Boolean(line) && line.includes("planted defect"),
    "reason present"
  );
  ok(
    "...and the record is written even though it failed",
    (record(dir) ?? []).some(
      (r) => r.name === "planted" && r.status === "fail"
    ),
    "recorded as fail"
  );
}

{
  // A checker whose PROOF failed tells you nothing, so it must not run — and the record has
  // to show that it did not, or a reader would assume the checker passed.
  const dir = sandbox(
    [
      {
        name: "unproven",
        proof: "scripts/p.mjs",
        checker: "scripts/c.mjs",
        why: "x",
      },
    ],
    { "scripts/p.mjs": BAD, "scripts/c.mjs": OK }
  );
  const { rc } = run(dir);
  const ran = record(dir) ?? [];
  ok(
    "a failed proof stops its checker from running",
    rc !== 0 &&
      ran.some((r) => r.phase === "proof" && r.status === "fail") &&
      !ran.some((r) => r.phase === "checker"),
    "proof failed, checker absent from the record"
  );
}

{
  // The hole. Nothing here executes the declared check, so it must be missing from the
  // record — which is what assert-checker-proof-pairing.mjs reads to catch exactly this.
  const dir = sandbox(
    [
      {
        name: "ran",
        proof: "scripts/p.mjs",
        checker: "scripts/c.mjs",
        why: "x",
      },
      {
        name: "declared-only",
        proof: "scripts/q.mjs",
        checker: "scripts/d.mjs",
        why: "x",
      },
    ],
    {
      "scripts/p.mjs": OK,
      "scripts/c.mjs": OK,
      "scripts/q.mjs": OK,
      "scripts/d.mjs": OK,
    }
  );
  run(dir);
  const ran = record(dir) ?? [];
  // Both DO run here — the point of the case is that the record names each execution, so an
  // entry that never ran cannot be inferred as having passed.
  ok(
    "the record names every execution individually",
    ran.filter((r) => r.name === "declared-only").length === 2 &&
      ran.every((r) => typeof r.exit === "number"),
    `${ran.length} phases recorded`
  );
}

{
  const dir = sandbox([], {});
  const { rc, out } = run(dir);
  ok(
    "an EMPTY list is exit 2, not a green",
    rc === 2 && out.includes("declares no checks"),
    "refused"
  );
}

{
  /*
   * A DECLARED SCRIPT THAT IS NOT IN THE TREE IS exit 2, NOT exit 1.
   *
   * `node missing.mjs` exits 1, which here means "the property is VIOLATED" — so before this,
   * a checker that was renamed or never landed was indistinguishable from one that found a
   * real defect. Both the status and the message are asserted: a run that stopped exercising
   * a registration has to SAY which one, or the next reader debugs the wrong thing.
   */
  const dir = sandbox(
    [
      {
        name: "gone",
        proof: "scripts/gone.selftest.mjs",
        checker: "scripts/gone.mjs",
      },
    ],
    { "scripts/gone.selftest.mjs": OK }
  );
  const { rc, out } = run(dir);
  ok(
    "a DECLARED script that is absent is exit 2, not exit 1",
    rc === 2 && out.includes("ABSENT") && out.includes("scripts/gone.mjs"),
    `exit ${rc}${out.includes("scripts/gone.mjs") ? ", named it" : ""}`
  );
}

{
  /*
   * THE PRESENCE COMPANION, and it is what stops the case above from being satisfied by a
   * runner that calls everything absent. Same shape of declaration, both files present, and
   * the run must reach a normal verdict instead of refusing.
   */
  const dir = sandbox(
    [
      {
        name: "here",
        proof: "scripts/here.selftest.mjs",
        checker: "scripts/here.mjs",
      },
    ],
    { "scripts/here.selftest.mjs": OK, "scripts/here.mjs": OK }
  );
  const { rc, out } = run(dir);
  ok(
    "...and a script that IS present is not called absent",
    rc === 0 && !out.includes("ABSENT"),
    `exit ${rc}`
  );
}

{
  /*
   * ABSENCE OUTRANKS FAILURE. A run drawn from an incomplete list cannot support "everything
   * else passed", so the weaker verdict claims the exit code even when something genuinely
   * failed — while the failure is still printed, because suppressing it would trade one
   * silence for another.
   */
  const dir = sandbox(
    [
      {
        name: "gone",
        proof: "scripts/gone.selftest.mjs",
        checker: "scripts/gone.mjs",
      },
      {
        name: "bad",
        proof: "scripts/bad.selftest.mjs",
        checker: "scripts/bad.mjs",
      },
    ],
    {
      "scripts/gone.selftest.mjs": OK,
      "scripts/bad.selftest.mjs": OK,
      "scripts/bad.mjs": BAD,
    }
  );
  const { rc, out } = run(dir);
  ok(
    "absent OUTRANKS failed, and the failure is still reported",
    rc === 2 && out.includes("ABSENT") && out.includes("also FAILED"),
    `exit ${rc}`
  );
}

{
  const dir = mkdtempSync(join(TMP, "nolist-"));
  const { rc, out } = run(dir);
  ok(
    "a MISSING list is exit 2, not a green",
    rc === 2 && out.includes("no check list"),
    "refused"
  );
}

{
  const dir = sandbox(
    [
      {
        name: "clean",
        proof: "scripts/p.mjs",
        checker: "scripts/c.mjs",
        why: "x",
      },
    ],
    { "scripts/p.mjs": OK, "scripts/c.mjs": OK }
  );
  const { rc, out } = run(dir);
  const ran = record(dir) ?? [];
  ok(
    "an all-green list exits 0 and emits no annotation",
    rc === 0 && !out.includes("::error") && ran.length === 2,
    "clean"
  );
}

/* ------------------------------------------------------------------ *
 * DECLARED CHANNELS (#404)
 *
 * A check may declare `needs: "<channel>"` and have its CHECKER skipped where that channel is
 * unavailable. That is a tolerance mechanism, and a tolerance mechanism is the thing most
 * likely to become a general opt-out — so these cases exist to pin the four properties that
 * keep it from being one, and the first of them is the one that matters most.
 * ------------------------------------------------------------------ */

const NEEDS = (needs) => ({
  name: "gated",
  proof: "scripts/p.mjs",
  checker: "scripts/c.mjs",
  needs,
  // A `needs` entry with no `subjectKind` is a MALFORMED DECLARATION, rejected before
  // anything executes (#1007). These fixtures are about channel and skip behaviour, so
  // they must be well-formed declarations or they never reach what they name.
  subjectKind: "tree",
  why: "x",
});

{
  /*
   * THE CASE THAT KEEPS THE ENUMERATION CLOSED. A closed set that fails open on an unknown
   * value is not closed. Someone adding a second channel carelessly — a typo, a rename, a
   * value from a branch that never landed — must get a refusal, not a check that quietly runs
   * unconditionally and not a check that quietly stops running.
   */
  const dir = sandbox([NEEDS("repo-admin")], {
    "scripts/p.mjs": OK,
    "scripts/c.mjs": OK,
  });
  const { rc, out } = run(dir, WITHOUT_TOKEN);
  ok(
    "an UNRECOGNISED needs value REFUSES — it is not treated as unconditional",
    rc === 2 &&
      out.includes('needs: "repo-admin"') &&
      out.includes("repo-settings"),
    "exit 2, naming the bad value and the channels that exist"
  );
  ok(
    "...and nothing was executed, so no record can imply otherwise",
    record(dir) === null,
    "no .checks-run.json written"
  );
}

{
  // An unsatisfiable channel skips the CHECKER. The PROOF is offline and must still run: a
  // checker nobody has watched fail is worthless whether or not it ran.
  const dir = sandbox([NEEDS("repo-settings")], {
    "scripts/p.mjs": OK,
    "scripts/c.mjs": OK,
  });
  const { rc, out } = run(dir, WITHOUT_TOKEN);
  const ran = record(dir) ?? [];
  const proof = ran.find((r) => r.phase === "proof");
  const checker = ran.find((r) => r.phase === "checker");
  ok(
    "an unsatisfiable channel skips the CHECKER and still runs the PROOF",
    proof?.status === "pass" && checker?.status === "skipped",
    "proof pass, checker skipped"
  );
  ok(
    "...the record says skipped, NOT pass, and carries no exit code to misread",
    checker?.status === "skipped" &&
      checker?.exit === null &&
      checker?.channel === "repo-settings" &&
      typeof checker?.because === "string" &&
      checker.because.length > 0,
    "status=skipped, exit=null, reason recorded"
  );
  ok(
    "...a ::warning:: names the check and says it reported NOTHING",
    out
      .split("\n")
      .some(
        (l) =>
          l.startsWith("::warning") &&
          l.includes("gated") &&
          l.includes("not the same as it passing")
      ),
    "annotated as unmeasured"
  );
  ok(
    "...and the run is GREEN, not red — a permission it can never hold is not a failure",
    rc === 0 && out.includes("NOT MEASURED") && !out.includes("::error"),
    "exit 0 with the hole announced"
  );
  ok(
    "...with skipped EXCLUDED from the executed count, never summed into it",
    /1 declared check\(s\), 1 phase\(s\) executed/.test(out),
    "1 phase executed, not 2"
  );
}

{
  /*
   * THE ACCEPT CASE. Without it, a runner that skipped everything unconditionally would
   * satisfy every assertion above — which is the same trap the checker's own proof avoids by
   * carrying accept cases.
   */
  const dir = sandbox([NEEDS("repo-settings")], {
    "scripts/p.mjs": OK,
    // Also proves the channel HANDS ITS CREDENTIAL to the checker, rather than declaring it
    // satisfiable and then running the checker without one.
    "scripts/c.mjs":
      'if (process.env.GH_TOKEN !== "fake-token-for-the-proof") {\n' +
      '  console.error("FAIL: the channel did not provide GH_TOKEN");\n' +
      "  process.exit(1);\n}\n" +
      'console.log("SUBJECT: 1 credential checked");\n' +
      "process.exit(0);\n",
  });
  const { rc, out } = run(dir, WITH_TOKEN);
  const ran = record(dir) ?? [];
  ok(
    "a SATISFIABLE channel runs the checker and provides its credential",
    rc === 0 &&
      ran.filter((r) => r.status === "pass").length === 2 &&
      !ran.some((r) => r.status === "skipped") &&
      !out.includes("NOT MEASURED"),
    "both phases executed, GH_TOKEN present"
  );
}

{
  /*
   * A CHECK CANNOT DECLARE ITSELF UNAVAILABLE. Satisfiability is derived by the runner from
   * the environment; the entry only names a channel. If any field on the entry could switch a
   * check off, the enumeration would be decorative.
   */
  const dir = sandbox(
    [
      {
        ...NEEDS("repo-settings"),
        satisfiable: false,
        skip: true,
        enabled: false,
      },
    ],
    { "scripts/p.mjs": OK, "scripts/c.mjs": OK }
  );
  const { rc } = run(dir, WITH_TOKEN);
  const ran = record(dir) ?? [];
  ok(
    "a check CANNOT opt itself out — only the runner's derivation decides",
    rc === 0 &&
      ran.filter((r) => r.status === "pass").length === 2 &&
      !ran.some((r) => r.status === "skipped"),
    "self-declared skip ignored, checker ran"
  );
}

{
  /*
   * THE FORK CONJUNCT, ON ITS OWN. Today it is redundant — a fork cannot reach the secret, so
   * the credential conjunct already decides. It is pinned separately so it keeps deciding if a
   * workflow ever runs on `pull_request_target`, where secrets ARE exposed to an untrusted
   * head and the credential conjunct would say yes.
   */
  const dir = sandbox([NEEDS("repo-settings")], {
    "scripts/p.mjs": OK,
    "scripts/c.mjs": OK,
  });
  const evt = join(dir, "event.json");
  writeFileSync(
    evt,
    JSON.stringify({
      pull_request: { head: { repo: { full_name: "someone/fork" } } },
    })
  );
  const { rc, out } = run(dir, {
    ...WITH_TOKEN,
    GITHUB_EVENT_NAME: "pull_request_target",
    GITHUB_EVENT_PATH: evt,
    GITHUB_REPOSITORY: "acme/widget",
  });
  const checker = (record(dir) ?? []).find((r) => r.phase === "checker");
  ok(
    "a FORK head is unsatisfiable even with the credential present",
    rc === 0 &&
      checker?.status === "skipped" &&
      /fork pull request/.test(checker?.because ?? ""),
    "skipped on the fork conjunct alone"
  );
}

{
  /*
   * THE SECOND CHANNEL VALUE IS IN THE ENUMERATION (#467). The unrecognised-`needs` case above
   * proves an unknown value is fatal; this proves `merge-commit` is not one — otherwise adding
   * a channel to the object and forgetting to keep it recognised would surface as every check
   * declaring it refusing, which reads as the check being broken rather than the list.
   *
   * Deliberately does NOT assert which way it resolves: satisfiability is derived from the
   * repository's HEAD, so a case pinning "skips" or "runs" would pass or fail on whether the
   * suite happened to be run on a merge commit. What is stable, and what matters here, is that
   * the value is KNOWN.
   */
  const dir = sandbox([NEEDS("merge-commit")], {
    "scripts/p.mjs": OK,
    "scripts/c.mjs": OK,
  });
  const { rc, out } = run(dir, WITHOUT_TOKEN);
  ok(
    "`merge-commit` is a RECOGNISED channel, not an unknown one",
    rc !== 2 && !out.includes("is not one of the channels"),
    "declared without a fatal"
  );
}

{
  /*
   * A REFUSAL IS RECORDED AS A REFUSAL, NOT AS A FAILURE (#684).
   *
   * The runner mapped every non-zero exit to "fail", so a checker exiting 2 — "I could not ask
   * the question" — was persisted under the same word as one exiting 1, "the property is
   * violated". Nothing was FOOLED by it: pairing keys on `!== "skipped"`, and the raw code
   * survives in the `exit` field. The damage was to the artifact people read, and to anything
   * computing a pass rate over `status`, which counts refusals as violations — the arithmetic
   * ci-completion.mjs refuses for cancelled runs.
   *
   * THE EXIT CODE IS ASSERTED UNCHANGED on purpose. This changes what the run SAYS, not what
   * it decides: a refusal was non-green before and is non-green now. A fix that also moved the
   * exit code would be two changes wearing one issue number.
   */
  const dir = sandbox(
    [
      {
        name: "refuser",
        proof: "scripts/p.mjs",
        checker: "scripts/c.mjs",
        why: "x",
      },
    ],
    { "scripts/p.mjs": OK, "scripts/c.mjs": REFUSES }
  );
  const { rc, out } = run(dir);
  const entry = (record(dir) ?? []).find((r) => r.phase === "checker");
  ok(
    "a checker exiting 2 is recorded as REFUSED, not as fail",
    entry?.status === "refused",
    `status=${entry?.status}`
  );
  ok(
    "...and the raw exit code is preserved beside it",
    entry?.exit === 2,
    `exit=${entry?.exit}`
  );
  /*
   * THE EXIT CODE IS 2, AND CI IS STILL RED (#689). Both are asserted, because they are two
   * claims: that a refusal joins `absent` in "the question could not be asked", and that no
   * job outcome moves because 1 and 2 are both non-zero. A change that silently made this
   * GREEN would satisfy "not 1" and is the thing worth guarding.
   */
  ok(
    "a refusal claims exit 2, not 1 — the same code `absent` claims",
    rc === 2,
    `rc=${rc}`
  );
  ok(
    "...and CI does not move: still non-zero, so every red job stays red",
    rc !== 0,
    `rc=${rc}`
  );
  ok(
    "...and the summary names it REFUSED rather than folding it into failed",
    /REFUSED/.test(out) && /the question could not be asked/.test(out),
    out
      .split("\n")
      .find((l) => l.includes("REFUSED"))
      ?.trim()
      .slice(0, 70) ?? "no REFUSED line"
  );
  ok(
    "...and it is not counted among the executed-and-green",
    !/all green/.test(out),
    "no false PASS line"
  );
}

{
  /*
   * AN ABSENCE AND A REFUSAL IN THE SAME RUN, AND BOTH ARE NAMED (#689).
   *
   * Measured on the real code before this change: a fixture carrying an absence, a refusal and
   * a failure exited 2, printed the absence and "1 phase(s) also FAILED", and NEVER MENTIONED
   * THE REFUSAL. It was in the record and missing from the summary — introduced by #684, which
   * added refusals to the exit-1 branch and not to the absent one.
   *
   * This is the three-way case the precedence question is really about, and the answer is that
   * there is no ordering to get wrong: absence and refusal are the same category, both claim
   * exit 2, and a failure alongside them is printed rather than ranked.
   */
  const dir = sandbox(
    [
      {
        name: "gone",
        proof: "scripts/p1.mjs",
        checker: "scripts/missing.mjs",
        why: "x",
      },
      {
        name: "refuser",
        proof: "scripts/p2.mjs",
        checker: "scripts/c2.mjs",
        why: "x",
      },
      {
        name: "breaker",
        proof: "scripts/p3.mjs",
        checker: "scripts/c3.mjs",
        why: "x",
      },
    ],
    {
      "scripts/p1.mjs": OK,
      "scripts/p2.mjs": OK,
      "scripts/p3.mjs": OK,
      "scripts/c2.mjs": REFUSES,
      "scripts/c3.mjs": BAD,
    }
  );
  const { rc, out } = run(dir);
  ok(
    "absence + refusal + failure exits 2, the weaker verdict",
    rc === 2,
    `rc=${rc}`
  );
  ok(
    "...and the ABSENCE is named",
    /ABSENT from the tree/.test(out),
    "absence named"
  );
  ok(
    "...and the REFUSAL is named — the summary gap #684 left",
    /REFUSED \(exit 2\) — refuser/.test(out),
    out
      .split("\n")
      .find((l) => l.includes("REFUSED"))
      ?.trim()
      .slice(0, 60) ?? "REFUSAL NOT MENTIONED"
  );
  ok(
    "...and the FAILURE is still printed rather than ranked away",
    /also FAILED: breaker/.test(out),
    "failure named"
  );
  const statuses = (record(dir) ?? []).map((r) => r.status).sort();
  ok(
    "...and the record still carries all three apart",
    statuses.includes("absent") &&
      statuses.includes("refused") &&
      statuses.includes("fail"),
    statuses.join(",")
  );
}

/* ── #741: a pass that examined NOTHING must not read as a pass ────────────── */

{
  /*
   * RED 1 — THE #750 RECONSTRUCTION, and it is a real historical input rather
   * than a constructed fixture.
   *
   * DEV3-lang's restriction checker matched 0 files, excluded all three
   * restrictions it existed to count, printed "0 restriction(s) in scope", and
   * exited 0. It named its subject. A free-text `subject` field would have been
   * satisfied by it — which is why the bar is a COUNT AGAINST A DECLARED FLOOR
   * and not prose.
   */
  const dir = sandbox(
    [
      {
        name: "zero-subject",
        proof: "scripts/p.mjs",
        checker: "scripts/c.mjs",
        floor: 1,
        floorObserved: {
          sha: "0123456789abcdef0123456789abcdef01234567",
          count: 9,
          on: "2026-09-05",
        },
      },
    ],
    {
      "scripts/p.mjs": "process.exit(0);\n",
      "scripts/c.mjs":
        'console.log("0 restriction(s) in scope");\n' +
        'console.log("SUBJECT: 0 restriction(s) in scope");\n' +
        "process.exit(0);\n",
    }
  );
  const r = run(dir);
  ok(
    "RED 1 — a pass reporting 0 against a floor of 1 is refused",
    r.rc !== 0,
    `rc ${r.rc}`
  );
  ok(
    "RED 1 — the refusal names the count and the floor",
    /\b0\b/.test(r.out) && /floor/i.test(r.out),
    "a refusal that does not say what it measured cannot be acted on"
  );
}

{
  /*
   * RED 2 — THE NON-ADOPTER. A checker emitting no subject at all is REFUSED,
   * not passed. Otherwise the field is optional, most registered checks never
   * emit one, and the record looks complete while being honest about a handful
   * — worse than today, when nobody believes the ok line says anything.
   */
  const dir = sandbox(
    [
      {
        name: "no-subject",
        proof: "scripts/p.mjs",
        checker: "scripts/c.mjs",
        floor: 1,
        floorObserved: {
          sha: "0123456789abcdef0123456789abcdef01234567",
          count: 9,
          on: "2026-09-05",
        },
      },
    ],
    {
      "scripts/p.mjs": "process.exit(0);\n",
      "scripts/c.mjs":
        'console.log("PASS: everything is fine");\nprocess.exit(0);\n',
    }
  );
  const r = run(dir);
  ok(
    "RED 2 — a checker that emits no subject is refused, not passed",
    r.rc !== 0,
    `rc ${r.rc}`
  );
  /*
   * AND IT MUST BE THE GUARD THAT FIRED, NOT A CRASH. `rc !== 0` alone cannot
   * tell "the runner refused with a diagnosis" from "the runner threw on a null
   * subject" — a TypeError is also non-zero. Disabling the `!subject` guard was
   * measured leaving this case GREEN at rc 1 with a TypeError in the output, so
   * the arm could not fail for its own reason.
   *
   * RED 1 and the no-floor case already assert their refusal text; this one had
   * no message companion, which is the whole of the difference. Found by
   * DEV3-lang, by mutation, in a change whose subject is checks that claim more
   * than they do.
   */
  ok(
    "RED 2 — ...and the refusal NAMES the missing subject, so a crash cannot pass for it",
    /without reporting a subject/.test(r.out ?? "") &&
      !/TypeError/.test(r.out ?? ""),
    "an exit code cannot attribute a failure"
  );
}

{
  /* #768 — a derived floor with NO tree it was observed against is FATAL. */
  const dir = sandbox(
    [
      {
        name: "unanchored",
        proof: "scripts/p.mjs",
        checker: "scripts/c.mjs",
        floor: 3,
      },
    ],
    {
      "scripts/p.mjs": "process.exit(0);\n",
      "scripts/c.mjs":
        'console.log("SUBJECT: 41 file(s) swept");\nprocess.exit(0);\n',
    }
  );
  const r = run(dir);
  ok(
    "a derived floor with no floorObserved is FATAL",
    r.rc === 2 && /records no tree it was observed against/.test(r.out ?? ""),
    `rc ${r.rc}`
  );
}

{
  /* The COMPANION that keeps the arm above from being satisfied by any old object. */
  const dir = sandbox(
    [
      {
        name: "badsha",
        proof: "scripts/p.mjs",
        checker: "scripts/c.mjs",
        floor: 3,
        floorObserved: { sha: "not-a-sha", count: 41, on: "2026-09-05" },
      },
    ],
    {
      "scripts/p.mjs": "process.exit(0);\n",
      "scripts/c.mjs":
        'console.log("SUBJECT: 41 file(s) swept");\nprocess.exit(0);\n',
    }
  );
  const r = run(dir);
  ok(
    "a floorObserved whose sha is not a sha is FATAL",
    r.rc === 2 && /records no tree it was observed against/.test(r.out ?? ""),
    `rc ${r.rc}`
  );
}

{
  /* A record BELOW its own floor contradicts the floor — the two cannot both be right. */
  const dir = sandbox(
    [
      {
        name: "contradicts",
        proof: "scripts/p.mjs",
        checker: "scripts/c.mjs",
        floor: 90,
        floorObserved: {
          sha: "0123456789abcdef0123456789abcdef01234567",
          count: 41,
          on: "2026-09-05",
        },
      },
    ],
    {
      "scripts/p.mjs": "process.exit(0);\n",
      "scripts/c.mjs":
        'console.log("SUBJECT: 95 file(s) swept");\nprocess.exit(0);\n',
    }
  );
  const r = run(dir);
  ok(
    "a floorObserved BELOW its own floor is FATAL even when the run is above both",
    r.rc === 2 && /CONTRADICTS the floor/.test(r.out ?? ""),
    `rc ${r.rc}`
  );
}

{
  /* floorPending is exempt — it declares floor 0 and has nothing to anchor yet. */
  const dir = sandbox(
    [
      {
        name: "pending",
        proof: "scripts/p.mjs",
        checker: "scripts/c.mjs",
        floor: 0,
        floorPending: true,
      },
    ],
    {
      "scripts/p.mjs": "process.exit(0);\n",
      "scripts/c.mjs":
        'console.log("SUBJECT: 7 file(s) swept");\nprocess.exit(0);\n',
    }
  );
  const r = run(dir);
  ok(
    "a floorPending check needs no floorObserved (the companion)",
    r.rc === 0,
    `rc ${r.rc}`
  );
}

/* ── #825: a declaration guard must fire where the CREDENTIAL is absent ───── */
{
  /*
   * THE DEFECT THIS PINS. `no integer floor` lived in `subjectComplaint`, which is reached
   * only by a check that RAN — so a check whose channel is unsatisfiable never reached it.
   * In CI that is three of the four channelled checks: `repo-settings` needs a token this
   * repo may not have, and `merge-commit` needs a two-parent HEAD, which is false on every
   * ordinary PR. Measured before the move: exit 2 locally, exit 0 under CI shape.
   *
   * BOTH ENVIRONMENTS, because one of them gates merges and the other is the one that passed
   * throughout the defect's life. THE PINNED ARM IS THE ONE THAT CARRIES THE CLAIM: the first
   * reads the AMBIENT environment, so when this suite is itself run under CI shape both arms
   * are CI-shaped and the first stops being a second reading. Naming it "locally" would have
   * been a test claiming more than it tests — a truly-local arm is not reliably constructible
   * here, because with GITHUB_ACTIONS unset satisfiability falls through to `gh auth status`
   * and would depend on the tester's login, which is what this file's own run() comment
   * warns against.
   */
  const decl = [
    {
      name: "no-floor",
      proof: "scripts/p.mjs",
      checker: "scripts/c.mjs",
      needs: "repo-settings",
      // Declared so this arm fails for the reason it NAMES rather than for a missing
      // subjectKind, which is fatal earlier (#1007).
      subjectKind: "tree",
      // `floor: undefined` and not omission: sandbox() injects `floor: 0` unless the key is
      // PRESENT, and JSON.stringify then drops it — so the entry reaches the runner with no
      // floor at all, which is the state under test.
      floor: undefined,
    },
  ];
  const files = {
    "scripts/p.mjs": "process.exit(0);\n",
    "scripts/c.mjs": 'console.log("SUBJECT: 7 things");\nprocess.exit(0);\n',
  };
  const local = run(sandbox(decl, files));
  ok(
    "a channelled check with no floor is FATAL in the ambient environment",
    local.rc === 2 && /declares no integer/.test(local.out ?? ""),
    `rc ${local.rc}`
  );
  const ci = run(sandbox(decl, files), {
    GITHUB_ACTIONS: "true",
    PROTECTION_READ_TOKEN: undefined,
  });
  ok(
    "...and FATAL under a PINNED CI shape — the arm that carries the claim",
    ci.rc === 2 && /declares no integer/.test(ci.out ?? ""),
    `rc ${ci.rc} — before #825 this was rc 0, the check unreachable`
  );
}

/* ── #811: the record's FORM follows the subject's KIND ──────────────────── */
const P = { proof: "scripts/p.mjs", checker: "scripts/c.mjs" };
const FILES = {
  "scripts/p.mjs": "process.exit(0);\n",
  "scripts/c.mjs":
    'console.log("SUBJECT: 41 file(s) swept");\nprocess.exit(0);\n',
};
const kindCase = (extra) =>
  run(sandbox([{ name: "k", ...P, floor: 3, ...extra }], FILES));

{
  const r = kindCase({ needs: "repo-settings" });
  ok(
    "a channelled check with a floor and no subjectKind is FATAL",
    r.rc === 2 && /no ?subjectKind/.test((r.out ?? "").replace(/\s+/g, " ")),
    `rc ${r.rc}`
  );
}
/*
 * THE SAME GUARD AT floor: 0, WHICH IS THE PATH IT COULD NOT REACH (#1007).
 *
 * The arm above uses kindCase's `floor: 3`. That is why nobody noticed the guard sat after
 * `if (!(c.floor > 0) || c.floorPending) return null;` in `subjectComplaint` — the only case
 * driving it took the one route where the early return does not fire. Every real check
 * declaring `needs` and no `subjectKind` has `floor: 0`, so the guard was proven on the path
 * where it worked and unreachable on every path where it was needed.
 *
 * Reverting the move to `declarationComplaint` fails THIS arm and leaves the one above green,
 * which is the discriminator: the two differ only in the floor.
 */
{
  const r = kindCase({ needs: "repo-settings", floor: 0 });
  ok(
    "...and at floor 0, where the old placement could not reach it",
    r.rc === 2 && /no ?subjectKind/.test((r.out ?? "").replace(/\s+/g, " ")),
    `rc ${r.rc}`
  );
}
{
  const r = kindCase({ subjectKind: "sideways" });
  ok(
    "a subjectKind that is neither tree nor external is FATAL",
    r.rc === 2 && /neither "tree" nor/.test(r.out ?? ""),
    `rc ${r.rc}`
  );
}
{
  const r = kindCase({
    subjectKind: "external",
    floorObserved: { count: 41, on: "2026-09-05" },
  });
  ok(
    "an EXTERNAL record with no source is FATAL",
    r.rc === 2 && /records no source it was observed from/.test(r.out ?? ""),
    `rc ${r.rc}`
  );
}
{
  /*
   * THE ARM THIS ISSUE EXISTS FOR. Both original instances carried a sha for a subject no
   * sha describes, and a flag beside it would have left the sha there and left it wrong.
   */
  const r = kindCase({
    subjectKind: "external",
    floorObserved: {
      source: "GitHub branch-protection API",
      sha: "70fb8afa39bffab1691dbd74acceb930ad4e1993",
      count: 41,
      on: "2026-09-05",
    },
  });
  ok(
    "an EXTERNAL record CARRYING a sha is FATAL",
    r.rc === 2 &&
      /NOTHING AT THAT SHA DESCRIBES THIS SUBJECT/.test(r.out ?? ""),
    `rc ${r.rc}`
  );
}
{
  const r = kindCase({
    subjectKind: "external",
    floorObserved: {
      source: "GitHub branch-protection API",
      count: 41,
      on: "2026-09-05",
    },
  });
  ok(
    "an EXTERNAL record with a source PASSES (the companion)",
    r.rc === 0,
    `rc ${r.rc}`
  );
}
{
  const r = kindCase({
    subjectKind: "tree",
    floorObserved: {
      sha: "0123456789abcdef0123456789abcdef01234567",
      count: 41,
      on: "2026-09-05",
    },
  });
  ok(
    "a TREE record with a sha still PASSES (the companion)",
    r.rc === 0,
    `rc ${r.rc}`
  );
}
{
  /* The contradiction check must read `source` rather than a sha it does not have. */
  const r = run(
    sandbox(
      [
        {
          name: "k",
          ...P,
          floor: 90,
          subjectKind: "external",
          floorObserved: {
            source: "GitHub board",
            count: 41,
            on: "2026-09-05",
          },
        },
      ],
      {
        "scripts/p.mjs": "process.exit(0);\n",
        "scripts/c.mjs":
          'console.log("SUBJECT: 95 file(s) swept");\nprocess.exit(0);\n',
      }
    )
  );
  ok(
    "an EXTERNAL record below its floor CONTRADICTS, naming the source not a sha",
    r.rc === 2 &&
      /CONTRADICTS the floor/.test(r.out ?? "") &&
      /from GitHub board/.test(r.out ?? ""),
    `rc ${r.rc}`
  );
}

{
  /*
   * #768 — a NON-INTEGER count must be caught by the malformed branch, not the
   * contradiction one. This arm exists for ATTRIBUTION rather than for detection: JS
   * coerces, so `"41" < 90` is true, and without `!Number.isInteger(o.count)` the
   * contradiction refusal would fire and name the wrong defect — telling a reader the
   * record disagrees with the floor when the real problem is that the count is a string.
   * The assertion anchors on the malformed message for exactly that reason.
   */
  const dir = sandbox(
    [
      {
        name: "stringcount",
        proof: "scripts/p.mjs",
        checker: "scripts/c.mjs",
        floor: 90,
        floorObserved: {
          sha: "0123456789abcdef0123456789abcdef01234567",
          count: "41",
          on: "2026-09-05",
        },
      },
    ],
    {
      "scripts/p.mjs": "process.exit(0);\n",
      "scripts/c.mjs":
        'console.log("SUBJECT: 95 file(s) swept");\nprocess.exit(0);\n',
    }
  );
  const r = run(dir);
  ok(
    "a non-integer count is caught as MALFORMED, not misattributed as a contradiction",
    r.rc === 2 &&
      /records no tree it was observed against/.test(r.out ?? "") &&
      !/CONTRADICTS the floor/.test(r.out ?? ""),
    `rc ${r.rc}`
  );
}

{
  /*
   * #789 — A FAILING CHECKER'S SUBJECT REACHES THE RECORD. This is the whole payoff: the
   * reading was being discarded because a subject from a failing run MIGHT be partial, and
   * measurement showed it cannot be by the shape these checkers have. `status` sits beside
   * `subject` in the same entry, so a consumer reading one next to `status: "fail"` knows
   * exactly what it has.
   */
  const dir = sandbox(
    [
      {
        name: "emits-then-fails",
        proof: "scripts/p.mjs",
        checker: "scripts/c.mjs",
      },
    ],
    {
      "scripts/p.mjs": "process.exit(0);\n",
      "scripts/c.mjs":
        'console.log("SUBJECT: 51 python file(s) examined");\nconsole.error("FAIL: something");\nprocess.exit(1);\n',
    }
  );
  const r = run(dir);
  const entry = (record(dir) ?? []).find(
    (e) => e.name === "emits-then-fails" && e.phase === "checker"
  );
  ok(
    "a FAILING checker's subject is recorded, not discarded",
    entry?.status === "fail" && entry?.subject?.count === 51,
    `status=${entry?.status} subject=${JSON.stringify(entry?.subject)}`
  );
  ok(
    "...and the run still fails (the companion — recording is not forgiving)",
    r.rc !== 0,
    `rc ${r.rc}`
  );
}

{
  /*
   * #789 — AND ON A REFUSAL (exit 2) THE SUBJECT IS RECORDED TOO. Pinned as INTENDED rather
   * than tolerated, because the widened read reaches exit 2 as well as exit 1 and the issue's
   * own text argued the opposite: a subject on a refusal "would be actively false", since "a
   * checker that could not ask has examined nothing".
   *
   * THE PREMISE IS WHAT FAILS. Exit 2 means the QUESTION could not be asked, which is not the
   * same as nothing having been examined — a checker can read 51 files, report them
   * completely, and only then fail to reach a second query it needed. That checker has
   * examined something and said so, and gating it out would collapse two states the record
   * has room for, which is the collapse this whole change removes.
   *
   * THIS ARM PINS BEHAVIOUR, NOT SAFETY, and the distinction is the point. No registered
   * checker can reach exit 2 after emitting a subject today — but that is a property of the
   * checker POPULATION, not of run-checks, and nothing in the runner enforces it. This says
   * what the runner does when handed such a checker. It does not say it never will be.
   */
  const dir = sandbox(
    [
      {
        name: "emits-then-refuses",
        proof: "scripts/p.mjs",
        checker: "scripts/c.mjs",
      },
    ],
    {
      "scripts/p.mjs": "process.exit(0);\n",
      "scripts/c.mjs":
        'console.log("SUBJECT: 51 python file(s) examined");\nconsole.error("COULD NOT COMPUTE: no interpreter, so the second query was never asked");\nprocess.exit(2);\n',
    }
  );
  const r = run(dir);
  const entry = (record(dir) ?? []).find(
    (e) => e.name === "emits-then-refuses" && e.phase === "checker"
  );
  ok(
    "a REFUSING checker's subject is recorded, qualified by its status",
    entry?.status === "refused" && entry?.subject?.count === 51,
    `status=${entry?.status} subject=${JSON.stringify(entry?.subject)}`
  );
  ok(
    "...and the run still REFUSES (exit 2), not fails — recording changes no verdict",
    r.rc === 2,
    `rc ${r.rc}`
  );
}

{
  /*
   * THE DISCRIMINATOR FOR THE ARM ABOVE. Without this one, "a refusal carries a subject" is
   * satisfied by a reader that invents one, and the two refusals this record must keep apart —
   * EXAMINED 51 AND THEN COULD NOT ASK, versus COULD NOT ASK AT ALL — would render alike. A
   * checker that refuses without emitting must record `subject: null`, which is also the shape
   * every refusing checker in the tree has today.
   */
  const dir = sandbox(
    [
      {
        name: "refuses-without-emitting",
        proof: "scripts/p.mjs",
        checker: "scripts/c.mjs",
      },
    ],
    {
      "scripts/p.mjs": "process.exit(0);\n",
      "scripts/c.mjs":
        'console.error("COULD NOT COMPUTE: no token, so nothing was compared");\nprocess.exit(2);\n',
    }
  );
  const r = run(dir);
  const entry = (record(dir) ?? []).find(
    (e) => e.name === "refuses-without-emitting" && e.phase === "checker"
  );
  ok(
    "a refusal with NO emission records subject: null, not a fabricated count",
    entry?.status === "refused" && entry?.subject === null,
    `status=${entry?.status} subject=${JSON.stringify(entry?.subject)}`
  );
  ok(
    "...so the two refusals are DISTINGUISHABLE in the record",
    r.rc === 2,
    `rc ${r.rc}`
  );
}

{
  /*
   * #789 — THE EMITTER REFUSES A SECOND EMISSION IN ONE PROCESS. Once-only forecloses the
   * running-total shape, which is how a partial subject would actually arise. Driven through
   * the REAL scripts/lib/subject.mjs rather than a copy, so this tests the contract rather
   * than a restatement of it.
   */
  const emitter = join(HERE, "lib", "subject.mjs");
  const dir = sandbox(
    [{ name: "emits-twice", proof: "scripts/p.mjs", checker: "scripts/c.mjs" }],
    {
      "scripts/p.mjs": "process.exit(0);\n",
      "scripts/c.mjs":
        `import { reportSubject } from ${JSON.stringify(emitter)};\n` +
        'reportSubject(1, "thing(s)");\nreportSubject(2, "thing(s)");\n',
    }
  );
  const r = run(dir);
  const out = r.out ?? "";
  ok(
    "a second reportSubject in one process THROWS",
    r.rc !== 0 && /called twice in one process/.test(out),
    `rc ${r.rc}`
  );
  ok(
    "...and the message names the MODULE-SCOPE cause, not just the shape",
    /MODULE SCOPE/.test(out) && /LIKELIER CAUSE/.test(out),
    "the error describes the symptom's shape without naming what usually causes it"
  );
  ok(
    "...and names the genuine-second-call cause too (the companion)",
    /OTHER CAUSE/.test(out),
    "only one cause named"
  );
}

{
  /* The ACCEPT arm. A checker at or above its floor passes and is recorded. */
  const dir = sandbox(
    [
      {
        name: "real-subject",
        proof: "scripts/p.mjs",
        checker: "scripts/c.mjs",
        floor: 3,
        // #768: a derived floor must name a tree it was observed against.
        floorObserved: {
          sha: "0123456789abcdef0123456789abcdef01234567",
          count: 41,
          on: "2026-09-05",
        },
      },
    ],
    {
      "scripts/p.mjs": "process.exit(0);\n",
      "scripts/c.mjs":
        'console.log("SUBJECT: 41 file(s) swept");\nprocess.exit(0);\n',
    }
  );
  const r = run(dir);
  ok("a subject at or above its floor passes", r.rc === 0, `rc ${r.rc}`);
  const rec = record(dir);
  const entry = (rec ?? []).find(
    (e) => e.name === "real-subject" && e.phase === "checker"
  );
  ok(
    "the count reaches the record, not just the log",
    entry?.subject?.count === 41,
    `subject=${JSON.stringify(entry?.subject)}`
  );
}

{
  /*
   * A DECLARED FLOOR OF ZERO IS A REVIEWABLE SENTENCE, not an invisible default.
   * #730's package.json domain was legitimately empty and that was the right
   * finding. A universal `> 0` would be wrong on those and would get
   * exception-listed into a mute button.
   */
  const dir = sandbox(
    [
      {
        name: "legitimately-empty",
        proof: "scripts/p.mjs",
        checker: "scripts/c.mjs",
        floor: 0,
      },
    ],
    {
      "scripts/p.mjs": "process.exit(0);\n",
      "scripts/c.mjs":
        'console.log("SUBJECT: 0 package.json with scripts");\nprocess.exit(0);\n',
    }
  );
  ok(
    "a floor of 0, declared, accepts an empty domain",
    run(dir).rc === 0,
    "(accepted)"
  );
}

{
  /* A check with no `floor` declared is refused: the requirement lands on the
   * PRODUCER in the same change as the consumer, or the record is honest about
   * a handful and looks complete. */
  // Written WITHOUT the harness default, or this case would test the harness.
  const dir = mkdtempSync(join(TMP, "nofloor-"));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(
    join(dir, "scripts", "checks.json"),
    JSON.stringify(
      {
        checks: [
          {
            name: "undeclared-floor",
            proof: "scripts/p.mjs",
            checker: "scripts/c.mjs",
          },
        ],
      },
      null,
      2
    )
  );
  writeFileSync(join(dir, "scripts", "p.mjs"), "process.exit(0);\n");
  writeFileSync(
    join(dir, "scripts", "c.mjs"),
    'console.log("SUBJECT: 9 things");\nprocess.exit(0);\n'
  );
  const r = run(dir);
  ok("a check declaring no floor is refused", r.rc !== 0, `rc ${r.rc}`);
  ok(
    "...and the refusal names the missing floor rather than the subject",
    /floor/i.test(r.out),
    "a refusal must say which of the three rules it hit"
  );
}

/*
 * PROVENANCE IN THE RECORD (#822). `treeProvenance` takes its runner so these cases
 * need no repository — the risk is in what it does with git's ANSWERS, not in git.
 */
{
  const fake = (out) => () => out;
  const okRun = (cmd, args) =>
    args.includes("rev-parse")
      ? { status: 0, stdout: "f".repeat(40) + "\n" }
      : { status: 0, stdout: "" };
  ok(
    "a clean repo records its head and dirty:false",
    (() => {
      const t = treeProvenance("/x", okRun);
      return t.head === "f".repeat(40) && t.dirty === false;
    })(),
    JSON.stringify(treeProvenance("/x", okRun))
  );

  const dirtyRun = (cmd, args) =>
    args.includes("rev-parse")
      ? { status: 0, stdout: "f".repeat(40) + "\n" }
      : { status: 0, stdout: " M scripts/x.mjs\n" };
  ok(
    "uncommitted tracked changes are recorded as dirty:true, not hidden by a valid head",
    treeProvenance("/x", dirtyRun).dirty === true,
    JSON.stringify(treeProvenance("/x", dirtyRun))
  );

  /*
   * NOT A REPOSITORY IS A LEGITIMATE PLACE TO RUN CHECKS and an illegitimate place to
   * claim provenance from. `head: null` says so; omitting the field or guessing a
   * value would be indistinguishable from a real reading downstream.
   */
  ok(
    "a tree git cannot answer for records head:null rather than omitting or guessing",
    (() => {
      const t = treeProvenance("/x", fake({ status: 128, stdout: "" }));
      return t.head === null && t.dirty === null;
    })(),
    JSON.stringify(treeProvenance("/x", fake({ status: 128, stdout: "" })))
  );
}

const EXPECTED_CASES = 83;
{
  /*
   * THE floorPending CONSUMER (#741). The field marked a floor nobody had
   * derived yet, and NOTHING READ IT — a note describing a mechanism that does
   * not exist. This case is what makes it a marker rather than a comment, and it
   * fires on the drift it is otherwise defenceless against: the floor gets
   * derived and set, and the flag is left behind.
   */
  const dir = sandbox(
    [
      {
        name: "pending-with-a-real-floor",
        proof: "scripts/p.mjs",
        checker: "scripts/c.mjs",
        floor: 7,
        floorPending: true,
      },
    ],
    {
      "scripts/p.mjs": "process.exit(0);\n",
      "scripts/c.mjs": 'console.log("SUBJECT: 9 things");\nprocess.exit(0);\n',
    }
  );
  const r = run(dir);
  ok(
    "floorPending: true with a non-zero floor is FATAL",
    r.rc !== 0 && /floorPending/.test(r.out ?? ""),
    `rc ${r.rc}`
  );
}

{
  /* The ACCEPT arm: pending with floor 0 is the state the two real entries are in. */
  const dir = sandbox(
    [
      {
        name: "pending-and-underived",
        proof: "scripts/p.mjs",
        checker: "scripts/c.mjs",
        floor: 0,
        floorPending: true,
      },
    ],
    {
      "scripts/p.mjs": "process.exit(0);\n",
      "scripts/c.mjs": 'console.log("SUBJECT: 0 things");\nprocess.exit(0);\n',
    }
  );
  ok(
    "floorPending: true with floor 0 is accepted",
    run(dir).rc === 0,
    "(accepted)"
  );
}

/* ── #833: a fixture that can SEE the ordering defect ───────────────────────── */

/*
 * WHY THESE EXIST WHEN THE ABSENT CASES ABOVE ALREADY PASSED.
 *
 * Every absent case above declares the OK stub as its proof — a script that exits 0 without
 * touching its checker. No real proof does that. All 49 declared checks run their checker as
 * a subprocess or import it, so a deleted checker fails the PROOF, the loop breaks on a failed
 * proof, and the checker's existence was never tested at all. Measured over all 49 with the
 * deletion COMMITTED, 48 exited 1 — the code reserved for a property being VIOLATED — for a
 * file that is simply not there. The one that behaved was `readme-quickstart`, whose proof
 * names its checker and never runs it: the fixture shape, and the only place the old placement
 * worked.
 *
 * So the proof below SPAWNS ITS CHECKER. That is the single property the old fixtures lacked,
 * and the only one that decides the answer.
 */
const PROOF_THAT_RUNS_ITS_CHECKER = (checkerRel) =>
  'import { spawnSync } from "node:child_process";\n' +
  'import { dirname, join } from "node:path";\n' +
  'import { fileURLToPath } from "node:url";\n' +
  'const root = join(dirname(fileURLToPath(import.meta.url)), "..");\n' +
  `const r = spawnSync(process.execPath, [join(root, ${JSON.stringify(
    checkerRel
  )})], { encoding: "utf8" });\n` +
  "if (r.status !== 0) {\n" +
  '  console.error("FAIL: 5/5. The checker is NOT trustworthy.");\n' +
  "  process.exit(1);\n" +
  "}\n" +
  'console.log("SUBJECT: 7 thing(s) examined");\nprocess.exit(0);\n';

{
  const dir = sandbox(
    [{ name: "vanished", proof: "scripts/pv.mjs", checker: "scripts/cv.mjs" }],
    { "scripts/pv.mjs": PROOF_THAT_RUNS_ITS_CHECKER("scripts/cv.mjs") }
  );
  const { rc, out } = run(dir);
  ok(
    "a deleted checker is ABSENT even though its proof fails first",
    rc === 2 &&
      /ABSENT from the tree/.test(out) &&
      out.includes("scripts/cv.mjs"),
    `exit ${rc}`
  );
  /*
   * THE DISCRIMINATING HALF. Without the hoist this case exits 1 printing "1 of 1 phase(s)
   * failed", which is the runner saying a property was violated about a file that is not
   * there — the confusion the absent status exists to end.
   */
  ok(
    "...and NOT as the property being violated",
    rc !== 1 && !/^FAIL: 1 of 1 phase\(s\) failed/m.test(out),
    rc === 1 ? "exit 1 — misreported" : "absence outranks the proof's failure"
  );
  const ran = record(dir) ?? [];
  ok(
    "...and the record keeps the absence apart from the failure it caused",
    ran.some((r) => r.phase === "checker" && r.status === "absent") &&
      ran.some((r) => r.phase === "proof" && r.status === "fail"),
    ran.map((r) => `${r.phase}=${r.status}`).join(",") || "no record"
  );
}

{
  /*
   * THE PRESENCE COMPANION FOR THE SHAPE ABOVE. The existing one at the top of this file uses
   * the stub proof, so it cannot rule out a runner that calls a spawning proof's checker
   * absent whether or not it is there.
   */
  const dir = sandbox(
    [{ name: "present", proof: "scripts/pp.mjs", checker: "scripts/cp.mjs" }],
    {
      "scripts/pp.mjs": PROOF_THAT_RUNS_ITS_CHECKER("scripts/cp.mjs"),
      "scripts/cp.mjs": OK,
    }
  );
  const { rc, out } = run(dir);
  ok(
    "...and the same proof with its checker THERE is a clean pass",
    rc === 0 && !/ABSENT/.test(out),
    `exit ${rc}`
  );
}

{
  /*
   * ABSENCE OUTRANKS AN UNSATISFIABLE CHANNEL, and this is the case #833 was filed about. A
   * checker that is not in the tree is not in the tree whether or not a credential exists to
   * run it. Before the hoist the channel gate claimed the phase first and reported SKIPPED —
   * "not measured here", a sentence about the environment standing in for one about the
   * repository — and the run exited 0.
   */
  const dir = sandbox(
    [
      {
        name: "gated-gone",
        proof: "scripts/pg.mjs",
        checker: "scripts/cg.mjs",
        needs: "repo-settings",
        // Declared so this arm fails for the reason it NAMES rather than for a missing
        // subjectKind, which is fatal earlier (#1007).
        subjectKind: "tree",
      },
    ],
    { "scripts/pg.mjs": OK }
  );
  const { rc, out } = run(dir, WITHOUT_TOKEN);
  ok(
    "a GONE checker reports absent, not skipped for want of a credential",
    rc === 2 && /ABSENT/.test(out) && !/SKIPPED/.test(out),
    `exit ${rc}`
  );
}

{
  /*
   * A path that is not a string. Nothing validates that `proof` and `checker` are strings, so
   * an entry omitting one reached join(root, undefined) and crashed with a TypeError naming
   * neither the check nor the field.
   */
  const dir = sandbox([{ name: "halfdeclared", proof: "scripts/ph.mjs" }], {
    "scripts/ph.mjs": OK,
  });
  const { rc, out } = run(dir);
  ok(
    "a check declaring NO checker path is a named refusal, not a TypeError",
    rc === 2 &&
      /ABSENT/.test(out) &&
      out.includes("halfdeclared") &&
      !/TypeError/.test(out),
    `exit ${rc}`
  );
}
{
  /*
   * A CRASH IS NOT SENT TO #1030'S REPAIR (#1175). A checker that dies on an uncaught throw exits
   * 1 with no subject, exactly as a controlled failing exit that emitted none does, and the
   * warning told both to "move reportSubject() above the failing exit". A crash has no failing
   * exit to move it above. Node ends an uncaught exception's report with a `Node.js vNN` line,
   * which a controlled exit never prints, and the warning routes on it. Both directions are
   * driven: a branch watched in one direction is shown not to be dead, not shown to be right.
   */
  const CRASHES = 'JSON.parse("{ not json");\n';
  const warningFor = (checker) => {
    const dir = sandbox(
      [
        {
          name: "subjectless",
          proof: "scripts/p.mjs",
          checker: "scripts/c.mjs",
          why: "x",
        },
      ],
      { "scripts/p.mjs": OK, "scripts/c.mjs": checker }
    );
    return run(dir)
      .out.split("\n")
      .find(
        (l) =>
          l.startsWith("::warning") &&
          l.includes("failed without naming its subject")
      );
  };
  const crash = warningFor(CRASHES);
  ok(
    "an UNCAUGHT crash is warned as a crash, not sent to #1030's repair",
    Boolean(crash) &&
      crash.includes("UNCAUGHT") &&
      crash.includes("#1175") &&
      !crash.includes("#1030"),
    crash ? crash.slice(0, 62) : "no subject warning emitted"
  );
  const controlled = warningFor(BAD);
  ok(
    "...while a CONTROLLED exit 1 with no subject is still sent to #1030",
    Boolean(controlled) &&
      controlled.includes("#1030") &&
      !controlled.includes("UNCAUGHT"),
    controlled ? controlled.slice(0, 62) : "no subject warning emitted"
  );
}

/* ---- the summary line reports the VERDICT, not a planted fixture (#1045) -------------- */

/*
 * THIS FUNCTION MADE THE MISREAD IT EXISTS TO PREVENT, and three readers reproduced it in one
 * day by running its own predicate by hand. A selftest that drives a checker over planted
 * fixtures prints the checker's real `FAIL: …` lines as DATA, before any of its own results —
 * so first-match named a fixture and the verdict sat at the bottom unread.
 *
 * The fixture below is that shape exactly: two lines of planted output, then per-case results,
 * then the tally. If the selection reverts to `.find()` this arm fails and the two below it
 * stay green, which is what distinguishes an arm about the SELECTION from one about the fixture.
 */
const DRIVEN_SELFTEST_OUTPUT = [
  "check-cors-parity selftest",
  "",
  "FAIL: django is missing default origin(s): http://localhost:3000",
  "  ok     a plane MISSING a declared origin FAILS",
  "FAIL: node allows origin(s) the fixture does not declare: http://sneaky.example",
  "  ok     a plane declaring an EXTRA origin FAILS",
  "",
  "FAIL: 2/14 cases wrong.",
].join("\n");

ok(
  "a driven selftest reports its TALLY, not the first planted fixture line",
  firstMeaningfulLine(DRIVEN_SELFTEST_OUTPUT) === "FAIL: 2/14 cases wrong.",
  firstMeaningfulLine(DRIVEN_SELFTEST_OUTPUT)
);

/*
 * AND IT DEGRADES TO THE OLD BEHAVIOUR WHERE THAT WAS RIGHT. A checker that fails usually prints
 * ONE verdict-shaped line, so first and last are the same line and nothing changes. An arm on
 * the selftest case alone would pass over an implementation that always returned the last line
 * of the file, so this one is what keeps the change conservative rather than merely different.
 */
ok(
  "a checker with a single FAIL line is unchanged — first and last are the same line",
  firstMeaningfulLine(
    [
      "running the thing",
      "FAIL: 1 registration finding(s):",
      "  scripts/x.mjs has a proof",
    ].join("\n")
  ) === "FAIL: 1 registration finding(s):",
  firstMeaningfulLine(
    [
      "running the thing",
      "FAIL: 1 registration finding(s):",
      "  scripts/x.mjs has a proof",
    ].join("\n")
  )
);

/*
 * THE FALLBACK IS REACHED ONLY WHEN NOTHING MATCHES, which is the case TEAMLEAD asked to be sure
 * of: a genuine failure that prints no verdict-shaped line at all still gets its first non-empty
 * line rather than "no output".
 */
ok(
  "output with no verdict-shaped line falls back to the first non-empty line, not to nothing",
  firstMeaningfulLine("\n\n  something went wrong quietly\n  and again\n") ===
    "something went wrong quietly",
  firstMeaningfulLine("\n\n  something went wrong quietly\n  and again\n")
);

ok(
  "empty output says so rather than returning an empty string",
  firstMeaningfulLine("") === "no output",
  firstMeaningfulLine("")
);

console.log();
rmSync(TMP, { recursive: true, force: true });

/*
 * THE COUNT GUARD RUNS AT EXIT, NOT IN LINE (#836).
 *
 * It used to sit here as a plain `if`, so it ran at THIS POINT in the file and saw
 * only the cases above it. Both occurrences of the defect were created by appending a
 * case at the END of the file — which is after the guard, because the guard IS the
 * summary block at the end. The count then matched the cases the guard could see and
 * the suite reported "PASS: 14/8".
 *
 * Comparing the tally at the guard rather than via a hoisted binding does NOT fix
 * that: a case appended below the guard still runs after it. Only a hook firing at
 * EXIT sees everything, because nothing can be appended past process exit.
 *
 * `code === 0` MATTERS: without it this overwrites the exit code of a run that already
 * failed for a real reason, turning a genuine defect into a count complaint.
 *
 * AND THE VERDICT MOVED IN HERE TOO, NOT ONLY THE COUNT (#1047). #836 moved the count
 * guard and left the verdict and the banner in line, which is half the property. An arm
 * appended below them still incremented `fail` — but `if (fail !== 0)` had already been
 * evaluated, and `total` had already been computed. So a FAILING arm in that position
 * produced `PASS: 81/81`: a green run, asserting a clean pass, EXCLUDING the failure from
 * the number it reported, with the failing arm's own output in the log above it.
 *
 *     failing arm below the guard, count bumped
 *       before   exit 0   PASS: 81/81            <- the failure counted OUT, not just unreported
 *       after    exit 1   FAIL: 1/82 cases wrong
 *
 * THE COUNT GUARD FIRING WAS THE TRAP, NOT THE RESCUE. It said "the harness is broken",
 * which invites bumping the constant — and bumping it is the correct repair for arms that
 * were ADDED and the destruction of the finding for arms added where they DO NOT RUN. A
 * count cannot tell those apart. DEV2 hit exactly this while building #1046: the guard
 * fired, they read it as bookkeeping, and bumped the number.
 *
 * With the verdict here, placement is irrelevant and bumping is safe again BECAUSE a
 * failing arm now fails on its own. A passing arm below this point reports 82/82 rather
 * than being tolerated — it is counted, not merely non-fatal.
 *
 * ORDER MATTERS: the failure is reported FIRST. A run with both a failed arm and a changed
 * count is a failed arm, and saying "the harness is broken" about it names the wrong thing.
 *
 * THE BANNER MOVED WITH IT, which is the other half. DEV3 stated the caveat before anyone
 * found it: a repair that moves only the exit leaves `console.log` running in line, so the
 * run prints BOTH `PASS: 81/82` and `FAIL: 1/82` — right code, right verdict, and a false
 * PASS still sitting in the log. Verified absent here: the failing-arm run prints no PASS
 * line at all.
 *
 * `process.exitCode`, NOT `process.exit()` — this is already the exit path, and calling
 * exit from an exit handler does not re-enter it.
 */
process.on("exit", (code) => {
  const ran = pass + fail;

  if (fail !== 0) {
    console.error(`FAIL: ${fail}/${ran} cases wrong.`);
    process.exitCode = 1;
    return;
  }

  if (code === 0 && ran !== EXPECTED_CASES) {
    console.error(
      `FAIL: ran ${ran} cases, expected ${EXPECTED_CASES} — a case was added or lost. ` +
        `Arms below this point are NOT inert: every result is counted at exit, so if the ` +
        `new arms pass, update the constant.`
    );
    process.exitCode = 1;
    return;
  }

  if (code !== 0) return;

  console.log(
    `PASS: ${ran}/${ran}. A real failure was watched producing a real ::error:: annotation\n` +
      `      naming the checker and its reason, a failed proof stops its checker, and the record\n` +
      `      names each execution so a declared check that never ran cannot read as a pass.\n` +
      `      Watched on declared channels: an unrecognised \`needs\` REFUSING rather than running\n` +
      `      unconditionally and writing no record at all; an unsatisfiable channel skipping the\n` +
      `      checker while the proof still ran; "skipped" recorded apart from "pass" and excluded\n` +
      `      from the executed count; the skip announced and still green; a SATISFIABLE channel\n` +
      `      running the checker with its credential; and a check unable to opt itself out.`
  );
});
