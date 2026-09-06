#!/usr/bin/env node
/**
 * Proof for measure-push-only-jobs.mjs.
 *
 * The streak is the number the whole issue turns on — a 33%-flaky job and a permanently-red
 * one can share a failure RATE and need opposite responses — so the arithmetic that produces
 * it gets a proof rather than a glance.
 *
 * THE CASE THAT EARNS THIS FILE is the cancelled run. Over the recent window, 13 of 60 runs
 * did not conclude. If a cancellation BROKE a streak, a job red for 34 consecutive runs with
 * two cancellations in the middle would report three short streaks and read as flaky — the
 * exact misreading #400 is about, produced by the instrument meant to detect it.
 *
 * Usage: node scripts/measure-push-only-jobs.selftest.mjs
 */
import { streaks, summarise } from "./measure-push-only-jobs.mjs";

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

// Newest-first, as `gh run list` returns them.
const F = "failure",
  S = "success",
  C = "cancelled";

console.log("\nstreaks — how long a red survives\n");

let r = streaks([F, F, F, S, F, S]);
ok(
  "current streak counts only the unbroken run at the newest end",
  r.current === 3,
  r
);
ok("longest streak is the longest anywhere in the window", r.longest === 3, r);

r = streaks([S, F, F, F, F]);
ok(
  "a green at the newest end means the current streak is 0",
  r.current === 0,
  r
);
ok("...but the longest still reports the older run", r.longest === 4, r);

/*
 * THE CANCELLATION CASE. A run that reports no verdict tells a watcher nothing, so it cannot
 * end a red. Counting it as a break would split one 5-long streak into two short ones and turn
 * a broken job into a flaky-looking one.
 */
r = streaks([F, F, C, F, F, F]);
ok(
  "a cancelled run neither breaks nor extends a streak",
  r.current === 5 && r.longest === 5,
  r
);

r = streaks([C, C, C]);
ok(
  "a window with no verdicts at all has no streak",
  r.longest === 0 && r.current === 0,
  r
);

r = streaks([F, F, F]);
ok(
  "never green in the window is reported as such",
  r.everGreen === false && r.current === 3,
  r
);

r = streaks([S, S, S]);
ok(
  "all green is zero, not one",
  r.longest === 0 && r.current === 0 && r.everGreen,
  r
);

/*
 * `trailing` — THE RUN THAT TOUCHES THE OLDEST EDGE (#742).
 *
 * WHY THIS BELONGS HERE AND NOT ONLY IN THE CONSUMER. Deleting this field leaves
 * every case above green: none of them reads it, so this suite reported 11/11
 * while `verdict-streak` went red. Someone editing THIS file runs THIS selftest.
 * A guard for a field lives with the field.
 *
 * The pair below is the reason the field exists. Both windows have longest 3 and
 * everGreen true and are indistinguishable on everything else this returns; only
 * `trailing` says which 3 is a measured length and which ran off the edge.
 * Newest-first, so the OLDEST run is the truncated one.
 */
r = streaks([F, F, F, S, F]);
ok(
  "trailing is the OLDEST run, not the newest",
  r.trailing === 1 && r.longest === 3,
  r
);

r = streaks([F, S, F, F, F]);
ok(
  "a longest run at the oldest edge IS the trailing run",
  r.trailing === 3 && r.longest === 3,
  r
);

r = streaks([F, F, F]);
ok(
  "with no green anywhere, trailing and longest and current coincide",
  r.trailing === 3 && r.longest === 3 && r.current === 3,
  r
);

r = streaks([S, S, S]);
ok("an all-green window has no trailing run", r.trailing === 0, r);

console.log("\nsummarise — the denominator is never the sample size\n");

const rows = [
  { conclusion: F, at: "2026-08-31T12:00:00Z" },
  { conclusion: C, at: "2026-08-31T11:00:00Z" },
  { conclusion: F, at: "2026-08-31T10:00:00Z" },
  { conclusion: S, at: "2026-08-31T09:00:00Z" },
];
const s = summarise(rows);
ok(
  "cancelled runs are excluded from the denominator",
  s.concluded === 3 && s.seen === 4,
  s
);
ok(
  "the rate is over CONCLUDED runs, not over the sample",
  Math.abs(s.rate - 2 / 3) < 1e-9,
  s
);
/*
 * The streak counts FAILURES, and a cancellation is not one — it neither breaks the run nor
 * adds to it. [F, C, F, S] is therefore a current streak of 2, not 3. My first version of this
 * fixture asserted 3 and the code was right; recording that because the off-by-one is exactly
 * the kind of thing a glance at a passing test would have carried.
 */
ok(
  "a cancelled run in the middle does not break the current streak",
  s.current === 2,
  s
);

const EXPECTED = 15;
const total = pass + fail;
console.log();
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
 */
process.on("exit", (code) => {
  const ran = pass + fail;
  if (code === 0 && ran !== EXPECTED) {
    console.error(
      `FAIL: ran ${ran} checks, expected ${EXPECTED} — the harness is broken.`
    );
    process.exitCode = 1;
  }
});
if (fail !== 0) {
  console.error(`FAIL: ${fail}/${total} wrong.`);
  process.exit(1);
}
console.log(
  `PASS: ${pass}/${total}. A cancelled run cannot split a red streak into short ones, the rate\n` +
    `      is taken over runs that concluded rather than over the sample, and "never green" is\n` +
    `      distinguished from "green somewhere".`
);
