#!/usr/bin/env node
/**
 * PROOF FOR flake-census.mjs — it names the spec, keeps a SAID zero distinct from an absent
 * reading, and is not fooled by the other producer writing the same words into the same log.
 *
 * THE CASE THAT MATTERS MOST IS THE ANCHORING ONE. `summarise-flaky.mjs` prints
 * `SUBJECT: 1 flaky test(s) …` and Playwright's list reporter prints `  1 flaky` — the same
 * substring, the same log, different producers and different meanings. A pattern of
 * `\d+ flaky` matches both, selects the wrong one, and returns a census with no spec names
 * and no error. That is not hypothetical: it is exactly what happened while this was being
 * built, and it returned an EMPTY result rather than a wrong one, which is the only reason
 * it was noticed.
 *
 * So the negative arm below feeds a `SUBJECT:` line to Playwright's pattern and asserts it
 * does NOT match. Without it, `^\s*\d+ flaky\s*$` looks like a needlessly fussy regex and
 * the next reader simplifies it.
 *
 * THE SECOND CASE THAT MATTERS is a log with no SUBJECT line at all. That must be UNKNOWN,
 * never zero — the census exists because a green run and an unread run were indistinguishable,
 * and a census that reproduced that would be a downgrade from the count it replaces.
 *
 * WHAT THESE ARMS ARE AND ARE NOT. They are fixtures, so they assert the parser handles what
 * its author believes the log looks like — which is exactly the weakness a fixture always has.
 * The parser was ALSO driven over four real captured job logs during development (a zero-flake
 * run, `e4d168f7` naming `:153`, `ee12800b` naming two, `828d6f65` naming `:190`) and
 * reproduced the `:190` -> `:153` transition. That is not asserted here because this suite must
 * not depend on network fixtures; it is recorded so nobody mistakes these arms for evidence
 * about real logs.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  noReadingExpected,
  populations,
  readFlakeReport,
  specDelta,
  stripLogPrefix,
} from "./flake-census.mjs";

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name} — ${JSON.stringify(detail)?.slice(0, 240)}`);
  }
};

const TS = "2026-09-07T17:02:37.0176078Z ";
const PW_SUMMARY_ONE = [
  `${TS}  1 flaky`,
  `${TS}    [open-swe] › e2e/rungs/open-swe/open-swe-queue-polling.spec.ts:153:7 › queue — a failed poll`,
  `${TS}  4 skipped`,
  `${TS}  603 passed (7.4m)`,
].join("\n");
const SUBJECT = (n) =>
  `${TS}SUBJECT: ${n} flaky test(s) surfaced from Playwright's own report`;

console.log("\nflake-census.mjs\n");

ok(
  "a SAID zero is a reading — SUBJECT: 0 with no Playwright block is counted, not unknown",
  (() => {
    const r = readFlakeReport(SUBJECT(0));
    return r.state === "counted" && r.count === 0 && r.specs.length === 0;
  })(),
  readFlakeReport(SUBJECT(0))
);

ok(
  "a flake is NAMED, not just counted",
  (() => {
    const r = readFlakeReport(`${SUBJECT(1)}\n${PW_SUMMARY_ONE}`);
    return (
      r.state === "counted" &&
      r.count === 1 &&
      r.specs.length === 1 &&
      r.specs[0] === "e2e/rungs/open-swe/open-swe-queue-polling.spec.ts:153:7"
    );
  })(),
  readFlakeReport(`${SUBJECT(1)}\n${PW_SUMMARY_ONE}`)
);

/*
 * THE ONE THE WHOLE CENSUS RESTS ON. No SUBJECT line means the summariser did not run or
 * could not read — which is not the same as it running and finding nothing.
 */
ok(
  "NO SUBJECT line is UNKNOWN, never zero",
  (() => {
    const r = readFlakeReport(`${TS}603 passed (7.4m)`);
    return r.state === "unreadable" && r.count === null;
  })(),
  readFlakeReport(`${TS}603 passed (7.4m)`)
);

/*
 * THE ANCHORING NEGATIVE. `SUBJECT: 1 flaky test(s) …` must not be read as Playwright's
 * summary line, or the parser harvests spec names from the wrong block — or, as happened,
 * from no block at all and reports a count with an empty name list.
 */
ok(
  "a SUBJECT line is NOT mistaken for Playwright's summary — the anchor is load-bearing",
  (() => {
    const decoyed = [
      SUBJECT(1),
      `${TS}    [open-swe] › e2e/DECOY-should-not-be-harvested.spec.ts:1:1 › decoy`,
      `${TS}  603 passed (7.4m)`,
    ].join("\n");
    const r = readFlakeReport(decoyed);
    // The SUBJECT line did not open a Playwright block, so no name is harvested…
    return r.specs.length === 0 && r.disagreement !== null;
  })(),
  readFlakeReport(
    [
      SUBJECT(1),
      `${TS}    [open-swe] › e2e/DECOY-should-not-be-harvested.spec.ts:1:1 › decoy`,
      `${TS}  603 passed (7.4m)`,
    ].join("\n")
  )
);

/*
 * …and when they disagree, that is REPORTED rather than resolved. Picking a winner would
 * hide the run where one of the two producers is broken, which is the run worth seeing.
 */
ok(
  "a count with no matching names is a DISAGREEMENT, not a silent zero",
  (() => {
    const r = readFlakeReport(SUBJECT(2));
    return (
      r.count === 2 &&
      r.specs.length === 0 &&
      /counted 2/.test(r.disagreement ?? "")
    );
  })(),
  readFlakeReport(SUBJECT(2))
);

ok(
  "two flakes are named separately and agree with the count",
  (() => {
    const two = [
      SUBJECT(2),
      `${TS}  2 flaky`,
      `${TS}    [chromium] › e2e/api/keys.spec.ts:120:7 › GET /api/keys`,
      `${TS}    [open-swe] › e2e/rungs/open-swe/open-swe-queue-polling.spec.ts:190:7 › queue`,
      `${TS}  601 passed (7.1m)`,
    ].join("\n");
    const r = readFlakeReport(two);
    return r.count === 2 && r.specs.length === 2 && r.disagreement === null;
  })(),
  readFlakeReport(
    [
      SUBJECT(2),
      `${TS}  2 flaky`,
      `${TS}    [chromium] › e2e/api/keys.spec.ts:120:7 › GET /api/keys`,
      `${TS}    [open-swe] › e2e/rungs/open-swe/open-swe-queue-polling.spec.ts:190:7 › queue`,
      `${TS}  601 passed (7.1m)`,
    ].join("\n")
  )
);

ok(
  "the GitHub log prefix is stripped, including the job/step columns before the timestamp",
  stripLogPrefix(
    "E2E — Mocked (no backend required)\tRun mocked E2E tests\t2026-09-07T17:02:37.0Z   1 flaky"
  ) === "  1 flaky",
  stripLogPrefix(
    "E2E — Mocked (no backend required)\tRun mocked E2E tests\t2026-09-07T17:02:37.0Z   1 flaky"
  )
);

/*
 * THE MOVE IS WHAT THE CENSUS IS FOR, so it is asserted rather than left to the output.
 * These three arms are the real `:190` -> `:153` sequence: the count is 1 on both sides and
 * a count-only census reports nothing, while the identity changed at the second reading.
 */
const row = (sha, specs, extra = {}) => ({
  sha,
  state: "counted",
  count: specs.length,
  specs,
  disagreement: null,
  partial: false,
  ...extra,
});
const P190 = "e2e/rungs/open-swe/open-swe-queue-polling.spec.ts:190:7";
const P153 = "e2e/rungs/open-swe/open-swe-queue-polling.spec.ts:153:7";

ok(
  "the MOVE is reported — same count either side, and the substitution is named",
  (() => {
    // rows arrive newest-first, as the API returns them
    const moves = specDelta([row("e4d168f7", [P153]), row("828d6f65", [P190])]);
    return (
      moves.length === 1 &&
      moves[0].from === "828d6f65" &&
      moves[0].to === "e4d168f7" &&
      moves[0].arrived.length === 1 &&
      moves[0].arrived[0] === P153 &&
      moves[0].departed.length === 1 &&
      moves[0].departed[0] === P190
    );
  })(),
  specDelta([row("e4d168f7", [P153]), row("828d6f65", [P190])])
);

ok(
  "an unchanged spec set reports no move — the census does not manufacture one",
  specDelta([row("bbbbbbbb", [P190]), row("aaaaaaaa", [P190])]).length === 0,
  specDelta([row("bbbbbbbb", [P190]), row("aaaaaaaa", [P190])])
);

/*
 * THE ONE THAT KEEPS THE DELTA HONEST. A disagreement row has a known-incomplete spec set, so
 * a name absent from it may simply not have been parsed. Reporting that as a departure would
 * MANUFACTURE a move in the exact field this exists to report — and arrivals stay trustworthy,
 * because a name that is present is present.
 */
ok(
  "a PARTIAL spec set suppresses departures and says so, while arrivals still report",
  (() => {
    const moves = specDelta([
      row("bbbbbbbb", [P153], { partial: true, disagreement: "x" }),
      row("aaaaaaaa", [P190]),
    ]);
    return (
      moves.length === 1 &&
      moves[0].arrived[0] === P153 &&
      moves[0].departed.length === 0 &&
      moves[0].suppressed === true
    );
  })(),
  specDelta([
    row("bbbbbbbb", [P153], { partial: true, disagreement: "x" }),
    row("aaaaaaaa", [P190]),
  ])
);

ok(
  "a disagreement marks the spec set PARTIAL, which is what the delta reads",
  readFlakeReport(SUBJECT(2)).partial === true &&
    readFlakeReport(`${SUBJECT(1)}\n${PW_SUMMARY_ONE}`).partial === false,
  [
    readFlakeReport(SUBJECT(2)).partial,
    readFlakeReport(`${SUBJECT(1)}\n${PW_SUMMARY_ONE}`).partial,
  ]
);

/*
 * THE BLOCKING FINDING FROM #1035's REVIEW, ASSERTED SO IT CANNOT COME BACK. A CANCELLED RUN
 * HAS `status: "completed"` — measured on this repo, all 20 cancellations in a 100-run sample.
 * The first version of this file tested `status !== "completed"` and therefore caught queued and
 * in-progress runs and NOT ONE cancellation, while its comment said the opposite. The arm that
 * matters is the first: it fails against that condition and passes against `conclusion`.
 */
const RUN = (conclusion, status) => ({ conclusion, status });
const JOBS = [{ name: "E2E — Mocked (no backend required)" }];
const PAT = "Mocked";

ok(
  "a CANCELLED run is recognised as cancelled — it has status 'completed', so `status` cannot see it",
  noReadingExpected(RUN("cancelled", "completed"), JOBS, PAT) === "cancelled",
  noReadingExpected(RUN("cancelled", "completed"), JOBS, PAT)
);

ok(
  "a cancelled run is the SAME fact whether or not its job was ever created — no split by timing",
  noReadingExpected(RUN("cancelled", "completed"), [], PAT) === "cancelled",
  noReadingExpected(RUN("cancelled", "completed"), [], PAT)
);

ok(
  "an in-progress run is not a reading either, and says which",
  noReadingExpected(RUN(null, "in_progress"), [], PAT) === "still in_progress",
  noReadingExpected(RUN(null, "in_progress"), [], PAT)
);

ok(
  "a completed run with no matching job says THAT, not 'cancelled'",
  noReadingExpected(RUN("failure", "completed"), [], PAT) === "no matching job",
  noReadingExpected(RUN("failure", "completed"), [], PAT)
);

ok(
  "a completed, non-cancelled run WITH a job expects a reading — null, so the log is read",
  noReadingExpected(RUN("failure", "completed"), JOBS, PAT) === null &&
    noReadingExpected(RUN("success", "completed"), JOBS, PAT) === null,
  [
    noReadingExpected(RUN("failure", "completed"), JOBS, PAT),
    noReadingExpected(RUN("success", "completed"), JOBS, PAT),
  ]
);

/*
 * DEV3's NON-BLOCKING NOTE ON #1035, TAKEN. Only `counted` rows can be compared, so a span
 * printed `from -> to` is between consecutive READINGS and not necessarily consecutive commits.
 * Two bare shas invite attributing the move to the later one when it could have happened at any
 * skipped run. Refusing to compare across the gap would lose the signal, so the gap is counted
 * and travels with the span instead.
 */
ok(
  "a span that SKIPS unreadable runs says how many, so the move is not pinned to the later sha",
  (() => {
    const moves = specDelta([
      row("cccccccc", [P153]),
      { sha: "bbbbbbbb", state: "expected", reason: "cancelled", specs: [] },
      row("aaaaaaaa", [P190]),
    ]);
    return (
      moves.length === 1 &&
      moves[0].from === "aaaaaaaa" &&
      moves[0].to === "cccccccc" &&
      moves[0].skipped === 1
    );
  })(),
  specDelta([
    row("cccccccc", [P153]),
    { sha: "bbbbbbbb", state: "expected", reason: "cancelled", specs: [] },
    row("aaaaaaaa", [P190]),
  ])
);

ok(
  "adjacent readings report skipped=0 — the note is not printed when there is no gap",
  specDelta([row("bbbbbbbb", [P153]), row("aaaaaaaa", [P190])])[0].skipped ===
    0,
  specDelta([row("bbbbbbbb", [P153]), row("aaaaaaaa", [P190])])[0]
);

/*
 * #1042's BLOCKING FINDING, ASSERTED SO IT CANNOT RETURN. The old signature took a `job`, so a
 * caller whose jobs listing FAILED passed `undefined` and got "no matching job" — a row
 * asserting the job does not exist, filed in the bucket excluded from the denominator. An API
 * outage would have shrunk the readable population invisibly, which is the exact blindness this
 * census removes. Taking the LIST makes that unrepresentable: no list, no call.
 */
ok(
  "an UNREAD jobs listing cannot be passed off as an absent job — it throws rather than guessing",
  (() => {
    try {
      noReadingExpected(RUN("failure", "completed"), undefined, PAT);
      return false;
    } catch (e) {
      return (
        e instanceof TypeError &&
        /an unread listing is not an absent job/.test(e.message)
      );
    }
  })(),
  "expected a TypeError naming the distinction"
);

ok(
  "a READ listing with no match still reports 'no matching job' — the honest case is unchanged",
  noReadingExpected(
    RUN("failure", "completed"),
    [{ name: "Some Other Job" }],
    PAT
  ) === "no matching job",
  noReadingExpected(
    RUN("failure", "completed"),
    [{ name: "Some Other Job" }],
    PAT
  )
);

/*
 * #1041: THE EVENT IS A COLUMN, NOT A FILTER, AND THE BRANCH SCOPE DIFFERS BY EVENT.
 *
 * `:245` was reported absent from five runs and present in two of three, and the figures looked
 * combinable. The five were `event=push` on `branch=main`; the three were `event=pull_request`
 * on feature branches; no run is in both. A `branch=main` query returns 100 runs, every one a
 * push. So the branch filter is meaningful for push and MEANINGLESS for pull_request — PR runs
 * live on as many head branches as there are pull requests, and there is no branch value that
 * names them.
 */
ok(
  "both populations are returned by default — neither is the implicit one",
  (() => {
    const p = populations("main");
    return (
      p.length === 2 && p[0].event === "push" && p[1].event === "pull_request"
    );
  })(),
  populations("main").map((x) => x.event)
);

ok(
  "the branch filter applies to push and NOT to pull_request",
  (() => {
    const [push, pr] = populations("main");
    return (
      /branch=main/.test(push.query) &&
      !/branch=/.test(pr.query) &&
      /event=pull_request/.test(pr.query)
    );
  })(),
  populations("main").map((x) => x.query)
);

ok(
  "each population states its own scope, so a reader is told what they are looking at",
  (() => {
    const [push, pr] = populations("feat/x");
    return (
      /branch feat\/x/.test(push.scope) && /all head branches/.test(pr.scope)
    );
  })(),
  populations("feat/x").map((x) => x.scope)
);

ok(
  "asking for one event returns only that one, still labelled",
  (() => {
    const p = populations("main", "pull_request");
    return p.length === 1 && p[0].event === "pull_request";
  })(),
  populations("main", "pull_request")
);

ok(
  "an unknown event REFUSES rather than silently returning nothing to census",
  (() => {
    try {
      populations("main", "workflow_dispatch");
      return false;
    } catch (e) {
      return e instanceof RangeError && /unknown event/.test(e.message);
    }
  })(),
  "expected a RangeError naming the known events"
);

/*
 * THE NEGATIVE THAT KEEPS THE SEPARATION STRUCTURAL. A tool that CAN emit a union invites the
 * reading it exists to prevent, so there must be no population whose query spans both events.
 */
ok(
  "no population mixes events — there is no query that would produce a combined figure",
  populations("main").every(
    (p) => (p.query.match(/event=/g) ?? []).length === 1
  ),
  populations("main").map((x) => x.query)
);

/* ---- process-level: the refusals live in main(), and no pure-function arm can reach one ---- */

/*
 * EVERY ARM ABOVE IS OVER A PURE FUNCTION, AND THE WINDOW GUARD IS NOT ONE. It lives in
 * `main()`, so this proof would have passed with the guard DELETED — and that guard produced
 * the only real finding of its first live run, refusing a pull_request census whose page did
 * not reach back to the requested window. A component exercised once, live, and one edit from
 * silent removal is not proven.
 *
 * The same is true of two other things `main()` alone does: turning a failed jobs listing into
 * an `unreadable` row that CARRIES ITS CAUSE (the #1042 repair), and emitting no line that sums
 * the two populations. Both were asserted only by docstring.
 *
 * The harness is ARCHITECT's from assert-every-branch-was-raised.selftest.mjs, written for this
 * exact reason: drive the assembled path with a stand-in `gh`, PATH PREPENDED and never
 * replaced, so the real binary is still reachable for anything the shim does not answer.
 */
const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "flake-census.mjs"
);

function runAgainst(shimScript, args = []) {
  const dir = mkdtempSync(join(tmpdir(), "census-"));
  const shim = join(dir, "gh");
  writeFileSync(shim, shimScript);
  chmodSync(shim, 0o755);
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 60000,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
}

/**
 * A runs page: newest first, as the API returns it.
 *
 * TWO ENTRIES, AND BOTH ARE LOAD-BEARING. The window guard reads the OLDEST (last) entry and
 * refuses if it does not reach back past `--since`; the row loop keeps only entries NEWER than
 * `--since`. A one-entry page cannot satisfy both, and a fixture that satisfies only the guard
 * censuses ZERO runs — which is how the first version of the jobs-failure arm below passed no
 * rows at all and reported nothing rather than the row it exists to check.
 */
const runsPage = (oldest, inWindow = "2026-09-07T18:00:00Z") =>
  `{"total_count":500,"workflow_runs":[` +
  `{"id":1,"head_sha":"aaaaaaaabbbbbbbb","status":"completed","conclusion":"success","created_at":"${inWindow}"},` +
  `{"id":2,"head_sha":"ccccccccdddddddd","status":"completed","conclusion":"success","created_at":"${oldest}"}` +
  `]}`;

const LOG_ONE_FLAKE = [
  "2026-09-07T17:00:00.0Z   1 flaky",
  "2026-09-07T17:00:00.0Z     [open-swe] › e2e/x.spec.ts:1:1 › a case",
  "2026-09-07T17:00:00.0Z   3 passed",
  "2026-09-07T17:00:00.0Z SUBJECT: 1 flaky test(s) surfaced from Playwright's own report",
].join("\n");

ok(
  "PULL_REQUEST: a page that does not reach past the window REFUSES rather than censusing part of it",
  (() => {
    const r = runAgainst(
      `#!/bin/sh
case "$*" in
  *"event=pull_request"*) echo '${runsPage(
    "2026-09-07T12:00:00Z",
    "2026-09-07T12:30:00Z"
  )}' ;;
  *"event=push"*)         echo '${runsPage("2026-09-01T00:00:00Z")}' ;;
  *jobs*)                 echo '{"jobs":[]}' ;;
  *)                      echo '' ;;
esac
`,
      ["--since", "2026-09-07T11:00:00Z", "--event", "pull_request"]
    );
    const out = `${r.stdout}${r.stderr}`;
    return (
      r.status === 2 && /REFUSE/.test(out) && /pull_request page/.test(out)
    );
  })(),
  "expected exit 2 naming the pull_request page"
);

/*
 * THE SYMMETRY IS ASSERTED, NOT INFERRED FROM A SHARED LINE. One guard serves both populations
 * today; an arm on only one of them would pass if someone later special-cased the other.
 */
ok(
  "PUSH: the same page condition REFUSES too — the guard is not pull_request-only",
  (() => {
    const r = runAgainst(
      `#!/bin/sh
case "$*" in
  *"event=push"*) echo '${runsPage(
    "2026-09-07T12:00:00Z",
    "2026-09-07T12:30:00Z"
  )}' ;;
  *jobs*)         echo '{"jobs":[]}' ;;
  *)              echo '' ;;
esac
`,
      ["--since", "2026-09-07T11:00:00Z", "--event", "push"]
    );
    const out = `${r.stdout}${r.stderr}`;
    return r.status === 2 && /REFUSE/.test(out) && /push page/.test(out);
  })(),
  "expected exit 2 naming the push page"
);

/*
 * #1042's REPAIR, WHICH NOTHING HAS ASSERTED UNTIL NOW. A failed jobs listing must become an
 * `unreadable` row CARRYING ITS CAUSE — not "no matching job", which asserts the job does not
 * exist, and not an `expected` row, which is excluded from the denominator.
 */
ok(
  "a FAILED jobs listing becomes an UNKNOWN row carrying its cause, not an absent job",
  (() => {
    const r = runAgainst(
      `#!/bin/sh
case "$*" in
  *"event=push"*) echo '${runsPage("2026-09-01T00:00:00Z")}' ;;
  *jobs*)         echo "boom" >&2; exit 1 ;;
  *)              echo '' ;;
esac
`,
      ["--since", "2026-09-07T11:00:00Z", "--event", "push"]
    );
    const out = `${r.stdout}${r.stderr}`;
    return (
      r.status === 0 &&
      /out of 1 in the window/.test(out) && // NOT vacuous: a row was examined
      /UNKNOWN/.test(out) &&
      /jobs listing could not be fetched/.test(out) &&
      !/no matching job/.test(out)
    );
  })(),
  "expected an UNKNOWN row naming the fetch failure"
);

/*
 * NO LINE SUMS THE TWO POPULATIONS. The pure-function arm proves no QUERY spans both events;
 * this proves the assembled run emits no combined figure either — the gap between those two is
 * a union built in the caller, which no query-shaped assertion can reach.
 */
ok(
  "the assembled two-population run emits per-population totals and NO combined figure",
  (() => {
    const r = runAgainst(
      `#!/bin/sh
case "$*" in
  *runs?*|*"event="*) echo '${runsPage("2026-09-01T00:00:00Z")}' ;;
  *jobs*)             echo '{"jobs":[{"id":9,"name":"E2E — Mocked (no backend required)"}]}' ;;
  *"--log"*)          printf '%s\n' "${LOG_ONE_FLAKE}" ;;
  *)                  echo '' ;;
esac
`,
      ["--since", "2026-09-07T11:00:00Z"]
    );
    const out = `${r.stdout}${r.stderr}`;
    const perPop = (out.match(/^\s+(push|pull_request): \d+ counted/gm) ?? [])
      .length;
    // a combined line would name a total not attributable to one population
    const combined =
      /\btotal(?:s)? across\b|\bcombined\b|\ball populations\b/i.test(out);
    const examined = (out.match(/out of (\d+) in the window/g) ?? []).map((m) =>
      Number(m.match(/\d+/)[0])
    );
    return (
      r.status === 0 &&
      perPop === 2 &&
      examined.length === 2 &&
      examined.every((n) => n > 0) && // NOT vacuous: both populations examined a run
      !combined &&
      /NEVER SUMMED/.test(out)
    );
  })(),
  "expected two per-population totals, no combined figure"
);

const total = pass + fail;
console.log();
if (fail) {
  console.error(`FAIL: ${fail}/${total} cases wrong.`);
  process.exit(1);
}
console.log(
  `PASS: ${pass}/${total}. It names the spec and REPORTS the move rather than leaving it\n` +
    `      to the eye, keeps a SAID zero distinct from an absent reading, decides "no reading\n` +
    `      expected" by \`conclusion\` because a cancelled run is \`status: "completed"\`, refuses\n` +
    `      to harvest names from the other producer's line, and suppresses departures from a\n` +
    `      spec set it knows is partial rather than manufacturing a move.`
);
