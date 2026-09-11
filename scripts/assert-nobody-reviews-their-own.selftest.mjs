#!/usr/bin/env node
/**
 * PROOF for assert-nobody-reviews-their-own.mjs (#1058).
 *
 * The arms that matter are the ones where a plausible implementation is silently wrong:
 *
 *   - a join on RAW NAMES misses the self-review that spelled itself the other way. `DEV3` and
 *     `DEV3-lang` are the same agent and both forms are live on this board, in different channels.
 *   - `null === null` reports two off-roster names as one agent, accusing a reader on the
 *     strength of neither name being known — the empty-set-equals-empty-set defect, in identities.
 *   - a WITHDRAWN token still counts, which is how a retracted read certified a pull request once
 *     already.
 */
import {
  STATE,
  FINDINGS,
  Refusal,
  declaredIdentity,
  selfReviews,
  offRoster,
  classify,
  REFUSALS,
  main,
} from "./assert-nobody-reviews-their-own.mjs";
import { ROSTER } from "./assert-pr-authorship-is-attributable.mjs";

/*
 * AN OFF-ROSTER NAME DERIVED FROM THE ROSTER, SO IT CANNOT EXPIRE. These arms used "DEV7" as their
 * example of an agent the roster does not know, and it stopped being one the day DEV7 joined. One
 * past the highest DEVn on the roster is agent-shaped, and off-roster by construction.
 */
const OFF_ROSTER = `DEV${
  Math.max(
    0,
    ...Object.keys(ROSTER).map((k) => Number(/^DEV(\d+)$/.exec(k)?.[1] ?? 0))
  ) + 1
}`;

let pass = 0,
  fail = 0;
const t = (name, ok, detail = "") => {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.error(`  WRONG ${name}${detail ? `\n        ${detail}` : ""}`);
  }
};
const rep = (agent, sha = "abc1234", withdrawn = false) => ({
  agent,
  from: null,
  sha,
  unparsed: null,
  withdrawn,
});

/* ---- reading the declaration ------------------------------------------------------------- */
t(
  "a declaration in the BODY is read",
  declaredIdentity({ body: "AUTHORING-AGENT: DEV2", commits: [] }) === "DEV2"
);
t(
  "a declaration in a COMMIT BODY is read — the channel the header prefers",
  declaredIdentity({
    body: "no line",
    commits: [{ messageBody: "AUTHORING-AGENT: DEV3" }],
  }) === "DEV3"
);
t(
  "AND IT RESOLVES THROUGH THE ROSTER: DEV3-lang is DEV3",
  declaredIdentity({ body: "AUTHORING-AGENT: DEV3-lang", commits: [] }) ===
    "DEV3"
);
t(
  "no declaration reads null, not a guess",
  declaredIdentity({ body: "nothing here", commits: [] }) === null
);
t(
  "an unfetched detail is null rather than an empty author",
  declaredIdentity(null) === null
);

/* ---- the join --------------------------------------------------------------------------- */
t(
  "SAME AGENT, DIFFERENT SPELLING, IS A SELF-REVIEW — a raw-string join misses exactly this",
  selfReviews("DEV3", [rep("DEV3-lang")]).length === 1
);
t(
  "DIRECTOR / DEV4 / DEV5 / DEV6 cross-spelling self-reviews all catch — the roster was widened " +
    "for them, so missing one is a false-OK waiting for the day their token covers their own PR",
  selfReviews("DIRECTOR", [rep("DIRECTOR-lang")]).length === 1 &&
    selfReviews("DEV4", [rep("DEV4-lang")]).length === 1 &&
    selfReviews("DEV5", [rep("DEV5-lang")]).length === 1 &&
    selfReviews("DEV6", [rep("DEV6-lang")]).length === 1
);
t(
  "PAIRED CONTROL — different agents covering DIRECTOR / DEV4 / DEV5 / DEV6 is OK, the widen " +
    "must not invent self-reviews that weren't there",
  selfReviews("DIRECTOR", [rep("DEV3")]).length === 0 &&
    selfReviews("DEV4", [rep("DIRECTOR-lang")]).length === 0 &&
    selfReviews("DEV5", [rep("DEV6-lang")]).length === 0
);
t(
  "UNKNOWN-NAME REFUSAL IS PRESERVED — Claude still reports UNCOMPARABLE rather than matching, " +
    "even with DIRECTOR on the roster alongside",
  (() => {
    const r = classify({
      detail: { body: "AUTHORING-AGENT: DIRECTOR", commits: [] },
      reports: [rep("Claude")],
    });
    return r.state === STATE.UNCOMPARABLE && /Claude/.test(r.detail);
  })()
);
t(
  "and the identical spelling too",
  selfReviews("DEV3", [rep("DEV3")]).length === 1
);
t("a different agent is not", selfReviews("DEV3", [rep("DEV2")]).length === 0);
t(
  "TWO OFF-ROSTER NAMES ARE NOT A MATCH — null must never equal null",
  selfReviews(null, [rep("Claude")]).length === 0
);
t(
  "and an off-roster READER never matches a known author",
  selfReviews("DEV3", [rep("Claude")]).length === 0
);
t(
  "off-roster names are reported as uncomparable rather than ignored",
  offRoster([rep("Claude"), rep("DEV2")]).length === 1
);

/* ---- classify --------------------------------------------------------------------------- */
{
  const r = classify({
    detail: { body: "AUTHORING-AGENT: DEV2", commits: [] },
    reports: [rep("DEV2")],
  });
  t(
    "a self-review is a FINDING",
    r.state === STATE.SELF_REVIEW && FINDINGS.has(r.state)
  );
  t(
    "and it names the agent, the sha, and a repair",
    /DEV2/.test(r.detail) &&
      /abc1234/.test(r.detail) &&
      /REPAIR:/.test(r.detail)
  );
  t(
    "and the repair names WITHDRAWN, which is the mechanism that actually retracts a token",
    /WITHDRAWN/.test(r.detail)
  );
}
{
  const r = classify({
    detail: { body: "AUTHORING-AGENT: DEV2", commits: [] },
    reports: [rep("DEV3")],
  });
  t(
    "PAIRED CONTROL: a report from someone else passes",
    r.state === STATE.OK && !FINDINGS.has(r.state)
  );
}
{
  const r = classify({
    detail: { body: "AUTHORING-AGENT: DEV2", commits: [] },
    reports: [rep("DEV2", "abc1234", true)],
  });
  t(
    "A WITHDRAWN SELF-REVIEW DOES NOT COUNT — a retracted read certified a pull request once already",
    r.state === STATE.OK,
    JSON.stringify(r)
  );
}
{
  const r = classify({
    detail: { body: "no declaration", commits: [] },
    reports: [rep("DEV2")],
  });
  t(
    "an undeclared author is UNDECLARED, not a pass and not an accusation",
    r.state === STATE.UNDECLARED && !FINDINGS.has(r.state)
  );
}
{
  const r = classify({
    detail: { body: "AUTHORING-AGENT: DEV2", commits: [] },
    reports: [rep("Claude")],
  });
  t(
    "an off-roster reader is UNCOMPARABLE and says which name",
    r.state === STATE.UNCOMPARABLE && /Claude/.test(r.detail)
  );
}
/*
 * DRIVING main() OVER AN INJECTED BOARD (#1177, #1215). `prs` maps a number to its detail, or to null
 * for a `gh pr view` that did not answer. A thrown Refusal is exit 2, exactly as the entry point
 * maps it, so a mutation that restores the throw is a WRONG ANSWER here and not a crash.
 */
const drive = (prs) => {
  const out = [];
  let code;
  try {
    code = main({
      ask: (args) =>
        args[1] === "list"
          ? Object.keys(prs).map((k) => ({ number: Number(k) }))
          : prs[args[2]] ?? null,
      log: (s) => out.push(s),
      error: (s) => out.push(s),
      report: () => {},
    });
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    code = 2;
    out.push(e.message);
  }
  return { code, out: out.join("\n") };
};
const board = (author, reader) => ({
  body: `AUTHORING-AGENT: ${author}`,
  commits: [],
  comments: [{ body: `READER-REPORT: ${reader} @ abc1234` }],
});
{
  /*
   * #1177 ARM A (DEV1's). A declaration that NAMES an off-roster agent is not an absent one. Before
   * the fix, both resolved to null, so this pull request, reviewed by its own author under a
   * matching spelling, read as UNDECLARED and passed.
   */
  const r = classify({
    detail: { body: `AUTHORING-AGENT: ${OFF_ROSTER}`, commits: [] },
    reports: [rep(`${OFF_ROSTER}-lang`)],
  });
  const run = drive({ 5: board(OFF_ROSTER, `${OFF_ROSTER}-lang`) });
  t(
    "#1177 ARM A: a declared OFF-ROSTER author is UNKNOWN_AUTHOR, names the agent, and exits 2",
    r.state === STATE.UNKNOWN_AUTHOR &&
      REFUSALS.has(r.state) &&
      r.detail.includes(OFF_ROSTER) &&
      run.code === 2 &&
      /#5\s+the AUTHORING-AGENT declaration/.test(run.out),
    `${r.state}; main -> ${run.code}`
  );
}
{
  const r = classify({
    detail: { body: "AUTHORING-AGENT: DEV4", commits: [] },
    reports: [rep("DEV4-lang")],
  });
  const run = drive({ 5: board("DEV4", "DEV4-lang") });
  t(
    "#1177 ARM B, THE CONTROL: the same shape with an ON-roster name is still SELF_REVIEW, exit 1",
    r.state === STATE.SELF_REVIEW && run.code === 1,
    `${r.state}; main -> ${run.code}`
  );
}
{
  const r = classify({
    detail: {
      body: "",
      commits: [
        { messageHeadline: "x", messageBody: `AUTHORING-AGENT: ${OFF_ROSTER}` },
      ],
    },
    reports: [rep("DEV2")],
  });
  t(
    "#1177: declared in a COMMIT, with an ON-roster reader, the author is still UNKNOWN_AUTHOR",
    r.state === STATE.UNKNOWN_AUTHOR,
    JSON.stringify(r)
  );
}
{
  const mixed = drive({
    1: board("DEV2", "DEV2"),
    2: board(OFF_ROSTER, "DEV3"),
  });
  const reader = drive({ 1: board("DEV2", "Claude") });
  t(
    "#1177: a finding outranks a refusal and BOTH are printed; an off-roster READER still passes",
    mixed.code === 1 &&
      /#1\s+A READER REPORT COVERS/.test(mixed.out) &&
      /#2\s+the AUTHORING-AGENT declaration/.test(mixed.out) &&
      reader.code === 0,
    `mixed -> ${mixed.code}, off-roster reader -> ${reader.code}`
  );
}
{
  /*
   * #1215's row for this checker (:180). One `gh pr view` that did not answer threw inside the loop,
   * so a self-review on another pull request was never printed and the run said only "could not ask".
   */
  const hidden = drive({ 1: null, 2: board("DEV2", "DEV2-lang") });
  const control = drive({ 1: null, 2: board("DEV2", "DEV3") });
  t(
    "#1215: an unanswered `gh pr view` beside a SELF_REVIEW exits 1, and the finding is SHOWN",
    hidden.code === 1 &&
      /#2\s+A READER REPORT COVERS/.test(hidden.out) &&
      /#1\s+`gh pr view 1` did not answer/.test(hidden.out),
    `-> ${hidden.code}`
  );
  t(
    "#1215 CONTROL: the same unanswered view beside a clean pull request is exit 2, not a pass",
    control.code === 2 &&
      /#1\s+`gh pr view 1` did not answer/.test(control.out),
    `-> ${control.code}`
  );
}
t(
  "an unfetched detail REFUSES rather than passing",
  (() => {
    try {
      classify({ detail: null, reports: [] });
      return false;
    } catch (e) {
      return e instanceof Refusal;
    }
  })()
);

/*
 * THE VERDICT COMES FROM AN EXIT HOOK, AND NOTHING CALLS `process.exit` (#1122). Written the
 * ordinary way the banner prints HERE, so an arm appended below it still RUNS but is not counted --
 * the tally is already out. That is the `uncounted` half of the class, distinct from the `inert`
 * half where the arm never runs at all, and #1145's ratchet flagged this file the moment it could
 * see it. Changed by DEV3 while landing that ratchet; the edit is mechanical and the file is DEV2's,
 * so say if you would rather own it.
 */
process.exitCode = 0;
process.on("exit", () => {
  const total = pass + fail;
  if (fail !== 0) {
    console.error(`\nFAIL: ${fail}/${total} cases wrong.`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `\nPASS: ${pass}/${total}. The join is on ROSTER IDENTITY, so a self-review that spelled itself\n` +
      `      DEV3-lang against an author declared DEV3 is caught — a raw-string comparison misses\n` +
      `      exactly that, and both spellings are live on this board in different channels. Two\n` +
      `      off-roster names are two unknowns rather than one agent, so null never matches null.\n` +
      `      A WITHDRAWN token does not cover anything, which is how a retracted read certified a\n` +
      `      pull request before the marker existed.`
  );
});
