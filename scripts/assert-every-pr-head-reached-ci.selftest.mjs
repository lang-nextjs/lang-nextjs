/**
 * Proof for assert-every-pr-head-reached-ci (#1095).
 *
 * THE STATE THIS GUARDS AGAINST HAS OCCURRED ONCE IN 225 FORCE-PUSHES, so the live board will
 * essentially never exercise the finding. A checker whose finding path only runs on the day it
 * matters is a checker nobody has seen work -- so every state is driven here, both through the
 * pure classifier and end to end through a `gh` shim, including the one the board does not hold.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  classify,
  headAgeMinutes,
  FINDINGS,
  STATE,
  GRACE_MINUTES,
  PR_LIMIT,
} from "./assert-every-pr-head-reached-ci.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "assert-every-pr-head-reached-ci.mjs");
const results = [];
const ok = (name, cond) => results.push({ ok: !!cond, name });

/* ---- the three states, driven ---------------------------------------------------------- */

ok(
  "a head with checks is done — its age is not consulted, because CI having run settles it",
  classify({ number: 1, rollupCount: 27, ageMinutes: 99999 }).state ===
    STATE.HAS_CI
);

ok(
  "an empty rollup on a FRESH head is the grace state, not a finding",
  classify({ number: 1, rollupCount: 0, ageMinutes: 1 }).state ===
    STATE.WITHIN_GRACE
);

ok(
  "an empty rollup on an OLD head is THE FINDING, and it names the pull request",
  (() => {
    const r = classify({ number: 1086, rollupCount: 0, ageMinutes: 600 });
    return r.state === STATE.NO_CI && /#1086/.test(r.detail);
  })()
);

ok(
  "only NO_CI fails — the grace state is not smuggled into the findings set",
  FINDINGS.size === 1 &&
    FINDINGS.has(STATE.NO_CI) &&
    !FINDINGS.has(STATE.WITHIN_GRACE)
);

/* ---- the UNMERGEABLE state (#1086's control set) --------------------------------------- */

ok(
  "a DIRTY pull request with an empty rollup is EXPLAINED, not a finding — a conflicted pull " +
    "request has no merge commit for a `pull_request` workflow to run on",
  classify({
    number: 1,
    rollupCount: 0,
    ageMinutes: 600,
    mergeStateStatus: "DIRTY",
  }).state === STATE.UNMERGEABLE
);

ok(
  "and it says DIRTY, so the excuse names its own reason",
  /DIRTY/.test(
    classify({
      number: 1,
      rollupCount: 0,
      ageMinutes: 600,
      mergeStateStatus: "DIRTY",
    }).detail
  )
);

ok(
  "THE ORDERING CONTROL: a DIRTY pull request WITH checks is still reached — five conflicted pull " +
    "requests on the board carry full rollups, and testing DIRTY first would excuse all of them",
  classify({
    number: 1,
    rollupCount: 35,
    ageMinutes: 600,
    mergeStateStatus: "DIRTY",
  }).state === STATE.HAS_CI
);

ok(
  "THE OTHER CONTROL: the same empty rollup on a MERGEABLE pull request is still THE FINDING, so " +
    "the new state excuses the conflict and not the condition",
  classify({
    number: 1,
    rollupCount: 0,
    ageMinutes: 600,
    mergeStateStatus: "CLEAN",
  }).state === STATE.NO_CI
);

ok(
  "an UNKNOWN merge state does not earn the excuse — absent is not DIRTY",
  classify({ number: 1, rollupCount: 0, ageMinutes: 600 }).state === STATE.NO_CI
);

ok(
  "UNMERGEABLE is not a finding, and NO_CI still is",
  !FINDINGS.has(STATE.UNMERGEABLE) && FINDINGS.has(STATE.NO_CI)
);

/* ---- an UNREADABLE rollup is not an empty one ------------------------------------------ */

ok(
  "a null rollup is a FINDING, not a pass — unreadable and empty are opposite answers",
  classify({ number: 1, rollupCount: null, ageMinutes: 1 }).state ===
    STATE.NO_CI
);

ok(
  "and it says WHY, rather than reporting the same sentence as a genuinely empty one",
  /could not be read/.test(
    classify({ number: 1, rollupCount: null, ageMinutes: 1 }).detail
  )
);

ok(
  "an ABSENT rollup field behaves as unreadable, not as zero",
  classify({ number: 1, ageMinutes: 1 }).state === STATE.NO_CI
);

/* ---- the grace boundary, both sides ----------------------------------------------------- */

ok(
  `exactly ${GRACE_MINUTES} minutes is a FINDING — the window is strictly less-than`,
  classify({ number: 1, rollupCount: 0, ageMinutes: GRACE_MINUTES }).state ===
    STATE.NO_CI
);

ok(
  `one minute under is still grace — PAIRED CONTROL, so the arm above is not passing because the window is broken`,
  classify({ number: 1, rollupCount: 0, ageMinutes: GRACE_MINUTES - 1 })
    .state === STATE.WITHIN_GRACE
);

ok(
  "an UNKNOWN age does not earn the grace — a date we could not read is not evidence of youth",
  (() => {
    const r = classify({ number: 1, rollupCount: 0, ageMinutes: null });
    return r.state === STATE.NO_CI && /age could not be read/.test(r.detail);
  })()
);

/* ---- headAgeMinutes ---------------------------------------------------------------------- */

const NOW = Date.parse("2026-09-09T12:00:00Z");
const ago = (m) => new Date(NOW - m * 60000).toISOString();

ok(
  "a head written 45 minutes ago reads as 45",
  headAgeMinutes(ago(45), NOW) === 45
);

ok(
  "a head dated in the FUTURE reads as UNKNOWN, not as young",
  headAgeMinutes(ago(-120), NOW) === null
);

ok(
  "PAIRED CONTROL: a head dated in the PAST still yields a number, so the guard above did not " +
    "simply disable the reading",
  headAgeMinutes(ago(5), NOW) === 5
);

ok(
  "a future-dated head therefore reaches the FINDING rather than the grace",
  classify({
    number: 1,
    rollupCount: 0,
    ageMinutes: headAgeMinutes(ago(-120), NOW),
  }).state === STATE.NO_CI
);

ok("a non-string date is unknown", headAgeMinutes(undefined, NOW) === null);
ok(
  "an unparseable date is unknown",
  headAgeMinutes("not a date", NOW) === null
);

/* ---- END TO END, through a `gh` shim ----------------------------------------------------- */

/**
 * Run the checker with a `gh` that answers `pr list` with `json`. PATH is PREPENDED and never
 * replaced, so the shim shadows `gh` while `node` still resolves.
 */
function drive(
  json,
  apiBody = `echo '{"commit":{"committer":{"date":"${ago(600)}"}}}'`
) {
  const dir = mkdtempSync(join(tmpdir(), "pr-head-ci-"));
  const shim = join(dir, "gh");
  writeFileSync(
    shim,
    `#!/bin/sh\ncase "$1 $2" in\n  "pr list") cat <<'J'\n${json}\nJ\n  ;;\n  "api repos/{owner}/{repo}/commits/"*) ${apiBody} ;;\n  *) echo '{}' ;;\nesac\n`
  );
  chmodSync(shim, 0o755);
  const r = spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
  return { status: r.status, all: `${r.stdout}${r.stderr}` };
}

const prJson = (over = {}) =>
  JSON.stringify([
    {
      number: 4242,
      headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      isDraft: false,
      statusCheckRollup: [],
      ...over,
    },
  ]);

ok(
  "end to end: an old head with an empty rollup FAILS with exit 1 and names the pull request",
  (() => {
    const r = drive(prJson());
    return r.status === 1 && /#4242/.test(r.all) && /no CI ran on/.test(r.all);
  })()
);

ok(
  "end to end: the same board with checks present PASSES — PAIRED CONTROL for the arm above",
  (() => {
    const r = drive(prJson({ statusCheckRollup: [{ name: "ci" }] }));
    return r.status === 0 && !/no CI ran on/.test(r.all);
  })()
);

ok(
  "end to end: the same board with a FRESH head passes, so the finding above is the age and " +
    "not the empty rollup alone",
  drive(
    prJson(),
    `echo '{"commit":{"committer":{"date":"${new Date().toISOString()}"}}}'`
  ).status === 0
);

ok(
  "end to end: when the commit lookup FAILS the head is a FINDING, not a pass — an age that " +
    "could not be read must not inherit the grace",
  (() => {
    const r = drive(prJson(), "exit 1");
    return r.status === 1 && /age could not be read/.test(r.all);
  })()
);

ok(
  "end to end: it reports its SUBJECT on the failing path too, not only when it passes (#1030)",
  /*
   * ANCHORED ON THE `SUBJECT:` LINE, AND THE FIRST VERSION WAS NOT. It matched
   * `1 open pull request(s)`, which also appears in the FAILURE line -- so deleting the
   * reportSubject call entirely left this arm green. A mutation caught it; the name did not.
   */
  /^SUBJECT: 1 open pull request\(s\)$/m.test(drive(prJson()).all)
);

ok(
  `end to end: a FULL page of ${PR_LIMIT} refuses with exit 2 — a subject that may be short is not a subject`,
  (() => {
    const many = JSON.stringify(
      Array.from({ length: PR_LIMIT }, (_, i) => ({
        number: i + 1,
        headRefOid: "b".repeat(40),
        isDraft: false,
        statusCheckRollup: [{ name: "ci" }],
        commits: [{ oid: "b".repeat(40), committedDate: ago(1) }],
      }))
    );
    const r = drive(many);
    return r.status === 2 && /the limit asked for/.test(r.all);
  })()
);

ok(
  "with no `gh` on PATH it REFUSES with exit 2, which is not the same answer as every head being covered",
  (() => {
    const r = spawnSync(process.execPath, [SCRIPT], {
      encoding: "utf8",
      env: { ...process.env, PATH: "" },
    });
    return r.status === 2 && /REFUSE/.test(`${r.stdout}${r.stderr}`);
  })()
);

ok(
  "an empty board PASSES rather than refusing — zero open pull requests is a legitimate state, " +
    "and the vacuity floor for it lives in checks.json where the runner can see it",
  drive("[]").status === 0
);

ok(
  "end to end: a DIRTY board row with an empty rollup PASSES and is NAMED in the output — an " +
    "exclusion nobody can see is the shape this gate refuses everywhere else",
  (() => {
    const r = drive(prJson({ mergeStateStatus: "DIRTY" }));
    return r.status === 0 && /unmergeable/.test(r.all) && /#4242/.test(r.all);
  })()
);

const EXPECTED = 31;

/*
 * THE VERDICT, THE LISTING AND THE COUNT ALL COME FROM AN EXIT HOOK, AND NOTHING CALLS
 * `process.exit` (#1122).
 *
 * Written the ordinary way -- print, compare, `process.exit(code)` -- an arm appended BELOW this
 * block never runs at all, and the suite reports the same green it did before the arm was added.
 * That is the whole of the #1122 class, and `assert-selftest-arms-are-visible.mjs` probes for it by
 * appending a marker and asking whether the banner comes after it.
 *
 * MEASURED, NOT COPIED FROM THE ADVICE. The remedy text names
 * `eject-subject-audit.selftest.mjs` as the worked example; probed, that file is `inert` -- it
 * moved its COUNT GUARD into a hook but still ends in `process.exit`, so an appended arm is still
 * dead. Of 40 selftests probed, exactly one reaches `counted`:
 * `assert-armed-prs-are-covered-by-a-review.selftest.mjs`, and its distinguishing property is that
 * it never calls `process.exit` at all. That is the shape copied here.
 */
process.exitCode = 0;
process.on("exit", () => {
  const pass = results.filter((r) => r.ok).length;
  for (const r of results)
    process.stdout.write(`  ${r.ok ? "ok  " : "FAIL"}  ${r.name}\n`);
  process.stdout.write(`\n  ${pass}/${results.length} passed\n`);
  if (pass !== results.length) process.exitCode = 1;
  else if (results.length !== EXPECTED) {
    process.stderr.write(
      `\nFAIL: ran ${results.length}, expected ${EXPECTED} — a case was added or lost.\n`
    );
    process.exitCode = 1;
  }
});
