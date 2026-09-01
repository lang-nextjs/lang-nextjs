#!/usr/bin/env node
/**
 * PROOF THAT THE EXCLUSION AUDIT CAN FAIL (#632).
 *
 * The thing it guards is green either way — that is the whole reason it exists — so a version
 * of it that quietly accepted everything would look exactly like the working one. Every case
 * drives audit() with synthetic YAML; the real workflow is asserted at the end.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { audit } from "./assert-scan-exclusions-justified.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
let fail = 0;
const t = (label, ok, detail = "") => {
  if (ok) {
    console.log(`  ok   ${label}`);
    pass++;
  } else {
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    fail++;
  }
};

const scan = (body) => `        run: |\n          semgrep scan \\\n${body}`;

t(
  "an exclusion whose comment names it is ACCEPTED",
  audit(
    scan(
      "            # dist: build output, its source is scanned\n            --exclude=dist\n"
    )
  ).problems.length === 0
);

t(
  "an exclusion with NO comment above it is REFUSED (the #632 shape)",
  audit(scan("            --exclude=apps/django-backend\n")).problems.some(
    (p) => /has no reason above it/.test(p)
  )
);

/*
 * THE CASE THAT IS EASIEST TO GET WRONG. A comment is present, so a check asking only "is there
 * a comment" would accept this — and the prose is about a DIFFERENT entry, which is exactly how
 * an unjustified exclusion inherits cover: someone replaces the line under a comment and the
 * comment stays. Requiring the reason to NAME what it excuses is what separates the two.
 */
t(
  "a comment that does not name what it excludes is REFUSED",
  audit(
    scan(
      "            # node_modules: installed dependencies, not our source\n" +
        "            --exclude=apps/fastapi-backend\n"
    )
  ).problems.some((p) => /never names apps\/fastapi-backend/.test(p))
);

t(
  "a file with no `semgrep scan` REFUSES rather than reporting everything justified",
  audit("jobs:\n  build:\n    steps:\n      - run: echo hi\n").problems.some(
    (p) => /^REFUSING/.test(p)
  )
);

/*
 * A scan with nothing excluded is a legitimate state and must not be confused with a broken
 * parse — the anchor above is what tells them apart.
 */
t(
  "a scan that excludes nothing is ACCEPTED, not reported as a parse failure",
  (() => {
    const r = audit(scan("            --metrics=off\n"));
    return r.problems.length === 0 && r.excluded.length === 0;
  })()
);

/* ── the real workflow ────────────────────────────────────────────────────────────────────── */
{
  const yaml = readFileSync(
    join(ROOT, ".github", "workflows", "security.yml"),
    "utf8"
  );
  const r = audit(yaml);
  t(
    "the real security.yml has every exclusion justified",
    r.problems.length === 0,
    r.problems.join(" | ")
  );
  t(
    "the audit found exclusions to check (a census of none proves nothing)",
    r.excluded.length > 0,
    `excluded: ${r.excluded.join(", ")}`
  );
  /*
   * #632 ITSELF, asserted directly rather than left to follow from the audit passing. The audit
   * would also pass if someone re-added these two WITH a reason, and that is the right
   * behaviour for a general rule — but re-admitting the python backends to the exclusion list
   * is a decision this issue argued against on a measurement, so it should have to edit a test
   * that says so.
   */
  t(
    "the python backends are not excluded from SAST",
    !r.excluded.some((e) => /apps\/(django|fastapi)-backend/.test(e)),
    `excluded: ${r.excluded.join(", ")}`
  );
}

const total = pass + fail;
if (fail !== 0) {
  console.error(`\nFAIL: ${fail}/${total} cases wrong.`);
  process.exit(1);
}
console.log(
  `\nPASS: ${pass}/${total}. The audit refuses an exclusion with no reason, one whose reason\n` +
    `      names something else, and a workflow with no scan in it — and it accepts a scan\n` +
    `      that excludes nothing, which is a real state rather than a broken parse.`
);
