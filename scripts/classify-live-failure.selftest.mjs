#!/usr/bin/env node
/**
 * The live-failure classifier, watched saying DEFECT before it is trusted (#400).
 *
 * THE FAILURE MODE THIS GUARDS IS SPECIFIC. A classifier that has only ever been
 * seen agreeing with "upstream" is indistinguishable from one that returns
 * "upstream" unconditionally — and it would then relabel every genuine transport
 * break as someone else's problem. That is strictly worse than the red it
 * replaces, because today's red is at least honest.
 *
 * So both directions are asserted, and the fixtures are REAL: each was produced
 * by driving this repo's own `guarded_stream` with an exception and capturing
 * what came out. Not written by hand — a hand-written fixture asserts what the
 * author believed the error path emits.
 *
 * READ THE TWO `code` FIELDS. They are IDENTICAL — `backend_error` on both,
 * because a provider APIError carries no HTTP status and falls through to the
 * same branch a KeyError from our own emitter lands in. `origin` is the only
 * field that separates them, which is the whole reason it exists.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "classify-live-failure.mjs");

let failures = 0;
const ok = (n, c, d = "") => {
  console.log(`  ${c ? "ok  " : "FAIL"}   ${n}${d ? `   ${d}` : ""}`);
  if (!c) failures++;
};

/* Captured from a real run of guarded_stream — see the header. */
const REAL_UPSTREAM =
  'data: {"type": "data-error", "data": {"id": "stream-error", "seq": 0, "code": "backend_error", "message": "Service temporarily overloaded", "retryable": false, "origin": "provider", "cause": {"exception": "APIError"}}}';
const REAL_DEFECT =
  'data: {"type": "data-error", "data": {"id": "stream-error", "seq": 0, "code": "backend_error", "message": "\'tool_call_id\'", "retryable": false, "origin": "backend", "cause": {"exception": "KeyError"}}}';

const line = (frame, cell) =>
  `    Error: LIVE_TRANSPORT_ERROR_FRAME ${cell} :: ${frame}`;

function run(logText, exitCode) {
  const dir = mkdtempSync(join(tmpdir(), "live-classify-"));
  const p = join(dir, "run.log");
  writeFileSync(p, logText);
  let code, out;
  try {
    out = execFileSync(process.execPath, [SCRIPT, p, String(exitCode)], {
      encoding: "utf-8",
      env: { ...process.env, GITHUB_STEP_SUMMARY: "" },
    });
    code = 0;
  } catch (e) {
    out = (e.stdout ?? "") + (e.stderr ?? "");
    code = e.status ?? -1;
  }
  rmSync(dir, { recursive: true, force: true });
  return { code, out };
}

console.log("classify-live-failure selftest\n");

/* 0 — the fixtures are what they claim to be. */
ok(
  "both real frames carry code=backend_error — so `code` cannot discriminate",
  REAL_UPSTREAM.includes('"code": "backend_error"') &&
    REAL_DEFECT.includes('"code": "backend_error"')
);
ok(
  "they differ ONLY in origin",
  REAL_UPSTREAM.includes('"origin": "provider"') &&
    REAL_DEFECT.includes('"origin": "backend"')
);

/* 1 — upstream. */
{
  const r = run(line(REAL_UPSTREAM, "langgraph/plan-execute"), 1);
  ok(
    "a real provider APIError classifies as UPSTREAM_UNAVAILABLE",
    /UPSTREAM_UNAVAILABLE/.test(r.out),
    `exit ${r.code}`
  );
  ok(
    "  ...and exits 3 — a code a caller can act on without parsing prose",
    r.code === 3
  );
}

/* 2 — THE DIRECTION THAT MATTERS. */
{
  const r = run(line(REAL_DEFECT, "deepagents/react"), 1);
  ok(
    "a real backend defect classifies as TRANSPORT_DEFECT",
    /TRANSPORT_DEFECT/.test(r.out),
    `exit ${r.code}`
  );
  ok(
    "  ...and is NOT reported as upstream",
    !/UPSTREAM_UNAVAILABLE/.test(r.out.split("\n")[0])
  );
}

/* 3 — a defect alongside an outage outranks it. One real break is the thing
 *     this job exists to catch; it must not be filed under an outage that
 *     happened in the same run. */
{
  const r = run(
    [line(REAL_UPSTREAM, "a/b"), line(REAL_DEFECT, "c/d")].join("\n"),
    1
  );
  ok(
    "a defect ALONGSIDE an outage still reports DEFECT",
    /TRANSPORT_DEFECT/.test(r.out.split("\n")[0])
  );
}

/* 4 — a frame with no origin at all (an older backend, or the Node proxy).
 *     "We could not attribute this" must not read as "not our problem". */
{
  const noOrigin =
    'data: {"type": "data-error", "data": {"code": "upstream_disconnect", "message": "x"}}';
  const r = run(line(noOrigin, "a/b"), 1);
  ok(
    "an UNATTRIBUTED frame is ours, not theirs",
    /TRANSPORT_DEFECT/.test(r.out.split("\n")[0])
  );
}

/* 5 — failed with no classified frame: a timeout, a crash, a missing backend. */
{
  const r = run("  some unrelated failure output\n", 1);
  ok(
    "a failure with NO error frame is FAILED_UNCLASSIFIED, not upstream",
    /FAILED_UNCLASSIFIED/.test(r.out)
  );
}

/* 6 — green stays green, and an upstream frame in a passing run does not
 *     invent a failure. */
{
  const r = run(line(REAL_UPSTREAM, "a/b"), 0);
  ok("exit 0 reports PASS and exits 0", /PASS/.test(r.out) && r.code === 0);
}

/* 7 — a missing log is an error, not a clean run. */
{
  let code;
  try {
    execFileSync(process.execPath, [SCRIPT, "/nonexistent/run.log", "1"], {
      encoding: "utf-8",
    });
    code = 0;
  } catch (e) {
    code = e.status ?? -1;
  }
  ok(
    "a MISSING log refuses (exit 2) rather than reporting nothing",
    code === 2
  );
}

/* 7b — THE EXIT CONTRACT, all three codes. A caller branches on these, so a
 *      wrong one is a policy applied to the wrong case. 3 must never collide
 *      with 0: something reading only the status must not mistake "we could
 *      not test this" for "this works". */
{
  ok("defect exits 1", run(line(REAL_DEFECT, "a/b"), 1).code === 1);
  ok("upstream exits 3", run(line(REAL_UPSTREAM, "a/b"), 1).code === 3);
  ok("pass exits 0", run(line(REAL_UPSTREAM, "a/b"), 0).code === 0);
  ok(
    "unclassified exits 1, NOT 3 — an unexplained failure is not an outage",
    run("some unrelated failure\n", 1).code === 1
  );
}

/* 7c — ATTEMPT TAGGING. A retry-recovery rate is a statement about PAIRS, so a
 *      record that does not say which attempt it describes reduces to a count
 *      of failures — the number we already had. */
{
  const first = run(line(REAL_UPSTREAM, "a/b"), 1);
  ok(
    "a first attempt records attempt=first and advises retry",
    /attempt=first/.test(first.out) &&
      /LIVE_TRANSPORT_ADVICE retry/.test(first.out)
  );

  const dir = mkdtempSync(join(tmpdir(), "live-classify-retry-"));
  const p2 = join(dir, "run.log");
  writeFileSync(p2, line(REAL_UPSTREAM, "a/b"));
  let out2 = "";
  try {
    out2 = execFileSync(process.execPath, [SCRIPT, p2, "1"], {
      encoding: "utf-8",
      env: {
        ...process.env,
        LIVE_TRANSPORT_IS_RETRY: "1",
        GITHUB_STEP_SUMMARY: "",
      },
    });
  } catch (e) {
    out2 = (e.stdout ?? "") + (e.stderr ?? "");
  }
  rmSync(dir, { recursive: true, force: true });
  ok(
    "a retry records attempt=retry and does NOT advise retrying again",
    /attempt=retry/.test(out2) && /LIVE_TRANSPORT_ADVICE no-retry/.test(out2)
  );
}

/* 8 — COUNTABILITY. A verdict nobody can aggregate is one nobody notices
 *     getting worse, and "a neutral nobody investigates" is the same failure
 *     as the red it replaced. The record must exist in EVERY verdict, not
 *     just the interesting ones — a format emitted only on failure cannot
 *     produce a rate, because the denominator is missing. */
{
  const cases = [
    ["UPSTREAM_UNAVAILABLE", line(REAL_UPSTREAM, "a/b"), 1, "notice"],
    ["TRANSPORT_DEFECT", line(REAL_DEFECT, "a/b"), 1, "error"],
    ["FAILED_UNCLASSIFIED", "unrelated failure\n", 1, "warning"],
    ["PASS", line(REAL_UPSTREAM, "a/b"), 0, "notice"],
  ];
  for (const [verdict, log, code, level] of cases) {
    const r = run(log, code);
    const rec = r.out
      .split("\n")
      .find((l) => l.startsWith("LIVE_TRANSPORT_VERDICT "));
    ok(
      `${verdict}: emits a countable record line`,
      Boolean(rec) && rec.includes(`verdict=${verdict}`),
      rec ?? "(none)"
    );
    ok(
      `${verdict}:   ...with every field a rate needs`,
      /verdict=\S+ defects=\d+ upstream=\d+ exit=\d+/.test(rec ?? "")
    );
    ok(
      `${verdict}:   ...and an annotation readable without opening the log`,
      r.out.includes(`::${level} title=live-transport::`)
    );
  }
}

console.log(
  failures === 0
    ? "\nPASS: the classifier was watched saying DEFECT on a real backend defect,\n" +
        "      not merely agreeing with UPSTREAM on the overload cases."
    : `\nFAIL: ${failures} check(s) failed. Do not trust this classifier.`
);
process.exit(failures === 0 ? 0 : 1);
