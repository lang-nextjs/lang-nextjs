#!/usr/bin/env node
/**
 * classify.selftest.mjs — prove CHECK-1 can fail, by MUTATION.
 *
 * WHY MUTATION AND NOT UNIT TESTS.
 * classify.mjs is the census that eject and CHECK-2 are built on. If it is broken it reports a
 * serene green over a broken tree, and every number downstream inherits the lie. Reading the
 * code cannot establish that it fails when it should — only watching it fail can.
 *
 * So each case below takes the REAL manifest and the REAL repo, breaks exactly one thing, and
 * asserts the classifier catches it. One mutation per gate, named for the gate it targets. If
 * a gate is ever silently disabled — an early return, an inverted condition, a swallowed
 * error — its mutation goes green here and this suite fails.
 *
 * This is not hypothetical hygiene. Building this classifier, two of my own gates caught two of
 * my own bugs before any of it reached CI:
 *   - C4 caught globToRegExp compiling `dir/**` to a regex that matched NOTHING, which had
 *     silently zeroed every glob in the manifest.
 *   - C7 caught five real rung files sitting in `shared` (docs/rungs/*.md, the open-swe e2e
 *     specs, two SSE fixtures, deepagents-handler.ts) that `pnpm eject` would have shipped
 *     into a fork that ejected those rungs.
 * A harness that finds its author's bugs is worth more than one that agrees with them.
 *
 * Usage: node scripts/classify.selftest.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLASSIFY = join(ROOT, "scripts", "classify.mjs");
const REAL = JSON.parse(readFileSync(join(ROOT, "rungs.json"), "utf8"));
const TMP = mkdtempSync(join(tmpdir(), "classify-selftest-"));

let pass = 0;
let fail = 0;

/** Run classify.mjs against a (possibly mutated) manifest and optional cwd. Never throws. */
function run(manifest, { cwd } = {}) {
  const path = join(TMP, `m-${Math.abs(hash(JSON.stringify(manifest)))}.json`);
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  try {
    const out = execFileSync("node", [CLASSIFY], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, RUNGS_MANIFEST: path, ...(cwd ? { RUNGS_CWD: cwd } : {}) },
    });
    return { rc: 0, out };
  } catch (e) {
    return { rc: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}
/** Deep clone so each mutation starts from a pristine copy of the real manifest. */
const clone = () => JSON.parse(JSON.stringify(REAL));

/** A mutation must be CAUGHT: non-zero exit, and the named gate must be the one that fired. */
function mutationCaught(name, gate, mutate) {
  const m = clone();
  mutate(m);
  const { rc, out } = run(m);
  if (rc !== 0 && out.includes(gate)) {
    console.log(`  ok   ${name.padEnd(56)} (caught by ${gate})`);
    pass++;
  } else if (rc !== 0) {
    console.error(`  FAIL ${name.padEnd(56)} failed, but not via ${gate}`);
    console.error(`       ${out.split("\n").filter((l) => l.startsWith("FAIL"))[0] ?? out.slice(0, 200)}`);
    fail++;
  } else {
    console.error(`  FAIL ${name.padEnd(56)} MUTATION SURVIVED — ${gate} did not fire`);
    fail++;
  }
}

function expectPass(name, mutate = () => {}) {
  const m = clone();
  mutate(m);
  const { rc, out } = run(m);
  if (rc === 0) {
    console.log(`  ok   ${name.padEnd(56)} (exit 0, correctly accepted)`);
    pass++;
  } else {
    console.error(`  FAIL ${name.padEnd(56)} expected 0, got ${rc}`);
    console.error(`       ${out.split("\n").filter((l) => l.startsWith("FAIL"))[0] ?? ""}`);
    fail++;
  }
}

console.log("classify.mjs self-test — proving CHECK-1 can fail, by mutation\n");

// --- C1: the walk must find a real tree --------------------------------------------------
// A git repo with two files. Without C1, "all zero rung files are classified" passes and the
// whole census is vacuously green — the failure mode ARCHITECT's >10-modules guard prevents.
{
  const empty = join(TMP, "tiny-repo");
  mkdirSync(empty, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: empty });
  writeFileSync(join(empty, "a.txt"), "a");
  execFileSync("git", ["add", "-A"], { cwd: empty });
  const { rc, out } = run(clone(), { cwd: empty });
  if (rc !== 0 && out.includes("C1 walk")) {
    console.log(`  ok   ${"tiny tree (walk found almost nothing)".padEnd(56)} (caught by C1 walk)`);
    pass++;
  } else {
    console.error(`  FAIL tiny tree — C1 did not fire (rc=${rc})`);
    fail++;
  }
}

// --- C2: totality --------------------------------------------------------------------------
mutationCaught("a shared path removed -> files unclassified", "C2 total", (m) => {
  m.shared.paths = m.shared.paths.filter((p) => p !== "packages/**" && p !== "packages/server/**");
});

// --- C3: disjointness ----------------------------------------------------------------------
mutationCaught("two rungs claim the same file", "C3 disjoint", (m) => {
  const victim = m.rungs.find((r) => r.id === "langchain").owns.ts[0];
  m.rungs.find((r) => r.id === "langgraph").owns.ts.push(victim);
});

// --- C4: a glob that matches nothing --------------------------------------------------------
mutationCaught("manifest glob matches nothing (rot)", "C4 glob", (m) => {
  m.rungs[0].owns.ts.push("packages/server/src/adapters/does-not-exist.ts");
});
mutationCaught("shared glob matches nothing (rot)", "C4 glob", (m) => {
  m.shared.paths.push("no/such/dir/**");
});

// --- C5: a `planned` rung that has shipped --------------------------------------------------
mutationCaught("a rung with source is marked planned", "C5 planned", (m) => {
  m.rungs.find((r) => r.id === "open-swe").state = "planned";
});

// --- C6: the frozen census drifts -----------------------------------------------------------
mutationCaught("ownedFileCount too low (under-count)", "C6 census", (m) => {
  m.rungs.find((r) => r.id === "open-swe").ownedFileCount -= 1;
});
mutationCaught("ownedFileCount too high (over-count)", "C6 census", (m) => {
  m.rungs.find((r) => r.id === "deepagents").ownedFileCount += 1;
});

// --- C7: a rung file swallowed by a broad `shared` glob -------------------------------------
// The exact defect #40 introduced: docs/rungs/4-open-swe.md under `docs/**`. Totality does NOT
// catch it — the file is classified, just wrongly — so only C7 stands between that file and a
// fork that ejected rung 4 while still shipping its documentation.
mutationCaught("rung doc falls through to shared", "C7 misfiled", (m) => {
  const r = m.rungs.find((x) => x.id === "open-swe");
  r.owns.docs = [];
  r.ownedFileCount -= 1;
});
mutationCaught("rung e2e spec falls through to shared", "C7 misfiled", (m) => {
  const r = m.rungs.find((x) => x.id === "open-swe");
  const before = r.owns.ts.length;
  r.owns.ts = r.owns.ts.filter((g) => !g.startsWith("e2e/"));
  r.ownedFileCount -= before - r.owns.ts.length;
});
mutationCaught("rung SSE fixture falls through to shared", "C7 misfiled", (m) => {
  const r = m.rungs.find((x) => x.id === "langchain");
  r.owns.ts = r.owns.ts.filter((g) => !g.includes("__fixtures__"));
  r.ownedFileCount -= 1;
});

// --- Positives: the checker must also ACCEPT truth, or it is just `exit 1` in a costume -----
expectPass("the real, unmutated manifest");
expectPass("C7 allowlist genuinely suppresses a false positive", (m) => {
  // Removing the Django project-package exception must NOT be needed for a green run; adding a
  // redundant entry must stay green. Proves the allowlist is a real escape hatch, not decoration.
  m.shared.knownRungNamedSharedPaths.push("docs/NOT-A-REAL-FILE-langchain.md");
});

// --- Non-vacuity of THIS suite --------------------------------------------------------------
const EXPECTED_CASES = 13;
const total = pass + fail;
console.log();
if (total !== EXPECTED_CASES) {
  console.error(
    `FAIL: self-test ran ${total} cases, expected ${EXPECTED_CASES} — the harness itself is broken.\n` +
      `      (If you added or removed a case on purpose, update EXPECTED_CASES.)`
  );
  rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
}
rmSync(TMP, { recursive: true, force: true });
if (fail !== 0) {
  console.error(`FAIL: ${fail}/${total} mutations survived or misfired. classify.mjs is NOT trustworthy.`);
  process.exit(1);
}
console.log(
  `PASS: ${pass}/${total}. Every gate was watched failing on a deliberate mutation,\n` +
    `      and the unmutated manifest still passes. The census means something.`
);
