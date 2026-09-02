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
import {
  parseVerdict,
  tally,
  render,
  REAL_TOKEN,
  FIXTURE_TOKEN,
  STREAK_TOKEN,
  KNOWN_VERDICTS,
} from "./verdict-streak.mjs";

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
const EXPECTED = 27;
const total = pass + fail;
if (total !== EXPECTED) {
  console.error(
    `\nFAIL: ran ${total} assertions, expected ${EXPECTED} — a case was added or lost.`
  );
  process.exit(1);
}
console.log(`\n${pass}/${total} passed`);
process.exit(fail ? 1 : 0);
