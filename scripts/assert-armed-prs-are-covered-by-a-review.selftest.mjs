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
  STATE,
  FINDINGS,
} from "./assert-armed-prs-are-covered-by-a-review.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "assert-armed-prs-are-covered-by-a-review.mjs");
const results = [];
const ok = (name, cond, detail) => results.push({ ok: !!cond, name, detail });

const files = (...pairs) => pairs.map(([filename, sha]) => ({ filename, sha }));
const REVIEWED = contribution(files(["a.ts", "blob1"], ["b.ts", "blob2"]));

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
      atHead: contribution(
        files(["a.ts", "blob1"], ["b.ts", "blob2"], ["c.ts", "blob9"])
      ),
      atReviewed: REVIEWED,
      reviewedInBranch: true,
    });
    return r.state === STATE.UNCOVERED && r.detail.includes("c.ts");
  })()
);

ok(
  "the SAME filename with a CHANGED blob is UNCOVERED - a filename set cannot see this",
  classify({
    armed: true,
    reports: [{ agent: "DEV1", sha: "abc1234" }],
    atHead: contribution(files(["a.ts", "blobCHANGED"], ["b.ts", "blob2"])),
    atReviewed: REVIEWED,
    reviewedInBranch: true,
  }).state === STATE.UNCOVERED
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
      atHead: contribution(files(["a.ts", "blobCHANGED"], ["b.ts", "blob2"])),
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
  "SUPERSEDED is kept for the case that COSTS the answer: sha gone AND unreadable",
  classify({
    armed: true,
    reports: [{ agent: "DEV1", sha: "abc1234" }],
    atHead: REVIEWED,
    atReviewed: null,
    reviewedInBranch: false,
  }).state === STATE.SUPERSEDED
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
const EXPECTED = 21;
const code = pass === results.length ? 0 : 1;
process.stdout.write(`\n  ${pass}/${results.length} passed\n`);
if (code === 0 && results.length !== EXPECTED) {
  process.stderr.write(
    `\nFAIL: ran ${results.length}, expected ${EXPECTED} — a case was added or lost.\n`
  );
  process.exit(1);
}
process.exit(code);
