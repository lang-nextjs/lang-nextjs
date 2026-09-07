#!/usr/bin/env node
/**
 * PROOF FOR summarise-flaky.mjs — it finds a flake, says so when there is none, and
 * REFUSES rather than reporting none when it could not look.
 *
 * THE CASE THAT MATTERS IS THE THIRD ONE. A summariser that cannot read its report and
 * prints "no flaky tests" is worse than no summariser: it converts an unread run into a
 * clean bill of health, which is the same defect #777 exists for, one layer up. So the
 * empty case and the unreadable case are asserted to be DISTINGUISHABLE, not merely
 * individually correct.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { flakyTests, render } from "./summarise-flaky.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "summarise-flaky.mjs");

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

const run = (args) => {
  try {
    return {
      code: 0,
      out: execFileSync("node", [SCRIPT, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (e) {
    return { code: e.status, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
};

/** A report shaped like Playwright's, with one flaky webkit test carrying a reading. */
const FLAKY_REPORT = {
  suites: [
    {
      title: "hitl.spec.ts",
      file: "e2e/hitl.spec.ts",
      specs: [
        {
          title: "approve: card dismisses; no error-msg appears",
          file: "e2e/hitl.spec.ts",
          line: 1103,
          tests: [
            {
              projectName: "webkit",
              status: "flaky",
              results: [
                {
                  status: "failed",
                  stdout: [
                    { text: "GIVING UP: headers 129ms, baseline 98ms\n" },
                  ],
                  stderr: [],
                  error: {
                    message: "approval card never appeared within 30000ms",
                  },
                },
                { status: "passed", stdout: [], stderr: [] },
              ],
            },
          ],
        },
      ],
      suites: [],
    },
  ],
};

const CLEAN_REPORT = {
  suites: [
    {
      title: "hitl.spec.ts",
      file: "e2e/hitl.spec.ts",
      specs: [
        {
          title: "approve: card dismisses",
          file: "e2e/hitl.spec.ts",
          line: 1103,
          tests: [
            {
              projectName: "webkit",
              status: "expected",
              results: [{ status: "passed" }],
            },
          ],
        },
      ],
      suites: [],
    },
  ],
};

const dir = mkdtempSync(join(tmpdir(), "flaky-"));
try {
  /* ── it finds the flake, and takes the FAILED attempt's output ─────────────────── */
  {
    const found = flakyTests(FLAKY_REPORT);
    ok("a flaky test is found", found.length === 1, found);
    ok(
      "...and the reading comes from the FAILED attempt, not the passing retry",
      found[0]?.output.includes("GIVING UP: headers 129ms"),
      found[0]?.output
    );
    ok(
      "...and it names project, file and line, so the reader need not re-derive them",
      found[0]?.project === "webkit" &&
        found[0]?.file === "e2e/hitl.spec.ts" &&
        found[0]?.line === 1103,
      found[0]
    );
  }

  /* ── a passing test is NOT reported: the check must be able to say nothing ─────── */
  {
    ok(
      "a report with no flake yields none — it does not report every test",
      flakyTests(CLEAN_REPORT).length === 0,
      flakyTests(CLEAN_REPORT)
    );
  }

  /* ── nested suites, because Playwright nests describe blocks ───────────────────── */
  {
    const nested = {
      suites: [
        { file: "e2e/a.spec.ts", specs: [], suites: [FLAKY_REPORT.suites[0]] },
      ],
    };
    ok(
      "a flake inside a NESTED suite is still found",
      flakyTests(nested).length === 1
    );
  }

  /* ── THE ONE THAT MATTERS: empty and unreadable must not look the same ─────────── */
  {
    const clean = join(dir, "clean.json");
    writeFileSync(clean, JSON.stringify(CLEAN_REPORT));
    const outA = join(dir, "a.md");
    const r1 = run(["--report", clean, "--out", outA]);
    const emptyText = readFileSync(outA, "utf8");
    ok("a report with no flakes exits 0", r1.code === 0, r1);
    ok(
      "...and SAYS SO, so a clean run is distinguishable from an unread one",
      /Flaky tests: none/.test(emptyText),
      emptyText.slice(0, 160)
    );

    const r2 = run(["--report", join(dir, "does-not-exist.json")]);
    ok(
      "a MISSING report REFUSES (exit 2) rather than reporting none",
      r2.code === 2,
      r2
    );

    const bad = join(dir, "bad.json");
    writeFileSync(bad, "not json {{{");
    const r3 = run(["--report", bad]);
    ok("an UNPARSEABLE report REFUSES (exit 2) too", r3.code === 2, r3);
    ok(
      "...and says it RAN rather than that it was missing — different next actions",
      /not parseable JSON/.test(r3.out) && /not a missing file/.test(r3.out),
      r3.out.slice(0, 220)
    );
  }

  /* ── a flake never turns the run red: reporting is the whole job ───────────────── */
  {
    const flaky = join(dir, "flaky.json");
    writeFileSync(flaky, JSON.stringify(FLAKY_REPORT));
    const outB = join(dir, "b.md");
    const r = run(["--report", flaky, "--out", outB]);
    ok(
      "finding a flake still exits 0 — a flake is not a failure",
      r.code === 0,
      r
    );
    const md = readFileSync(outB, "utf8");
    ok(
      "...and the summary carries the reading itself, not just a count",
      /GIVING UP: headers 129ms/.test(md) && /webkit/.test(md),
      md.slice(0, 300)
    );
    ok(
      "...and it reports a SUBJECT, so a run over nothing is visible",
      /SUBJECT: 1 flaky test\(s\)/.test(r.out),
      r.out
    );
  }

  /*
   * THE SCOPE CAVEAT MUST BE IN THE ARTEFACT, NOT ONLY IN THE SOURCE (#919 review).
   *
   * The header states what this cannot see. The header is in the source, and the reader
   * of a run summary is by construction someone NOT opening a log — so a caveat that
   * lives only there is a caveat where its audience never looks, which is #777's own
   * defect one layer out. Asserted on BOTH branches: "none" must not read as "nothing
   * went wrong", and a populated table must not read as "these are all of them".
   */
  {
    ok(
      "the EMPTY summary states its scope — none is not 'nothing went wrong'",
      /whole attempts/.test(render([])) &&
        /INSIDE a single attempt/.test(render([])),
      render([]).slice(0, 240)
    );
    const md = render(flakyTests(FLAKY_REPORT));
    ok(
      "...and the POPULATED summary states it too — a table is not 'all of them'",
      /whole attempts/.test(md),
      md.slice(0, 240)
    );
  }

  /* ── the renderer is total: no output on an attempt must not crash it ──────────── */
  {
    const noOutput = JSON.parse(JSON.stringify(FLAKY_REPORT));
    noOutput.suites[0].specs[0].tests[0].results[0] = { status: "failed" };
    const md = render(flakyTests(noOutput));
    ok(
      "a failed attempt with NO captured output still renders a row",
      /webkit/.test(md),
      md.slice(0, 200)
    );
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const EXPECTED = 16;
const total = pass + fail;
if (total !== EXPECTED) {
  console.log(
    `\nFAIL: ran ${total} assertions, expected ${EXPECTED} — a case was added or lost.`
  );
  process.exit(1);
}
console.log();
if (fail) {
  console.error(`FAIL: ${fail}/${total} cases wrong.`);
  process.exit(1);
}
console.log(
  `PASS: ${pass}/${total}. It finds the flake and takes the FAILED attempt's reading,\n` +
    `      says so when there is none, and REFUSES rather than reporting none when the\n` +
    `      report could not be read.`
);
