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
  "one commit written at two lengths is ONE endpoint, not two unioned with itself",
  (() => {
    const long = "959ea154f0b2c3d4e5f60718293a4b5c6d7e8f90";
    const seen = [];
    for (const sha of [long, "959ea154"])
      if (!seen.some((e) => e.startsWith(sha) || sha.startsWith(e)))
        seen.push(sha);
    return seen.length === 1;
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
const EXPECTED = 39;
const code = pass === results.length ? 0 : 1;
process.stdout.write(`\n  ${pass}/${results.length} passed\n`);
if (code === 0 && results.length !== EXPECTED) {
  process.stderr.write(
    `\nFAIL: ran ${results.length}, expected ${EXPECTED} — a case was added or lost.\n`
  );
  process.exit(1);
}
process.exit(code);
