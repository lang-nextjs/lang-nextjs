#!/usr/bin/env node
/**
 * Proof for assert-index-paths-exist.mjs.
 *
 * The checker's whole value is that it CAN fail — an index whose every entry had rotted looks
 * identical to one still true, and prose cannot tell you which you have. So every case here
 * plants the rot and requires it caught, and the 1-vs-2 split is asserted separately because
 * "a file is missing" and "I could not read the index" must never share an exit code.
 *
 * Usage: node scripts/assert-index-paths-exist.selftest.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { namedScripts, pendingScripts } from "./assert-index-paths-exist.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKER = join(HERE, "assert-index-paths-exist.mjs");

let pass = 0,
  fail = 0;
const ok = (label, cond, got) => {
  if (cond) {
    console.log(`  ok   ${label}`);
    pass++;
  } else {
    console.error(
      `  FAIL ${label}${
        got !== undefined ? ` — got ${JSON.stringify(got)}` : ""
      }`
    );
    fail++;
  }
};

const GHOST = "definitely-not-a-real-script-xyz.mjs";
const REAL = "census.mjs";

function runIndex(body, floor = "1") {
  const dir = mkdtempSync(join(tmpdir(), "index-fixture-"));
  const f = join(dir, "idx.md");
  writeFileSync(f, body);
  return spawnSync(
    process.execPath,
    [CHECKER, "--index", f, "--floor", floor],
    { encoding: "utf8" }
  );
}

console.log("\nparsing\n");
ok(
  "named scripts are extracted from backticks",
  namedScripts("see `a.mjs` and `b.sh`").length === 2
);
ok(
  "a glob is not a filename",
  namedScripts("`scripts/*.mjs`").length === 0,
  namedScripts("`scripts/*.mjs`")
);
ok("names are deduplicated", namedScripts("`a.mjs` `a.mjs`").length === 1);

/*
 * THE BUG THIS CHECKER FOUND IN ITSELF, PRE-REGISTERED. The first pendingScripts scanned the
 * whole Pending SECTION, so the sentence introducing that section — which names this very file
 * — granted it an exemption nobody wrote. A pattern answering a broader question than the one
 * asked, in the checker guarding an index about exactly that.
 */
const prose =
  "## Pending\n\nThis paragraph mentions `x.mjs` but grants nothing.\n\n- `y.mjs` — real entry\n";
ok(
  "only LIST ITEMS are pending; prose in the section exempts nothing",
  pendingScripts(prose).length === 1 && pendingScripts(prose)[0] === "y.mjs",
  pendingScripts(prose)
);

console.log("\nPLANTED ROT — each must be caught, as 1 rather than 2\n");

let r = runIndex(`# idx\n\n- \`${GHOST}\` — a file that is not there\n`);
ok("a named file that does not exist is caught", r.status === 1, r.status);
ok("...and is named in the output", r.stderr.includes(GHOST));

r = runIndex(
  `# idx\n\n- \`${REAL}\` — fine\n\n## Pending\n\n- \`${REAL}\` — stale\n`
);
ok(
  "a pending entry that now EXISTS is caught as stale",
  r.status === 1,
  r.status
);
ok(
  "...and says to delete the line",
  /EXPIRED/.test(r.stderr) && /delete that line/.test(r.stderr)
);

/*
 * The prose case again, end to end: a Pending section that only MENTIONS the ghost must not
 * exempt it. If it did, this fixture would exit 0 and the exemption would be invisible.
 */
r = runIndex(
  `# idx\n\n- \`${GHOST}\` — missing\n\n## Pending\n\nWe mention \`${GHOST}\` here in prose only.\n`
);
ok(
  "a prose mention in Pending does NOT exempt a missing file",
  r.status === 1,
  r.status
);

console.log("\nREFUSAL — 'I could not ask' is exit 2, never 1 and never 0\n");

r = runIndex(`# idx\n\n- \`${REAL}\` — only one name\n`, "40");
ok("too few names to trust is exit 2, not 0", r.status === 2, r.status);
ok("...and says COULD NOT COMPUTE", /COULD NOT COMPUTE/.test(r.stderr));

r = spawnSync(
  process.execPath,
  [CHECKER, "--index", join(tmpdir(), "nope-does-not-exist.md")],
  { encoding: "utf8" }
);
ok("an unreadable index is exit 2, not 1", r.status === 2, r.status);

/*
 * AND THE REAL INDEX IS ONE OF THE CASES. Every assertion above runs against fixtures, so all
 * of them would stay green if .planning/scripts-question-index.md were deleted tomorrow.
 */
r = spawnSync(process.execPath, [CHECKER], { encoding: "utf8" });
ok("the REAL index in the tree passes", r.status === 0, {
  status: r.status,
  err: r.stderr.slice(0, 200),
});

const EXPECTED = 13;
const total = pass + fail;
if (total !== EXPECTED) {
  console.error(
    `\nFAIL: ran ${total} assertions, expected ${EXPECTED} — a case was added or lost.`
  );
  process.exit(1);
}
console.log(`\n${pass}/${total} passed`);
process.exit(fail ? 1 : 0);
