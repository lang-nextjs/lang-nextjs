/**
 * PROOF for assert-armed-prs-are-covered-by-a-review.mjs.
 *
 * `classify` is pure over facts the caller has already fetched, so every state is driven from
 * fabricated inputs rather than from whatever the board happens to hold. That matters more than
 * usual here: the board's true state changes hourly, so a proof that queried it would assert
 * something different on every run and could not hold a negative case at all.
 *
 * THE COULD-NOT-CHECK CASES ARE THE POINT, NOT AN EDGE. A prototype of this check labelled a
 * report that named NO SHA as "stale sha", which reports the unverifiable as verified. NO_SHA and
 * UNREADABLE are therefore separate states with separate cases below, and a null comparison is
 * asserted NOT to read as an equal one.
 *
 * THE BENIGN CASE IS A REGRESSION. The first version reported `report sha != head` and would have
 * fired on nearly every armed PR, because promoting a PR moves its head. `covered-after-a-main-
 * merge` is that case: the head differs from the reviewed sha and the contribution is identical.
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  classify,
  contribution,
  reportsFrom,
  unanchoredDeltas,
  COMPARE_FILE_CAP,
  unreadableReason,
  unreadableReasonOfList,
  withheldPatchFiles,
  expectedFileCount,
  unionContributions,
  endpointsOf,
  liveReports,
  passLine,
  isMergeCandidate,
  allChecksGreen,
  prUnderTest,
  admitsUnderTest,
  STATE,
  FINDINGS,
  REFUSALS,
} from "./assert-armed-prs-are-covered-by-a-review.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "assert-armed-prs-are-covered-by-a-review.mjs");
const results = [];

/*
 * THE AMBIENT EVENT ENVIRONMENT IS NEUTRALISED FOR EVERY SPAWNED CHECKER, AND IT BELONGS HERE
 * RATHER THAN IN THE CHECKER (#1074).
 *
 * GitHub Actions sets `GITHUB_EVENT_NAME` and `GITHUB_EVENT_PATH` on EVERY step. This change made
 * the checker read them to learn which pull request it is gating -- which is correct and is the
 * whole point -- and these harnesses hand a child `...process.env`, so on the runner the spawned
 * checker read the REAL event, found the pull request under test absent from the STUB board, and
 * refused with exit 2. Nine arms failed for a reason none of them was about.
 *
 * IT PASSED LOCALLY AND FAILED WHERE IT GATES, which is the worse direction of the two: the local
 * green is what gets reported, and it was -- 114/114 read by hand, 105/114 on the runner. The arms
 * that broke are exactly the ones that exist because unit arms cannot see `main()`, so making the
 * proof reach `main()` is what moved it into the one region where the two environments differ.
 *
 * A TEST THAT INHERITS AN ENVIRONMENT IT DOES NOT CONTROL IS TESTING THE RUNNER TOO. Every arm
 * that WANTS an event payload still passes one: this sits before `...extraEnv` at every site.
 */
const NO_CI_EVENT = { GITHUB_EVENT_NAME: "", GITHUB_EVENT_PATH: "" };

const ok = (name, cond, detail) => results.push({ ok: !!cond, name, detail });

/** A compare `files[]` entry carrying a real unified patch, which is what the API returns. */
const file = (filename, patch) => ({ filename, patch });
const REVIEWED = contribution([
  file("a.ts", "+one\n+two"),
  file("b.ts", "+three"),
]);

/* ---- the two states a prototype of this check conflated ---------------------------------- */

ok(
  "a report naming no sha is COULD NOT CHECK, not absent and not stale",
  classify({
    inSubject: true,
    reports: [{ agent: null, sha: null }],
    atHead: REVIEWED,
    atReviewed: REVIEWED,
    reviewedInBranch: true,
  }).state === STATE.NO_SHA
);

ok(
  "a null comparison with NO reason attached is a REFUSAL and does NOT read as equal — an unknown is not a verdict (#1082)",
  (() => {
    const r = classify({
      inSubject: true,
      reports: [{ agent: "DEV1", sha: "abc1234" }],
      atHead: null,
      atReviewed: null,
      reviewedInBranch: true,
    });
    return r.state === STATE.UNCOMPARED && REFUSALS.has(r.state);
  })()
);

/* ---- the benign case, which is why `sha != head` is not the finding ----------------------- */

ok(
  "a head moved by a main-merge is COVERED, because the contribution is unchanged",
  classify({
    inSubject: true,
    reports: [{ agent: "DEV1", sha: "fab1884c" }],
    atHead: REVIEWED,
    atReviewed: REVIEWED,
    reviewedInBranch: true,
  }).state === STATE.OK
);

/* ---- the real findings -------------------------------------------------------------------- */

ok(
  "armed with no report at all is a finding",
  classify({
    inSubject: true,
    reports: [],
    atHead: REVIEWED,
    atReviewed: REVIEWED,
    reviewedInBranch: true,
  }).state === STATE.NO_REPORT
);

ok(
  "a file added after the review is UNCOVERED and the message names it",
  (() => {
    const r = classify({
      inSubject: true,
      reports: [{ agent: "DEV1", sha: "abc1234" }],
      atHead: contribution([
        file("a.ts", "+one\n+two"),
        file("b.ts", "+three"),
        file("c.ts", "+brand new"),
      ]),
      atReviewed: REVIEWED,
      reviewedInBranch: true,
    });
    return r.state === STATE.UNCOVERED && r.detail.includes("c.ts");
  })()
);

ok(
  "a NEW LINE in an already-reviewed file is UNCOVERED - a filename set cannot see this",
  classify({
    inSubject: true,
    reports: [{ agent: "DEV1", sha: "abc1234" }],
    atHead: contribution([
      file("a.ts", "+one\n+two\n+FOUR"),
      file("b.ts", "+three"),
    ]),
    atReviewed: REVIEWED,
    reviewedInBranch: true,
  }).state === STATE.UNCOVERED
);

/*
 * THE LOCKFILE REGRESSION. `path@blob` was the first comparison and the live board refuted it:
 * #800, #803 and #808 each add EXACTLY what they added at review time, and differ only by one
 * removal -- an orphan pruned by the rebase's fresh resolution. Since promotion is a rebase,
 * every rebased dependabot PR flagged forever, on the pull requests needing least attention.
 */
ok(
  "identical additions plus an extra REMOVAL is not a finding - the live #800/#803/#808 shape",
  (() => {
    const r = classify({
      inSubject: true,
      reports: [{ agent: "DEV2", sha: "7c942553" }],
      atHead: contribution([
        file("pnpm-lock.yaml", "+axe-core@4.13.0\n-tailwindcss@4.3.0"),
      ]),
      atReviewed: contribution([file("pnpm-lock.yaml", "+axe-core@4.13.0")]),
      reviewedInBranch: false,
    });
    return r.state === STATE.REMOVED_ONLY && !FINDINGS.has(r.state);
  })()
);

ok(
  "a removal is REPORTED, not dropped - a deleted guard must not vanish silently",
  classify({
    inSubject: true,
    reports: [{ agent: "DEV2", sha: "7c942553" }],
    atHead: contribution([file("guard.ts", "-assertSomethingImportant();")]),
    atReviewed: contribution([file("guard.ts", "")]),
    reviewedInBranch: true,
  }).detail.includes("guard.ts")
);

ok(
  "a MISSING patch is a FINDING and stays one (#1082) — the compare ANSWERED and the pull request carries something no reader can have read, which is the case a wholesale move to REFUSALS would have silenced",
  (() => {
    const files = [{ filename: "big.bin" }];
    const c = contribution(files);
    // `main()` computes the reason whenever the fetch answered; passing it is what that wiring does
    const r = classify({
      inSubject: true,
      reports: [{ agent: "DEV1", sha: "abc1234" }],
      unreadable: unreadableReason(files),
      atHead: c,
      atReviewed: REVIEWED,
      reviewedInBranch: true,
    });
    return (
      c === null &&
      r.state === STATE.UNREADABLE &&
      FINDINGS.has(r.state) &&
      /carries no patch/.test(r.detail)
    );
  })()
);

ok(
  "a rebase whose contribution is UNCHANGED is covered - the rebase alone is not the finding",
  classify({
    inSubject: true,
    reports: [{ agent: "DEV1", sha: "abc1234" }],
    atHead: REVIEWED,
    atReviewed: REVIEWED,
    reviewedInBranch: false,
  }).state === STATE.OK
);

ok(
  "a rebase that ALSO changed content is UNCOVERED and names the file AND the rebase",
  (() => {
    const r = classify({
      inSubject: true,
      reports: [{ agent: "DEV1", sha: "abc1234" }],
      atHead: contribution([
        file("a.ts", "+brand new"),
        file("b.ts", "+three"),
      ]),
      atReviewed: REVIEWED,
      reviewedInBranch: false,
    });
    return (
      r.state === STATE.UNCOVERED &&
      r.detail.includes("a.ts") &&
      r.detail.includes("rebased")
    );
  })()
);

ok(
  "there is no force-pushed state left, and a reviewed side that never answered is a REFUSAL rather than a verdict about the pull request",
  (() => {
    const r = classify({
      inSubject: true,
      reports: [{ agent: "DEV1", sha: "abc1234" }],
      atHead: REVIEWED,
      atReviewed: null,
      reviewedInBranch: false,
    });
    return r.state === STATE.UNCOMPARED && !("SUPERSEDED" in STATE);
  })()
);

ok(
  "an UNARMED pr is not examined and is not a finding",
  (() => {
    const s = classify({
      inSubject: false,
      reports: [],
      atHead: null,
      atReviewed: null,
      reviewedInBranch: null,
    }).state;
    return s === STATE.UNARMED && !FINDINGS.has(s);
  })()
);

/* ---- the token, and the two proxies it exists to beat -------------------------------------- */

ok(
  "the token parses the agent and the sha",
  (() => {
    const [r] = reportsFrom([
      { body: "READER-REPORT: DEV1 @ 00d5f110\n\nprose after" },
    ]);
    return r?.agent === "DEV1" && r?.sha === "00d5f110";
  })()
);

ok(
  "a Dependabot comment does NOT satisfy the token - comment COUNT would have",
  reportsFrom([
    { body: "### Labels\n\nDependabot will merge this automatically." },
  ]).length === 0
);

ok(
  "the legacy PROSE marker does NOT satisfy the token - matching wording is the dependency #946 exists for",
  reportsFrom([
    { body: "**Reviewed by DEV1 at `00d5f110`; posted by me (#915).**" },
  ]).length === 0
);

/* ---- a report that is PRESENT and cannot be counted is not an ABSENT one ------------------- */

/*
 * FIVE DECORATIONS, ONE FALSE SENTENCE. `TOKEN_LOOSE` was anchored exactly like `TOKEN`, so a
 * token wearing any markdown decoration matched neither and the pull request was told
 * `ARMED, NO READER REPORT` -- nobody looked. #974 carried `**READER-REPORT: ARCHITECT @
 * 87e8c6eb**` and that is the sentence it got. The VERDICT was right both before and after; the
 * CAUSE was false, and a reader sent to find a reader does not go looking for two asterisks.
 *
 * THE ANCHOR IS NOT LOOSENED, WHICH IS THE LOAD-BEARING DECISION. Accepting `**` into `TOKEN`
 * would fail toward COVERED. Reporting a refusal fails toward "I could not answer", which is the
 * distinction this repository's exit codes already draw and the one `assert-formatted` draws
 * between "unformatted" and "no prettier".
 */
const DECORATED = {
  blockquote: "> READER-REPORT: DEV1 @ 00d5f110",
  list: "- READER-REPORT: DEV1 @ 00d5f110",
  heading: "## READER-REPORT: DEV1 @ 00d5f110",
  indented: "    READER-REPORT: DEV1 @ 00d5f110",
  backticks: "`READER-REPORT: DEV1 @ 00d5f110`",
  "half-bolded": "**READER-REPORT: DEV1 @ 00d5f110",
};

for (const [how, body] of Object.entries(DECORATED))
  ok(
    `a ${how} token is a REFUSAL, not "nobody read this"`,
    (() => {
      const st = classify({
        inSubject: true,
        reports: reportsFrom([{ body }]),
        atHead: REVIEWED,
        atReviewed: REVIEWED,
        reviewedInBranch: true,
      }).state;
      return st === STATE.UNPARSED && st !== STATE.NO_REPORT;
    })()
  );

ok(
  "the refusal's ADVICE matches the rule - it used to say `undecorated`, which the ruling made false",
  (() => {
    const { detail } = classify({
      inSubject: true,
      reports: reportsFrom([{ body: DECORATED.blockquote }]),
      atHead: REVIEWED,
      atReviewed: REVIEWED,
      reviewedInBranch: true,
    });
    return detail.includes("symmetric") && !detail.includes("undecorated");
  })()
);

ok(
  "the refusal QUOTES the offending line, so the repair is visible without opening the PR",
  (() => {
    const { detail } = classify({
      inSubject: true,
      reports: reportsFrom([{ body: DECORATED.blockquote }]),
      atHead: REVIEWED,
      atReviewed: REVIEWED,
      reviewedInBranch: true,
    });
    return (
      detail.includes(DECORATED.blockquote) && !detail.includes("names no sha")
    );
  })()
);

/*
 * THE SYMMETRIC WRAPPER IS THE ONE EXCEPTION, AND THE BOARD DECIDED IT RATHER THAN TASTE. Swept
 * over 19 open pull requests: DEV2 writes `**READER-REPORT: ...**` for 5 of 5 of their tokens,
 * DEV3 for 1 of 3. Four pull requests carried a read and no parseable token and would have been
 * told `ARMED, NO READER REPORT` the moment they were armed. A symmetric wrapper is semantically
 * empty -- the content is still matched character for character -- so it is stripped; the five
 * forms above genuinely CHANGE the line and stay refusals.
 */
ok(
  "a symmetric **bold** token parses, agent and sha intact",
  (() => {
    const [r] = reportsFrom([{ body: "**READER-REPORT: DEV2 @ 2583f062**" }]);
    return r?.agent === "DEV2" && r?.sha === "2583f062" && !r?.unparsed;
  })()
);

ok(
  "a bolded DELTA token keeps its range - the wrapper must not eat the trailing prose",
  (() => {
    const [r] = reportsFrom([
      { body: "**READER-REPORT: DEV2 @ 959ea154..47063cf2 (delta only)**" },
    ]);
    return r?.from === "959ea154" && r?.sha === "47063cf2";
  })()
);

/*
 * ASYMMETRY IS STILL A REFUSAL, which is what `\k<bold>` buys and an optional `(\*\*)?` at each
 * end would not: an unmatched group backreferences the EMPTY STRING, so an opening pair with no
 * closing one does not parse. `half-bolded` above is that case, and it is in the refusal table
 * rather than here.
 */
ok(
  "the groups are read BY NAME - adding the wrapper renumbered every positional read",
  (() => {
    const src = readFileSync(SCRIPT, "utf8");
    return /m\.groups\.agent/.test(src) && !/agent:\s*m\[1\]/.test(src);
  })()
);

/*
 * THE FALSE-POSITIVE CONTROL, which is the arm that makes the refusals above mean something. A
 * pattern that matched `READER-REPORT` ANYWHERE would pass all six and would also fire on every
 * comment discussing the convention -- and this repository writes many of those, including the
 * one that reported this defect.
 */
ok(
  "prose DISCUSSING the token is not mistaken for one - the class admits decoration, not words",
  reportsFrom([
    {
      body: "A reader clears one by posting a READER-REPORT: line naming the sha.",
    },
  ]).length === 0
);

/*
 * THE MULTI-LINE CASE, WHICH ONLY THE LIVE ARTIFACT PRODUCED. Every fixture above is one line, so
 * a class written with `\s` -- which matches NEWLINES -- passed all of them while capturing
 * backwards across blank lines. Driven against #974's real comment it quoted a horizontal rule as
 * part of the token line. The class admits HORIZONTAL whitespace only, and this is the arm that
 * says so.
 */
ok(
  "the quoted line is ONE line - decoration on earlier lines is not swallowed into it",
  (() => {
    const { detail } = classify({
      inSubject: true,
      reports: reportsFrom([
        { body: "some prose\n\n---\n\n> READER-REPORT: DEV1 @ 00d5f110" },
      ]),
      atHead: REVIEWED,
      atReviewed: REVIEWED,
      reviewedInBranch: true,
    });
    return (
      detail.includes("> READER-REPORT: DEV1 @ 00d5f110") &&
      !detail.includes("---")
    );
  })()
);

/* ---- a withdrawn token used to COUNT, which is the half that changes a verdict ------------- */

/*
 * MEASURED ON THE ARTIFACT, NOT ARGUED. TEAMLEAD withdrew a coverage carry on #974 by editing a
 * `> [!CAUTION]` block above the token and leaving the token intact so the defect stayed
 * searchable. Before this arm existed, `classify` returned `covered` for exactly that comment:
 * the check had no concept of withdrawal, so a RETRACTED read armed a pull request. That is
 * silent in the direction that costs, and it is the only change here that moves a verdict rather
 * than a sentence.
 */
const WITHDRAWN_BODY =
  "> [!CAUTION]\n> **WITHDRAWN — THIS TOKEN IS NOT COVERAGE.** Superseded.\n\n---\n\nREADER-REPORT: DEV1 @ 00d5f110";

ok(
  "a withdrawn token does NOT cover - it used to return `covered` off a retracted read",
  (() => {
    const st = classify({
      inSubject: true,
      reports: reportsFrom([{ body: WITHDRAWN_BODY }]),
      atHead: REVIEWED,
      atReviewed: REVIEWED,
      reviewedInBranch: true,
    }).state;
    return st === STATE.WITHDRAWN && st !== STATE.OK;
  })()
);

/*
 * WITHDRAWAL IS TESTED BEFORE EVERY OTHER BRANCH, and this arm exists because the ordering is the
 * whole fix. A withdrawn token is WELL FORMED: it parses, it names a sha, its contribution
 * compares equal. Every test below it passes, so placing it anywhere later makes it unreachable
 * for precisely the tokens it exists to catch -- the same reachability trap the `unreadable`
 * branch in `classify` carries a paragraph about.
 */
ok(
  "the withdrawn token here is otherwise PERFECT - which is why order, not presence, is the fix",
  (() => {
    const [r] = reportsFrom([{ body: WITHDRAWN_BODY }]);
    return r.agent === "DEV1" && r.sha === "00d5f110" && r.withdrawn === true;
  })()
);

ok(
  "one withdrawal does not poison a live read - #974's actual state today is covered",
  classify({
    inSubject: true,
    reports: reportsFrom([
      { body: WITHDRAWN_BODY },
      { body: "READER-REPORT: ARCHITECT @ 00d5f110" },
    ]),
    atHead: REVIEWED,
    atReviewed: REVIEWED,
    reviewedInBranch: true,
  }).state === STATE.OK
);

ok(
  "liveReports drops the withdrawn and keeps the rest",
  (() => {
    const rs = liveReports([
      { sha: "a", withdrawn: true },
      { sha: "b", withdrawn: false },
      { sha: "c" },
    ]);
    return rs.length === 2 && !rs.some((r) => r.sha === "a");
  })()
);

ok(
  "both new states FAIL - a report that cannot be counted must not pass silently",
  FINDINGS.has(STATE.UNPARSED) && FINDINGS.has(STATE.WITHDRAWN)
);

ok(
  "the four present-but-uncountable sentences are distinguishable from each other and from absent",
  new Set([STATE.NO_REPORT, STATE.NO_SHA, STATE.UNPARSED, STATE.WITHDRAWN])
    .size === 4
);

/* ---- a delta read covers the difference, not the pull request ------------------------------ */

ok(
  "the range form parses as a delta and does NOT read as a full read of its end sha",
  (() => {
    const [r] = reportsFrom([
      { body: "READER-REPORT: DEV1 @ 959ea154..47063cf2 (delta only)" },
    ]);
    return r?.from === "959ea154" && r?.sha === "47063cf2";
  })()
);

ok(
  "a full read leaves `from` null, so the two forms are distinguishable",
  reportsFrom([{ body: "READER-REPORT: DEV1 @ 00d5f110" }])[0]?.from === null
);

ok(
  "#935's shape: a full read then a delta from it COMPOSES and is not a finding",
  (() => {
    const reports = [
      { agent: "DEV1", from: null, sha: "959ea154" },
      { agent: "DEV1", from: "959ea154", sha: "47063cf2" },
    ];
    return (
      unanchoredDeltas(reports).length === 0 &&
      classify({
        inSubject: true,
        reports,
        atHead: REVIEWED,
        atReviewed: REVIEWED,
        reviewedInBranch: true,
      }).state === STATE.OK
    );
  })()
);

ok(
  "a delta whose base nobody read is PARTIAL, even when the contribution matches",
  classify({
    inSubject: true,
    reports: [{ agent: "DEV1", from: "959ea154", sha: "47063cf2" }],
    atHead: REVIEWED,
    atReviewed: REVIEWED,
    reviewedInBranch: true,
  }).state === STATE.PARTIAL
);

ok(
  "anchoring tolerates different abbreviations of the same sha",
  unanchoredDeltas([
    {
      agent: "DEV1",
      from: null,
      sha: "959ea154f0b2c3d4e5f60718293a4b5c6d7e8f90",
    },
    { agent: "DEV2", from: "959ea154", sha: "47063cf2" },
  ]).length === 0
);

ok(
  "the reviewer name is not an allow-list - TEAMLEAD reviews too, and a `DEV[123]` pattern mis-scored #883",
  (() => {
    const names = ["TEAMLEAD", "DEV1", "someone-new_2"].map(
      (n) => reportsFrom([{ body: `READER-REPORT: ${n} @ fc99d858` }])[0]?.agent
    );
    return names.join(",") === "TEAMLEAD,DEV1,someone-new_2";
  })()
);

ok(
  "a TRUNCATED file list returns null - the compare endpoint caps at 300 and reports no total",
  contribution([file("a.ts", "+one")], 7) === null
);

/*
 * THE BOUNDARY CASES TOUCH THE BOUNDARY, AND THE VERSION DEV2 REVIEWED DID NOT. It asserted "an
 * agreeing independent total is trusted, EVEN AT THE CAP" over a fixture of ONE file. A test whose
 * name makes a boundary claim and whose fixture never reaches the boundary is worse than none: it
 * is the reason the latent finding underneath it stayed invisible, because the one case where the
 * reasoning could be wrong had a passing test with its name on it.
 */
const many = (n) => Array.from({ length: n }, (_, i) => file(`f${i}.ts`, "+x"));

ok(
  "AT the cap an agreeing total does NOT clear it - the two readings may share the cap",
  contribution(many(COMPARE_FILE_CAP), COMPARE_FILE_CAP) === null
);

ok(
  "one under the cap, with an agreeing total, is trusted",
  contribution(many(COMPARE_FILE_CAP - 1), COMPARE_FILE_CAP - 1) !== null
);

ok(
  "an unreadable side is COULD NOT CHECK, and a diverged branch does not change that",
  classify({
    inSubject: true,
    reports: [{ agent: "DEV1", sha: "abc1234" }],
    unreadable: "the compare listed 300 files, at the cap",
    atHead: REVIEWED,
    atReviewed: null,
    reviewedInBranch: false,
  }).state === STATE.UNREADABLE
);

/*
 * THREE CAUSES, THREE SENTENCES. A boolean named `truncated` was set for all three -- a list at
 * the cap, a count disagreeing with the pull request's own, and an absent patch -- so ONE binary
 * file reported "the compare file list was truncated", asserting a cause that had not occurred.
 * The reachability is inverted, which is what made it worth fixing: truncation needs 300 changed
 * files and the largest pull request this repository has ever had is #81 at 253, while an absent
 * patch needs ONE binary file and four PNG baselines are tracked here.
 */
ok(
  "the cap names the cap",
  (unreadableReason(many(COMPARE_FILE_CAP)) ?? "").includes("cap")
);

ok(
  "a disagreeing total names BOTH counts, not the cap",
  (() => {
    const why = unreadableReason([file("a.ts", "+one")], 7) ?? "";
    return why.includes("1") && why.includes("7") && !why.includes("cap");
  })()
);

ok(
  "an absent patch names THE FILE and does not claim truncation",
  (() => {
    const why = unreadableReason([{ filename: "baseline.png" }]) ?? "";
    return why.includes("baseline.png") && !why.includes("truncat");
  })()
);

ok(
  "a readable list has no reason at all",
  unreadableReason([file("a.ts", "+one")], 1) === null
);

/*
 * THE STACKED SHAPE, WHICH THE LIVE GREEN COULD NOT SEE. `changedFiles` is measured against the
 * pull request's OWN base and the compare is against `main`, so for a stacked pull request they
 * are different quantities and the mismatch guard fires on a healthy branch. Driven against #953
 * itself: 5 files in the compare, 2 in `changedFiles`, neither reading incomplete.
 */
ok(
  "a main-based pull request supplies its own file count as the second reading",
  expectedFileCount({ baseRefName: "main", changedFiles: 5 }) === 5
);

ok(
  "a STACKED pull request supplies NO second reading - the two counts have different bases",
  expectedFileCount({
    baseRefName: "feat/some-other-branch",
    changedFiles: 2,
  }) === null
);

ok(
  "#953's own live shape produces no mismatch verdict once the base is accounted for",
  unreadableReason(
    many(5),
    expectedFileCount({
      baseRefName: "feat/an-armed-pr-is-covered-by-its-review",
      changedFiles: 2,
    })
  ) === null
);

ok(
  "and the same shape on a MAIN base still catches a real disagreement",
  (
    unreadableReason(
      many(5),
      expectedFileCount({ baseRefName: "main", changedFiles: 2 })
    ) ?? ""
  ).includes("incomplete")
);

/*
 * #950's LIVE SHAPE. A full read and a delta, where the FULL read was posted SEVENTEEN MINUTES
 * LATER because it travelled by message first. Taking the last endpoint selected the older sha,
 * discarded the delta's coverage, and reported content added since a review that had covered it.
 */
ok(
  "two reports COMPOSE - the later-POSTED one being older does not discard the other's coverage",
  (() => {
    const base = contribution([file("a.ts", "+one")]);
    const later = contribution([file("a.ts", "+one\n+two")]);
    const union = unionContributions([later, base]); // deliberately newest-first
    return (
      classify({
        inSubject: true,
        reports: [
          { agent: "DEV1", from: null, sha: "22460e29" },
          { agent: "DEV1", from: "22460e29", sha: "71c12b05" },
        ],
        atHead: later,
        atReviewed: union,
        reviewedInBranch: true,
      }).state === STATE.OK
    );
  })()
);

ok(
  "a union containing an unreadable member is null, not a smaller set",
  unionContributions([contribution([file("a.ts", "+one")]), null]) === null
);

ok(
  "one commit written at two lengths is ONE endpoint - and this calls the MODULE, not a copy",
  endpointsOf([
    { agent: "DEV1", sha: "959ea154f0b2c3d4e5f60718293a4b5c6d7e8f90" },
    { agent: "DEV2", sha: "959ea154" },
  ]).length === 1
);

ok(
  "two genuinely different shas are two endpoints",
  endpointsOf([
    { agent: "A", sha: "aaaaaaa1" },
    { agent: "B", sha: "bbbbbbb2" },
  ]).length === 2
);

/*
 * THESE ASSERT `detail`, NOT `state`, AND THAT IS THE POINT. Removing the force-pushed state took
 * the line that READ `unreadable` with it, so every cause fell through to one generic sentence --
 * and the suite stayed green at 39/39, because both surviving unreadable arms asserted only the
 * STATE. A parameter can be computed, passed, and discarded without a single case noticing.
 */
ok(
  "an absent patch's reason REACHES the output, it is not merely constructed",
  (() => {
    const why = unreadableReason([{ filename: "baseline.png" }]);
    return (
      classify({
        inSubject: true,
        reports: [{ agent: "DEV1", sha: "abc1234" }],
        unreadable: why,
        atHead: REVIEWED,
        atReviewed: null,
        reviewedInBranch: true,
      }).detail === why
    );
  })()
);

ok(
  "the cap's reason reaches the output too - all four causes share this path",
  (() => {
    const why = unreadableReason(many(COMPARE_FILE_CAP));
    return (
      classify({
        inSubject: true,
        reports: [{ agent: "DEV1", sha: "abc1234" }],
        unreadable: why,
        atHead: REVIEWED,
        atReviewed: null,
        reviewedInBranch: true,
      }).detail === why
    );
  })()
);

ok(
  "with NO reason, the generic sentence is still what a null comparison gets",
  classify({
    inSubject: true,
    reports: [{ agent: "DEV1", sha: "abc1234" }],
    unreadable: null,
    atHead: REVIEWED,
    atReviewed: null,
    reviewedInBranch: true,
  }).detail.includes("could not be made")
);

/*
 * THE WIRING, STRUCTURALLY, AND THE LIMIT IS STATED RATHER THAN IMPLIED. The two arms above call
 * `endpointsOf` directly, so replacing its CALL SITE with an inline Set left this suite green --
 * the mutation was at the call site and the arms tested the function. Different subjects.
 *
 * THIS ARM COVERS THE CALL SITE'S EXISTENCE, NOT ITS EXECUTION, and that is a weaker claim than it
 * may look: it reads source text, so it cannot see whether the assembled path reaches it, and a
 * rename breaks the arm rather than the code. It fails LOUD in that case, which is why it is worth
 * having at all. LIFTED BY a harness that runs `main()` against a stand-in `gh` -- the first real
 * coverage of the assembled path in a file that has now hidden THREE defects there, every one of
 * them found by a reader while this suite was green.
 */
ok(
  "main() is WIRED to endpointsOf - the call site, which the arms above do not cover",
  (() => {
    const src = readFileSync(SCRIPT, "utf8");
    // `= endpointsOf(` is the CALL; the definition line reads `export function endpointsOf(`,
    // which the first version of this arm matched -- it was inside its own subject and passed
    // over a mutation that removed every call.
    return /=\s*endpointsOf\(/.test(src);
  })()
);

/*
 * TWO PLACES HAVE TO AGREE AND ONLY ONE OF THEM IS `classify`. `main()` unions the contributions
 * of the shas the reports name BEFORE classifying, so filtering withdrawal in `classify` alone
 * would leave a retracted read widening the covered set on the way in -- the pull request would
 * then be reported `covered` by a comparison the withdrawn sha helped satisfy. Asserting the call
 * site is the same lesson as the arm above it: an arm that tests its own copy asserts nothing.
 *
 * THIS ARM WAS FIRST WRITTEN INSIDE THE ONE ABOVE IT, after its `return`, where it parsed, never
 * ran, and asserted nothing. That is the THIRD time an arm in this repository has been placed
 * where it cannot execute, and all three were caught by a count guard rather than by the rule
 * against it -- which is the argument for the guard.
 */
ok(
  "main() takes its endpoints from liveReports - a withdrawn sha must not widen the union",
  (() => {
    const src = readFileSync(SCRIPT, "utf8");
    return /=\s*endpointsOf\(liveReports\(/.test(src);
  })()
);

/* ---- a failed FETCH is not an empty comment list ------------------------------------------- */

/*
 * THIS FILE'S OWN THESIS, USED AGAINST IT. `main()` kept `null` from a failed `gh pr view` and
 * then handed `reports ?? []` to `classify`, so a fetch that did not answer became "there were no
 * comments" and came back `ARMED, NO READER REPORT` at exit 1 -- sending a reader to a pull
 * request whose comments were never retrieved and which may carry a perfect token. The file
 * already drew this distinction one call earlier, exiting 2 with a paragraph when `gh pr list`
 * fails, and the neighbouring `assert-census-fresh` draws it too.
 */
ok(
  "a FAILED fetch is a refusal, not `nobody read this`",
  (() => {
    const st = classify({
      inSubject: true,
      reports: null,
      atHead: REVIEWED,
      atReviewed: REVIEWED,
      reviewedInBranch: true,
    }).state;
    return st === STATE.UNFETCHED && st !== STATE.NO_REPORT;
  })()
);

ok(
  "an EMPTY comment list is still NO_REPORT - null and [] are the two answers being kept apart",
  classify({
    inSubject: true,
    reports: [],
    atHead: REVIEWED,
    atReviewed: REVIEWED,
    reviewedInBranch: true,
  }).state === STATE.NO_REPORT
);

ok(
  "UNFETCHED is a REFUSAL and not a FINDING - exit 2 and exit 1 are different answers",
  REFUSALS.has(STATE.UNFETCHED) && !FINDINGS.has(STATE.UNFETCHED)
);

ok(
  "main() passes `reports` through - `reports ?? []` at the call site is what collapsed them",
  (() => {
    const src = readFileSync(SCRIPT, "utf8");
    return !/reports:\s*reports\s*\?\?\s*\[\]/.test(src);
  })()
);

/*
 * DRIVEN THROUGH THE ASSEMBLED PATH with a `gh` that answers `pr list` and FAILS `pr view`, which
 * is the only way to reach the collapse -- it lived at the call site, not in `classify`. PATH is
 * PREPENDED and never replaced, so the shim shadows `gh` while `node` and the rest still resolve.
 */
ok(
  "end to end: a `gh` whose `pr view` fails exits 2 and does NOT report a missing reader",
  (() => {
    const dir = mkdtempSync(join(tmpdir(), "armed-cov-"));
    const shim = join(dir, "gh");
    writeFileSync(
      shim,
      `#!/bin/sh
case "$1 $2" in
  "pr list") echo '[{"number":4242,"headRefOid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","autoMergeRequest":{"enabledBy":{"login":"x"}},"changedFiles":1,"baseRefName":"main"}]' ;;
  "pr view") exit 1 ;;
  *) echo '{}' ;;
esac
`
    );
    chmodSync(shim, 0o755);
    const r = spawnSync(process.execPath, [SCRIPT], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        ...NO_CI_EVENT,
      },
    });
    const all = `${r.stdout}${r.stderr}`;
    return (
      r.status === 2 &&
      /COULD NOT CHECK/.test(all) &&
      !/NO READER REPORT/.test(all)
    );
  })()
);

/* ---- the passing sentence must not assert more than it measured ---------------------------- */

/*
 * ZERO ARMED IS THE ORDINARY CASE, and the sentence for it used to read
 * `0 armed pull requests examined, EACH COVERED by a reader report ...` -- vacuously true over an
 * empty set and, in a CI log, indistinguishable from coverage confirmed. The vacuity GUARD is real
 * and sits one level out: checks.json floors OPEN pull requests at 1, deliberately not the armed
 * count, because a quiet board overnight is legitimate. The subject was protected; the sentence
 * was not. Two claims, one mechanism.
 */
ok(
  "with nothing armed the line says nothing was examined, and does NOT say `each covered`",
  (() => {
    const line = passLine(0, 19);
    return (
      /asserts nothing/.test(line) &&
      !/each covered/.test(line) &&
      line.includes("19")
    );
  })()
);

ok(
  "with one candidate it DOES claim coverage, and in the singular",
  (() => {
    const line = passLine(1, 19);
    return (
      /each covered/.test(line) &&
      /1 merge candidate /.test(line) &&
      !/candidates/.test(line)
    );
  })()
);

ok(
  "with two candidates it claims coverage in the plural - the singular arm above is not a spelling test",
  /2 merge candidates examined/.test(passLine(2, 19))
);

ok(
  "main() is WIRED to passLine - the sentence lived inline and an arm on the function alone would not see it",
  (() => {
    const src = readFileSync(SCRIPT, "utf8");
    return (
      /passLine\(\s*armed\.length,\s*open\.length,/.test(src) &&
      !/examined, each covered by a reader `/.test(src)
    );
  })()
);

/*
 * END TO END, because the wiring arm above reads TEXT and cannot see whether the branch is
 * reachable. A `gh` whose `pr list` returns one OPEN and UNARMED pull request drives the exact
 * shape this change exists for: the check has nothing to examine and must say so while still
 * exiting 0, since a quiet board is not a failure.
 */
ok(
  "end to end: an open but UNARMED board exits 0 and does not print a coverage claim",
  (() => {
    const dir = mkdtempSync(join(tmpdir(), "armed-pass-"));
    const shim = join(dir, "gh");
    writeFileSync(
      shim,
      `#!/bin/sh
case "$1 $2" in
  "pr list") echo '[{"number":7,"headRefOid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","autoMergeRequest":null,"changedFiles":1,"baseRefName":"main"}]' ;;
  *) echo '{}' ;;
esac
`
    );
    chmodSync(shim, 0o755);
    const r = spawnSync(process.execPath, [SCRIPT], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        ...NO_CI_EVENT,
      },
    });
    const all = `${r.stdout}${r.stderr}`;
    return (
      r.status === 0 && /asserts nothing/.test(all) && !/each covered/.test(all)
    );
  })()
);

/* ---- process-level properties, spawned because they are properties of the PROCESS ---------- */

ok(
  "importing the module runs NOTHING - a checker that queries on import cannot be unit-tested",
  (() => {
    const r = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `import ${JSON.stringify(SCRIPT)};`],
      {
        encoding: "utf8",
      }
    );
    return (
      r.status === 0 &&
      !/FAIL|OK:|COULD NOT CHECK/.test(`${r.stdout}${r.stderr}`)
    );
  })()
);

ok(
  "with no `gh` on PATH it REFUSES with exit 2, which is not the same answer as `all covered`",
  (() => {
    const r = spawnSync(process.execPath, [SCRIPT], {
      encoding: "utf8",
      env: { ...process.env, PATH: "", ...NO_CI_EVENT },
    });
    return (
      r.status === 2 &&
      /COULD NOT CHECK/.test(r.stderr) &&
      !/^OK:/m.test(r.stdout)
    );
  })()
);

/* ── THE ASSEMBLED PATH, DRIVEN BY A `gh` SHIM (#964) ───────────────────────── */
/*
 * EVERY ARM ABOVE DRIVES A PURE FUNCTION, AND ALL THREE DEFECTS THAT REACHED A READER LIVED IN
 * `main()`. The truncation misnomer, last-report-wins, and an `unreadable` reason that was
 * computed, passed and never read — each shipped with this suite green, and each was found by a
 * person rather than by a case. A pure-function proof structurally cannot see them.
 *
 * PORTED, NOT DESIGNED. `assert-bot-silence-is-classified.selftest.mjs` has had this harness all
 * along: a stub `gh` earlier on PATH, so the whole checker runs against a fabricated board. Both
 * checkers call `gh` by bare name, so the same mechanism reaches both.
 *
 * AND THE CHECKER'S REAL SUBJECT IS EMPTY MOST OF THE TIME, WHICH IS THE STRONGEST REASON THIS
 * HARNESS EXISTS. Run against the live board with nothing armed there is nothing to examine at
 * all. THE SENTENCE FOR THAT CASE HAS SINCE BEEN FIXED -- it now says nothing was examined rather
 * than claiming every armed pull request was covered -- but that fixed the WORDING, not the
 * REACH: a checker that can only exercise itself when the board happens to be in the right state
 * is one nobody can watch fail on demand,
 * and every defect this file has shipped was found by a person rather than by a run. The arms
 * below run `main()` whenever the suite runs.
 *
 * AND THE PORT CARRIES A LESSON A FRESH DESIGN WOULD REPEAT. The PATH is PREPENDED, never
 * replaced. An early version of the original set it to `${nodeDir}:/usr/bin:/bin`, which removes
 * `gh` on macOS and NOT on Ubuntu — where it lives in /usr/bin — so the isolation passed locally
 * and asserted nothing on the runner.
 */
const CHECKER = join(HERE, "assert-armed-prs-are-covered-by-a-review.mjs");

/** Run the whole checker against a fabricated board. Returns {status, stdout, stderr}. */
function runAgainst(fixture, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "apc-shim-"));
  const fx = join(dir, "fixture.json");
  writeFileSync(fx, JSON.stringify(fixture));
  const js = join(dir, "gh.mjs");
  writeFileSync(
    js,
    [
      'import { readFileSync } from "node:fs";',
      'const f = JSON.parse(readFileSync(process.env.APC_FIXTURE, "utf8"));',
      "const a = process.argv.slice(2);",
      'const joined = a.join(" ");',
      "let out = null;",
      'if (a[0] === "pr" && a[1] === "list") out = f.prs ?? [];',
      'else if (a[0] === "pr" && a[1] === "view") out = { comments: (f.comments ?? {})[a[2]] ?? [] };',
      'else if (a[0] === "api") {',
      "  const key = (joined.match(/compare\\/(.*)$/) ?? [])[1];",
      "  out = (f.compare ?? {})[key] ?? null;",
      "}",
      "if (out === null) { process.exit(1); }",
      "process.stdout.write(JSON.stringify(out));",
      "",
    ].join("\n")
  );
  const shim = join(dir, "gh");
  writeFileSync(
    shim,
    ["#!/bin/sh", `exec ${process.execPath} ${js} "$@"`, ""].join("\n")
  );
  chmodSync(shim, 0o755);
  const r = spawnSync(process.execPath, [CHECKER], {
    encoding: "utf8",
    timeout: 60000,
    // PREPEND, never replace — see the note above
    env: {
      ...process.env,
      PATH: dir + ":" + process.env.PATH,
      APC_FIXTURE: fx,
      ...NO_CI_EVENT,
      ...extraEnv,
    },
  });
  rmSync(dir, { recursive: true, force: true });
  return r;
}

const patchOf = (adds) => adds.map((l) => "+" + l).join("\n");

ok(
  "ASSEMBLED: a covered pull request exits 0 and says so — the harness reaches a verdict at all",
  (() => {
    const r = runAgainst({
      prs: [
        {
          number: 1,
          headRefOid: "aaaa1111",
          autoMergeRequest: {},
          changedFiles: 1,
          baseRefName: "main",
        },
      ],
      comments: { 1: [{ body: "READER-REPORT: DEV1 @ aaaa1111" }] },
      compare: {
        "main...aaaa1111": {
          files: [{ filename: "a.ts", patch: patchOf(["one"]) }],
        },
        "aaaa1111...aaaa1111": { status: "identical" },
      },
    });
    return r.status === 0 && /^OK: 1 merge candidate /m.test(r.stdout ?? "");
  })()
);

ok(
  "ASSEMBLED: the unreadable REASON reaches stderr — the defect that shipped was a dead parameter",
  (() => {
    const r = runAgainst({
      prs: [
        {
          number: 2,
          headRefOid: "bbbb2222",
          autoMergeRequest: {},
          changedFiles: 1,
          baseRefName: "main",
        },
      ],
      comments: { 2: [{ body: "READER-REPORT: DEV1 @ cccc3333" }] },
      compare: {
        "main...bbbb2222": {
          files: [{ filename: "a.ts", patch: patchOf(["one"]) }],
        },
        "main...cccc3333": { files: [{ filename: "baseline.png" }] },
        "cccc3333...bbbb2222": { status: "ahead" },
      },
    });
    return (
      r.status === 1 &&
      /baseline\.png carries no patch/.test(r.stderr ?? "") &&
      !/the comparison could not be made/.test(r.stderr ?? "")
    );
  })()
);

ok(
  "ASSEMBLED: #950's shape — a full read POSTED AFTER a delta still composes, and it exits 0",
  (() => {
    const r = runAgainst({
      prs: [
        {
          number: 3,
          headRefOid: "bbbb2222",
          autoMergeRequest: {},
          changedFiles: 1,
          baseRefName: "main",
        },
      ],
      comments: {
        3: [
          { body: "READER-REPORT: DEV1 @ aaaa1111..bbbb2222 (delta only)" },
          { body: "READER-REPORT: DEV1 @ aaaa1111" },
        ],
      },
      compare: {
        "main...bbbb2222": {
          files: [{ filename: "a.ts", patch: patchOf(["one", "two"]) }],
        },
        "main...aaaa1111": {
          files: [{ filename: "a.ts", patch: patchOf(["one"]) }],
        },
        "aaaa1111...bbbb2222": { status: "ahead" },
        "bbbb2222...bbbb2222": { status: "identical" },
      },
    });
    return r.status === 0;
  })()
);

ok(
  "ASSEMBLED: an armed pull request with no token is a finding that NAMES it",
  (() => {
    const r = runAgainst({
      prs: [
        {
          number: 4,
          headRefOid: "dddd4444",
          autoMergeRequest: {},
          changedFiles: 1,
          baseRefName: "main",
        },
      ],
      comments: { 4: [] },
      compare: {
        "main...dddd4444": {
          files: [{ filename: "a.ts", patch: patchOf(["one"]) }],
        },
      },
    });
    return (
      r.status === 1 &&
      /#4/.test(r.stderr ?? "") &&
      /NO READER REPORT/.test(r.stderr ?? "")
    );
  })()
);

/* ---- process-level properties, spawned because they are properties of the PROCESS ---------- */

/* ---- report ------------------------------------------------------------------------------- */

/*
 * THE SUBJECT PREDICATE (#1053), AND THE POSITIVE ARM IS FIRST BECAUSE THE REST ARE NEGATIVES.
 *
 * Nine of the eleven cases below assert `false`, and a predicate that returned `false` for
 * EVERYTHING would satisfy every one of them — which is the defect this whole file exists about,
 * arriving in the test of its repair. So the accepting cases come first and are what make the
 * refusals mean something.
 *
 * THE STEADY-STATE ARM IS THE ONE THAT MATTERS. `armed` was zero continuously, and `CLEAN` is
 * zero too: measured live at main 0eb40cb7, BEHIND 10 / DIRTY 3 / BLOCKED 1 / CLEAN 0, with all
 * six fully-green pull requests BEHIND. Under `strict: true` a branch is behind the moment
 * anything else lands, so a subject that excluded BEHIND would be empty for the same reason the
 * armed subject is, and would go green saying so.
 */
const GREEN = [{ conclusion: "SUCCESS" }, { conclusion: "SKIPPED" }];
const candidate = (over = {}) => ({
  isDraft: false,
  mergeStateStatus: "BEHIND",
  statusCheckRollup: GREEN,
  ...over,
});

ok(
  "POSITIVE: a green BEHIND pull request IS a candidate — the steady state under strict:true, and excluding it rebuilds the empty subject one predicate over",
  isMergeCandidate(candidate()) === true
);

ok(
  "POSITIVE: a green CLEAN one is a candidate too — rare on this board, not excluded",
  isMergeCandidate(candidate({ mergeStateStatus: "CLEAN" })) === true
);

ok(
  "POSITIVE: an ARMED pull request stays in the subject whatever else it is — it merges itself on green, which is #945 and is not covered by the candidate test",
  isMergeCandidate({
    autoMergeRequest: {},
    isDraft: true,
    mergeStateStatus: "DIRTY",
    statusCheckRollup: [{ conclusion: "FAILURE" }],
  }) === true
);

ok(
  "a DRAFT is not a candidate even when green and BEHIND — #1028 is exactly this, and including it made the live subject 6 where 5 is right",
  isMergeCandidate(candidate({ isDraft: true })) === false
);

ok(
  "DIRTY is not a candidate — resolving the conflict changes the head, so today's reading is superseded before it matters",
  isMergeCandidate(candidate({ mergeStateStatus: "DIRTY" })) === false
);

ok(
  "BLOCKED is not a candidate, for the same reason as DIRTY",
  isMergeCandidate(candidate({ mergeStateStatus: "BLOCKED" })) === false
);

ok(
  "a red check disqualifies a BEHIND pull request — being behind is the only thing a candidate may be waiting on",
  isMergeCandidate(
    candidate({
      statusCheckRollup: [{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }],
    })
  ) === false
);

ok(
  "a PENDING check disqualifies it — `not yet failed` is not `passed`",
  isMergeCandidate(
    candidate({
      statusCheckRollup: [{ conclusion: "SUCCESS" }, { status: "IN_PROGRESS" }],
    })
  ) === false
);

/*
 * AN EMPTY ROLLUP IS THE VACUOUS GREEN THIS FILE IS ABOUT. `[].every(...)` is TRUE, so a
 * predicate written the obvious way calls a pull request with no checks at all fully green and
 * puts it in the subject. Asserted on `allChecksGreen` directly as well as through the predicate,
 * because it is the one line where the mistake is invisible on reading.
 */
ok(
  "an EMPTY rollup is not green — `[].every()` is true and that is the trap",
  allChecksGreen({ statusCheckRollup: [] }) === false &&
    isMergeCandidate(candidate({ statusCheckRollup: [] })) === false
);

ok(
  "an ABSENT rollup is not green either, and is not the same question as an empty one",
  allChecksGreen({}) === false &&
    allChecksGreen({ statusCheckRollup: null }) === false
);

ok(
  "NEUTRAL and SKIPPED count as green, so a skipped job does not remove a pull request from the subject",
  allChecksGreen({
    statusCheckRollup: [{ conclusion: "NEUTRAL" }, { conclusion: "SKIPPED" }],
  }) === true
);

/*
 * THE WIRING, NOT THE PREDICATE (#1053). `isMergeCandidate` is pinned eleven ways above and every
 * one of them passes while `main()` still filters on `autoMergeRequest` — measured: reverting the
 * filter to armed-only survived the whole suite. Every ASSEMBLED fixture arms its pull request, so
 * none of them can tell the two filters apart, and a predicate wired to nothing reads exactly like
 * a predicate wired correctly.
 *
 * This is the only case where the pull request is NOT armed: green, BEHIND, no reader report. It
 * fails under the new subject and is invisible under the old one.
 */
ok(
  "ASSEMBLED: an UNARMED green BEHIND pull request with no token is a finding — the arm that fails if the subject filter reverts to armed-only",
  (() => {
    const r = runAgainst({
      prs: [
        {
          number: 55,
          headRefOid: "eeee5555",
          autoMergeRequest: null,
          isDraft: false,
          mergeStateStatus: "BEHIND",
          statusCheckRollup: [{ conclusion: "SUCCESS" }],
          changedFiles: 1,
          baseRefName: "main",
        },
      ],
      comments: { 55: [] },
      compare: {},
    });
    return (
      r.status === 1 &&
      /#55/.test(r.stderr ?? "") &&
      /NO READER REPORT/.test(r.stderr ?? "")
    );
  })()
);

/* ---- #1074: the gate can now fail on the pull request it is running on -------------------- */

/*
 * A PULL REQUEST IS NEVER IN ITS OWN GATE'S SUBJECT DURING ITS OWN RUN. `isMergeCandidate` is
 * defined over CHECK STATE and evaluated BY a check, so at the moment this executes at least one
 * check has not concluded -- the one executing -- and every verdict this file has ever published
 * about X came from a run in which X was invisible.
 *
 * THE LAST ARM IN THIS BLOCK IS THE ONE THAT MATTERS: the SAME board, exit 0 without the event
 * payload and exit 1 with it. Nothing about the pull request changes between those two runs.
 */
const evtDir = mkdtempSync(join(tmpdir(), "armed-evt-"));
const evtFile = join(evtDir, "event.json");
writeFileSync(evtFile, JSON.stringify({ pull_request: { number: 7 } }));
const PR_ENV = {
  GITHUB_EVENT_NAME: "pull_request",
  GITHUB_EVENT_PATH: evtFile,
};

ok(
  "OUTSIDE a pull_request event there is no pull request under test, and null is the truth rather than a refusal",
  prUnderTest({ GITHUB_EVENT_NAME: "push" }).number === null &&
    prUnderTest({ GITHUB_EVENT_NAME: "push" }).reason === null &&
    prUnderTest({}).reason === null
);

ok(
  "the event payload names the pull request under test — the one fact about this run that no check state can contradict",
  prUnderTest(PR_ENV).number === 7 && prUnderTest(PR_ENV).reason === null
);

ok(
  "`pull_request_target` is recognised too, so a fork build does not silently drop its own subject",
  prUnderTest({ ...PR_ENV, GITHUB_EVENT_NAME: "pull_request_target" })
    .number === 7
);

ok(
  "inside a pull_request event with GITHUB_EVENT_PATH unset it REFUSES — a run gating a pull request it cannot name must not report on coverage",
  (() => {
    const r = prUnderTest({ GITHUB_EVENT_NAME: "pull_request" });
    return r.number === null && /GITHUB_EVENT_PATH is unset/.test(r.reason);
  })()
);

ok(
  "an unparseable payload is a refusal, not an absent pull request — the two are opposite answers and only one is safe",
  (() => {
    const bad = join(evtDir, "bad.json");
    writeFileSync(bad, "{not json");
    const r = prUnderTest({ ...PR_ENV, GITHUB_EVENT_PATH: bad });
    return r.number === null && /could not be read or parsed/.test(r.reason);
  })()
);

ok(
  "a payload carrying no `pull_request.number` refuses rather than defaulting to nothing-under-test",
  (() => {
    const empty = join(evtDir, "empty.json");
    writeFileSync(empty, JSON.stringify({ pull_request: {} }));
    const r = prUnderTest({ ...PR_ENV, GITHUB_EVENT_PATH: empty });
    return r.number === null && /no integer/.test(r.reason);
  })()
);

ok(
  "a DRAFT under test stays OUT — that exclusion is true while its own run is in flight, and admitting drafts would red-light every push-and-raise on its first push",
  admitsUnderTest({ isDraft: true, mergeStateStatus: "BEHIND" }) === false
);

ok(
  "a DIRTY pull request under test stays OUT — conflicts are not a function of check state, and the work that fixes them changes the head",
  admitsUnderTest({ isDraft: false, mergeStateStatus: "DIRTY" }) === false
);

ok(
  "BLOCKED is ADMITTED, which is the case `mergeStateStatus` kills: a pull request up to date with main and mid-run reads BLOCKED for that reason alone",
  admitsUnderTest({ isDraft: false, mergeStateStatus: "BLOCKED" }) === true
);

ok(
  "and so is one whose OTHER checks are red — from inside the run the two cannot be told apart, and admitting a non-candidate costs a comment while excluding a candidate costs an unexamined merge",
  admitsUnderTest({ isDraft: false, mergeStateStatus: "BEHIND" }) === true &&
    admitsUnderTest(null) === false
);

/*
 * THE ASSEMBLED PAIR. One board, one pull request: open, not a draft, BEHIND, with a check still
 * IN_PROGRESS and no reader report. `isMergeCandidate` is false for it, so it is exactly the
 * pull request this gate could never examine.
 */
const midRunBoard =
  '[{"number":7,"headRefOid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",' +
  '"autoMergeRequest":null,"changedFiles":1,"baseRefName":"main","isDraft":false,' +
  '"mergeStateStatus":"BEHIND","statusCheckRollup":[{"conclusion":"SUCCESS"},{"status":"IN_PROGRESS"}]}]';

const runWith = (board, env) => {
  const dir = mkdtempSync(join(tmpdir(), "armed-1074-"));
  const shim = join(dir, "gh");
  writeFileSync(
    shim,
    `#!/bin/sh
case "$1 $2" in
  "pr list") echo '${board}' ;;
  "pr view") echo '{"comments":[]}' ;;
  *) echo '{}' ;;
esac
`
  );
  chmodSync(shim, 0o755);
  const r = spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      ...NO_CI_EVENT,
      ...env,
    },
  });
  rmSync(dir, { recursive: true, force: true });
  return { status: r.status, all: `${r.stdout}${r.stderr}` };
};

ok(
  "WITHOUT the event payload the mid-run pull request is invisible and the check exits 0 — this is the defect, driven rather than argued",
  (() => {
    const r = runWith(midRunBoard, {
      GITHUB_EVENT_NAME: "",
      GITHUB_EVENT_PATH: "",
    });
    return r.status === 0 && /asserts nothing/.test(r.all);
  })()
);

ok(
  "WITH it, the SAME board fails and names #7 — one board, two runs, and the only difference is whether the check was told what it was gating",
  (() => {
    const r = runWith(midRunBoard, PR_ENV);
    return r.status === 1 && /#7/.test(r.all) && /FAIL/.test(r.all);
  })()
);

ok(
  "the pass line NAMES the pull request under test, because `N candidates examined` was true on every run that examined none of them",
  /INCLUDING #12, the pull request this run is gating/.test(
    passLine(3, 9, 12)
  ) && !/INCLUDING/.test(passLine(3, 9, null))
);

ok(
  "a DRAFT under test does not fail the run end to end — the unit arm pins the predicate and this pins the WIRING, which is where the last three defects here lived",
  (() => {
    const r = runWith(
      midRunBoard.replace('"isDraft":false', '"isDraft":true'),
      PR_ENV
    );
    return r.status === 0 && /asserts nothing/.test(r.all);
  })()
);

/*
 * THE OK PATH, WHICH NO ARM ABOVE REACHES. Every end-to-end case here drives a pull request that
 * FAILS, so `passLine`'s third argument was never exercised through `main()`: passing `null` for
 * it survived the unit arm on the function AND the text arm on the call site. Predicate pinned,
 * wiring unpinned, for the third time in two pull requests -- and only a mutation found it.
 */
ok(
  "ASSEMBLED, the OK path: a COVERED pull request under test exits 0 and the sentence NAMES it, so a reader can tell this run examined the thing it was gating",
  (() => {
    const r = runAgainst(
      {
        prs: [
          {
            number: 7,
            headRefOid: "aaaa1111",
            autoMergeRequest: null,
            changedFiles: 1,
            baseRefName: "main",
            isDraft: false,
            mergeStateStatus: "BEHIND",
            statusCheckRollup: [{ status: "IN_PROGRESS" }],
          },
        ],
        comments: { 7: [{ body: "READER-REPORT: DEV1 @ aaaa1111" }] },
        compare: {
          "main...aaaa1111": {
            files: [{ filename: "a.ts", patch: patchOf(["one"]) }],
          },
          "aaaa1111...aaaa1111": { status: "identical" },
        },
      },
      PR_ENV
    );
    return (
      r.status === 0 &&
      /INCLUDING #7, the pull request this run is gating/.test(r.stdout ?? "")
    );
  })()
);

ok(
  "an event naming a pull request ABSENT from the board exits 2 — it closed mid-run or the listing truncated below it, and both make the subject a SUBSET reported as the whole",
  (() => {
    const r = runWith(midRunBoard.replace('"number":7', '"number":8'), PR_ENV);
    return r.status === 2 && /not in\s*\n?\s*the open board/.test(r.all);
  })()
);

ok(
  "and an unreadable payload exits 2 end to end rather than passing over a subject it could not determine",
  (() => {
    const r = runWith(midRunBoard, {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: join(evtDir, "does-not-exist.json"),
    });
    return r.status === 2 && /COULD NOT CHECK/.test(r.all);
  })()
);

rmSync(evtDir, { recursive: true, force: true });

/*
 * THE DRAFT EXCLUSION HAS A DEPENDENCY IN ANOTHER FILE, AND THIS IS WHERE IT IS ASSERTED.
 *
 * `admitsUnderTest` keeps exactly one exclusion — a DRAFT — and that exclusion is only safe
 * while a draft's promotion re-runs this gate. `ci.yml` declares `pull_request:`, whose DEFAULT
 * types are `opened, synchronize, reopened`: nothing fires on `ready_for_review`. Without the
 * explicit list, the exclusion becomes the bypass — a draft goes green while excluded AS a
 * draft, is marked ready with no re-trigger, and is a merge candidate carrying a rollup from a
 * run in which it was never examined.
 *
 * The constraint lives HERE rather than in the workflow's comments because this is the file
 * that depends on it. Two facts that must agree, with something asserting they do.
 */
ok(
  "ci.yml re-runs on `ready_for_review`, without which this gate's DRAFT exclusion is a bypass rather than an exclusion",
  (() => {
    const yml = readFileSync(
      join(HERE, "..", ".github", "workflows", "ci.yml"),
      "utf8"
    );
    const block = yml.match(/^ {2}pull_request:\n((?: {4}.*\n|\s*\n)*)/m);
    return (
      block !== null &&
      /^ {4}types:.*\bready_for_review\b/m.test(block[1]) &&
      // the default three must survive too - naming only the new one drops the rest
      ["opened", "synchronize", "reopened"].every((t) =>
        new RegExp(`^ {4}types:.*\\b${t}\\b`, "m").test(block[1])
      )
    );
  })()
);

/*
 * AND THE NEUTRALISATION IS PINNED, because the defect it repairs was INVISIBLE on the machine
 * where the suite is run. This arm POLLUTES THE PARENT with exactly what Actions sets, then drives
 * a harness arm through it. Removing `NO_CI_EVENT` fails here on any machine, instead of only on
 * the runner -- which is the difference between a proof and a local habit.
 */
ok(
  "the harness neutralises the ambient CI event env: a spawned checker sees no pull request under test unless an arm passes one, so the suite tests the subject rather than the runner",
  (() => {
    const saved = {
      GITHUB_EVENT_NAME: process.env.GITHUB_EVENT_NAME,
      GITHUB_EVENT_PATH: process.env.GITHUB_EVENT_PATH,
    };
    const evt = join(mkdtempSync(join(tmpdir(), "armed-amb-")), "event.json");
    writeFileSync(evt, JSON.stringify({ pull_request: { number: 999999 } }));
    process.env.GITHUB_EVENT_NAME = "pull_request";
    process.env.GITHUB_EVENT_PATH = evt;
    try {
      const r = runAgainst({
        prs: [
          {
            number: 1,
            headRefOid: "aaaa1111",
            autoMergeRequest: {},
            changedFiles: 1,
            baseRefName: "main",
          },
        ],
        comments: { 1: [{ body: "READER-REPORT: DEV1 @ aaaa1111" }] },
        compare: {
          "main...aaaa1111": {
            files: [{ filename: "a.ts", patch: patchOf(["one"]) }],
          },
          "aaaa1111...aaaa1111": { status: "identical" },
        },
      });
      // Without the neutralisation this is exit 2: #999999 is not on the stub board.
      return r.status === 0 && !/999999/.test(`${r.stdout}${r.stderr}`);
    } finally {
      for (const [k, v] of Object.entries(saved))
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
  })()
);

/* ---- #1082: a compare that DID NOT ANSWER is a refusal, not a finding -------------------- */

/*
 * THE FILE STATED THE RULE FOR `reports` AND ABANDONED IT NINETY LINES LATER FOR THE COMPARE.
 * `null` means the fetch did not answer; `[]` means it answered and there was nothing there.
 * Only the second is a finding. Observed live: #1078 named as failing coverage while both
 * compares answered by hand and the rate limit sat at 4380/5000.
 *
 * THE ARMS BELOW ARE MOSTLY END-TO-END, and that is forced rather than stylistic: a failed fetch
 * is a fact about `gh`, so it cannot be reached by driving `classify` with fabricated arguments.
 * A unit arm here would assert what I chose to pass in.
 */
ok(
  "a compare that did not answer is a REFUSAL, and a refusal is not in FINDINGS — the two sets must not overlap or the exit code is undefined",
  REFUSALS.has(STATE.UNCOMPARED) && !FINDINGS.has(STATE.UNCOMPARED)
);

ok(
  "`uncompared` OUTRANKS `unreadable`: if an endpoint never answered, nothing is known including whether the answer would have been readable",
  (() => {
    const r = classify({
      inSubject: true,
      reports: [{ agent: "DEV1", sha: "abc1234" }],
      unreadable: "a reason derived from the OTHER endpoint",
      uncompared: "this one did not answer",
      atHead: null,
      atReviewed: null,
      reviewedInBranch: true,
    });
    return r.state === STATE.UNCOMPARED && /did not answer/.test(r.detail);
  })()
);

/*
 * A `gh` THAT ANSWERS `pr list` AND `pr view` AND FAILS ONLY ON `api compare`. The fixture shim
 * returns null for a compare key it does not hold, which is exactly a failed fetch.
 */
const compareFails = (which) => {
  const pr = {
    number: 9,
    headRefOid: "aaaa1111",
    autoMergeRequest: {},
    changedFiles: 1,
    baseRefName: "main",
  };
  const both = {
    "main...aaaa1111": {
      files: [{ filename: "a.ts", patch: patchOf(["one"]) }],
    },
    "main...bbbb2222": {
      files: [{ filename: "a.ts", patch: patchOf(["one"]) }],
    },
    "bbbb2222...aaaa1111": { status: "identical" },
  };
  const compare = { ...both };
  delete compare[which];
  return runAgainst({
    prs: [pr],
    comments: { 9: [{ body: "READER-REPORT: DEV1 @ bbbb2222" }] },
    compare,
  });
};

ok(
  "END TO END: a HEAD compare that did not answer exits 2, not 1 — a transient hiccup must not name a pull request as failing coverage",
  (() => {
    const r = compareFails("main...aaaa1111");
    return (
      r.status === 2 &&
      /COULD NOT CHECK/.test(r.stderr ?? "") &&
      /#9/.test(r.stderr ?? "")
    );
  })()
);

ok(
  "END TO END: a REVIEWED compare that did not answer exits 2 as well — this endpoint was the UNGATED one, twelve lines from the gated one",
  (() => {
    const r = compareFails("main...bbbb2222");
    return r.status === 2 && /COULD NOT CHECK/.test(r.stderr ?? "");
  })()
);

ok(
  "and it no longer says the repository CANNOT RESOLVE the sha — that sentence was reachable only on a failed fetch, so it was never a true statement, and `gh()` collapses a 404 and a throttle to the same null",
  (() => {
    const r = compareFails("main...bbbb2222");
    const all = `${r.stdout}${r.stderr}`;
    return (
      !/cannot resolve/.test(all) &&
      /did not answer/.test(all) &&
      /may not exist in this repository, or the request was refused/.test(all)
    );
  })()
);

ok(
  "END TO END: a compare that ANSWERS with an unreadable diff still exits 1 — the split keeps the binary case a finding, which a wholesale move to REFUSALS would have silenced",
  (() => {
    const r = runAgainst({
      prs: [
        {
          number: 9,
          headRefOid: "aaaa1111",
          autoMergeRequest: {},
          changedFiles: 1,
          baseRefName: "main",
        },
      ],
      comments: { 9: [{ body: "READER-REPORT: DEV1 @ bbbb2222" }] },
      compare: {
        "main...aaaa1111": { files: [{ filename: "big.bin" }] },
        "main...bbbb2222": {
          files: [{ filename: "a.ts", patch: patchOf(["one"]) }],
        },
        "bbbb2222...aaaa1111": { status: "identical" },
      },
    });
    return (
      r.status === 1 &&
      /carries no patch/.test(r.stderr ?? "") &&
      /#9/.test(r.stderr ?? "")
    );
  })()
);

/* ---- #1105: an anchor is about COVERAGE, not presence -------------------------------------- */

/*
 * A BARE token has no `from`, so it could never anchor anything, and a chain of deltas stayed
 * PARTIAL forever even after a reader read the WHOLE contribution. Driven on #1086: the returned
 * set was byte-identical with and without the full read, so the sentence "no report names <from>"
 * was true and was the wrong thing to say.
 *
 * THE SECOND ARM IS THE ONE THAT MATTERS. "Any bare token clears everything" turns a false finding
 * into a FALSE CLEAR, which is the direction that costs -- and it is the repair I would have
 * reached for. A bare read at an OLD sha says nothing about content pushed after it.
 */
{
  const chain = [
    { from: "b3a67ea0", sha: "e34c3c27" },
    { from: "93c059c1", sha: "b2ed51e6" },
    { from: "ac7c4e88", sha: "1bd22049" },
  ];
  const HEAD = "ed9fc0f9";

  ok(
    "a bare token AT THE CURRENT HEAD anchors every delta — its subject is main...head, which by construction contains each delta's range",
    unanchoredDeltas([...chain, { sha: HEAD }], HEAD).length === 0
  );

  ok(
    "PRODUCTION SHAPE: an 8-char token against a 40-char head — `main()` passes `p.headRefOid`, which is 40 hex, and every real token is abbreviated, so this is the ONLY comparison that happens on a live run and no other arm makes it",
    (() => {
      const head40 = "ed9fc0f9a1b2c3d4e5f60718293a4b5c6d7e8f90";
      const cleared = unanchoredDeltas([...chain, { sha: "ed9fc0f9" }], head40);
      // and the abbreviation must not clear a DIFFERENT head that merely shares no prefix
      const other = unanchoredDeltas(
        [...chain, { sha: "ed9fc0f9" }],
        "aaaaaaaaa1b2c3d4e5f60718293a4b5c6d7e8f90"
      );
      return cleared.length === 0 && other.length === 3;
    })()
  );

  ok(
    "FALSE-CLEAR GUARD: a bare token at an OLD sha clears NOTHING — it says nothing about content pushed after it, and those are exactly the deltas that need anchoring",
    (() => {
      const stale = [{ sha: "b3a67ea0" }, ...chain.slice(1)];
      const out = unanchoredDeltas(stale, HEAD);
      return out.length === 2 && out.every((d) => d.from !== "b3a67ea0");
    })()
  );

  ok(
    "without the full read the chain is still PARTIAL, so the repair did not simply disable the check",
    unanchoredDeltas(chain, HEAD).length === 3
  );

  ok(
    "and with no head known, behaviour is exactly what it was — a caller that cannot supply one gets the old answer rather than a silent clear",
    unanchoredDeltas([...chain, { sha: HEAD }], null).length === 3
  );

  ok(
    "a floor-anchored chain is still empty, which is the control that stops these arms passing over a function that always returns []",
    unanchoredDeltas([{ sha: "aaa1" }, { from: "aaa1", sha: "bbb2" }], "zzz9")
      .length === 0
  );

  /*
   * ANCHORING IS REACHABILITY, NOT ONE HOP (#1073).
   *
   * The old test asked whether ANY other report named a delta's base as an endpoint -- including
   * another delta. That composes chains correctly and is satisfiable CIRCULARLY, so two deltas
   * could anchor each other with no full read anywhere and the gate reported the pull request
   * covered. A local test standing in for a global property: they coincide on every acyclic
   * shape and come apart on a cycle.
   *
   * The first arm is the defect. The second is the control that stops the repair from being
   * "flag everything" -- a grounded chain must still clear, or the fix is a disabled check.
   */
  ok(
    "TWO DELTAS CANNOT ANCHOR EACH OTHER — A..B and B..A with no full read anywhere is not covered, and the old one-hop test cleared it",
    unanchoredDeltas([
      { from: "aaa1", sha: "bbb2" },
      { from: "bbb2", sha: "aaa1" },
    ]).length === 2
  );

  ok(
    "THE COMPANION: a chain that DOES reach a full read still clears, over two hops rather than one — the repair composes, it does not just refuse",
    unanchoredDeltas([
      { from: null, sha: "aaa1" },
      { from: "aaa1", sha: "bbb2" },
      { from: "bbb2", sha: "ccc3" },
    ]).length === 0
  );

  ok(
    "and an UNGROUNDED chain reports every member rather than only its root — no member of it is covered, and naming one understated what is unread",
    unanchoredDeltas([
      { from: "aaa1", sha: "bbb2" },
      { from: "bbb2", sha: "ccc3" },
    ]).length === 2
  );

  /*
   * A self-referential report is its own cycle of LENGTH ONE, and the cycle check alone handles
   * it: the walk finds the report at its own base, follows `from` back to the same sha, and the
   * second visit is already in `seen`.
   *
   * I FIRST WROTE A SEPARATE GUARD FOR THIS CASE AND MUTATION FOUND NOTHING COULD REACH IT.
   * Removing it changed no arm and changed neither answer -- self-reference still flags 1, the
   * two-delta cycle still flags 2 -- so it was a guard no test could distinguish from a wrong
   * one, and it is gone rather than pinned. This arm stays: the PROPERTY is worth holding down
   * even though the clause that appeared to implement it was dead.
   */
  ok(
    "a report whose base IS its own tip does not ground itself",
    unanchoredDeltas([{ from: "aaa1", sha: "aaa1" }]).length === 1
  );

  ok(
    "a DELTA ending at the head does NOT clear — it covers its own range only, and its base is exactly what is unanchored; only a BARE read has main...head as its subject",
    (() => {
      const out = unanchoredDeltas(
        [
          { from: "b3a67ea0", sha: "e34c3c27" },
          { from: "ac7c4e88", sha: "1bd22049" },
        ],
        "1bd22049"
      );
      return out.length === 2;
    })()
  );

  ok(
    "classify WIRES it: the same reports go PARTIAL without the head and OK-ward with it, so a computed `head` that never reaches the predicate fails here",
    (() => {
      const reports = [...chain, { agent: "DEV2", sha: HEAD }];
      const args = {
        inSubject: true,
        reports,
        atHead: { adds: new Set(), rems: new Set() },
        atReviewed: { adds: new Set(), rems: new Set() },
        reviewedInBranch: true,
      };
      return (
        classify({ ...args }).state === STATE.PARTIAL &&
        classify({ ...args, head: HEAD }).state !== STATE.PARTIAL
      );
    })()
  );
}

/*
 * ASSEMBLED, because `main()` computing the head and never passing it to `classify` survives every
 * unit arm above -- the predicate is pinned and the wiring is not, for the sixth time in this file
 * family. Only running the process can tell a live `head` from a dead one.
 */
ok(
  "ASSEMBLED: a bare token at the head clears a delta chain end to end, so a head computed and not passed fails here",
  (() => {
    const r = runAgainst({
      prs: [
        {
          number: 3,
          headRefOid: "cccc3333",
          autoMergeRequest: {},
          changedFiles: 1,
          baseRefName: "main",
        },
      ],
      comments: {
        3: [
          { body: "READER-REPORT: DEV1 @ aaaa1111..bbbb2222" },
          { body: "READER-REPORT: DEV2 @ cccc3333" },
        ],
      },
      compare: {
        "main...cccc3333": {
          files: [{ filename: "a.ts", patch: patchOf(["one"]) }],
        },
        "main...bbbb2222": {
          files: [{ filename: "a.ts", patch: patchOf(["one"]) }],
        },
        "bbbb2222...cccc3333": { status: "identical" },
        "cccc3333...cccc3333": { status: "identical" },
      },
    });
    const all = `${r.stdout}${r.stderr}`;
    return r.status === 0 && !/ONLY A DELTA WAS READ/.test(all);
  })()
);

/* ---- a withheld patch has a route, and three shapes that must NOT take it (#1140) ------- */

/*
 * THE FOUR FILE SHAPES, AND ONLY ONE OF THEM IS THIS FILE'S OWN WORLD.
 *
 * `contribution` has a second caller — #1120's `reader-token-still-applies`, whose files come
 * from a LOCAL `git diff` and carry `{ filename, patchLines }` with no `status`, no `sha` and no
 * `contents_url`. Every other arm in this suite is written from the REST world, so a fallback
 * that read a REST-only field unconditionally would break that caller AT A DISTANCE and this
 * suite would stay green. DEV3 proved that rather than predicting it: they planted exactly that
 * defect on main and the LOCAL row THREW while the REST-with-patch row was untouched.
 *
 * DEV3's statement of why the suite could not have caught it, which is the durable part:
 *
 *     The test and the code share a premise, so agreement between them is not evidence.
 *     Here the shared premise is WHICH FIELDS A FILE OBJECT HAS.
 *
 * So these arms deliberately construct inputs from a caller this file does not own.
 */
/*
 * The separator `contribution` keys with, built rather than typed: a literal NUL byte in a
 * source file is exactly what `assert-no-nul-in-text-sources` refuses, and it would be
 * invisible in review.
 */
const NUL = String.fromCharCode(0);
/*
 * CAPTURED, NOT COMPOSED — and this replaced a fixture I had written from my own idea of what
 * the API returns. TEAMLEAD measured that this suite contains ZERO REST-shaped file objects:
 * all twelve of its fixtures are bare `{ filename, patch }`, the same shape as #1120's local-git
 * world. So the branch this change adds had NOTHING in the suite resembling its real input, and
 * my arms would have been the only thing standing under it, written from the same idea of the
 * shape as the code they test.
 *
 * That is the composed-fixture problem DEV2 closed on #1120 by capturing real `git` output. The
 * equivalent here is a captured REST response, and #1140's issue body already carries six of
 * them from the determinism sampling.
 *
 * VERBATIM from `gh api repos/{owner}/{repo}/compare/main...fccec8ee`, sampled 2026-09-08, one
 * of six byte-identical responses:
 *
 *     merge_base  add586bdfbb96b3f1ba59dd10ef6d56c7b31c10a
 *     head        fccec8eecfbb257688160d413ab2ede6af056ae9
 *
 * Note what GitHub DOES send for a file whose patch it withholds: every field except `patch`,
 * including `changes`, `sha` and a `contents_url` naming exactly where the content lives. The
 * entry is present and self-describing; only its diff is missing. That is the whole reason this
 * case has a route and a truncated LIST does not.
 */
const WITHHELD = [
  {
    sha: "3db51b94648e99ff3df0cff49cdc59527ebc0d2a",
    filename: "pnpm-lock.yaml",
    status: "modified",
    additions: 646,
    deletions: 647,
    changes: 1293,
    blob_url:
      "https://github.com/lang-nextjs/lang-nextjs/blob/fccec8eecfbb257688160d413ab2ede6af056ae9/pnpm-lock.yaml",
    raw_url:
      "https://github.com/lang-nextjs/lang-nextjs/raw/fccec8eecfbb257688160d413ab2ede6af056ae9/pnpm-lock.yaml",
    contents_url:
      "https://api.github.com/repos/lang-nextjs/lang-nextjs/contents/pnpm-lock.yaml?ref=fccec8eecfbb257688160d413ab2ede6af056ae9",
  },
];

/*
 * AND A CAPTURED REST FILE THAT DOES CARRY A PATCH, from the same response — the shape this
 * suite had none of. Without it, "the fallback did not engage" could be satisfied by a fallback
 * that never engages for anything, and every arm asserting the normal path would still be
 * reading a local-git-shaped object.
 */
const CAPTURED_WITH_PATCH = [
  {
    additions: 0,
    blob_url:
      "https://github.com/lang-nextjs/lang-nextjs/blob/fccec8eecfbb257688160d413ab2ede6af056ae9/package.json",
    changes: 1,
    contents_url:
      "https://api.github.com/repos/lang-nextjs/lang-nextjs/contents/package.json?ref=fccec8eecfbb257688160d413ab2ede6af056ae9",
    deletions: 1,
    filename: "package.json",
    patch:
      '@@ -133,7 +133,6 @@\n   },\n   "pnpm": {\n     "overrides": {\n-      "react-dom": "19.2.6",\n       "esbuild": "^0.25.0",\n       "tar": ">=7.5.21",\n       "fast-uri": ">=3.1.5",',
    raw_url:
      "https://github.com/lang-nextjs/lang-nextjs/raw/fccec8eecfbb257688160d413ab2ede6af056ae9/package.json",
    sha: "d949ceb850578d8b6873c7f499aa7863fed8255b",
    status: "modified",
  },
];
const LOCAL_SHAPE = [{ filename: "a.txt", patch: "@@\n+added\n-removed\n" }];
const NEITHER_SHAPE = [{ filename: "a.txt" }];
const stubBlobs = (base, head) => ({
  base: "B",
  head: "H",
  readBlob: (ref) => (ref === "B" ? base : head),
});

ok(
  "ROW 1, THE ONE THAT MUST NOT MOVE: a LOCAL-git file — patch, no REST fields — still reads " +
    "exactly as before, and no fallback is consulted",
  (() => {
    const c = contribution(LOCAL_SHAPE, null);
    return (
      c !== null &&
      c.adds.size === 1 &&
      c.rems.size === 1 &&
      unreadableReason(LOCAL_SHAPE) === null
    );
  })()
);

ok(
  "ROW 1 HOLDS EVEN WITH A CONTEXT SUPPLIED, so a caller that has blobs available cannot " +
    "accidentally change the answer for a file that already carries its patch",
  (() => {
    let touched = 0;
    const c = contribution(LOCAL_SHAPE, null, {
      base: "B",
      head: "H",
      readBlob: () => {
        touched++;
        return "x";
      },
    });
    return c !== null && c.adds.size === 1 && touched === 0;
  })()
);

ok(
  "ROW 2, CAPTURED: a REAL REST file object that DOES carry a patch reads through the ordinary " +
    "path and consults no blob — the shape this suite previously had none of, so every other " +
    "arm here was reading a local-git object and calling it the gate's world",
  (() => {
    let touched = 0;
    const c = contribution(CAPTURED_WITH_PATCH, null, {
      base: "B",
      head: "H",
      readBlob: () => {
        touched++;
        return "x";
      },
    });
    return (
      c !== null &&
      touched === 0 &&
      c.rems.has(`package.json${NUL}      "react-dom": "19.2.6",`)
    );
  })()
);

ok(
  "ROW 3, THE FALLBACK'S CASE: a withheld patch refuses WITHOUT a context, exactly as it did " +
    "before this change",
  contribution(WITHHELD, null) === null &&
    /carries no patch/.test(unreadableReason(WITHHELD) ?? "")
);

ok(
  "...and WITH a context it is read from the two blobs instead",
  (() => {
    const c = contribution(WITHHELD, null, stubBlobs("one\ntwo", "one\nthree"));
    return (
      c !== null &&
      c.adds.has(`pnpm-lock.yaml${NUL}three`) &&
      c.rems.has(`pnpm-lock.yaml${NUL}two`)
    );
  })()
);

ok(
  "ROW 4, WHICH IS IN NEITHER CALLER'S WORLD (DEV3): no patch AND no REST fields keeps the " +
    "refusal it already gave — it does not throw, and it does not return an empty set",
  contribution(NEITHER_SHAPE, null) === null &&
    contribution(NEITHER_SHAPE, null, stubBlobs("x", "y")) !== undefined
);

ok(
  "AN EMPTY CONTRIBUTION IS THE WRONG ANSWER, NOT A HARMLESS ONE: when a blob cannot be read " +
    "the result is null, because an empty set compares EQUAL to every other empty set and this " +
    "gate refuses on exactly that false identity elsewhere",
  contribution(WITHHELD, null, {
    base: "B",
    head: "H",
    readBlob: () => null,
  }) === null
);

ok(
  "a file object with NO filename refuses rather than throwing, so an odd shape is a refusal " +
    "and not a crash",
  contribution([{}], null, stubBlobs("x", "y")) === null
);

ok(
  "THE OVER-STATEMENT IS THE POINT: a withheld file contributes its WHOLE CONTENT, so its adds " +
    "are a SUPERSET of what a patch would have given. An understated `adds` is what makes " +
    "`head.adds \\ reviewed.adds` empty and the gate say COVERED for a line nobody read",
  (() => {
    const c = contribution(WITHHELD, null, stubBlobs("a\nb", "a\nb\nc"));
    // a patch would have given {c}; whole content gives {a,b,c} — a superset, never smaller
    return (
      c.adds.has(`pnpm-lock.yaml${NUL}c`) &&
      c.adds.has(`pnpm-lock.yaml${NUL}a`) &&
      c.adds.size === 3
    );
  })()
);

ok(
  "AND THE OVER-STATEMENT COSTS NOTHING WHEN BOTH SIDES ARE MEASURED THE SAME WAY: for a file " +
    "unchanged between the reviewed sha and the head, the two whole-content sets are equal and " +
    "their difference is empty — which is #1132's actual case",
  (() => {
    const same = "l1\nl2\nl3";
    const atReviewed = contribution(WITHHELD, null, stubBlobs("base", same));
    const atHead = contribution(WITHHELD, null, stubBlobs("base", same));
    const newAdds = [...atHead.adds].filter((k) => !atReviewed.adds.has(k));
    return newAdds.length === 0;
  })()
);

ok(
  "THE LIST-LEVEL REASONS HAVE NO FALLBACK AND MUST NOT ACQUIRE ONE: a truncated list still " +
    "refuses even with a context, because the files you would fetch are the ones you cannot see",
  (() => {
    const many = Array.from({ length: COMPARE_FILE_CAP }, (_, i) => ({
      filename: `f${i}`,
      status: "modified",
    }));
    return (
      contribution(many, null, stubBlobs("x", "y")) === null &&
      unreadableReasonOfList(many) !== null
    );
  })()
);

ok(
  "...and so does a file-count disagreement, for the same reason",
  contribution(WITHHELD, 5, stubBlobs("x", "y")) === null &&
    unreadableReasonOfList(WITHHELD, 5) !== null
);

ok(
  "PAIRED CONTROL for the two arms above: with the list intact the SAME context DOES produce a " +
    "contribution, so they are not satisfied by a fallback that never engages",
  contribution(WITHHELD, 1, stubBlobs("x", "y")) !== null
);

ok(
  "withheldPatchFiles names only the files that need the route, and skips `unchanged`",
  withheldPatchFiles([
    ...WITHHELD,
    { filename: "u", status: "unchanged" },
    { filename: "ok", status: "modified", patch: "@@" },
  ]).length === 1
);

const pass = results.filter((r) => r.ok).length;
for (const r of results)
  process.stdout.write(`  ${r.ok ? "ok  " : "FAIL"}  ${r.name}\n`);

const EXPECTED = 142; // 109 at the merge-base; +6 for #1082's refusal split, +9 for #1105's
// anchor arms merged in, +4 for #1073's reachability arms (the cycle, its grounded companion,
// the ungrounded chain, and the self-reference), +14 for #1140's blob fallback (the four file
// shapes, the captured REST-with-patch shape, the empty-is-not-absent guard, the superset
// property, the identical-blobs case, and the list-level reasons keeping their refusal).
//
// DERIVED FROM A RUN, NOT FROM ARITHMETIC. This constant collided on the rebase — #1136 took it
// to 128 while this branch had it at 138 from a base of 124 — and adding my delta to the number
// visible on my branch would have used a pre-#1136 total. DEV3's rule from #1126: take
// `results.length` from an actual run after the rebase.
//
// It happens to agree with 128 + 14 here. That is a coincidence worth naming rather than a
// vindication of the arithmetic: the two routes agree only when nothing else moved, which is
// exactly the condition you cannot check without doing the run.
//
// AND THE RUN HAS TO BE READ AT THE RIGHT PLACE. `pass` above is computed BEFORE the end of the
// file, so an arm added below it is counted in `results.length` and never in `pass` — the suite
// then reports "N/M passed" with no failing arm named. Verified for this change: zero `ok(`
// calls follow line 2272.
const code = pass === results.length ? 0 : 1;
process.stdout.write(`\n  ${pass}/${results.length} passed\n`);
if (code === 0 && results.length !== EXPECTED) {
  process.stderr.write(
    `\nFAIL: ran ${results.length}, expected ${EXPECTED} — a case was added or lost.\n`
  );
  process.exit(1);
}
process.exit(code);
