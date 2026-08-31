#!/usr/bin/env node
/**
 * Proof for assert-playwright-leaves-history-intact.mjs.
 *
 * The REJECT case is the repository as it stood before #470: a Playwright config with no
 * `captureGitInfo`, which depth-fetches the PR base into whatever repo it runs in. If this
 * case ever stops failing, the checker has stopped being able to see the defect and its green
 * on the real config means nothing.
 *
 * AND IT CHECKS THE CHECKER'S OWN BLAST RADIUS. A `--depth` fetch from a git WORKTREE writes
 * the SHARED `.git/shallow` and would flag the parent repository -- the checker inflicting the
 * exact defect it exists to detect, on the machine of whoever ran it. The last case asserts
 * this repository is untouched after a full probe.
 *
 * Usage: node scripts/assert-playwright-leaves-history-intact.selftest.mjs
 */
import {
  mkdtempSync,
  writeFileSync,
  existsSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CHECKER = join(HERE, "assert-playwright-leaves-history-intact.mjs");
const TMP = mkdtempSync(join(tmpdir(), "pw-hist-self-"));
let pass = 0,
  fail = 0;

function runChecker(configText) {
  const cfg = join(TMP, `cfg-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(cfg, configText);
  try {
    return {
      rc: 0,
      out: execFileSync("node", [CHECKER, "--cwd", ROOT, "--config", cfg], {
        encoding: "utf8",
      }),
    };
  } catch (e) {
    return { rc: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

function expect(label, want, configText, mustSay = []) {
  const { rc, out } = runChecker(configText);
  const got = rc === 0 ? "accept" : rc === 2 ? "vacuous" : "reject";
  const said = mustSay.every((s) => out.includes(s));
  if (got === want && said) {
    console.log(`  ok   ${label.padEnd(58)} (${want})`);
    pass++;
  } else {
    console.error(
      `  FAIL ${label} — wanted ${want}, got ${got} (rc=${rc}), named=${said}`
    );
    console.error(
      out
        .split("\n")
        .map((l) => "         " + l)
        .join("\n")
    );
    fail++;
  }
}

const BASE = `import { defineConfig } from "@playwright/test";\nexport default defineConfig({\n  testDir: "./e2e",\n`;

console.log("\nassert-playwright-leaves-history-intact — REJECT\n");

// The repository as it was before #470.
expect(
  "a config with no captureGitInfo depth-fetches the PR base",
  "reject",
  `${BASE}});\n`,
  ["shallow-flagged", "PRESENT"]
);

/*
 * HALF A FIX IS NOT A FIX. `commit: false` alone leaves `diff` at its default, which is the
 * setting that performs the fetch. A config that looks like it addressed this and did not is
 * more dangerous than one that never tried.
 */
expect(
  "captureGitInfo.commit alone does NOT stop the fetch",
  "reject",
  `${BASE}  captureGitInfo: { commit: false },\n});\n`,
  ["PRESENT"]
);

console.log("\nassert-playwright-leaves-history-intact — ACCEPT\n");

expect(
  "captureGitInfo { commit: false, diff: false } leaves history intact",
  "accept",
  `${BASE}  captureGitInfo: { commit: false, diff: false },\n});\n`,
  ["absent", "is-shallow-repo : false"]
);

expect(
  "diff:false alone is enough — it is the fetch that matters",
  "accept",
  `${BASE}  captureGitInfo: { diff: false },\n});\n`,
  ["absent"]
);

console.log("\nassert-playwright-leaves-history-intact — VACUITY\n");

{
  const empty = mkdtempSync(join(TMP, "noroot-"));
  let rc = 0,
    out = "";
  try {
    out = execFileSync("node", [CHECKER, "--cwd", empty], { encoding: "utf8" });
  } catch (e) {
    rc = e.status ?? 1;
    out = (e.stdout ?? "") + (e.stderr ?? "");
  }
  const label = "no playwright binary is exit 2, not a green";
  if (rc === 2 && out.includes("COULD NOT COMPUTE")) {
    console.log(`  ok   ${label.padEnd(58)} (vacuous)`);
    pass++;
  } else {
    console.error(`  FAIL ${label} — rc=${rc}`);
    fail++;
  }
}

console.log(
  "\nassert-playwright-leaves-history-intact — THE CHECKER'S OWN BLAST RADIUS\n"
);

{
  /*
   * The probe just ran Playwright with a depth-fetching config, four times. If it had done so
   * in a worktree of this repository rather than a repo of its own, THIS repository would now
   * be shallow-flagged.
   */
  const gitDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
  const shallow = join(
    gitDir.startsWith("/") ? gitDir : join(ROOT, gitDir),
    "shallow"
  );
  const isShallow = execFileSync(
    "git",
    ["rev-parse", "--is-shallow-repository"],
    { cwd: ROOT, encoding: "utf8" }
  ).trim();
  const label = "this repository is NOT flagged after probing";
  if (!existsSync(shallow) && isShallow === "false") {
    console.log(`  ok   ${label.padEnd(58)} (clean)`);
    pass++;
  } else {
    console.error(
      `  FAIL ${label} — ${shallow} exists=${existsSync(
        shallow
      )}, is-shallow=${isShallow}`
    );
    console.error(
      `         The probe leaked into the real repository. Recover with: git fetch --unshallow`
    );
    fail++;
  }
}

// 6 binary-driven cases + 10 census cases (#480). This count is the guard that caught the
// census being added without it: a suite that grows silently is a suite whose new cases nobody
// confirmed ran.
const EXPECTED = 16;
/* ─────────────────────────────────────────────────────────────────────────────────────────
 * THE CONFIG CENSUS (#480)
 *
 * The cases above vary the CONFIG and run it through the real binary. They cannot vary the
 * TREE, so the census's failure paths are not reachable through that harness — these drive the
 * exported functions directly and say so, rather than asserting less than they appear to.
 * ───────────────────────────────────────────────────────────────────────────────────────── */
const { playwrightConfigs, isVendored, declaresCaptureDisabled } = await import(
  "./assert-playwright-leaves-history-intact.mjs"
);

/** Plain assertion, for the census cases that drive functions rather than the binary. */
function check(label, ok_, detail = "") {
  if (ok_) {
    console.log(`  ok   ${label}`);
    pass++;
  } else {
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    fail++;
  }
}

console.log("\nassert-playwright-leaves-history-intact — CENSUS\n");

{
  const found = playwrightConfigs(ROOT);
  check(
    "the census finds more than one config — a set of one cannot show a gap",
    found.length > 1,
    found.join(", ")
  );
  check(
    "  ...including the vendored one, which is the whole subject",
    found.some(
      (f) => f.startsWith("rungs/") && f.endsWith("playwright.config.ts")
    ),
    found.join(", ")
  );
  check(
    "  ...and nothing from node_modules or a build tree",
    !found.some((f) => f.includes("node_modules") || f.includes(".next")),
    found.join(", ")
  );
}

{
  check(
    "ours is classified owned",
    isVendored("playwright.config.ts") === false
  );
  check(
    "upstream's is classified vendored",
    isVendored(
      "rungs/5-software-developer-agent/apps/open-swe/playwright.config.ts"
    ) === true
  );
  check(
    "  ...by the rungs/ prefix, so a vendored tree added later is classified without an edit",
    isVendored("rungs/9-something-new/playwright.config.ts") === true
  );
}

{
  // BOTH DIRECTIONS. "Reports exposed" is satisfied by a predicate that always says exposed,
  // which would make the STALE branch unreachable and the record permanent.
  const real = readFileSync(
    join(
      ROOT,
      "rungs/5-software-developer-agent/apps/open-swe/playwright.config.ts"
    ),
    "utf-8"
  );
  check(
    "the real vendored config reads as NOT disabling capture",
    !declaresCaptureDisabled(real)
  );
  check(
    "  ...and the fixed shape reads as disabling it, so the record can go stale",
    declaresCaptureDisabled("captureGitInfo: { commit: false, diff: false },")
  );
}

{
  /*
   * THE INVARIANT THE RECORD EXISTS FOR: every vendored config in the tree has been examined.
   * Asserted against the tree rather than against the record, so a vendored config arriving
   * with no entry fails here and not only inside the checker's own run.
   */
  const src = readFileSync(
    join(HERE, "assert-playwright-leaves-history-intact.mjs"),
    "utf-8"
  );
  const vendored = playwrightConfigs(ROOT).filter(isVendored);
  check(
    "there is at least one vendored config to account for",
    vendored.length > 0
  );
  for (const rel of vendored) {
    check(`  ${rel} is named in VENDORED_KNOWN`, src.includes(`"${rel}"`));
  }
}

const total = pass + fail;
console.log();
rmSync(TMP, { recursive: true, force: true });
if (total !== EXPECTED) {
  console.error(
    `FAIL: ran ${total} cases, expected ${EXPECTED} — the harness is broken.`
  );
  process.exit(1);
}
if (fail !== 0) {
  console.error(`FAIL: ${fail}/${total} cases wrong.`);
  process.exit(1);
}
console.log(
  `PASS: ${pass}/${total}. The pre-#470 config is caught, a half-fix (commit only) is caught,\n` +
    `      every playwright.config.* in the tree is accounted for and the vendored one is\n` +
    `      declared rather than silently skipped (#480),\n` +
    `      both working forms are accepted, an unrunnable probe is exit 2 rather than green,\n` +
    `      and the probe left this repository's own history intact.`
);
