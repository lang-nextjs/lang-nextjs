/**
 * PROOF for assert-every-branch-was-raised.mjs.
 *
 * `classify` is pure over facts the caller fetched, so every state is driven from fabricated
 * inputs. That matters here more than usual: the live board holds only some of these states at
 * any moment, and the two that cost — an unraised branch, and a comparison that could not be
 * made — are precisely the ones a run against the real board may not contain.
 *
 * THE PROCESS-LEVEL ARMS ARE THE POINT, NOT AN EDGE. This check's finding is an ABSENCE, and
 * every way of failing to ask produces an absence too. A capped listing, a silent `gh`, an empty
 * page: each yields "no pull request found" for branches that have one. So the refusals are
 * driven through the assembled path with a stand-in `gh`, not asserted about a helper.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  classify,
  KNOWN_UNRAISED,
  RAISED_LIMIT,
  STATE,
  FINDINGS,
} from "./assert-every-branch-was-raised.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "assert-every-branch-was-raised.mjs");
const results = [];
const ok = (name, cond) => results.push({ ok: !!cond, name });

/* ---- the four states, driven ---------------------------------------------------------- */

ok(
  "a raised branch is not examined further - the pull request is the whole answer",
  classify({ branch: "fix/x", raised: true, aheadBy: 9 }).state === STATE.RAISED
);

ok(
  "a branch with commits and no pull request is the FINDING, and it names the count",
  (() => {
    const r = classify({ branch: "fix/x", raised: false, aheadBy: 3 });
    return r.state === STATE.UNRAISED && /3 commit/.test(r.detail);
  })()
);

ok(
  "ZERO ahead is excluded BY RULE, not by list - there is no invisible work to find",
  classify({ branch: "feat/anything", raised: false, aheadBy: 0 }).state ===
    STATE.NOTHING_TO_LOSE
);

ok(
  "a recorded branch passes and CARRIES ITS REASON to the reader",
  (() => {
    const r = classify({
      branch: "specimen/stale-tree-reverts-398",
      raised: false,
      aheadBy: 1,
    });
    return r.state === STATE.RECORDED && /SPECIMEN/.test(r.detail);
  })()
);

/*
 * NULL IS NOT ZERO, and this is the arm that would have caught the tempting simplification.
 * `aheadBy` is null when the compare could not be made. Defaulting that to 0 would route it to
 * NOTHING_TO_LOSE and silently excuse the one branch nobody can see anything about.
 */
ok(
  "an UNRESOLVABLE comparison is a finding, not a zero - null and 0 are different answers",
  (() => {
    const r = classify({ branch: "fix/x", raised: false, aheadBy: null });
    return r.state === STATE.UNRAISED && /could not be made/.test(r.detail);
  })()
);

ok(
  "only UNRAISED fails - recorded, raised and empty branches do not",
  FINDINGS.has(STATE.UNRAISED) &&
    !FINDINGS.has(STATE.RECORDED) &&
    !FINDINGS.has(STATE.RAISED) &&
    !FINDINGS.has(STATE.NOTHING_TO_LOSE)
);

/*
 * THE EXCEPTION LIST IS PROSE, AND PROSE THAT SAYS NOTHING IS THE FAILURE MODE. An entry whose
 * reason is "wip" or "later" reintroduces the suppression list this is not supposed to be.
 */
ok(
  "every KNOWN_UNRAISED entry carries a substantive reason, not a placeholder",
  Object.values(KNOWN_UNRAISED).every(
    (why) => typeof why === "string" && why.length >= 60
  )
);

ok(
  "an unrecorded branch is NOT quietly matched by a prefix of a recorded one",
  classify({
    branch: "specimen/stale-tree-reverts-398-extra",
    raised: false,
    aheadBy: 1,
  }).state === STATE.UNRAISED
);

/* ---- process-level: every way of failing to ask produces the same absence -------------- */

/** Run the whole checker against a stand-in `gh`. PATH is PREPENDED, never replaced. */
function runAgainst(script) {
  const dir = mkdtempSync(join(tmpdir(), "unraised-"));
  const shim = join(dir, "gh");
  writeFileSync(shim, script);
  chmodSync(shim, 0o755);
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
}

const BRANCHES = 'if [ "$2" = "api" ] || [ "$1" = "api" ]; then :; fi';

ok(
  "a CAPPED pull-request listing REFUSES with exit 2 - it must not accuse raised branches",
  (() => {
    const rows = Array.from(
      { length: RAISED_LIMIT },
      (_, i) => `{"headRefName":"b${i}"}`
    ).join(",");
    const r = runAgainst(`#!/bin/sh
case "$1 $2" in
  "api repos/{owner}/{repo}/branches?per_page=100") echo "main"; echo "fix/x" ;;
  "pr list") echo '[${rows}]' ;;
  *) echo '{"ahead_by":1}' ;;
esac
`);
    return r.status === 2 && /CAPPED/.test(`${r.stdout}${r.stderr}`);
  })()
);

ok(
  "an EMPTY branch listing REFUSES - this repository always has branches",
  (() => {
    const r = runAgainst(`#!/bin/sh
case "$1 $2" in
  "api repos/{owner}/{repo}/branches?per_page=100") : ;;
  "pr list") echo '[]' ;;
  *) echo '{"ahead_by":1}' ;;
esac
`);
    return r.status === 2 && /EMPTY/.test(`${r.stdout}${r.stderr}`);
  })()
);

ok(
  "a silent `gh pr list` REFUSES rather than reporting every branch unraised",
  (() => {
    const r = runAgainst(`#!/bin/sh
case "$1 $2" in
  "api repos/{owner}/{repo}/branches?per_page=100") echo "main"; echo "fix/x" ;;
  "pr list") exit 1 ;;
  *) echo '{"ahead_by":1}' ;;
esac
`);
    return (
      r.status === 2 && /raised set is unknown/.test(`${r.stdout}${r.stderr}`)
    );
  })()
);

ok(
  "END TO END: one unraised branch with commits exits 1 and NAMES it",
  (() => {
    const r = runAgainst(`#!/bin/sh
case "$1 $2" in
  "api repos/{owner}/{repo}/branches?per_page=100") echo "main"; echo "fix/invisible" ;;
  "pr list") echo '[{"headRefName":"fix/other"}]' ;;
  *) echo '{"ahead_by":4}' ;;
esac
`);
    const all = `${r.stdout}${r.stderr}`;
    return r.status === 1 && /fix\/invisible/.test(all) && /4 commit/.test(all);
  })()
);

ok(
  "END TO END: a board where everything is raised exits 0 and reports its subject",
  (() => {
    const r = runAgainst(`#!/bin/sh
case "$1 $2" in
  "api repos/{owner}/{repo}/branches?per_page=100") echo "main"; echo "fix/x" ;;
  "pr list") echo '[{"headRefName":"fix/x"}]' ;;
  *) echo '{"ahead_by":1}' ;;
esac
`);
    return r.status === 0 && /SUBJECT: 2 remote branch/.test(r.stdout);
  })()
);

ok(
  "with no `gh` on PATH it REFUSES with exit 2, not a clean board",
  (() => {
    const r = spawnSync(process.execPath, [SCRIPT], {
      encoding: "utf8",
      env: { ...process.env, PATH: "" },
    });
    return r.status === 2 && /COULD NOT CHECK/.test(r.stderr);
  })()
);

ok(
  "importing the module runs NOTHING - a checker that queries on import cannot be unit-tested",
  (() => {
    const r = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `import ${JSON.stringify(SCRIPT)};`],
      { encoding: "utf8" }
    );
    return (
      r.status === 0 &&
      !/FAIL|OK:|COULD NOT CHECK/.test(`${r.stdout}${r.stderr}`)
    );
  })()
);

/* ---- report ---------------------------------------------------------------------------- */

const pass = results.filter((r) => r.ok).length;
for (const r of results)
  process.stdout.write(`  ${r.ok ? "ok  " : "FAIL"}  ${r.name}\n`);
const EXPECTED = 15;
const code = pass === results.length ? 0 : 1;
process.stdout.write(`\n  ${pass}/${results.length} passed\n`);
if (code === 0 && results.length !== EXPECTED) {
  process.stderr.write(
    `\nFAIL: ran ${results.length}, expected ${EXPECTED} — a case was added or lost.\n`
  );
  process.exit(1);
}
process.exit(code);
