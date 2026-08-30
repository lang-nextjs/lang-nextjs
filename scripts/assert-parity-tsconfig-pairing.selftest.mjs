#!/usr/bin/env node
/**
 * Proof for assert-parity-tsconfig-pairing.mjs.
 *
 * The REJECT case that matters is the quiet one — a file excluded from the package program and
 * absent from the parity include is in no program at all, still runs under vitest, and is
 * green while never being typechecked. It cannot be caught by running tsc, because tsc is
 * exactly what it has escaped.
 *
 * The ACCEPT cases carry as much weight, and one of them is the rest of the repository:
 * `test-utils` is the only package with a parity config, so a rule that fired on packages
 * without one would be red everywhere and muted inside a week.
 *
 * Usage: node scripts/assert-parity-tsconfig-pairing.selftest.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { stripJsonComments } from "./assert-parity-tsconfig-pairing.mjs";

const CHECKER = join(
  dirname(fileURLToPath(import.meta.url)),
  "assert-parity-tsconfig-pairing.mjs"
);
const TMP = mkdtempSync(join(tmpdir(), "paritycfg-"));

let pass = 0;
let fail = 0;

/** A tree of packages, each described by the two configs it has (or does not). */
function sandbox(packages) {
  const dir = mkdtempSync(join(TMP, "case-"));
  for (const [name, cfg] of Object.entries(packages)) {
    const p = join(dir, "packages", name);
    mkdirSync(p, { recursive: true });
    // A STRING IS WRITTEN RAW. JSON.stringify("{ not json") produces a valid JSON string
    // literal, so the malformed-config case would have written parseable JSON and the
    // checker would have been right to accept it — the fixture failing to build the
    // scenario, not the checker failing to catch it.
    const write = (file, value) =>
      writeFileSync(
        join(p, file),
        typeof value === "string" ? value : JSON.stringify(value)
      );
    if (cfg.own !== undefined) write("tsconfig.json", cfg.own);
    if (cfg.parity !== undefined) write("tsconfig.parity.json", cfg.parity);
  }
  return dir;
}

function run(dir) {
  try {
    return { rc: 0, out: execFileSync("node", [CHECKER, "--cwd", dir], { encoding: "utf8" }) };
  } catch (e) {
    return { rc: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

function expect(label, want, packages, mustSay = []) {
  const { rc, out } = run(sandbox(packages));
  const got = rc === 0 ? "accept" : "reject";
  const said = mustSay.every((s) => out.includes(s));
  if (got === want && said) {
    console.log(`  ok   ${label.padEnd(58)} (${want}ed)`);
    pass++;
  } else {
    console.error(`  FAIL ${label} — wanted ${want}, got ${got}, named=${said}`);
    console.error(out.split("\n").map((l) => "         " + l).join("\n"));
    fail++;
  }
}

const PAIRED = {
  demo: {
    own: { include: ["src"], exclude: ["src/a.test.ts", "src/b.test.ts"] },
    parity: { include: ["src/a.test.ts", "src/b.test.ts"] },
  },
};

console.log("\nassert-parity-tsconfig-pairing — REJECT\n");

expect(
  "excluded but NOT in the parity include: in NO program",
  "reject",
  {
    demo: {
      own: { include: ["src"], exclude: ["src/a.test.ts", "src/orphan.test.ts"] },
      parity: { include: ["src/a.test.ts"] },
    },
  },
  ["src/orphan.test.ts", "NO PROGRAM"]
);

/*
 * THE DIRECTION NOBODY WAS WORRIED ABOUT. A file in the parity include and missing from
 * exclude compiles TWICE — harmless today, and the quieter mis-pairing. A checker guarding
 * only the failure we happened to fear is the partial-coverage habit this repo keeps finding.
 */
expect(
  "in the parity include but NOT excluded: compiles twice",
  "reject",
  {
    demo: {
      own: { include: ["src"], exclude: [] },
      parity: { include: ["src/a.test.ts"] },
    },
  },
  ["src/a.test.ts", "BOTH programs"]
);

expect(
  "an unparseable config REFUSES rather than passing",
  "reject",
  {
    demo: { own: "{ not json", parity: { include: [] } },
  },
  ["could not parse"]
);

{
  // VACUITY. No package uses the pattern -> the property cannot be computed. Exit 2, distinct
  // from a violation, because "nothing to check" and "nothing wrong" are different answers.
  const { rc, out } = run(sandbox({ plain: { own: { include: ["src"] } } }));
  const label = "no package with a parity config is exit 2, not a green";
  if (rc === 2 && out.includes("could not compute")) {
    console.log(`  ok   ${label.padEnd(58)} (rejected)`);
    pass++;
  } else {
    console.error(`  FAIL ${label} — rc=${rc}`);
    fail++;
  }
}

console.log("\nassert-parity-tsconfig-pairing — ACCEPT (why it is allowed to exist)\n");

expect("a correctly paired package", "accept", PAIRED);

/*
 * THE REST OF THE REPOSITORY. test-utils is the only package with a parity config, so every
 * other package is this rule's false-positive guard. Firing on them would be red everywhere.
 */
expect("packages with no parity config are not examined", "accept", {
  ...PAIRED,
  plain: { own: { include: ["src"] } },
  another: { own: { include: ["src"], exclude: ["src/x.test.ts"] } },
});

expect("a paired package with both lists empty", "accept", {
  demo: { own: { include: ["src"], exclude: [] }, parity: { include: [] } },
});

console.log("\nassert-parity-tsconfig-pairing — the comment stripper\n");

{
  /*
   * A NAIVE STRIPPER CUTS A PATH IN HALF AND STILL PRODUCES VALID JSON — a parse that
   * succeeds while describing different files, which is worse than a crash. `//` inside a
   * string is not a comment.
   */
  const src = '{ // lead\n "include": ["src/a//b.test.ts"], /* mid */ "exclude": [] }';
  const parsed = JSON.parse(stripJsonComments(src));
  const label = "a `//` inside a string is not a comment";
  if (parsed.include[0] === "src/a//b.test.ts" && Array.isArray(parsed.exclude)) {
    console.log(`  ok   ${label.padEnd(58)} (path intact)`);
    pass++;
  } else {
    console.error(`  FAIL ${label} — got ${JSON.stringify(parsed)}`);
    fail++;
  }
}

{
  const label = "an escaped quote does not end the string early";
  const parsed = JSON.parse(stripJsonComments('{"include": ["a\\"//b"]}'));
  if (parsed.include[0] === 'a"//b') {
    console.log(`  ok   ${label.padEnd(58)} (intact)`);
    pass++;
  } else {
    console.error(`  FAIL ${label} — got ${JSON.stringify(parsed)}`);
    fail++;
  }
}

const EXPECTED_CASES = 9;
const total = pass + fail;
console.log();
rmSync(TMP, { recursive: true, force: true });

if (total !== EXPECTED_CASES) {
  console.error(`FAIL: ran ${total} cases, expected ${EXPECTED_CASES} — the harness is broken.`);
  process.exit(1);
}
if (fail !== 0) {
  console.error(`FAIL: ${fail}/${total} cases wrong.`);
  process.exit(1);
}
console.log(
  `PASS: ${pass}/${total}. Both mis-pairings are caught — the quiet one that leaves a file in\n` +
    `      no program, and the loud-harmless one that compiles it twice — and packages without\n` +
    `      a parity config are left alone.`
);
