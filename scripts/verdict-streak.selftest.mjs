#!/usr/bin/env node
/**
 * Proof for verdict-streak.mjs.
 *
 * This instrument's whole job is to tell a reader whether a red is the sixteenth of an external
 * cause or the first of a new one. Every case below is one where getting it wrong produces a
 * CONFIDENT WRONG ANSWER rather than a visible error — which is the only kind worth a fixture.
 *
 * Usage: node scripts/verdict-streak.selftest.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseVerdict,
  STATUS_TOKEN,
  tally,
  render,
  REAL_TOKEN,
  FIXTURE_TOKEN,
  STREAK_TOKEN,
  KNOWN_VERDICTS,
  streakCount,
  currentIsTruncated,
  longestIsTruncated,
} from "./verdict-streak.mjs";

// The REAL reducer, not a copy. A fixture that reimplements `streaks()` tests the
// copy: it agrees with itself by construction and cannot observe a divergence in
// the function this file exists to defend.
import { streaks } from "./measure-push-only-jobs.mjs";

let pass = 0,
  fail = 0;
const ok = (label, cond, got) => {
  if (cond) {
    console.log(`  ok   ${label}`);
    pass++;
  } else {
    console.error(
      `  FAIL ${label}${
        got !== undefined ? ` — got ${JSON.stringify(got)}` : ""
      }`
    );
    fail++;
  }
};

const line = (t, v, d = 0, u = 0) =>
  `2026-09-01T05:02:11.3Z ${t} verdict=${v} defects=${d} upstream=${u} unattributed=0 exit=1 attempt=first`;

console.log("\nparseVerdict — reading a verdict out of a job log\n");

ok(
  "finds a real verdict on a runner-timestamped line",
  parseVerdict(line(REAL_TOKEN, "UPSTREAM_UNAVAILABLE", 0, 4))?.verdict ===
    "UPSTREAM_UNAVAILABLE"
);

/*
 * THE #496 TRAP, PRE-REGISTERED. The selftest of the classifier prints its fixture verdicts in
 * the SAME job, the SAME stream and the SAME format as a real classification. If this reader
 * picked those up, a green selftest run would manufacture verdict history that no real run
 * produced — and the mirror case is worse than a false red: a fixture PASS would read as a
 * transport that worked.
 */
ok(
  "a log containing ONLY fixture verdicts yields NO real verdict",
  parseVerdict(
    [
      line(FIXTURE_TOKEN, "PASS"),
      line(FIXTURE_TOKEN, "TRANSPORT_DEFECT", 2),
    ].join("\n")
  ) === null,
  parseVerdict(line(FIXTURE_TOKEN, "PASS"))
);

ok(
  "the two tokens are not substrings of one another (the property that makes the above hold)",
  !FIXTURE_TOKEN.includes(REAL_TOKEN) && !REAL_TOKEN.includes(FIXTURE_TOKEN)
);

/*
 * LAST WINS. A first attempt classified UPSTREAM and a retry classified TRANSPORT_DEFECT is a
 * DEFECT run. Taking the first match would file a genuine regression as a provider outage —
 * the single most costly mistake this reader can make, because it is the one that tells someone
 * to wait it out.
 */
ok(
  "the LAST verdict in a retried run wins, not the first",
  parseVerdict(
    [
      line(REAL_TOKEN, "UPSTREAM_UNAVAILABLE", 0, 4),
      line(REAL_TOKEN, "TRANSPORT_DEFECT", 2, 1),
    ].join("\n")
  )?.verdict === "TRANSPORT_DEFECT"
);

ok(
  "a log with no verdict at all yields null",
  parseVerdict("nothing to see") === null
);

console.log(
  "\ntally — the two streaks, and the difference between zero and unreadable\n"
);

const R = (verdict, conclusion = "failure") => ({ conclusion, verdict });

/*
 * THE HEADLINE CASE, and the one measured on main: sixteen consecutive reds, every one of them
 * a provider outage. The RED streak must be 16 — a watcher saw sixteen reds and that is real —
 * while the DEFECT streak must be 0, because not one of them exercised the transport.
 */
let t = tally(Array.from({ length: 16 }, () => R("UPSTREAM_UNAVAILABLE")));
ok(
  "16 upstream reds are 16 red but ZERO defect-attributed",
  t.red.current === 16 && t.defect.current === 0,
  { red: t.red, defect: t.defect }
);

/*
 * AN OUTAGE MUST NOT BREAK A DEFECT STREAK EITHER. Three real defects with an outage in the
 * middle is a three-long defect run, not two short ones. If an outage BROKE the streak, a
 * genuinely broken transport punctuated by provider trouble would read as flaky — the exact
 * misreading, produced by the instrument built to prevent it.
 */
t = tally([
  R("TRANSPORT_DEFECT"),
  R("UPSTREAM_UNAVAILABLE"),
  R("TRANSPORT_DEFECT"),
  R("TRANSPORT_DEFECT"),
]);
ok(
  "an outage neither breaks nor extends a defect streak",
  t.defect.current === 3,
  t.defect
);

t = tally([R("PASS", "success"), R("TRANSPORT_DEFECT"), R("TRANSPORT_DEFECT")]);
ok(
  "a PASS ends the defect streak",
  t.defect.current === 0 && t.defect.longest === 2,
  t.defect
);

/*
 * THE FALSE-GREEN TRAP, PRE-REGISTERED. A window in which every log has expired yields no
 * verdicts. If UNKNOWN were treated as "not a defect" and the streak still reported, the answer
 * would be a defect streak of 0 — indistinguishable from a genuinely clean window, and it would
 * tell a reader the transport is healthy when nothing was read at all.
 */
t = tally(Array.from({ length: 10 }, () => R("UNKNOWN")));
ok(
  "a window with NO readable verdict reports INDETERMINATE, never a defect streak of 0",
  t.defect === null,
  t.defect
);
ok("...and still reports the reds it could see", t.red.current === 10, t.red);
ok(
  "...and the rendering says INDETERMINATE rather than a number",
  render(t, { job: "x" }).join("\n").includes("INDETERMINATE")
);

/*
 * And an unreadable run inside an otherwise legible window must not be counted as a pass, which
 * would silently end a defect streak that is in fact still running.
 */
t = tally([R("TRANSPORT_DEFECT"), R("UNKNOWN"), R("TRANSPORT_DEFECT")]);
ok(
  "an unreadable run neither breaks nor extends the defect streak",
  t.defect.current === 2,
  t.defect
);
ok(
  "unreadable runs are counted and surfaced",
  t.counts.UNKNOWN === 1 && t.known === 2,
  t.counts
);

console.log("\nrender — the sentence a person actually reads\n");

t = tally(Array.from({ length: 16 }, () => R("UPSTREAM_UNAVAILABLE")));
let text = render(t, { job: "live transport" }).join("\n");
ok(
  "an all-upstream window says the red is likely external",
  /likely external/.test(text)
);
ok(
  "...and names the transition that WOULD be the signal",
  /FIRST defect-attributed red/.test(text)
);

t = tally([R("TRANSPORT_DEFECT"), R("TRANSPORT_DEFECT")]);
text = render(t, { job: "live transport" }).join("\n");
ok(
  "a defect-attributed window refuses the wait-it-out reading",
  /not waiting-it-out territory/.test(text)
);

/*
 * THE DEFECT THIS SCRIPT SHIPPED WITH, PRE-REGISTERED SO IT CANNOT RETURN.
 *
 * The first version knew three verdicts. Run against real history, four of the five most recent
 * reds were FAILED_UNCLASSIFIED — a verdict it had never heard of — and it printed "very likely
 * external ... needs no bisect" over them. The classifier's own comment says the opposite: an
 * unclassified red is one whose reason could not be read, and "an ambiguous frame still costs
 * someone a look". Telling a reader to ignore it is the exact false reassurance this whole
 * mechanism exists to prevent, produced by the mechanism itself.
 */
t = tally(Array.from({ length: 4 }, () => R("FAILED_UNCLASSIFIED")));
text = render(t, { job: "live transport" }).join("\n");
ok(
  "an unclassified window is NEVER called external",
  !/likely external/.test(text),
  text.slice(0, 120)
);
ok(
  "...it is called unexplained, and refuses the wait-it-out reading",
  /unexplained, not external/.test(text) &&
    /Do not wait this one out/.test(text)
);
ok(
  "...and it does not extend the DEFECT streak either (no claim was made)",
  t.defect.current === 0,
  t.defect
);
ok("...but it does count as needing a look", t.needsLook === 4, t.needsLook);

/*
 * AND THE REASSURING SENTENCE IS GATED ON THE WHOLE WINDOW, not just on defects. One
 * unexplained red among fifteen outages is still one red nobody has explained.
 */
t = tally([
  R("FAILED_UNCLASSIFIED"),
  ...Array.from({ length: 15 }, () => R("UPSTREAM_UNAVAILABLE")),
]);
ok(
  "a single unexplained red suppresses the external reading for the whole window",
  !/likely external/.test(render(t, { job: "x" }).join("\n"))
);

/*
 * A VERDICT THE CLASSIFIER GROWS LATER MUST NOT VANISH. The vocabulary is not frozen, and the
 * failure mode of the first version was silence: an invented key, a table missing a column, and
 * totals that no longer summed to the window.
 */
t = tally([R("SOMETHING_NEW"), R("UPSTREAM_UNAVAILABLE")]);
ok(
  "an unrecognised verdict is counted rather than dropped",
  t.unrecognisedTotal === 1,
  t.unrecognised
);
ok(
  "...is surfaced by name in the output",
  /SOMETHING_NEW/.test(render(t, { job: "x" }).join("\n"))
);
ok(
  "...counts as needing a look, never as external",
  t.needsLook === 1 &&
    !/likely external/.test(render(t, { job: "x" }).join("\n"))
);
ok(
  "...and is excluded from `known`, so it cannot pad the denominator",
  t.known === 1,
  t.known
);

ok(
  "every verdict the classifier can emit is in KNOWN_VERDICTS",
  [
    "PASS",
    "TRANSPORT_DEFECT",
    "UPSTREAM_UNAVAILABLE",
    "FAILED_UNCLASSIFIED",
  ].every((v) => KNOWN_VERDICTS.includes(v))
);

/*
 * MAPPING SANITY. If someone "simplifies" UNKNOWN or UPSTREAM to success, every assertion above
 * about streaks still needs this to be the reason it broke.
 */
ok(
  "no not-an-answer verdict maps to success or failure",
  ["UPSTREAM_UNAVAILABLE", "FAILED_UNCLASSIFIED", "UNKNOWN"].every(
    (v) => !["success", "failure"].includes(STREAK_TOKEN[v])
  ),
  STREAK_TOKEN
);

/*
 * The count is asserted so that a case deleted or short-circuited shows up as a number that
 * moved, rather than as a still-green run with less in it.
 */
console.log(
  "\n\nthe disaster paths — proving the annotator SPEAKS, not merely that it exits 0\n"
);

/*
 * EXIT 0 ON EVERY PATH IS RIGHT, AND IT CREATES THIS HOLE.
 *
 * A detector that can turn one red into two gets switched off the first time it misfires, so
 * exiting 0 always is the correct choice. But it makes "it ran and said nothing" and "it never
 * ran" IDENTICAL FROM THE OUTSIDE — and the paths where that matters are exactly the ones that
 * only execute during a disaster, when nobody is reading closely. Asserting the exit code here
 * would assert the thing that is true by construction and prove nothing.
 *
 * So these drive the real program as a subprocess, with a `gh` on PATH that fails the way the
 * real one would, and assert IT PRODUCED WORDS. Running the built file also exercises
 * invokedAsProgram() under a macOS temp dir — /var/folders is itself a symlink, which is the
 * precise condition under which the old main-module guards silently printed nothing at exit 0.
 */
const HERE = dirname(fileURLToPath(import.meta.url));

function withFakeGh(shell) {
  const dir = mkdtempSync(join(tmpdir(), "verdict-streak-gh-"));
  writeFileSync(join(dir, "gh"), `#!/bin/sh\n${shell}\n`, { mode: 0o755 });
  return spawnSync(
    process.execPath,
    [join(HERE, "verdict-streak.mjs"), "--limit", "3"],
    {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    }
  );
}

let r = withFakeGh('echo "gh: could not authenticate" >&2; exit 1');
ok(
  "a failing `gh` still produces output rather than silence",
  r.stdout.trim().length > 0,
  r.stdout
);
ok(
  "...and names it FETCH_FAILED, distinct from having found nothing",
  new RegExp(`${STATUS_TOKEN}=FETCH_FAILED`).test(r.stdout)
);
ok("...and does not fail the job it is annotating", r.status === 0, r.status);

r = withFakeGh('echo "[]"');
ok(
  "an empty run history reports NO_SUCH_JOB, not FETCH_FAILED",
  new RegExp(`${STATUS_TOKEN}=NO_SUCH_JOB`).test(r.stdout) &&
    !new RegExp(`${STATUS_TOKEN}=FETCH_FAILED`).test(r.stdout),
  r.stdout
);
ok("...also without failing the job", r.status === 0, r.status);

/*
 * ONE STATUS PER INVOCATION, AND NO TOKEN INSIDE ANOTHER OUTCOME'S PROSE (#496 again). The
 * first version explained the empty case as "different from FETCH_FAILED above", so a grep for
 * that token matched a run whose fetch had worked perfectly. Counting the token catches the
 * reintroduction; asserting on the VALUE catches a second status being appended.
 */
ok(
  "exactly one status line is printed, and no outcome names another's token",
  (r.stdout.match(new RegExp(STATUS_TOKEN, "g")) ?? []).length === 1,
  r.stdout.match(new RegExp(STATUS_TOKEN, "g"))
);

const EXPECTED = 48;

/* ── A STREAK THAT FILLS ITS WINDOW IS A LOWER BOUND (#742) ──────────────────
 *
 * `--limit 20` fetches twenty runs, so a streak of twenty inside twenty is
 * indistinguishable from one of fifty-five — the window ran out before the
 * streak did.
 *
 * THE MOTIVATING FIGURE WAS PREDICTED, NOT MEASURED, and this comment said
 * otherwise until the window was actually run. It claimed main's defect streak
 * was ~55 and that this annotator "would have printed 20 consecutive
 * defect-attributed reds". Measured: the defect streak was 0 current, 0 longest,
 * because 13 of the 20 reds were FAILED_UNCLASSIFIED and STREAK_TOKEN maps that
 * to "cancelled". No predicate would have printed a defect streak at all. The
 * DEFECT is real and was found by reading STREAK_TOKEN; the INSTANCE never
 * existed. Those are different claims and this file had the wrong one.
 *
 * Nothing here could go red before these cases existed: `defect.current` was
 * never compared to `seen` anywhere in the file, and `seen` appeared in this
 * selftest zero times.
 */
ok(
  "a streak reaching the oldest row is reported as a lower bound",
  streakCount(20, currentIsTruncated({ everGreen: false })) === "at least 20",
  streakCount(20, currentIsTruncated({ everGreen: false }))
);

/*
 * THE CASE THE FIRST PREDICATE GOT WRONG, and the reason this file needed a
 * second pass. `n === seen` asked whether the streak equalled the WINDOW, but
 * `seen` counts every row while `current` counts only "failure" rows — and a
 * cancelled row neither extends nor breaks. So a streak can run the entire
 * window, be truncated at its oldest edge, and still have n < seen.
 *
 * Driven through the real streaks(): 19 failures + 1 cancelled gives current 19,
 * seen 20, everGreen false. The first predicate printed "19" for a streak whose
 * true length is unknowable. For the DEFECT streak this is the normal case, not
 * an edge one — three of five verdicts map to "cancelled".
 */
ok(
  "a streak interrupted by a cancelled run is STILL a lower bound",
  streakCount(19, currentIsTruncated({ everGreen: false })) === "at least 19",
  streakCount(19, currentIsTruncated({ everGreen: false }))
);

/*
 * THE COMPANION, and without it "at least" degrades into a word that appears on
 * everything. A streak with room left in the window is a MEASURED length and
 * must not be hedged — hedging a number that is known is the same defect in the
 * opposite direction.
 */
ok(
  "a streak bounded by a success is NOT hedged",
  streakCount(3, currentIsTruncated({ everGreen: true })) === "3",
  streakCount(3, currentIsTruncated({ everGreen: true }))
);

/*
 * An empty window: zero of zero is not "at least zero". Nothing was read, and
 * `tally` already reports that as INDETERMINATE elsewhere — this must not
 * invent a bound over it.
 */
/*
 * THE GUARD THAT SURVIVES A CARELESS SIMPLIFICATION. `everGreen` is false on an
 * EMPTY window too, so dropping the `n > 0` half turns "0" into "at least 0" — a
 * lower bound invented over a subject that was never measured.
 */
ok(
  "an empty window is not a lower bound",
  streakCount(0, currentIsTruncated({ everGreen: false })) === "0",
  streakCount(0, currentIsTruncated({ everGreen: false }))
);

/* ── THE LONGEST STREAK IS A SEPARATE QUESTION (#742, second pass) ────────────
 *
 * `everGreen` answers "is the CURRENT streak truncated". It cannot answer the
 * same question about `longest`, and the window actually on `main` when this was
 * written is the case it gets wrong: `0 current, 19 longest`, everGreen TRUE.
 *
 * THE PAIR BELOW IS THE ENTIRE ARGUMENT. Both windows have longest 19 and
 * everGreen true. One is a measured 19, the other is a lower bound. Any
 * predicate built from the three fields `streaks()` used to return gives them
 * the SAME answer, so without both of these in the suite the new rule is
 * untestable in principle against the old one — which is the failure this PR is
 * about, repeated inside its own fixtures.
 *
 * Driven through the REAL `streaks()`: a fixture that recomputed these numbers
 * would agree with itself by construction.
 */
const fails = (n) => Array.from({ length: n }, () => "failure");

// Newest-first. 19 failures, a success, then one OLDER failure: the long run is
// bounded on both sides, so its length is known. trailing is the run of 1.
const bounded = streaks([...fails(19), "success", "failure"]);

// Newest-first. One failure, a success, then 19 OLDER failures running off the
// edge — main's shape on the day this was written.
const truncated = streaks(["failure", "success", ...fails(19)]);

ok(
  "THE COMPANION: the two windows are indistinguishable on longest+everGreen",
  bounded.longest === truncated.longest &&
    bounded.everGreen === truncated.everGreen &&
    bounded.longest === 19 &&
    bounded.everGreen === true,
  `bounded=${JSON.stringify(bounded)} truncated=${JSON.stringify(truncated)}`
);

ok(
  "`trailing` is what separates them",
  bounded.trailing === 1 && truncated.trailing === 19,
  `${bounded.trailing} vs ${truncated.trailing}`
);

ok(
  "a longest run bounded by a success on BOTH sides is a MEASURED length",
  longestIsTruncated(bounded) === false &&
    streakCount(bounded.longest, longestIsTruncated(bounded)) === "19",
  streakCount(bounded.longest, longestIsTruncated(bounded))
);

ok(
  "a longest run that touches the oldest edge is a LOWER BOUND",
  longestIsTruncated(truncated) === true &&
    streakCount(truncated.longest, longestIsTruncated(truncated)) ===
      "at least 19",
  streakCount(truncated.longest, longestIsTruncated(truncated))
);

/*
 * The guard that keeps `longestIsTruncated` honest where it is vacuously true:
 * an all-success window has longest 0 and trailing 0, so the predicate says
 * "truncated" over a streak that does not exist. `streakCount`'s `n > 0` half is
 * the only thing standing between that and "at least 0".
 */
const noReds = streaks(["success", "success"]);
ok(
  "an all-green window does not invent a lower bound over a streak of zero",
  longestIsTruncated(noReds) === true &&
    streakCount(noReds.longest, longestIsTruncated(noReds)) === "0",
  streakCount(noReds.longest, longestIsTruncated(noReds))
);

/*
 * END TO END, because the predicate being right is not the claim — the claim is
 * that the TABLE A READER SEES says it. This is main's shape: a recent pass, and
 * behind it a red run that leaves the window. `current` is 0 and must stay a
 * plain 0; `longest` must be hedged. Before this change the row read
 * "0 current, 2 longest" with nothing marking the second number as a bound.
 */
{
  const trailingRun = tally([
    R("PASS", "success"),
    R("TRANSPORT_DEFECT"),
    R("TRANSPORT_DEFECT"),
  ]);
  const row =
    render(trailingRun, { job: "x" }).find((l) => l.includes("current,")) ??
    "<no row>";
  ok(
    "the table hedges a LONGEST run that leaves the window",
    row.includes("0 current, at least 2 longest"),
    row
  );
  ok(
    "and does not hedge the current streak, which is a measured zero",
    !row.includes("at least 0 current"),
    row
  );
}

/*
 * END TO END THROUGH render(), because the formatter being right is not the
 * claim — the claim is that the SENTENCE A READER SEES says it. A window of
 * three, all defect-attributed, saturates.
 */
{
  const sat = tally([
    R("TRANSPORT_DEFECT"),
    R("TRANSPORT_DEFECT"),
    R("TRANSPORT_DEFECT"),
  ]);
  const out = render(sat, { job: "x" }).join("\n");
  ok(
    "render says 'at least' when the streak fills the window",
    out.includes("at least 3 consecutive defect-attributed reds"),
    out.split("\n").find((l) => l.includes("consecutive")) ?? "<no line>"
  );
  ok(
    "render explains that the true length is unknowable from here",
    out.includes("began") && out.includes("before the window starts"),
    "the explanation is absent"
  );

  // NEWEST-FIRST, so the PASS goes LAST: it is the older run that bounds the
  // streak from below and leaves room in the window. A leading PASS would end
  // the current streak at zero and never reach the sentence under test — which
  // is what the first draft of this case did, and it reported "<no line>"
  // rather than a wrong string, because the branch was never entered.
  /*
   * END TO END through the predicate that was wrong: UPSTREAM_UNAVAILABLE maps to
   * "cancelled", so this window's defect streak runs its whole length while
   * current (2) < seen (3). The first predicate printed "2 consecutive".
   */
  const interrupted = tally([
    R("TRANSPORT_DEFECT"),
    R("UPSTREAM_UNAVAILABLE"),
    R("TRANSPORT_DEFECT"),
  ]);
  const out3 = render(interrupted, { job: "x" }).join("\n");
  ok(
    "render hedges a streak a cancelled run runs through",
    out3.includes("at least 2 consecutive defect-attributed reds"),
    out3.split("\n").find((l) => l.includes("consecutive")) ?? "<no line>"
  );

  const room = tally([
    R("TRANSPORT_DEFECT"),
    R("TRANSPORT_DEFECT"),
    R("PASS", "success"),
  ]);
  const out2 = render(room, { job: "x" }).join("\n");
  ok(
    "render does NOT hedge when the window has room left",
    out2.includes("2 consecutive defect-attributed reds") &&
      !out2.includes("at least 2 consecutive"),
    out2.split("\n").find((l) => l.includes("consecutive")) ?? "<no line>"
  );
}

const total = pass + fail;
if (total !== EXPECTED) {
  console.error(
    `\nFAIL: ran ${total} assertions, expected ${EXPECTED} — a case was added or lost.`
  );
  process.exit(1);
}
console.log(`\n${pass}/${total} passed`);
process.exit(fail ? 1 : 0);
