#!/usr/bin/env node
/**
 * assert-checker-proof-pairing.selftest.mjs — the gate that requires proofs, proved.
 *
 * There is no way to write this file without noticing what it is. A gate asserting "every checker
 * must be observed to fail" and shipping unobserved would be its own counterexample, and it would
 * be the fourth checker tonight to do that. So it goes first, not last.
 *
 * THE DISTINCTION CASE 3 EXISTS FOR, which is the whole reason this gate is not a file-existence
 * check. `<stem>.selftest.mjs` sitting in `scripts/` proves nothing: a proof no workflow invokes
 * is a file. It looks fixed in a directory listing, it looks fixed in a PR diff, and it never
 * runs. Case 3 plants exactly that and requires the gate to say so IN THOSE WORDS, because
 * "unproven" and "proof present but never invoked" send a maintainer to different places.
 *
 * BOTH ALLOWLISTS GET A STALENESS CASE (7 and 8). An allowlist that cannot rot is the only kind
 * worth having, and this repo has three others carrying the same obligation. An entry that has
 * been fixed must FAIL and say to delete it, or the record silently becomes a permanent excuse.
 *
 * Fixtures are planted whole — a throwaway tree with its own package.json, workflows and scripts.
 * Nothing here reads the real repo except case 12, which is deliberate: everything else must be
 * true of trees this repo has never had.
 *
 * Usage: node scripts/assert-checker-proof-pairing.selftest.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPairing } from "./assert-checker-proof-pairing.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
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
 * Build a throwaway tree.
 *   scripts  — filenames to create under scripts/ (content is irrelevant; only names are read)
 *   workflows— { "ci.yml": "<yaml body>" }
 *   pkg      — package.json "scripts" map
 */
function fixture({ scripts = [], workflows = {}, pkg = {}, checks = null, ran = null }) {
  const root = mkdtempSync(join(tmpdir(), "pairing-selftest-"));
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  for (const f of scripts) writeFileSync(join(root, "scripts", f), "// fixture\n");
  for (const [name, body] of Object.entries(workflows)) {
    writeFileSync(join(root, ".github", "workflows", name), body);
  }
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "fixture", scripts: pkg }, null, 2)
  );
  // The declared list and the run record, for the cases about what the record MEANS.
  if (checks) writeFileSync(join(root, "scripts", "checks.json"), JSON.stringify({ checks }, null, 2));
  if (ran) writeFileSync(join(root, ".checks-run.json"), JSON.stringify({ ran }, null, 2));
  return root;
}

const step = (cmd) => `jobs:\n  a:\n    steps:\n      - run: ${cmd}\n`;

/**
 * Run the gate over a fixture and assert.
 *
 * BOTH ALLOWLISTS DEFAULT TO EMPTY HERE, and that is not tidiness. `checkPairing`'s defaults are
 * the real repo's allowlists; a fixture that varies the root but inherits them is judged against
 * entries describing a different tree, and the anti-rot rule correctly reports every one of them
 * stale. Varying the subject means varying ALL of it — the same lesson as classify()'s
 * module-level manifest and the generator that read one tree while writing another. A
 * half-injected subject is the bug those two were, wearing a test's clothes.
 */
function check(what, { tree, opts = {}, expect, pattern, detail = "" }) {
  const root = fixture(tree);
  try {
    const { problems, stale } = checkPairing(root, {
      minCheckers: 1,
      unproven: [],
      crossWorkflow: [],
      ...opts,
    });
    const all = [...problems, ...stale];
    if (expect === "accept") {
      if (all.length === 0) ok(what, detail);
      else bad(what, `expected clean, got: ${all[0]}`);
      return;
    }
    if (all.length === 0) {
      bad(what, "expected a complaint, got none");
      return;
    }
    if (pattern && !all.some((m) => pattern.test(m))) {
      bad(what, `right verdict, wrong reason: ${all[0]}`);
      return;
    }
    ok(what, detail);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --- 1. BASELINE ACCEPT, first, or every rejection below proves nothing ------------------------
check("a properly paired tree is ACCEPTED", {
  tree: {
    scripts: ["a.mjs", "a.selftest.mjs"],
    workflows: {
      "ci.yml": step("node scripts/a.selftest.mjs") + step("node scripts/a.mjs"),
    },
  },
  expect: "accept",
  detail: "(not a complain-always gate)",
});

// --- 2. THE ORIGINAL GAP ----------------------------------------------------------------------
check("a checker with no proof is REJECTED", {
  tree: {
    scripts: ["a.mjs"],
    workflows: { "ci.yml": step("node scripts/a.mjs") },
  },
  expect: "reject",
  pattern: /no can-it-fail proof/,
  detail: "(and says to add one)",
});

// --- 3. A PROOF NOTHING RUNS IS A FILE, NOT A CHECK --------------------------------------------
// The case that makes this a pairing gate rather than a file-existence check. The selftest is on
// disk — a directory listing and a PR diff both look correct — and no workflow invokes it.
check("a proof that exists but is never invoked is REJECTED", {
  tree: {
    scripts: ["a.mjs", "a.selftest.mjs"],
    workflows: { "ci.yml": step("node scripts/a.mjs") },
  },
  expect: "reject",
  pattern: /selftest file exists but NO WORKFLOW INVOKES IT/,
  detail: "(distinct message from 'no proof')",
});

// --- 4. SAME WORKFLOW, NOT MERELY SOMEWHERE ----------------------------------------------------
check("a proof in another workflow is REJECTED", {
  tree: {
    scripts: ["a.mjs", "a.selftest.mjs"],
    workflows: {
      "ci.yml": step("node scripts/a.selftest.mjs"),
      "other.yml": step("node scripts/a.mjs"),
    },
  },
  expect: "reject",
  pattern: /other\.yml would go green over an unproven checker/,
  detail: "(workflows fire independently)",
});

// --- 5 & 6. THE ALLOWLISTS WORK ----------------------------------------------------------------
check("an allowlisted cross-workflow pair is ACCEPTED", {
  tree: {
    scripts: ["a.mjs", "a.selftest.mjs"],
    workflows: {
      "ci.yml": step("node scripts/a.selftest.mjs"),
      "other.yml": step("node scripts/a.mjs"),
    },
  },
  opts: { crossWorkflow: [{ checker: "scripts/a.mjs", why: "recorded" }] },
  expect: "accept",
  detail: "(recorded, not blessed)",
});

check("an allowlisted unproven checker is ACCEPTED", {
  tree: {
    scripts: ["a.mjs"],
    workflows: { "ci.yml": step("node scripts/a.mjs") },
  },
  opts: { unproven: [{ checker: "scripts/a.mjs", why: "recorded" }] },
  expect: "accept",
  detail: "(so the gate can be turned on today)",
});

// --- 7 & 8. AND THEY DECAY LOUDLY --------------------------------------------------------------
// An allowlist nobody revisits is how a temporary suppression becomes permanent. Both entries
// must FAIL once the thing they excuse has been fixed.
check("a stale KNOWN_UNPROVEN entry is REJECTED", {
  tree: {
    scripts: ["a.mjs", "a.selftest.mjs"],
    workflows: {
      "ci.yml": step("node scripts/a.selftest.mjs") + step("node scripts/a.mjs"),
    },
  },
  opts: { unproven: [{ checker: "scripts/a.mjs", why: "fixed since" }] },
  expect: "reject",
  pattern: /KNOWN_UNPROVEN names scripts\/a\.mjs, which now HAS a proof/,
  detail: "(delete the entry)",
});

check("a stale KNOWN_CROSS_WORKFLOW entry is REJECTED", {
  tree: {
    scripts: ["a.mjs", "a.selftest.mjs"],
    workflows: {
      "ci.yml": step("node scripts/a.selftest.mjs") + step("node scripts/a.mjs"),
    },
  },
  opts: { crossWorkflow: [{ checker: "scripts/a.mjs", why: "moved since" }] },
  expect: "reject",
  pattern: /KNOWN_CROSS_WORKFLOW names scripts\/a\.mjs/,
  detail: "(delete the entry)",
});

// --- 9. A PROOF INVOKED THROUGH A pnpm SCRIPT COUNTS -------------------------------------------
// Most proofs in this repo are invoked as `pnpm test:x`, not by path. A gate that only understood
// paths would report every one of them missing.
check("a proof invoked via a pnpm script is found", {
  tree: {
    scripts: ["a.mjs", "a.selftest.mjs"],
    workflows: { "ci.yml": step("pnpm test:a") + step("pnpm check:a") },
    pkg: { "test:a": "node scripts/a.selftest.mjs", "check:a": "node scripts/a.mjs" },
  },
  expect: "accept",
  detail: "(pnpm indirection resolved)",
});

// --- 10. A DOCUMENTED INVOCATION IS NOT AN INVOCATION ------------------------------------------
// ci.yml really does carry a comment naming a script inside the step that removed it. Counting
// that would make the gate demand a proof for something no workflow runs.
check("a checker named only in a YAML comment is not counted", {
  tree: {
    scripts: ["a.mjs", "a.selftest.mjs", "ghost.mjs"],
    workflows: {
      "ci.yml":
        "# node scripts/ghost.mjs — removed, named here on purpose\n" +
        step("node scripts/a.selftest.mjs") +
        step("node scripts/a.mjs"),
    },
  },
  expect: "accept",
  detail: "(prose is not an invocation)",
});

// --- 11. NON-VACUITY --------------------------------------------------------------------------
// Note this case does NOT pass minCheckers: 1 — it is the one asserting the real floor.
check("a tree with almost no checkers is REJECTED", {
  tree: {
    scripts: ["a.mjs", "a.selftest.mjs"],
    workflows: {
      "ci.yml": step("node scripts/a.selftest.mjs") + step("node scripts/a.mjs"),
    },
  },
  opts: { minCheckers: undefined },
  expect: "reject",
  pattern: /the scan is broken/,
  detail: "(a tiny tree is a broken walk)",
});

/* --- 12/13. A SKIPPED ENTRY IS NOT AN INVOCATION (#404) --------------------------------------
 *
 * run-checks.mjs records a third status. This file used to map every record entry to its script
 * and add all of them to the invoked set, so a checker that reported NOTHING was counted as
 * invoked and inflated the number in this gate's own PASS line — the exact confusion the record
 * exists to prevent, one layer down and silent.
 *
 * The pair below is the point: a skipped checker must not be counted, and must still not be a
 * HOLE (its absence is declared and recorded with a reason), while a checker missing from the
 * record ENTIRELY must still be a hole. Only asserting the first would be satisfied by
 * hole-detection having been switched off.
 */
const CHECKS_TWO = [
  { name: "ran", proof: "scripts/a.selftest.mjs", checker: "scripts/a.mjs", why: "x" },
  {
    name: "gated",
    proof: "scripts/b.selftest.mjs",
    checker: "scripts/b.mjs",
    needs: "repo-settings",
    why: "x",
  },
];
const TREE_TWO = {
  scripts: ["a.mjs", "a.selftest.mjs", "b.mjs", "b.selftest.mjs"],
  // Deliberately invokes no checker by name: these two cases are about what the RECORD
  // means, so every script in the invoked set must arrive from the record and nowhere else.
  workflows: { "ci.yml": step("echo the declared list") },
  checks: CHECKS_TWO,
};
const P = (script, name) => ({ name, phase: "x", script, status: "pass", exit: 0, ms: 1 });

{
  const root = fixture({
    ...TREE_TWO,
    ran: [
      P("scripts/a.selftest.mjs", "ran"),
      P("scripts/a.mjs", "ran"),
      P("scripts/b.selftest.mjs", "gated"),
      {
        name: "gated",
        phase: "checker",
        script: "scripts/b.mjs",
        status: "skipped",
        channel: "repo-settings",
        because: "no credential here",
        exit: null,
        ms: 0,
      },
    ],
  });
  const { problems, stale, stats } = checkPairing(root, {
    minCheckers: 1,
    crossWorkflow: [],
    unproven: [],
  });
  const counted = problems.length === 0 && stale.length === 0;
  if (counted && stats.checkers === 1 && stats.notMeasured.length === 1) {
    ok("a SKIPPED checker is not a hole and is not counted as invoked", "(1 checker, 1 not measured)");
  } else {
    bad(
      "skipped-not-invoked",
      `problems=${problems.length} checkers=${stats?.checkers} notMeasured=${stats?.notMeasured?.length}`
    );
  }
  if (stats?.notMeasured?.[0]?.includes("gated") && stats.notMeasured[0].includes("repo-settings")) {
    ok("...and it is NAMED with the channel it needed", "(not silently dropped)");
  } else {
    bad("skipped-named", stats?.notMeasured?.[0] ?? "nothing reported");
  }
}

{
  // The companion. Absent from the record entirely — not skipped, just never executed — is
  // still a HOLE. Without this, "stop reporting holes" would satisfy the case above.
  const root = fixture({
    ...TREE_TWO,
    ran: [P("scripts/a.selftest.mjs", "ran"), P("scripts/a.mjs", "ran")],
  });
  const { problems } = checkPairing(root, { minCheckers: 1, crossWorkflow: [], unproven: [] });
  if (problems.some((p) => /scripts\/b\.mjs.*declared and not executed/.test(p))) {
    ok("a checker ABSENT from the record is still a HOLE", "(hole detection intact)");
  } else {
    bad("absent-is-hole", problems[0] ?? "no problem reported");
  }
}

// --- 14. AND THE REAL REPO --------------------------------------------------------------------
{
  const { problems, stale, stats } = checkPairing(REPO);
  if (problems.length === 0 && stale.length === 0 && stats.checkers >= 10) {
    ok("this repo satisfies its own pairing rules", `(${stats.checkers} checkers)`);
  } else {
    bad("real repo", [...problems, ...stale][0] ?? `only ${stats?.checkers} checkers`);
  }
}

const EXPECTED_CASES = 15;
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
    `FAIL: ${fail}/${total}. assert-checker-proof-pairing.mjs is NOT trustworthy.`
  );
  process.exit(1);
}
console.log(
  `PASS: ${pass}/${total}. The gate distinguishes "no proof" from "a proof nothing runs",\n` +
    `      requires the proof in the checker's own workflow, and both allowlists fail when the\n` +
    `      thing they excuse has been fixed.`
);
