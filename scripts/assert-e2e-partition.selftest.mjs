#!/usr/bin/env node
/**
 * Proof for assert-e2e-partition.mjs.
 *
 * The RESOLUTION half — turning testMatch into project/spec pairs — is Playwright's job and is
 * verified against the real binary by mutation, recorded in the checker's header. What is
 * proved here is the COMPARISON half and the refusals, driven through a stub that emits a
 * listing. Saying which half a fixture measures is the point: a proof that stubbed everything
 * and did not say so would look identical and mean much less.
 *
 * Every case asserts WHICH complaint appeared. A planted partition differs in several ways at
 * once, and an exit code cannot attribute a failure.
 *
 * Usage: node scripts/assert-e2e-partition.selftest.mjs
 */
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const CHECKER = join(
  dirname(fileURLToPath(import.meta.url)),
  "assert-e2e-partition.mjs"
);
const TMP = mkdtempSync(join(tmpdir(), "partition-"));
let pass = 0,
  fail = 0;

/** A tree whose `playwright` binary emits `listing`, with `frozen` already declared. */
function sandbox({ listing, frozen, brokenBinary = false }) {
  const dir = mkdtempSync(join(TMP, "case-"));
  mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  const bin = join(dir, "node_modules", ".bin", "playwright");
  writeFileSync(
    bin,
    brokenBinary
      ? `#!/bin/sh\necho "config error" >&2\nexit 1\n`
      : `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(listing)}\nJSON\n`
  );
  chmodSync(bin, 0o755);
  if (frozen)
    writeFileSync(
      join(dir, "scripts", "e2e-partition.json"),
      JSON.stringify(frozen)
    );
  return dir;
}

/** Playwright's --list shape, reduced to what the checker reads. */
const listingOf = (pairs) => ({
  suites: pairs.map(([project, file]) => ({
    file,
    specs: [{ file, tests: [{ projectName: project }] }],
    suites: [],
  })),
});

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

function expect(label, want, opts, mustSay = []) {
  const { rc, out } = run(sandbox(opts));
  const got = rc === 0 ? "accept" : rc === 2 ? "refuse" : "reject";
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

const PAIRS = [
  ["chromium", "e2e/a.spec.ts"],
  ["webkit", "e2e/a.spec.ts"],
  ["shell", "e2e/b.spec.ts"],
];
const FROZEN = PAIRS.map(([p, f]) => `${p}\t${f}`).sort();

console.log("\nassert-e2e-partition — ACCEPT\n");

expect(
  "what runs matches what is declared",
  "accept",
  { listing: listingOf(PAIRS), frozen: FROZEN },
  ["3 project/spec pair(s)", "2 spec(s) across 3 project(s)", "pair for pair"]
);

console.log("\nassert-e2e-partition — REJECT\n");

/*
 * THE #473 MECHANISM: a spec silently gains a project and runs against that project's baseURL.
 * It is not an orphan and the project is not a ghost, so the registration check cannot see it.
 */
expect(
  "a spec that JOINED a project it was not declared in",
  "reject",
  {
    listing: listingOf([...PAIRS, ["chromium", "e2e/b.spec.ts"]]),
    frozen: FROZEN,
  },
  ['JOINED project "chromium"', "e2e/b.spec.ts", "1 joined, 0 left"]
);

/*
 * THE MIRROR, and the one measured to be invisible to BOTH existing checks: an over-tight
 * anchor removes a spec from one project while it still runs in others.
 */
expect(
  "a spec that LEFT a project it is declared in",
  "reject",
  { listing: listingOf(PAIRS.filter(([p]) => p !== "webkit")), frozen: FROZEN },
  ['LEFT project "webkit"', "0 joined, 1 left"]
);

expect(
  "both directions at once are reported separately",
  "reject",
  {
    listing: listingOf([
      ["chromium", "e2e/a.spec.ts"],
      ["shell", "e2e/b.spec.ts"],
      ["firefox", "e2e/c.spec.ts"],
    ]),
    frozen: FROZEN,
  },
  ["JOINED", "LEFT", "1 joined, 1 left"]
);

console.log("\nassert-e2e-partition — REFUSALS\n");

expect(
  "no frozen declaration is a refusal, not a pass",
  "refuse",
  { listing: listingOf(PAIRS), frozen: null },
  ["no scripts/e2e-partition.json"]
);

/*
 * A listing with nothing in it cannot differ from anything, so every comparison would pass.
 * That is the shape of the defect, not the absence of it.
 */
expect(
  "an empty listing is a refusal, not 'no differences'",
  "refuse",
  { listing: { suites: [] }, frozen: FROZEN },
  ["resolved 0 project/spec pairs", "vacuously"]
);

expect(
  "a playwright that fails is a refusal, not an intact partition",
  "refuse",
  { listing: null, frozen: FROZEN, brokenBinary: true },
  ["--list failed", "COULD NOT COMPUTE"]
);

const EXPECTED = 7;
const total = pass + fail;
console.log();
rmSync(TMP, { recursive: true, force: true });
if (total !== EXPECTED) {
  console.error(
    `FAIL: ran ${total} cases, expected ${EXPECTED} — the harness is broken.`
  );
  process.exit(1);
}
if (fail !== 0) {
  console.error(`FAIL: ${fail}/${total} cases wrong.`);
  process.exit(1);
}
console.log(
  `PASS: ${pass}/${total}. Both membership directions are caught and named separately, and a\n` +
    `      missing declaration, an empty listing and a failed lister all refuse rather than\n` +
    `      reporting an intact partition.`
);
