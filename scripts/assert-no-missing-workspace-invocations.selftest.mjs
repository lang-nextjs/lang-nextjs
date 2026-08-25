#!/usr/bin/env node
/**
 * assert-no-missing-workspace-invocations.selftest.mjs — prove the workspace guard can fail,
 * and prove just as hard that it does NOT fire on the things it deliberately spares.
 *
 * WHY BOTH DIRECTIONS GET EQUAL WEIGHT HERE.
 *
 * This checker's history is entirely false positives. It matched a bare `--filter`, which docker
 * also uses, and flagged `--filter label=` in the open-swe sandbox spec. It counted the word
 * "open-swe" in prose and reported 135 hits. It used a 6-line guard window and flagged the very
 * has-rung guard it exists to credit. Every one of those would have been caught by a case
 * asserting the checker stays silent — and a checker that cries wolf gets deleted, which is a
 * worse outcome than one that never fires.
 *
 * So the reject cases prove it can fail, and the spare cases prove it is worth keeping.
 *
 * BASELINE ACCEPT RUNS FIRST. A guard that flags everything is indistinguishable from one that
 * flags the right things until something asserts a clean tree is passed.
 *
 * Fixtures are PLANTED. Borrowing a live violation ties the case to a defect someone may fix.
 *
 * Usage: node scripts/assert-no-missing-workspace-invocations.selftest.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SUT = join(HERE, "assert-no-missing-workspace-invocations.mjs");
const REPO = join(HERE, "..");

let pass = 0;
let fail = 0;
const ok = (what, detail = "") => {
  console.log(`  ok   ${what.padEnd(58)} ${detail}`);
  pass++;
};
const bad = (what, detail = "") => {
  console.error(`  FAIL ${what.padEnd(58)} ${detail}`);
  fail++;
};

/**
 * A throwaway git repo with the workspaces named in `wsNames` and the files in `files`.
 * Only git-TRACKED files are scanned, so everything is `git add`ed.
 */
function fixture(wsNames, files) {
  const root = mkdtempSync(join(tmpdir(), "ws-invocations-selftest-"));
  const write = (rel, body) => {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  for (const name of wsNames) {
    write(
      `packages/${name.replace(/^@[^/]+\//, "")}/package.json`,
      JSON.stringify({ name, version: "0.0.0" }, null, 2)
    );
  }
  for (const [rel, body] of Object.entries(files)) write(rel, body);
  execFileSync("git", ["init", "-q", "."], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  return root;
}

/** Run the checker over a fixture; return {code, out}. */
function run(root) {
  try {
    const out = execFileSync(process.execPath, [SUT, "--cwd", root], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (err) {
    return {
      code: err.status ?? 1,
      out: `${err.stdout ?? ""}${err.stderr ?? ""}`,
    };
  }
}

/** Build a fixture, run, assert, clean up. */
function check(what, { workspaces, files, expect, pattern, detail = "" }) {
  const root = fixture(workspaces, files);
  try {
    const r = run(root);
    const passed = expect === "accept" ? r.code === 0 : r.code !== 0;
    if (!passed) {
      bad(
        what,
        expect === "accept"
          ? `expected clean, got: ${r.out.trim().split("\n")[0]}`
          : "expected a failure, got exit 0"
      );
      return;
    }
    if (pattern && !pattern.test(r.out)) {
      bad(what, `right verdict, wrong reason: ${r.out.trim().split("\n")[0]}`);
      return;
    }
    ok(what, detail);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --- 1. BASELINE ACCEPT, first ----------------------------------------------------------------
check("a tree whose filters all resolve is ACCEPTED", {
  workspaces: ["example", "@scope/server"],
  files: {
    ".github/workflows/ci.yml": "jobs:\n  a:\n    steps:\n      - run: pnpm --filter example build\n",
    "scripts/dev.sh": "#!/bin/sh\npnpm --filter @scope/server test\n",
  },
  expect: "accept",
  detail: "(not a flag-everything guard)",
});

// --- 2. THE DEFECT IT EXISTS FOR --------------------------------------------------------------
check("an unguarded missing workspace is REJECTED", {
  workspaces: ["example"],
  files: {
    ".github/workflows/e2e.yml": "jobs:\n  a:\n    steps:\n      - run: pnpm --filter open-swe build\n",
  },
  expect: "reject",
  pattern: /invokes --filter open-swe, which is not a workspace here/,
  detail: "(and names file:line)",
});

// --- 3. THE GUARD IS CREDITED -----------------------------------------------------------------
// This is the case whose absence let a 6-line window ship: the checker flagged the very
// has-rung guard it was written to respect.
check("a has-rung-guarded invocation is SPARED", {
  workspaces: ["example"],
  files: {
    "scripts/dev.sh": [
      "#!/bin/sh",
      'if ! __rung=$(node scripts/has-rung.mjs open-swe); then',
      '  echo "cannot determine rung" >&2; exit 1',
      "fi",
      'if [ "$__rung" = "yes" ]; then',
      "  pnpm --filter open-swe build",
      "fi",
      "pnpm --filter example build",
    ].join("\n"),
  },
  expect: "accept",
  detail: "(the false positive that nearly killed it)",
});

// --- 4. A GUARD FOR A DIFFERENT WORKSPACE DOES NOT COUNT --------------------------------------
check("a guard naming ANOTHER workspace does not excuse it", {
  workspaces: ["example"],
  files: {
    "scripts/dev.sh": [
      "#!/bin/sh",
      'if ! __r=$(node scripts/has-rung.mjs deepagents); then exit 1; fi',
      "pnpm --filter open-swe build",
      "pnpm --filter example build",
    ].join("\n"),
  },
  expect: "reject",
  pattern: /--filter open-swe/,
  detail: "(the guard must name the same one)",
});

// --- 5. A GUARD TOO FAR AWAY DOES NOT COUNT ---------------------------------------------------
check("a guard beyond the 25-line window does not excuse it", {
  workspaces: ["example"],
  files: {
    "scripts/dev.sh": [
      "#!/bin/sh",
      'if ! __r=$(node scripts/has-rung.mjs open-swe); then exit 1; fi',
      ...Array.from({ length: 30 }, (_, i) => `echo padding ${i}`),
      "pnpm --filter open-swe build",
      "pnpm --filter example build",
    ].join("\n"),
  },
  expect: "reject",
  pattern: /--filter open-swe/,
  detail: "(the window is a stated limit, not a loophole)",
});

// --- 6. NOT PNPM'S --filter -------------------------------------------------------------------
// docker uses `--filter` too. Matching the flag instead of the invocation is what produced the
// open-swe sandbox-spec false positives.
check("a non-pnpm --filter is SPARED", {
  workspaces: ["example"],
  files: {
    "scripts/ps.sh": '#!/bin/sh\ndocker ps --filter name=blazing-sandbox\npnpm --filter example build\n',
  },
  expect: "accept",
  detail: "(docker's flag is not pnpm's)",
});

// --- 7. PROSE IS NOT AN INVOCATION ------------------------------------------------------------
// Counting the word rather than the invocation is what produced 135 hits.
check("a mention in a comment is SPARED", {
  workspaces: ["example"],
  files: {
    "scripts/dev.sh": "#!/bin/sh\n# pnpm --filter open-swe build   (documented, not run)\npnpm --filter example build\n",
    "scripts/note.mjs": "// pnpm --filter open-swe build\npnpm_placeholder = 1;\n",
  },
  expect: "accept",
  detail: "(prose mentions it legitimately)",
});

// --- 8. EXCLUSION FILTERS ARE NOT INVOCATIONS -------------------------------------------------
check("an exclusion filter is SPARED", {
  workspaces: ["example"],
  files: {
    "scripts/build.sh": "#!/bin/sh\npnpm --filter '!open-swe' build\npnpm --filter example build\n",
  },
  expect: "accept",
  detail: "(--filter !x excludes, it does not invoke)",
});

// --- 9. NON-VACUITY: NOTHING TO CHECK IS NOT A PASS -------------------------------------------
check("a tree with zero invocations is REJECTED", {
  workspaces: ["example"],
  files: { "scripts/dev.sh": "#!/bin/sh\necho hello\n" },
  expect: "reject",
  pattern: /zero --filter invocations — the scan is broken/,
  detail: "(a silent walk is not a clean tree)",
});

// --- 10. AND NEITHER IS A BROKEN WALK ---------------------------------------------------------
check("a tree with no workspaces at all is REJECTED", {
  workspaces: [],
  files: { "scripts/dev.sh": "#!/bin/sh\npnpm --filter example build\n" },
  expect: "reject",
  pattern: /no workspaces at all — the walk is broken/,
  detail: "(distinguished from an empty tree)",
});

// --- 11. TWO INVOCATIONS ON ONE LINE ----------------------------------------------------------
// `return` inside the per-match loop exits the whole per-LINE callback, so a resolving filter
// earlier on the line stopped the scan before reaching a missing one after it. Chained commands
// on a single `run:` line are ordinary in CI, which is exactly where this checker looks.
check("a missing workspace AFTER a resolving one is REJECTED", {
  workspaces: ["example"],
  files: {
    ".github/workflows/ci.yml":
      "jobs:\n  a:\n    steps:\n      - run: pnpm --filter example build && pnpm --filter open-swe build\n",
  },
  expect: "reject",
  pattern: /--filter open-swe/,
  detail: "(one line, two invocations)",
});

// --- 12. THE REAL REPO ------------------------------------------------------------------------
// Everything above judges planted fixtures. This asserts the checker is right about the tree it
// actually guards, so the suite is not proving a mechanism nobody runs.
{
  const r = run(REPO);
  if (r.code === 0 && /every one resolves or is guarded/.test(r.out)) {
    ok("this repo passes its own check", r.out.trim().split("\n")[0].slice(0, 40));
  } else {
    bad("real repo", r.out.trim().split("\n")[0]);
  }
}

const EXPECTED_CASES = 12;
const total = pass + fail;
console.log();
if (total !== EXPECTED_CASES) {
  console.error(
    `FAIL: ran ${total} cases, expected ${EXPECTED_CASES} — the harness is broken.`
  );
  process.exit(1);
}
if (fail > 0) {
  console.error(
    `FAIL: ${fail}/${total}. assert-no-missing-workspace-invocations.mjs is NOT trustworthy.`
  );
  process.exit(1);
}
console.log(
  `PASS: ${pass}/${total}. The guard flags unguarded invocations of absent workspaces, credits\n` +
    `      has-rung guards, and stays silent on docker flags, prose and exclusions — the three\n` +
    `      false positives that nearly got it deleted.`
);
