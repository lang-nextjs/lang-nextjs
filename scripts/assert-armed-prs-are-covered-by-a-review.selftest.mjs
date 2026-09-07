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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  classify,
  contribution,
  reportsFrom,
  unanchoredDeltas,
  COMPARE_FILE_CAP,
  unreadableReason,
  expectedFileCount,
  unionContributions,
  endpointsOf,
  liveReports,
  STATE,
  FINDINGS,
} from "./assert-armed-prs-are-covered-by-a-review.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "assert-armed-prs-are-covered-by-a-review.mjs");
const results = [];
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
    armed: true,
    reports: [{ agent: null, sha: null }],
    atHead: REVIEWED,
    atReviewed: REVIEWED,
    reviewedInBranch: true,
  }).state === STATE.NO_SHA
);

ok(
  "a null comparison is COULD NOT CHECK and does NOT read as equal",
  classify({
    armed: true,
    reports: [{ agent: "DEV1", sha: "abc1234" }],
    atHead: null,
    atReviewed: null,
    reviewedInBranch: true,
  }).state === STATE.UNREADABLE
);

/* ---- the benign case, which is why `sha != head` is not the finding ----------------------- */

ok(
  "a head moved by a main-merge is COVERED, because the contribution is unchanged",
  classify({
    armed: true,
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
    armed: true,
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
      armed: true,
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
    armed: true,
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
      armed: true,
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
    armed: true,
    reports: [{ agent: "DEV2", sha: "7c942553" }],
    atHead: contribution([file("guard.ts", "-assertSomethingImportant();")]),
    atReviewed: contribution([file("guard.ts", "")]),
    reviewedInBranch: true,
  }).detail.includes("guard.ts")
);

ok(
  "a MISSING patch cannot be compared and returns null, which classify turns into COULD NOT CHECK",
  (() => {
    const c = contribution([{ filename: "big.bin" }]);
    return (
      c === null &&
      classify({
        armed: true,
        reports: [{ agent: "DEV1", sha: "abc1234" }],
        atHead: c,
        atReviewed: REVIEWED,
        reviewedInBranch: true,
      }).state === STATE.UNREADABLE
    );
  })()
);

ok(
  "a rebase whose contribution is UNCHANGED is covered - the rebase alone is not the finding",
  classify({
    armed: true,
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
      armed: true,
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
  "there is no force-pushed state left: an unreadable reviewed side is COULD NOT CHECK",
  (() => {
    const r = classify({
      armed: true,
      reports: [{ agent: "DEV1", sha: "abc1234" }],
      atHead: REVIEWED,
      atReviewed: null,
      reviewedInBranch: false,
    });
    return r.state === STATE.UNREADABLE && !("SUPERSEDED" in STATE);
  })()
);

ok(
  "an UNARMED pr is not examined and is not a finding",
  (() => {
    const s = classify({
      armed: false,
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
        armed: true,
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
      armed: true,
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
      armed: true,
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
      armed: true,
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
      armed: true,
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
    armed: true,
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
        armed: true,
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
    armed: true,
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
    armed: true,
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
        armed: true,
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
        armed: true,
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
        armed: true,
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
    armed: true,
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
      env: { ...process.env, PATH: "" },
    });
    return (
      r.status === 2 &&
      /COULD NOT CHECK/.test(r.stderr) &&
      !/^OK:/m.test(r.stdout)
    );
  })()
);

/* ---- report ------------------------------------------------------------------------------- */

const pass = results.filter((r) => r.ok).length;
for (const r of results)
  process.stdout.write(`  ${r.ok ? "ok  " : "FAIL"}  ${r.name}\n`);
const EXPECTED = 64;
const code = pass === results.length ? 0 : 1;
process.stdout.write(`\n  ${pass}/${results.length} passed\n`);
if (code === 0 && results.length !== EXPECTED) {
  process.stderr.write(
    `\nFAIL: ran ${results.length}, expected ${EXPECTED} — a case was added or lost.\n`
  );
  process.exit(1);
}
process.exit(code);
