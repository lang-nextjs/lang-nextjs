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
  writeFileSync(
    join(dir, "scripts", "checks.json"),
    JSON.stringify({ checks }, null, 2)
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

const OK = "process.exit(0);\n";
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
      "  process.exit(1);\n}\nprocess.exit(0);\n",
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

const EXPECTED_CASES = 33;
const total = pass + fail;
console.log();
rmSync(TMP, { recursive: true, force: true });

if (total !== EXPECTED_CASES) {
  console.error(
    `FAIL: ran ${total} cases, expected ${EXPECTED_CASES} — the harness is broken.`
  );
  process.exit(1);
}
if (fail !== 0) {
  console.error(`FAIL: ${fail}/${total} cases wrong.`);
  process.exit(1);
}
console.log(
  `PASS: ${pass}/${total}. A real failure was watched producing a real ::error:: annotation\n` +
    `      naming the checker and its reason, a failed proof stops its checker, and the record\n` +
    `      names each execution so a declared check that never ran cannot read as a pass.\n` +
    `      Watched on declared channels: an unrecognised \`needs\` REFUSING rather than running\n` +
    `      unconditionally and writing no record at all; an unsatisfiable channel skipping the\n` +
    `      checker while the proof still ran; "skipped" recorded apart from "pass" and excluded\n` +
    `      from the executed count; the skip announced and still green; a SATISFIABLE channel\n` +
    `      running the checker with its credential; and a check unable to opt itself out.`
);
