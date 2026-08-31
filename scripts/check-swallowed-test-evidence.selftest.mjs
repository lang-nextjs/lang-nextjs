#!/usr/bin/env node
/**
 * Prove check-swallowed-test-evidence can fail, and that it stays silent where
 * it should (#456).
 *
 * THIS CHECKER FOUND ZERO ON THE REAL TREE, WHICH IS WHY THE CALIBRATION IS THE
 * POINT. A sweep reporting "0 found" is indistinguishable from a sweep that
 * searched wrong — the same non-falsifiable PASS the issue is about, one level
 * up. So case 1 plants a real instance and requires it to be found, and cases
 * 2-4 and 9 plant the four shapes that ALREADY EXIST in this repo and must not
 * be flagged. Without those, a checker that reported every line containing the
 * word "console" would score full marks against case 1 alone.
 *
 * PLANT, DON'T BORROW. Every fixture is written into a temp dir. The four
 * false-positive shapes are copied in spirit from real files (handler.test.ts,
 * debug.test.ts, useRunStream.test.ts, rate-limit-poll.spec.ts) but not read
 * from them: a selftest that borrows goes green the day someone edits the file
 * it borrowed from, and it would then be measuring nothing.
 *
 * CASE 8 IS THE ONE THAT MAKES THE REST MEAN ANYTHING. A checker pointed at a
 * tree with no test files reports "no console calls" and exits 0 — clean, and
 * about nothing. It must REFUSE instead. Neither a flag-everything checker nor
 * a find-nothing checker is caught by that case, and it is not caught by any
 * other case here.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { check } from "./check-swallowed-test-evidence.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECKER = path.join(HERE, "check-swallowed-test-evidence.mjs");

let pass = 0,
  fail = 0;

function sandbox(files) {
  const root = mkdtempSync(path.join(tmpdir(), "swallowed-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

async function expectFindings(name, files, wanted) {
  const root = sandbox(files);
  try {
    const { findings } = await check({ cwd: root });
    const got = findings
      .map((f) => `${path.basename(f.file)}:${f.line}`)
      .sort();
    const ok = JSON.stringify(got) === JSON.stringify(wanted.sort());
    if (ok) {
      pass++;
      console.log(`  ok   ${name} -> [${got.join(", ")}]`);
    } else {
      fail++;
      console.error(
        `  FAIL ${name}\n       expected [${wanted.join(
          ", "
        )}]\n       got      [${got.join(", ")}]`
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Run the CLI so the EXIT CODE is under test, not just the exported function. */
function runCli(root) {
  try {
    const stdout = execFileSync(process.execPath, [CHECKER], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.status, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function expectExit(name, files, wantedCode, mustMention) {
  const root = sandbox(files);
  try {
    const { code, out } = runCli(root);
    const ok =
      code === wantedCode && (!mustMention || out.includes(mustMention));
    if (ok) {
      pass++;
      console.log(`  ok   ${name} -> exit ${code}`);
    } else {
      fail++;
      console.error(
        `  FAIL ${name}\n       expected exit ${wantedCode}${
          mustMention ? ` mentioning "${mustMention}"` : ""
        }\n       got exit ${code}: ${out.trim().slice(0, 200)}`
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const P = "packages/thing/src";

console.log("check-swallowed-test-evidence selftest");

// 1. THE CALIBRATION. A real success-path evidence line must be found.
await expectFindings(
  "1 finds a real console.log on the success path",
  {
    [`${P}/a.test.ts`]: `import { it, expect } from "vitest";
it("prints its subject", () => {
  console.log("examined 4 axes");
  expect(1).toBe(1);
});
`,
  },
  ["a.test.ts:3"]
);

// 2-4, 9. The four shapes that already exist in this tree and are NOT defects.
await expectFindings(
  "2 ignores console in a line and a block comment",
  {
    [`${P}/b.test.ts`]: `import { it } from "vitest";
// the hook's catch swallows the error and console.errors
/* console.log("in a block comment"); */
it("x", () => {});
`,
  },
  []
);

await expectFindings(
  "3 ignores console named inside a test title",
  {
    [`${P}/c.test.ts`]: `import { it } from "vitest";
it("calls console.error when DEBUG is set", () => {});
`,
  },
  []
);

await expectFindings(
  "4 ignores vi.spyOn(console, ...) — a call ABOUT console, not ON it",
  {
    [`${P}/d.test.ts`]: `import { it, vi, expect } from "vitest";
it("spies", () => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(spy).toBeDefined();
});
`,
  },
  []
);

await expectFindings(
  "9 does not punish process.stdout.write — the correct pattern",
  {
    [`${P}/i.test.ts`]: `import { it } from "vitest";
it("prints visibly", () => {
  process.stdout.write("examined 4 axes\\n");
});
`,
  },
  []
);

// 5. THE REGRESSION. A regex containing an apostrophe defeated the hand-written
//    stripper this replaced: it opened a string that swallowed the rest of the
//    file, and a real call went unreported. Measured before the rewrite.
await expectFindings(
  "5 finds a call after a regex literal containing a quote",
  {
    [`${P}/e.test.ts`]: `import { it, expect } from "vitest";
it("regex", () => {
  const re = /it's a trap/;
  console.log("REAL");
  expect(re).toBeTruthy();
});
`,
  },
  ["e.test.ts:4"]
);

// 6-7. The escape hatch, and its price.
await expectFindings(
  "6 honours // swallowed-ok with a reason",
  {
    [`${P}/f.test.ts`]: `import { it } from "vitest";
it("diagnoses a failure", () => {
  // swallowed-ok: failure-path diagnostics, visible because the test fails
  console.error("upstream said", 500);
  throw new Error("boom");
});
`,
  },
  []
);

await expectFindings(
  "7 still reports a bare // swallowed-ok with no reason",
  {
    [`${P}/g.test.ts`]: `import { it } from "vitest";
it("silenced without saying why", () => {
  // swallowed-ok:
  console.log("evidence nobody will see");
});
`,
  },
  ["g.test.ts:4"]
);

// 8. THE ONE THAT MAKES THE OTHERS MEAN ANYTHING.
expectExit(
  "8 REFUSES a tree with no test files rather than reporting it clean",
  { "packages/thing/src/not-a-test.ts": "export const x = 1;\n" },
  2,
  "REFUSING"
);

// And the two exit codes a CI step actually reads.
expectExit(
  "10 exits 1 and names the file when it finds one",
  {
    [`${P}/h.test.ts`]: `import { it } from "vitest";
it("x", () => {
  console.log("evidence");
});
`,
  },
  1,
  "h.test.ts:3"
);

expectExit(
  "11 exits 0 and names its subject on a clean tree",
  { [`${P}/j.test.ts`]: `import { it } from "vitest";\nit("x", () => {});\n` },
  0,
  "1 vitest test files"
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
