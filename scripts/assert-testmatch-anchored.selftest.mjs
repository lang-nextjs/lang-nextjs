#!/usr/bin/env node
/**
 * Proof for assert-testmatch-anchored.mjs.
 *
 * EVERY CASE ASSERTS WHICH COMPLAINT APPEARED, not merely that the exit code was non-zero. A
 * planted config trips more than one rule at a time — an unanchored pattern is also, usually, a
 * pattern that matches the wrong things — and an exit code cannot attribute a failure. A
 * selftest that only read the status would go green having never exercised the rule it names.
 *
 * Usage: node scripts/assert-testmatch-anchored.selftest.mjs
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const CHECKER = join(dirname(fileURLToPath(import.meta.url)), "assert-testmatch-anchored.mjs");
const TMP = mkdtempSync(join(tmpdir(), "anchor-"));
let pass = 0, fail = 0;

const config = (body) => `import { defineConfig } from "@playwright/test";
export default defineConfig({ projects: [ ${body} ] });`;

function run(text) {
  const f = join(TMP, `c-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(f, text);
  try {
    return { rc: 0, out: execFileSync("node", [CHECKER, "--config", f], { encoding: "utf8" }) };
  } catch (e) {
    return { rc: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

function expect(label, want, text, mustSay = []) {
  const { rc, out } = run(text);
  const got = rc === 0 ? "accept" : rc === 2 ? "refuse" : "reject";
  const said = mustSay.every((s) => out.includes(s));
  if (got === want && said) { console.log(`  ok   ${label.padEnd(58)} (${want})`); pass++; }
  else {
    console.error(`  FAIL ${label} — wanted ${want}, got ${got} (rc=${rc}), named=${said}`);
    console.error(out.split("\n").map((l) => "         " + l).join("\n"));
    fail++;
  }
}

console.log("\nassert-testmatch-anchored — REJECT\n");

// The exact pre-#475 form that gave chromium an open-swe spec.
expect("unanchored at both ends (the #473 form)", "reject",
  config(`{ name: "a", testMatch: /accessibility\\.spec\\.ts/ }`),
  ["UNANCHORED at the start and end", "accessibility"]);

expect("anchored at the end only — a prefix can still be absorbed", "reject",
  config(`{ name: "a", testMatch: /accessibility\\.spec\\.ts$/ }`),
  ["UNANCHORED at the start"]);

expect("anchored at the start only — a suffix can still be absorbed", "reject",
  config(`{ name: "a", testMatch: /(^|\\/)accessibility\\.spec\\.ts/ }`),
  ["UNANCHORED at the end"]);

expect("one bad pattern inside an array of good ones", "reject",
  config(`{ name: "a", testMatch: [/(^|\\/)x\\.spec\\.ts$/, /y\\.spec\\.ts/] }`),
  ["UNANCHORED", "y"]);

console.log("\nassert-testmatch-anchored — ACCEPT\n");

expect("anchored at both ends", "accept",
  config(`{ name: "a", testMatch: /(^|\\/)shared\\/nextjs\\.spec\\.ts$/ }`), ["1 anchored"]);

/*
 * A DIRECTORY PREFIX MUST NOT BE FORCED TO END IN `$`. `/(^|\/)matrix\//` names a directory;
 * appending `$` would make it match nothing, which is the over-tightening this rule must not
 * cause while trying to prevent the opposite.
 */
expect("a directory glob ending in a slash is already closed", "accept",
  config(`{ name: "a", testMatch: /(^|\\/)matrix\\// }`), ["1 anchored"]);

expect("a shared TESTMATCH const is read too, not only inline values", "accept",
  `const CROSS_BROWSER_TESTMATCH = [/(^|\\/)a\\.spec\\.ts$/];\n` +
    config(`{ name: "a", testMatch: CROSS_BROWSER_TESTMATCH }`), ["1 anchored"]);

console.log("\nassert-testmatch-anchored — REFUSALS\n");

/*
 * A FORM IT CANNOT CLASSIFY IS A REFUSAL, NEVER A SKIP. Playwright also accepts glob strings,
 * which anchor by different rules; scoring one as "fine" would be the same defect this checker
 * exists to prevent, one level up.
 */
expect("a glob STRING is refused rather than passed", "refuse",
  config(`{ name: "a", testMatch: "**/foo.spec.ts" }`), ["STRINGS", "cannot classify"]);

expect("a config with no testMatch at all cannot compute the property", "refuse",
  `export default { projects: [{ name: "a" }] };`, ["COULD NOT COMPUTE"]);

const EXPECTED = 9;
const total = pass + fail;
console.log();
rmSync(TMP, { recursive: true, force: true });
if (total !== EXPECTED) { console.error(`FAIL: ran ${total} cases, expected ${EXPECTED} — the harness is broken.`); process.exit(1); }
if (fail !== 0) { console.error(`FAIL: ${fail}/${total} cases wrong.`); process.exit(1); }
console.log(
  `PASS: ${pass}/${total}. Each end is checked independently, a directory glob is not forced to\n` +
    `      end in \`$\`, shared consts are read, and an unclassifiable form refuses rather than\n` +
    `      passing. Every case asserts WHICH complaint appeared.`
);
