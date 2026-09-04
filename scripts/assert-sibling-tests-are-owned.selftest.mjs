#!/usr/bin/env node
/**
 * Self-test for assert-sibling-tests-are-owned.mjs.
 *
 * WHY BOTH DIRECTIONS, AND WHY THAT IS THE WHOLE POINT. A guard that refuses
 * everything is exactly as useless as one that refuses nothing, and the two are
 * indistinguishable from a red CI job. The real tree currently satisfies this
 * rule 53 times out of 53 — a uniform result, which means an integration test
 * alone would pass identically against a checker whose domain had silently
 * shrunk to zero. So the cases below drive the decision to all three of its
 * outcomes, and the acceptance case is as load-bearing as the rejections.
 *
 * THE RECONSTRUCTION. Case 6 is not a hypothetical. It is #709's actual defect,
 * rebuilt from the ownership state that shipped in that PR before it was fixed,
 * and it is paired with the repaired state — because a fixture that only shows
 * the red cannot tell a working checker from one that reds on everything.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";

import {
  siblingViolations,
  siblingTestsOf,
  verdict,
  describeViolation,
} from "./assert-sibling-tests-are-owned.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHECKER = join(ROOT, "scripts", "assert-sibling-tests-are-owned.mjs");

let pass = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("assert-sibling-tests-are-owned — both directions\n");

// --- 1. THE CONTROL: a clean input passes, and reports a non-zero subject -----------------
{
  const owner = new Map([
    ["a/Foo.tsx", "open-swe"],
    ["a/Foo.test.tsx", "open-swe"],
  ]);
  const tracked = new Set([...owner.keys()]);
  const { pairs, violations } = siblingViolations({ owner, tracked });
  const v = verdict({ pairs, violations, ownerSize: owner.size });
  ok(
    "THE CONTROL — a correctly-owned pair PASSES",
    v.code === 0 && pairs === 1,
    `code=${v.code} pairs=${pairs}`
  );
  ok(
    "...and the PASS names how many pairs it examined",
    /1 source\/test pair/.test(v.message),
    v.message
  );
}

// --- 2. an UNOWNED sibling fails, and the message names the row to add --------------------
{
  const owner = new Map([["a/Foo.tsx", "open-swe"]]);
  const tracked = new Set(["a/Foo.tsx", "a/Foo.test.tsx"]);
  const { pairs, violations } = siblingViolations({ owner, tracked });
  const v = verdict({ pairs, violations, ownerSize: owner.size });
  ok(
    "an UNOWNED sibling test FAILS",
    v.code === 1 && violations.length === 1,
    `code=${v.code}`
  );
  ok(
    "...the failure names the rung to add it to",
    /'open-swe'/.test(v.message)
  );
  ok(
    "...and prints the literal JSON line",
    v.message.includes('"a/Foo.test.tsx",'),
    v.message
  );
}

// --- 3. a sibling owned by ANOTHER rung is the same defect one step along -----------------
{
  const owner = new Map([
    ["a/Foo.tsx", "open-swe"],
    ["a/Foo.test.tsx", "software-developer-agent"],
  ]);
  const tracked = new Set([...owner.keys()]);
  const { violations } = siblingViolations({ owner, tracked });
  ok(
    "a CROSS-RUNG sibling FAILS",
    violations.length === 1 &&
      violations[0].testOwner === "software-developer-agent"
  );
  ok(
    "...and says which rung actually owns it",
    /owned by rung 'software-developer-agent'/.test(
      describeViolation(violations[0])
    )
  );
}

// --- 4. a test beside SHARED source is NOT this check's business --------------------------
{
  // Shared files survive every eject, so their tests may too. Without this case
  // the rule would demand ownership rows for files that must not have them.
  const owner = new Map([["a/Foo.tsx", "open-swe"]]);
  const tracked = new Set([
    "a/Foo.tsx",
    "a/Foo.test.tsx",
    "shared/Bar.ts",
    "shared/Bar.test.ts",
  ]);
  const { violations } = siblingViolations({ owner, tracked });
  ok(
    "a test beside SHARED source raises nothing",
    violations.length === 1 && violations[0].source === "a/Foo.tsx",
    `got ${violations.map((x) => x.source).join(",")}`
  );
}

// --- 5. ZERO PAIRS IS A REFUSAL, NOT A PASS ----------------------------------------------
{
  const owner = new Map([["a/Foo.tsx", "open-swe"]]);
  const tracked = new Set(["a/Foo.tsx"]); // no sibling test anywhere
  const { pairs, violations } = siblingViolations({ owner, tracked });
  const v = verdict({ pairs, violations, ownerSize: owner.size });
  ok(
    "examining NOTHING refuses (exit 2) rather than passing",
    v.code === 2,
    `code=${v.code}`
  );
  ok("...and says the question could not be asked", /REFUSED/.test(v.message));
}

// --- 6. THE RECONSTRUCTION: #709's real defect, and its repair ----------------------------
{
  // Exactly the ownership state that shipped in #709 before the fix.
  const broken = new Map([
    ["apps/open-swe/components/AgentModeBanner.tsx", "open-swe"],
  ]);
  const tracked = new Set([
    "apps/open-swe/components/AgentModeBanner.tsx",
    "apps/open-swe/components/AgentModeBanner.test.tsx",
  ]);
  const red = siblingViolations({ owner: broken, tracked });
  ok(
    "REPRODUCES #709 — the real unowned test is named",
    red.violations.length === 1 &&
      red.violations[0].test ===
        "apps/open-swe/components/AgentModeBanner.test.tsx"
  );

  // The matched half: the repair that actually landed must clear it. Without
  // this, a checker that flags every pair would pass the case above.
  const fixed = new Map(broken);
  fixed.set("apps/open-swe/components/AgentModeBanner.test.tsx", "open-swe");
  const green = siblingViolations({ owner: fixed, tracked });
  ok(
    "...and the repair that landed CLEARS it",
    green.violations.length === 0 && green.pairs === 1
  );
}

// --- 7. sibling derivation covers the extensions this repo actually uses ------------------
{
  const sibs = siblingTestsOf("a/Foo.tsx");
  ok(
    "a .tsx source derives a .test.tsx sibling",
    sibs.includes("a/Foo.test.tsx")
  );
  ok(
    "...and a .test.ts one, since both spellings occur here",
    sibs.includes("a/Foo.test.ts")
  );
}

// --- 8. THE WIRING: the real CLI, on the real tree, and on a planted red ------------------
{
  // Proves main() actually consults verdict(). A pure-function suite cannot see
  // a checker whose CLI ignores its own decision.
  let code = 0;
  let out = "";
  try {
    out = execFileSync("node", [CHECKER], { encoding: "utf8" });
  } catch (err) {
    code = err.status ?? 1;
    out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
  ok(
    "the real CLI passes on this tree",
    code === 0,
    `exit=${code} out=${out.trim().slice(0, 120)}`
  );
  ok(
    "...and names a NON-ZERO pair count",
    /[1-9]\d* source\/test pair/.test(out),
    out.trim().slice(0, 120)
  );

  // Now plant the defect in a throwaway copy of the manifest and prove the CLI
  // goes red. A guard that has never been observed failing end-to-end is a
  // guard whose failure path has never run.
  const dir = mkdtempSync(join(tmpdir(), "sibling-owned-"));
  try {
    execFileSync(
      "git",
      ["-C", ROOT, "worktree", "add", "-q", "--detach", dir, "HEAD"],
      {
        stdio: "pipe",
      }
    );
    // ASSERT THE SUBJECT EXISTS BEFORE ASKING IT ANYTHING. node exits 1 for a
    // violated property AND for a missing module, so without this the planted
    // case below passes for the wrong reason whenever the checker is not yet
    // in HEAD — which is every run before it is committed. Observed doing
    // exactly that while this file was being written.
    const inWorktree = join(
      dir,
      "scripts",
      "assert-sibling-tests-are-owned.mjs"
    );
    ok(
      "the checker is present in the fixture worktree (fixtures build from HEAD)",
      existsSync(inWorktree),
      `${inWorktree} missing — commit the checker before running this case`
    );

    const mf = join(dir, "rungs.json");
    const raw = readFileSync(mf, "utf8");
    const ROW = '    "apps/open-swe/components/AgentNarrative.test.tsx",\n';
    if (!raw.includes(ROW))
      throw new Error("fixture row not found — update the self-test");
    writeFileSync(mf, raw.replace(ROW, ""));

    let c = 0;
    let o = "";
    try {
      o = execFileSync("node", [inWorktree], {
        encoding: "utf8",
        env: { ...process.env, RUNGS_CWD: dir },
      });
    } catch (err) {
      c = err.status ?? 1;
      o = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    }
    ok(
      "a REMOVED ownership row makes the real CLI exit 1",
      c === 1,
      `exit=${c}`
    );
    ok(
      "...naming the file whose row went missing",
      o.includes("apps/open-swe/components/AgentNarrative.test.tsx"),
      o.trim().slice(0, 200)
    );
  } finally {
    try {
      execFileSync("git", ["-C", ROOT, "worktree", "remove", "--force", dir], {
        stdio: "pipe",
      });
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
}

// Summary LAST, and the exit after it — cases appended below a process.exit()
// print but never gate, and the signature of that mistake is exit 0 with FAIL
// lines above it.
console.log("");
if (failures.length > 0) {
  console.error(`FAIL: ${failures.length} of ${pass + failures.length} cases`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  `PASS: ${pass}/${pass} — the guard refuses an unowned sibling and a cross-rung one,\n` +
    `      passes a correct pair, refuses rather than passing when it examined nothing,\n` +
    `      and its CLI was observed going red end-to-end on a planted manifest.`
);
