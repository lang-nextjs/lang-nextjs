#!/usr/bin/env node
/**
 * Proof for assert-hitl-card-budget.mjs (#675).
 *
 * THE RED ARM IS THE HISTORICAL DEFECT, NOT AN INVENTED ONE. It restores the budget that
 * actually shipped — CARD_EXTENSION_MS 15_000, giving 30_000 against a 38_590ms release —
 * so the failing case is the configuration that cost five specs and five manual re-runs in
 * one night, rather than a synthetic edit chosen because it is easy to detect.
 *
 * THE FIXTURES ARE WRITTEN TO A TEMP TREE. Copies under scripts/ or e2e/ would enter the
 * subject of assert-formatted and of the checker itself, so proving this one would fail
 * others — and the formatting gate fires before the assertion under test is reached, which
 * reads as this proof failing. That is why the checker takes `--root`.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECKER = join(ROOT, "scripts", "assert-hitl-card-budget.mjs");

let pass = 0;
let fail = 0;
const ok = (label, cond, got) => {
  if (cond) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label} — got ${JSON.stringify(got)}`);
  }
};

const run = (root) => {
  try {
    return {
      code: 0,
      out: execFileSync("node", [CHECKER, "--root", root], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (e) {
    return { code: e.status, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
};

/** A fixture tree carrying only the three files the checker reads. */
function tree({
  close = 8_590,
  base = 15_000,
  ext = 30_000,
  grace = 30_000,
  perTest = 75_000,
  omit = null,
}) {
  const dir = mkdtempSync(join(tmpdir(), "card-budget-"));
  mkdirSync(join(dir, "e2e"), { recursive: true });
  mkdirSync(join(dir, "packages", "server", "src"), { recursive: true });
  if (omit !== "spec")
    writeFileSync(
      join(dir, "e2e", "hitl.spec.ts"),
      `const CARD_UPSTREAM_CLOSE_MS = ${close};\nconst CARD_BASE_MS = ${base};\nconst CARD_EXTENSION_MS = ${ext};\n`
    );
  else
    writeFileSync(
      join(dir, "e2e", "hitl.spec.ts"),
      "// the constants were renamed\n"
    );
  writeFileSync(
    join(dir, "packages", "server", "src", "approval-gating.ts"),
    `export const DEFAULT_DRAIN_GRACE_MS = ${grace};\n`
  );
  writeFileSync(
    join(dir, "playwright.config.ts"),
    `export default {\n  timeout: ${perTest},\n};\n`
  );
  return dir;
}
const withTree = (opts, fn) => {
  const d = tree(opts);
  try {
    return fn(d);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
};

/* GREEN ARM — the real repository. */
{
  const r = run(ROOT);
  ok(
    "the repository's own constants satisfy both relationships",
    r.code === 0,
    r
  );
  ok(
    "...and it reports a subject, so a pass over nothing is distinguishable",
    /SUBJECT: 5 declared timing constant/.test(r.out),
    r.out.split("\n")[0]
  );
}

/* RED ARM — the shipped defect: budget smaller than the release. */
withTree({ ext: 15_000 }, (d) => {
  const r = run(d);
  ok(
    "RED: the pre-#675 budget (30_000 vs a 38_590ms release) FAILS",
    r.code === 1,
    {
      code: r.code,
      out: r.out.slice(0, 160),
    }
  );
  ok(
    "...and it names both terms of the release, not just the total",
    /8590 upstream close/.test(r.out) && /30000 drain grace/.test(r.out),
    r.out.slice(0, 300)
  );
  ok(
    "...and it says to raise the EXTENSION, since raising the base hides occurrences",
    /RAISE CARD_EXTENSION_MS, NOT CARD_BASE_MS/.test(r.out),
    r.out.slice(0, 400)
  );
});

/*
 * THE GRACE IS THE OTHER TERM, and without this case the checker is satisfied by one that
 * only ever reads the e2e side — the coupling is the whole point, so both halves must move it.
 */
withTree({ grace: 60_000 }, (d) => {
  const r = run(d);
  ok(
    "RED: raising the SERVER's grace alone breaks the relationship",
    r.code === 1 && /60000 drain grace/.test(r.out),
    { code: r.code, out: r.out.slice(0, 200) }
  );
});

/* The per-test timeout arm, independent of the budget arm. */
withTree({ perTest: 40_000 }, (d) => {
  const r = run(d);
  ok(
    "RED: a per-test timeout below setup + budget FAILS",
    r.code === 1 && /OPAQUE expiry/.test(r.out),
    { code: r.code, out: r.out.slice(0, 200) }
  );
});

/*
 * THE REFUSAL ARM. A renamed constant reads as absent, and a checker that treated absence as
 * zero would compare the budget against a number nobody wrote — passing or failing for
 * reasons unrelated to the property. 2, not 1.
 */
withTree({ omit: "spec" }, (d) => {
  const r = run(d);
  ok("a renamed constant REFUSES (2) rather than failing (1)", r.code === 2, {
    code: r.code,
    out: r.out.slice(0, 200),
  });
  ok(
    "...and it names which value it could not read",
    /upstreamClose not found/.test(r.out),
    r.out.slice(0, 300)
  );
});

const EXPECTED = 9;
process.on("exit", (code) => {
  const ran = pass + fail;
  if (code === 0 && ran !== EXPECTED) {
    console.log(
      `\nFAIL: ran ${ran} assertions, expected ${EXPECTED} — a case was added or lost.`
    );
    process.exitCode = 1;
  }
});
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
