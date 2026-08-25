#!/usr/bin/env node
/**
 * The ratchet must measure the same tree however it is invoked.
 *
 * WHY THIS EXISTS. The ratchet shipped with a defect that its five original
 * tests could not see, because all five invoked it the same way: by path, from
 * the repo root. Run through the entry point its own package.json advertises
 * (`pnpm --filter open-swe palette:ratchet`), pnpm set cwd to the package,
 * check-palette resolved "apps/open-swe" against it, found nothing, exited 0,
 * and printed "Down 237 — lower findings to 0". A wrong number is a bad day; a
 * wrong number with a confident instruction to zero the baseline is worse.
 *
 * So the subject of this test is THE INVOCATION PATH, not the script.
 *
 * The non-zero assertion is not padding. Three paths agreeing proves nothing if
 * they agree on zero — that is precisely the broken state. Agreement plus
 * non-zero is the property; agreement alone is satisfied by the bug.
 */
import { spawnSync } from "node:child_process";
import {
  writeFileSync,
  unlinkSync,
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const SCRIPT = resolve(HERE, "palette-ratchet.mjs");

const run = (label, cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const m = out.match(/(\d+) findings in (\d+) files/);
  return {
    label,
    status: r.status,
    findings: m ? Number(m[1]) : null,
    files: m ? Number(m[2]) : null,
    out,
  };
};

const results = [
  run("node by path, cwd=repo root", process.execPath, [SCRIPT], REPO),
  run(
    "node by path, cwd=apps/open-swe",
    process.execPath,
    [SCRIPT],
    resolve(REPO, "apps/open-swe")
  ),
  run(
    "pnpm --filter (the advertised entry point)",
    "pnpm",
    ["--filter", "open-swe", "palette:ratchet"],
    REPO
  ),
];

let failed = 0;
const fail = (msg) => {
  console.error(`  x ${msg}`);
  failed++;
};

console.log("palette-ratchet selftest — invocation-path invariance\n");
for (const r of results) {
  console.log(
    `  ${r.label}: ${r.findings} findings / ${r.files} files (exit ${r.status})`
  );
}
console.log();

// 1. every path produced a parseable measurement
for (const r of results) {
  if (r.findings === null) fail(`${r.label}: no measurement in output`);
}

// 2. every path agreed
const uniq = new Set(
  results
    .filter((r) => r.findings !== null)
    .map((r) => `${r.findings}/${r.files}`)
);
if (uniq.size > 1) {
  fail(`invocation paths disagree: ${[...uniq].join(" vs ")}`);
  fail("this is the shipped defect — one path is not measuring the repo");
}

// 3. They agreed on something REAL — i.e. the scan actually reached the tree.
//
//    This used to assert the count was non-zero, on the reasoning that three
//    paths agreeing on 0/0 is the broken state rather than a pass. That was
//    right when apps/open-swe carried 237 hardcoded classes and WRONG the
//    moment it was converted to design tokens: 0/0 became the correct answer,
//    and the assertion fired on a clean tree.
//
//    A count is a proxy for "the scan ran". Prove it directly instead: plant a
//    known violation, confirm every path sees it, remove it. That holds at any
//    baseline, including zero.
const CANARY = resolve(REPO, "apps/open-swe/__palette_canary__.tsx");
const CANARY_CLASSES = 3; // bg-rose-500, text-lime-300, border-cyan-400
let canaryResults = [];
try {
  writeFileSync(
    CANARY,
    'export const c = "bg-rose-500 text-lime-300 border-cyan-400";\n'
  );
  canaryResults = [
    run("canary: node by path", process.execPath, [SCRIPT], REPO),
    run(
      "canary: node by path, cwd=apps/open-swe",
      process.execPath,
      [SCRIPT],
      resolve(REPO, "apps/open-swe")
    ),
    run(
      "canary: pnpm --filter",
      "pnpm",
      ["--filter", "open-swe", "palette:ratchet"],
      REPO
    ),
  ];
} finally {
  if (existsSync(CANARY)) unlinkSync(CANARY);
}

const cleanCount = results.find((r) => r.findings !== null)?.findings ?? null;
for (const r of canaryResults) {
  if (r.findings === null) {
    fail(`${r.label}: no measurement — the scan did not run`);
    continue;
  }
  if (cleanCount !== null && r.findings !== cleanCount + CANARY_CLASSES) {
    fail(
      `${r.label}: planted ${CANARY_CLASSES} violations, expected ` +
        `${cleanCount + CANARY_CLASSES} findings, got ${r.findings} — ` +
        `this path is not scanning the tree`
    );
  }
  if (r.status === 0) {
    fail(
      `${r.label}: exited 0 with a planted violation — the ratchet cannot fail`
    );
  }
}

// ---------------------------------------------------------------------------
// DECAYING ENTRY — delete this block when the checker-declaration mechanism lands.
//
// THE GAP IT RECORDS. This checker and this proof are rung-owned: they are
// invoked by apps/open-swe's own `test` script, not from the root package.json
// or the root ci.yml. So `assert-checker-proof-pairing` cannot see them — its
// subject is checkers CI invokes, and these are invoked one level down.
//
// WHY NOT ROOT-WIRE THEM. That was tried (#138, first revision) and it broke
// ejection: `eject langchain` refused with three dangling references, because
// root package.json and root ci.yml are RETAINED artifacts and naming
// apps/open-swe from them survives the app's deletion. The eject selftest
// caught it. Rung-owned wiring disappears with the rung, which is correct.
//
// WHY THIS IS STILL AN IMPROVEMENT. Before #138 these ran NOWHERE. They now run
// on every open-swe test invocation. The comparison is against nothing, not
// against a perfect root wiring that has never existed.
//
// WHY IT DECAYS. ARCHITECT has ruled that #116's subject will extend to tools
// that DECLARE themselves checkers and emit a run-marker, which removes the
// need for root wiring entirely. When that lands, or if anyone root-wires this
// checker by hand, the assertion below FAILS and demands this block's removal.
// An allowlist entry that cannot outlive its justification.
{
  const rootPkg = readFileSync(resolve(REPO, "package.json"), "utf8");
  const wfDir = resolve(REPO, ".github/workflows");
  const wfHits = existsSync(wfDir)
    ? readdirSync(wfDir).filter((f) =>
        readFileSync(resolve(wfDir, f), "utf8").includes("palette-ratchet")
      )
    : [];
  const rootHit = rootPkg.includes("palette-ratchet");
  if (rootHit || wfHits.length) {
    fail(
      "palette-ratchet is now referenced from the root " +
        [rootHit && "package.json", ...wfHits].filter(Boolean).join(", ") +
        " — this DECAYING ENTRY has outlived its justification. Delete this " +
        "block, and make sure the checker is recorded in the checker/proof " +
        "ledger. Also re-run `node scripts/eject.mjs langchain` first: root " +
        "references to apps/open-swe are what broke ejection last time."
    );
  }
}

if (failed) {
  console.error(`\n${failed} failure(s).`);
  process.exit(1);
}
console.log(
  "✔ all invocation paths measure the same tree, and each detects a planted violation."
);
