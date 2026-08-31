#!/usr/bin/env node
/**
 * PROOF FOR check-live-log-artifact.mjs.
 *
 * Drives the checker as a pure function of two file texts, so every failure mode
 * is reachable by mutating a string — including the one that matters most and is
 * unreachable by editing the real repo without breaking CI: THE CHECK LOSING ITS
 * SUBJECT. If nothing invokes the wrapper, every per-step assertion iterates an
 * empty list and passes, and the checker reports success while examining nothing.
 * That case is asserted first and explicitly.
 *
 * The real files are the positive control: a checker that cannot pass on the tree
 * it ships with would be noise, and one that cannot fail is worse.
 */

import { readFileSync } from "node:fs";
import { checkLiveLogArtifact } from "./check-live-log-artifact.mjs";

const workflowText = readFileSync(".github/workflows/e2e.yml", "utf-8");
const wrapperText = readFileSync(
  "scripts/live-transport-with-retry.sh",
  "utf-8",
);

let failures = 0;
function ok(label, cond, detail = "") {
  if (!cond) failures++;
  console.log(
    `  ${cond ? "ok  " : "FAIL"}   ${label}${detail ? `   ${detail}` : ""}`,
  );
}

const run = (w = workflowText, s = wrapperText) =>
  checkLiveLogArtifact({ workflowText: w, wrapperText: s });

/* 1 — POSITIVE CONTROL. */
{
  const p = run();
  ok("the repo as it stands passes", p.length === 0, p.join(" | "));
}

/* 2 — THE VACUITY CASE. The checker must refuse to pass when it has no subject,
 *     because every other assertion here is a per-step loop. */
{
  const renamed = workflowText.replaceAll(
    "scripts/live-transport-with-retry.sh",
    "scripts/live-transport-renamed.sh",
  );
  const p = run(renamed);
  ok(
    "a renamed wrapper FAILS the checker rather than emptying it",
    p.length > 0,
  );
  ok(
    "  ...and the message says the check lost its subject",
    p.some((x) => /lost its subject/.test(x)),
    p[0],
  );
}

/* 3 — an invoking step with no LIVE_TRANSPORT_LOG_DIR writes to /tmp uncollected. */
{
  const stripped = workflowText.replace(
    /^\s*LIVE_TRANSPORT_LOG_DIR: \$\{\{ runner\.temp \}\}\/live-transport-django\n/m,
    "",
  );
  const p = run(stripped);
  ok("a step without LIVE_TRANSPORT_LOG_DIR is caught", p.length > 0);
  ok(
    "  ...and the message NAMES the step, not just the rule",
    p.some((x) => /Django/.test(x)),
    p[0],
  );
}

/* 4 — both runtimes sharing one directory: the second overwrites the first. */
{
  const shared = workflowText.replace(
    "live-transport-fastapi",
    "live-transport-django",
  );
  const p = run(shared);
  ok(
    "two invocations sharing a log dir is caught",
    p.some((x) => /reuses/.test(x)),
    p[0],
  );
}

/* 5 — `if: failure()` on the upload. A PASS is as unauditable as a failure. */
{
  const onlyOnFail = workflowText.replace(
    /(- name: Upload the live-transport classifier input \(#440\)\n\s*if: )always\(\)/,
    "$1failure()",
  );
  const p = run(onlyOnFail);
  ok(
    "an upload gated on failure() is caught",
    p.some((x) => /always\(\)/.test(x)),
    p[0],
  );
}

/* 6 — an upload whose glob does not reach the directory that was written. */
{
  const wrongPath = workflowText.replace(
    "path: ${{ runner.temp }}/live-transport-*/",
    "path: ${{ runner.temp }}/something-else/",
  );
  const p = run(wrongPath);
  ok(
    "an upload glob that misses the log dir is caught",
    p.some((x) => /no upload-artifact step collects it/.test(x)),
    p[0],
  );
}

/* 7 — the wrapper half of the pair. */
{
  const noFingerprint = wrapperText.replaceAll(
    "LIVE_TRANSPORT_LOG_FINGERPRINT",
    "LIVE_TRANSPORT_LOG_QUIET",
  );
  ok(
    "dropping the fingerprint is caught",
    run(workflowText, noFingerprint).some((x) => /FINGERPRINT/.test(x)),
  );

  const noLogDir = wrapperText.replace(
    '"$LOG_DIR/live-transport.log"',
    '"/tmp/live-transport.log"',
  );
  ok(
    "the wrapper writing outside $LOG_DIR is caught",
    run(workflowText, noLogDir).some((x) => /no longer writes/.test(x)),
  );
}

console.log(
  failures === 0
    ? "\nPASS: the checker holds on this tree and fails on each way the pair can drift apart —\n      including the rename that would leave it green with nothing to examine."
    : `\nFAIL: ${failures} check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
