#!/usr/bin/env node
/**
 * PROOF for check-pr-triggers.mjs — by mutation, per #116.
 *
 * Each case DECLARES its expected verdict and the harness holds it to that.
 * That is DEV2's framing, and it is the one property that survived tonight's
 * survey: a case declares its expected verdict, and a mutation that cannot
 * have moved the verdict has proven nothing.
 *
 * Mutating cases additionally assert the fixture ACTUALLY CHANGED, per
 * ARCHITECT's ruling — `mutated == original` is VOID, not SURVIVED and not
 * PASSED. classify.selftest had a mutation rot into a no-op and then ACCUSE a
 * working checker of being untrustworthy; the guard is cheap and that failure
 * mode is not.
 *
 * The two ACCEPT cases are load-bearing rather than decorative: without them a
 * checker that refuses everything scores full marks.
 */
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECKER = join(ROOT, "scripts", "check-pr-triggers.mjs");

let pass = 0;
let fail = 0;

const CLEAN = [
  "on:",
  "  pull_request:",
  "  push:",
  "    branches: [main]",
  "",
  "jobs:",
  "  a:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: echo hi",
  "",
].join("\n");

/** Fingerprint names AND contents, so a deletion counts as a change. */
function fingerprint(dir) {
  // JSON, not a delimiter-joined string. An earlier version separated fields
  // with literal control bytes, which made git classify this file as BINARY —
  // the diff was unreviewable, and `grep` returned nothing with exit 1 rather
  // than an error. A proof that adjudicates whether CI runs at all had landed
  // invisible to both code review and every mechanism survey that greps for it.
  // JSON has no separator to collide with and stays plain text.
  return JSON.stringify(
    readdirSync(dir)
      .sort()
      .map((f) => [f, readFileSync(join(dir, f), "utf8")])
  );
}

function run(dir) {
  try {
    const out = execFileSync(process.execPath, [CHECKER], {
      env: { ...process.env, PR_TRIGGERS_DIR: dir },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { rc: 0, out };
  } catch (e) {
    return { rc: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

/**
 * @param want "reject" | "accept" — declared up front, not inferred from what
 *             happened. A case that decides afterwards what it meant to prove
 *             cannot fail.
 */
function testCase(name, want, mutate, { mutates = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), "prtrig-"));
  const wf = join(base, ".github", "workflows");
  mkdirSync(wf, { recursive: true });
  writeFileSync(join(wf, "ci.yml"), CLEAN);
  writeFileSync(join(wf, "e2e.yml"), CLEAN);

  const before = fingerprint(wf);
  mutate(wf);
  const after = fingerprint(wf);

  if (mutates && before === after) {
    console.error(
      "  VOID " +
        name.padEnd(52) +
        " MUTATION CHANGED NOTHING — the checker is not implicated"
    );
    fail++;
    rmSync(base, { recursive: true, force: true });
    return;
  }

  const { rc, out } = run(base);
  const got = rc === 0 ? "accept" : "reject";
  if (got === want) {
    console.log("  ok   " + name.padEnd(52) + " (" + want + "ed, as declared)");
    pass++;
  } else {
    console.error(
      "  FAIL " + name.padEnd(52) + " wanted " + want + ", got " + got
    );
    const line =
      out
        .split("\n")
        .find((l) => l.startsWith("FAIL") || l.startsWith("PASS")) ??
      out.slice(0, 160);
    console.error("       " + line);
    fail++;
  }
  rmSync(base, { recursive: true, force: true });
}

console.log(
  "check-pr-triggers.mjs self-test — proving it can fail, by mutation\n"
);

testCase("a base-branch filter is rejected", "reject", (wf) => {
  writeFileSync(
    join(wf, "ci.yml"),
    CLEAN.replace(
      "  pull_request:\n",
      "  pull_request:\n    branches: [main]\n"
    )
  );
});

testCase("the exact historical form is rejected", "reject", (wf) => {
  // The literal string under which #130 reached main with zero CI.
  writeFileSync(
    join(wf, "e2e.yml"),
    CLEAN.replace(
      "  pull_request:\n",
      "  pull_request:\n    branches: [main, feat/ai-backend-matrix]\n"
    )
  );
});

testCase(
  "no workflows at all is a broken probe, not a pass",
  "reject",
  (wf) => {
    for (const f of readdirSync(wf)) rmSync(join(wf, f));
  }
);

testCase(
  "workflows with no pull_request trigger is rejected",
  "reject",
  (wf) => {
    for (const f of readdirSync(wf)) {
      writeFileSync(join(wf, f), CLEAN.replace("  pull_request:\n", ""));
    }
  }
);

/*
 * THE PATHS HALF (#380). Same silence, one field over: a PR whose diff matches
 * none of the globs runs nothing from that workflow, and no checks section reads
 * as fine.
 */
testCase("a pull_request paths filter is rejected", "reject", (wf) => {
  // The literal filter cross-version.yml carried while four merged PRs edited
  // root package.json and ran ZERO of its seven contexts.
  writeFileSync(
    join(wf, "ci.yml"),
    CLEAN.replace(
      "  pull_request:\n",
      '  pull_request:\n    paths:\n      - "packages/**"\n      - "apps/**"\n      - "pnpm-lock.yaml"\n'
    )
  );
});

testCase("paths-ignore is rejected too", "reject", (wf) => {
  // Inverting the list fixes the under-enumeration — an unlisted path now RUNS
  // the job — but not the requirability half: a PR touching only ignored files
  // still skips, so a required check never reports and blocks the PR forever.
  writeFileSync(
    join(wf, "e2e.yml"),
    CLEAN.replace(
      "  pull_request:\n",
      '  pull_request:\n    paths-ignore:\n      - "**/*.md"\n'
    )
  );
});

testCase("a push paths filter is NOT flagged", "accept", (wf) => {
  // Deliberately out of scope, for the same reason push.branches is: it answers
  // "which pushes deserve a build", and a push that skips is not a review that
  // silently reported nothing. cross-version.yml drops its push filter too, but
  // as a judgement about main deserving verification — not because this rule
  // demands it, and this case is what keeps the rule from quietly growing.
  writeFileSync(
    join(wf, "ci.yml"),
    CLEAN.replace(
      "  push:\n    branches: [main]\n",
      '  push:\n    branches: [main]\n    paths:\n      - "src/**"\n'
    )
  );
});

testCase("a push base filter is NOT flagged", "accept", (wf) => {
  // push.branches answers "which branches deserve a build", a different
  // question. A checker that caught it would be over-firing, and friction with
  // no signal is exactly what gets a check rubber-stamped.
  writeFileSync(
    join(wf, "ci.yml"),
    CLEAN.replace("branches: [main]", "branches: [main, release]")
  );
});

testCase("the clean fixture is accepted", "accept", () => {}, {
  mutates: false,
});

// The REAL tree must pass, or this proves nothing about what we ship.
const real = run(ROOT);
if (real.rc === 0) {
  console.log(
    "  ok   " +
      "the real .github/workflows".padEnd(52) +
      " (exit 0, correctly accepted)"
  );
  pass++;
} else {
  console.error(
    "  FAIL " +
      "the real .github/workflows".padEnd(52) +
      " expected 0, got " +
      real.rc
  );
  console.error("       " + real.out.slice(0, 200));
  fail++;
}

console.log();
if (fail > 0) {
  console.error(
    "FAIL: " +
      fail +
      "/" +
      (pass + fail) +
      " cases failed. check-pr-triggers.mjs is NOT trustworthy."
  );
  process.exit(1);
}
console.log(
  "PASS: " +
    pass +
    "/" +
    pass +
    " — every gate watched failing on a deliberate mutation,\n" +
    "      and both the clean fixture and the real tree still pass."
);
