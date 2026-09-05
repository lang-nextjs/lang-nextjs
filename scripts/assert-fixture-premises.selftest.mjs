#!/usr/bin/env node
/**
 * Proof for assert-fixture-premises.mjs AND for the helper it points people at.
 *
 * Two things need proving and they are not the same:
 *
 *   the CHECKER  finds an unverified plant, and stays silent on everything else
 *   the HELPER   actually flips a fixture from green-about-nothing to red when the
 *                ownership it depends on moves
 *
 * The second is the acceptance condition from #375 and it is demonstrated on a synthetic
 * tree rather than this one, deliberately. In the real repo every reparent that unowns
 * freeze-all's plant ALSO unowns real specs, so the manifest's own C4 and census guards fire
 * and the fixture goes red regardless — with the wrong diagnosis, blaming freeze:all for a
 * broken manifest, but red. A hermetic tree is the only place the premise check is the sole
 * thing standing between the fixture and a green verdict about nothing.
 *
 * Usage: node scripts/assert-fixture-premises.selftest.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  requireRungOwned,
  requireSetupChanged,
} from "./lib/fixture-premise.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKER = join(HERE, "assert-fixture-premises.mjs");
const TMP = mkdtempSync(join(tmpdir(), "fixpremise-"));

let pass = 0;
let fail = 0;

/** A tree with a manifest and one fixture file, both fully specified by the case. */
function sandbox({ owns, fixture }) {
  const dir = mkdtempSync(join(TMP, "case-"));
  mkdirSync(join(dir, "scripts", "lib"), { recursive: true });
  writeFileSync(
    join(dir, "rungs.json"),
    JSON.stringify(
      {
        rungs: [{ id: "demo", owns: { ts: owns } }],
        shared: { paths: ["packages/**"] },
      },
      null,
      2
    ) + "\n"
  );
  writeFileSync(join(dir, "scripts", "demo.selftest.mjs"), fixture);
  return dir;
}

function run(dir) {
  try {
    return {
      rc: 0,
      out: execFileSync("node", [CHECKER, "--cwd", dir], { encoding: "utf8" }),
    };
  } catch (e) {
    return { rc: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

function expect(label, want, spec, mustSay = []) {
  const { rc, out } = run(sandbox(spec));
  const got = rc === 0 ? "accept" : "reject";
  const said = mustSay.every((s) => out.includes(s));
  if (got === want && said) {
    console.log(`  ok   ${label.padEnd(56)} (${want}ed)`);
    pass++;
  } else {
    console.error(
      `  FAIL ${label} — wanted ${want}, got ${got}, named=${said}`
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

console.log("\nassert-fixture-premises — REJECT\n");

expect(
  "an unverified plant under a directory glob",
  "reject",
  {
    owns: ["e2e/rungs/demo/**"],
    fixture: 'track(dir, "e2e/rungs/demo/planted.spec.ts", "export {};\\n");\n',
  },
  ["e2e/rungs/demo/planted.spec.ts", "e2e/rungs/demo/**"]
);

console.log(
  "\nassert-fixture-premises — ACCEPT (why it is allowed to exist)\n"
);

expect("the same plant, with the premise asserted", "accept", {
  owns: ["e2e/rungs/demo/**"],
  fixture:
    'requireRungOwned(dir, "e2e/rungs/demo/planted.spec.ts", "why");\n' +
    'track(dir, "e2e/rungs/demo/planted.spec.ts", "export {};\\n");\n',
});

/*
 * OWNED BY NAME IS OUT OF SCOPE. Removing that manifest line is a deliberate edit to the line
 * itself, visible in the diff that makes it. Flagging it would demand premise assertions from
 * every fixture naming any owned file, which is the over-firing that got #328's detector
 * dropped.
 */
expect("a plant a rung owns BY NAME, unverified", "accept", {
  // A directory glob is present but claims somewhere ELSE, so the vacuity guard is satisfied
  // and this case tests what it says it tests. Without it the manifest has no directory glob
  // at all, the "cannot compute the property" guard fires first, and the case would report a
  // rejection that says nothing about by-name ownership.
  owns: ["e2e/rungs/demo/planted.spec.ts", "e2e/rungs/elsewhere/**"],
  fixture: 'track(dir, "e2e/rungs/demo/planted.spec.ts", "export {};\\n");\n',
});

/*
 * A PATH THAT EXISTS IS BEING READ, NOT PLANTED. Nearly every fixture names real files it
 * reads; requiring premise checks from all of them is the same over-fire. `scripts/` exists
 * in the sandbox, so this is a read.
 */
expect("a path that exists is a read, not a plant", "accept", {
  owns: ["scripts/**"],
  fixture: 'const src = readFileSync("scripts/demo.selftest.mjs", "utf8");\n',
});

expect("a plant under no glob at all", "accept", {
  owns: ["e2e/rungs/other/**"],
  fixture: 'track(dir, "e2e/rungs/demo/planted.spec.ts", "export {};\\n");\n',
});

{
  // VACUITY: a manifest with no directory globs cannot compute the property. Exit 2, distinct
  // from a violation, because "nothing to check" and "nothing wrong" are different answers.
  const dir = sandbox({
    owns: ["e2e/rungs/demo/planted.spec.ts"],
    fixture: "// nothing\n",
  });
  const { rc, out } = run(dir);
  const label = "no directory globs at all is exit 2, not a green";
  if (rc === 2 && out.includes("cannot compute the property")) {
    console.log(`  ok   ${label.padEnd(56)} (rejected)`);
    pass++;
  } else {
    console.error(`  FAIL ${label} — rc=${rc}`);
    fail++;
  }
}

console.log("\nfixture-premise helper — the acceptance condition (#375)\n");

{
  /*
   * THE EVENT THAT HAPPENED THREE TIMES: the glob narrows, the plant stops being owned, and
   * the fixture is asked to keep reporting. Before the helper it reported a verdict about a
   * scenario it could no longer build. Here the SAME tree is put to the helper twice.
   */
  const dir = mkdtempSync(join(TMP, "reparent-"));
  const write = (owns) =>
    writeFileSync(
      join(dir, "rungs.json"),
      JSON.stringify({
        rungs: [{ id: "demo", owns: { ts: owns } }],
        shared: { paths: [] },
      }) + "\n"
    );
  const plant = "e2e/rungs/demo/planted.spec.ts";

  write(["e2e/rungs/demo/**"]);
  let before = "did not throw";
  try {
    requireRungOwned(dir, plant, "the case needs a rung-owned file.");
  } catch (e) {
    before = e.message;
  }

  // The reparent: the directory glob narrows to the real specs and no longer claims new files.
  write(["e2e/rungs/demo/real-one.spec.ts"]);
  let after = "did not throw";
  try {
    requireRungOwned(dir, plant, "the case needs a rung-owned file.");
  } catch (e) {
    after = e.message;
  }

  const label = "a reparent makes the fixture fail LOUDLY, naming the path";
  if (
    before === "did not throw" &&
    after.includes(plant) &&
    after.includes("owned by no rung")
  ) {
    console.log(`  ok   ${label.padEnd(56)} (silent before, named after)`);
    pass++;
  } else {
    console.error(
      `  FAIL ${label}\n         before: ${before}\n         after:  ${after}`
    );
    fail++;
  }
}

{
  // The setup VOID guard, which is the same idea applied to setup rather than to the mutation.
  const label = "setup that changed nothing is refused";
  let msg = "did not throw";
  try {
    requireSetupChanged(
      "same",
      "same",
      "planting the probe moved no ownedFileCount"
    );
  } catch (e) {
    msg = e.message;
  }
  let okChanged = true;
  try {
    requireSetupChanged("a", "b", "x");
  } catch {
    okChanged = false;
  }
  if (msg.includes("changed nothing") && okChanged) {
    console.log(`  ok   ${label.padEnd(56)} (refused; a real change passes)`);
    pass++;
  } else {
    console.error(`  FAIL ${label} — ${msg} / changed-case ok=${okChanged}`);
    fail++;
  }
}

const EXPECTED_CASES = 8;
const total = pass + fail;
console.log();
rmSync(TMP, { recursive: true, force: true });

if (total !== EXPECTED_CASES) {
  console.error(
    `FAIL: ran ${total} cases, expected ${EXPECTED_CASES} — the harness is broken.`
  );
  process.exit(1);
}
if (fail !== 0) {
  console.error(`FAIL: ${fail}/${total} cases wrong.`);
  process.exit(1);
}
console.log(
  `PASS: ${pass}/${total}. The rule fires on an unverified plant, stays silent on reads and on\n` +
    `      by-name ownership, and the helper turns a reparent into a named failure instead of a\n` +
    `      verdict about a scenario that no longer exists.`
);
