#!/usr/bin/env node
/**
 * Proof for assert-playwright-leaves-history-intact.mjs.
 *
 * The REJECT case is a Playwright run that depth-fetches the PR base into the repo it runs in.
 * If this case ever stops failing, the checker has stopped being able to see the defect and its
 * green on the real config means nothing.
 *
 * IT USED TO BE THE PRE-#470 CONFIG, relying on Playwright's own `captureGitInfo.diff` default
 * to perform that fetch. 1.63.0 does not, so the arm built the trigger itself (#1277). The
 * pre-#470 config is still run, and what the installed release does with it is RECORDED beside
 * its version — because "upstream stopped doing the dangerous thing" and "our detector broke"
 * are indistinguishable from a green.
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
  mkdirSync,
  chmodSync,
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

/*
 * THE TRIGGER IS CONSTRUCTED HERE, NOT BORROWED FROM UPSTREAM'S DEFAULT (#1277).
 *
 * Both REJECT arms used to plant the pre-#470 config and rely on Playwright's OWN
 * `captureGitInfo.diff` default to depth-fetch the PR base. On @playwright/test 1.63.0 it no
 * longer does: `.git/shallow` is absent and the repository is not shallow, so those arms went
 * `reject -> accept` and the proof could no longer show the detector works. Measured, both
 * directions: 30/30 on 1.62.1, 2/30 wrong on 1.63.0, exactly those two arms.
 *
 * The hazard is a Playwright run leaving the workspace shallow. That is what this arm builds:
 * the config performs the same `--depth=1` fetch itself, while Playwright loads it. The fixture
 * is its own repository (`probe()` git-inits it), so the boundary lands in the fixture's
 * `.git/shallow`, and the BLAST RADIUS arm below still proves this repository is untouched.
 */
const DEPTH_FETCH = `import { defineConfig } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ev = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
execFileSync("git", ["fetch", "origin", ev.pull_request.base.sha, "--depth=1"], {
  stdio: "ignore",
});

export default defineConfig({ testDir: "./e2e" });
`;

expect(
  "a Playwright run that depth-fetches the workspace is REJECTED",
  "reject",
  DEPTH_FETCH,
  ["shallow-flagged", "PRESENT"]
);

/*
 * AND WHAT UPSTREAM ITSELF DOES, RECORDED WITH ITS VERSION RATHER THAN REQUIRED.
 *
 * WHAT THIS CAN NO LONGER CONSTRUCT, said plainly: that Playwright's OWN capture path is what
 * writes the boundary. On a release that does not fetch, no config can make it. So this arm
 * asserts only that the probe RAN and prints what the installed release did with the pre-#470
 * config. When a future release re-introduces the fetch, this line changes and #470 is worth
 * re-reading.
 *
 * AND THE OTHER LOSS, WHICH IS NOT THE SAME ONE (DEV1). The deleted arm's subject was
 * `captureGitInfo: { commit: false }` — a config that LOOKS fixed and is not, because `diff` is
 * the setting that fetches. That shape is now covered by nothing. It is unconstructible for the
 * same reason and for the same releases, but it is a SECOND uncovered case rather than a restating
 * of the first, and the banner below must not claim either.
 *
 * THE PROBE MUST BE SEEN TO HAVE RUN, NOT INFERRED FROM AN EXIT CODE (DEV1). This guarded on
 * `rc !== 2`, which assumes exit 2 is the only way not to run. It is not: a checker that dies on
 * `ERR_MODULE_NOT_FOUND` exits 1, and the arm then printed "ABSENT — upstream no longer fetches"
 * on a version that DOES fetch — a false fact about upstream, from a run where upstream never ran.
 * The report's own lines are the evidence, so the arm reads them.
 */
{
  const version = JSON.parse(
    readFileSync(
      join(ROOT, "node_modules/@playwright/test/package.json"),
      "utf8"
    )
  ).version;
  const { rc, out } = runChecker(`${BASE}});\n`);
  // The probe's own report lines. Their ABSENCE means it never got that far, whatever rc says.
  const probeReported =
    /\.git\/shallow\s*:/.test(out) && /is-shallow-repo\s*:/.test(out);
  const boundary = /PRESENT/.test(out);
  const label = `the pre-#470 config on @playwright/test ${version}: boundary ${
    boundary
      ? "PRESENT — #470's hazard still reproduces"
      : "ABSENT — upstream no longer fetches"
  }`;
  if (probeReported) {
    console.log(`  ok   ${label.padEnd(58)} (recorded)`);
    pass++;
  } else {
    console.error(
      `  FAIL the pre-#470 config on @playwright/test ${version} — the probe did not report, so ` +
        `nothing about upstream was observed (rc=${rc}); a non-2 exit is not evidence that it ran`
    );
    fail++;
  }
}

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

// 6 binary-driven cases + 10 census cases (#480) + 6 for what a probe result licenses (#1204).
// This count is the guard that caught the
// census being added without it: a suite that grows silently is a suite whose new cases nobody
// confirmed ran.
const EXPECTED = 30;
/* ─────────────────────────────────────────────────────────────────────────────────────────
 * THE CONFIG CENSUS (#480)
 *
 * The cases above vary the CONFIG and run it through the real binary. They cannot vary the
 * TREE, so the census's failure paths are not reachable through that harness — these drive the
 * exported functions directly and say so, rather than asserting less than they appear to.
 * ───────────────────────────────────────────────────────────────────────────────────────── */
const {
  playwrightConfigs,
  isVendored,
  declaresCaptureDisabled,
  vendoredCensus,
  judge,
  probe,
} = await import("./assert-playwright-leaves-history-intact.mjs");

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

console.log();
/* ── THE RECORDS MUST DESCRIBE THE TREE ───────────────────────────────────────────────────
 *
 * The discovery walk already caught a NEWLY VENDORED CONFIG before this suite grew these
 * cases — that is asserted below rather than assumed, because it is the reason the rest of
 * these are about something else. What it did not catch was a record for a config that is
 * gone, and a record whose `exposed` field was not a boolean.
 * ───────────────────────────────────────────────────────────────────────────────────────── */
{
  const K = "rungs/5-x/playwright.config.ts";
  const EXPOSED = "export default { testDir: './e2e' };";
  const DISABLED =
    "export default { captureGitInfo: { commit: false, diff: false } };";
  const run = (configs, files, known) =>
    vendoredCensus(configs, (x) => files[x] ?? null, known);

  check(
    "a vendored config recorded exposed, and exposed, is ACCEPTED",
    run([K], { [K]: EXPOSED }, { [K]: { exposed: true } }).problems.length === 0
  );
  check(
    "a NEW vendored config absent from the records is REFUSED",
    run([K], { [K]: EXPOSED }, {}).problems.some((p) =>
      /never been examined/.test(p)
    )
  );
  check(
    "a record saying exposed, for a config that now disables capture, is REFUSED",
    run([K], { [K]: DISABLED }, { [K]: { exposed: true } }).problems.some((p) =>
      /STALE RECORD/.test(p)
    )
  );
  check(
    "a record saying NOT exposed, for a config that is exposed, is REFUSED",
    run([K], { [K]: EXPOSED }, { [K]: { exposed: false } }).problems.some((p) =>
      /is recorded as NOT exposed/.test(p)
    )
  );
  check(
    "a record saying NOT exposed, for a config that disables capture, is ACCEPTED",
    run([K], { [K]: DISABLED }, { [K]: { exposed: false } }).problems.length ===
      0
  );
  /*
   * MEASURED, NOT IMAGINED. Before this change `{ exposed: false }` and a typo'd `{}` both fell
   * past the unexamined branch and past the stale branch into the else, which printed "DECLARED
   * EXPOSED — sets no captureGitInfo" about a file containing exactly that setting. The census
   * line stated a property that branch never evaluated.
   */
  check(
    "a record whose exposed field is not a boolean is REFUSED, not narrated",
    run([K], { [K]: DISABLED }, { [K]: {} }).problems.some((p) =>
      /MALFORMED RECORD/.test(p)
    )
  );
  check(
    "a record for a config no walk finds is REFUSED (an ejected rung leaves one)",
    run([], {}, { [K]: { exposed: true } }).problems.some((p) =>
      /no walk of this tree finds/.test(p)
    )
  );
  check(
    "a discovered config that cannot be READ is reported, not treated as absent",
    run([K], {}, { [K]: { exposed: true } }).problems.some((p) =>
      /could not then be read/.test(p)
    )
  );
}

rmSync(TMP, { recursive: true, force: true });

// Counted AFTER the last case, not before it. Taken early, the tally described a suite that
// had not finished running — and the count guard exists precisely to notice cases going
// missing, which it cannot do while counting only the ones that ran before it.

/* ─────────────────────────────────────────────────────────────────────────────────────────
 * WHAT A PROBE RESULT LICENSES (#1204)
 *
 * The binary-driven cases above run the REAL Playwright, which always reaches collection, so
 * they cannot show a run that did not. These do: a table through judge(), and a probe whose
 * binary is a stub that kills itself before doing anything, the reproduction from #1204,
 * where that run printed the real PASS.
 * ───────────────────────────────────────────────────────────────────────────────────────── */
console.log(
  "\nassert-playwright-leaves-history-intact — WHAT A PROBE LICENSES (#1204)\n"
);
{
  const has = typeof judge === "function";
  const v = (r) => (has ? judge(r).verdict : "judge() is not exported");
  const base = { ran: true, shallowPresent: false, playwrightSignal: null };
  check(
    "a Playwright ended by a SIGNAL is could-not-compute, not a clean run",
    v({
      ...base,
      playwrightExit: null,
      playwrightSignal: "SIGKILL",
      playwrightOutput: "",
    }) === "refuse",
    v({ ...base, playwrightExit: null, playwrightSignal: "SIGKILL" })
  );
  check(
    '  ...and so is an exit 1 that never printed "No tests found"',
    v({
      ...base,
      playwrightExit: 1,
      playwrightOutput: "Error: config failed to load",
    }) === "refuse",
    v({
      ...base,
      playwrightExit: 1,
      playwrightOutput: "Error: config failed to load",
    })
  );
  check(
    '  ...while exit 1 WITH "No tests found" and no boundary is the pass',
    v({
      ...base,
      playwrightExit: 1,
      playwrightOutput: "Error: No tests found",
    }) === "pass",
    v({ ...base, playwrightExit: 1, playwrightOutput: "Error: No tests found" })
  );
  check(
    "  ...and a shallow boundary is a FAILURE whatever else happened",
    v({
      ...base,
      shallowPresent: true,
      playwrightExit: null,
      playwrightSignal: "SIGKILL",
    }) === "fail",
    v({
      ...base,
      shallowPresent: true,
      playwrightExit: null,
      playwrightSignal: "SIGKILL",
    })
  );

  // The reproduction: a root whose playwright binary kills itself before doing anything.
  const root = mkdtempSync(join(tmpdir(), "pw-hist-killed-"));
  try {
    const g = (...a) => execFileSync("git", a, { cwd: root, stdio: "ignore" });
    g("init", "--quiet");
    g("config", "user.email", "probe@example.invalid");
    g("config", "user.name", "probe");
    writeFileSync(join(root, "seed.txt"), "seed\n");
    g("add", "seed.txt");
    g("commit", "--quiet", "-m", "seed");
    mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
    const bin = join(root, "node_modules", ".bin", "playwright");
    writeFileSync(bin, "#!/bin/sh\nkill -9 $$\n");
    chmodSync(bin, 0o755);
    const cfg = join(root, "playwright.config.ts");
    writeFileSync(cfg, BASE + "});\n");
    const r = probe({ root, configPath: cfg });
    check(
      "a probe whose Playwright was SIGKILLed records the signal instead of an exit code",
      r.ran === true &&
        r.playwrightSignal === "SIGKILL" &&
        r.playwrightExit === null,
      JSON.stringify({
        ran: r.ran,
        signal: r.playwrightSignal,
        exit: r.playwrightExit,
      })
    );
    check(
      "  ...and that probe is could-not-compute, where it used to print the real run's PASS",
      v(r) === "refuse",
      v(r)
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/*
 * THE COUNT GUARD RUNS AT EXIT, NOT IN LINE (#836).
 *
 * It used to sit here as a plain `if`, so it ran at THIS POINT in the file and saw
 * only the cases above it. Both occurrences of the defect were created by appending a
 * case at the END of the file — which is after the guard, because the guard IS the
 * summary block at the end. The count then matched the cases the guard could see and
 * the suite reported "PASS: 14/8".
 *
 * Comparing the tally at the guard rather than via a hoisted binding does NOT fix
 * that: a case appended below the guard still runs after it. Only a hook firing at
 * EXIT sees everything, because nothing can be appended past process exit.
 *
 * `code === 0` MATTERS: without it this overwrites the exit code of a run that already
 * failed for a real reason, turning a genuine defect into a count complaint.
 */
process.on("exit", (code) => {
  const ran = pass + fail;
  if (code === 0 && ran !== EXPECTED) {
    console.error(
      `FAIL: ran ${ran} cases, expected ${EXPECTED} — the harness is broken.`
    );
    process.exitCode = 1;
  }
});
// Counted HERE, after every case, so the banner cannot report fewer than ran (#1204).
const total = pass + fail;
if (fail !== 0) {
  console.error(`FAIL: ${fail}/${total} cases wrong.`);
  process.exit(1);
}
console.log(
  `PASS: ${pass}/${total}. A Playwright run that depth-fetches the workspace is caught,\n` +
    `      every playwright.config.* in the tree is accounted for and the vendored one is\n` +
    `      declared rather than silently skipped (#480),\n` +
    `      both working forms are accepted, an unrunnable probe is exit 2 rather than green,\n` +
    `      and the probe left this repository's own history intact.\n` +
    `      The records are held to the tree in both directions: a record that no longer\n` +
    `      describes its config, a record for a config that is gone, and a record whose\n` +
    `      claim is not a boolean are each refused rather than narrated as a declaration.\n` +
    `      NOT CLAIMED HERE, AND THE BANNER USED TO CLAIM BOTH (#1277): that Playwright's OWN\n` +
    `      capture default writes the boundary, and that a half-fix (\`commit: false\` alone, with\n` +
    `      \`diff\` left at its default) is caught. Neither is constructible on a release that does\n` +
    `      not fetch; what the installed release does is RECORDED above, not asserted.`
);
