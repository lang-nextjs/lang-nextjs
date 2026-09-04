#!/usr/bin/env node
/**
 * Self-test — plants each pipeline shape the checker claims to catch.
 *
 * A checker never observed refusing is indistinguishable from one that cannot,
 * and this one nearly shipped as the latter: its first version scanned line by
 * line and reported PASS on main while the two `playwright … | grep -c` lines
 * that motivated #216 sat in the tree, because the pipe began a CONTINUATION
 * line. Case C below is that exact shape, and it is the reason this file has a
 * multi-line case at all.
 *
 * The ACCEPT half is not decoration. A checker that refuses everything scores
 * full marks on the reject cases and is useless, so the safe forms the issue
 * prescribes — capture-then-filter, and pipefail — must pass.
 */
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECKER = join(
  ROOT,
  "scripts",
  "assert-no-verdict-destroying-pipelines.mjs"
);
// realpath: on macOS tmpdir() is /var/… symlinked to /private/var/…, and paths
// that disagree across that boundary have broken sandboxes here before.
const TMP = realpathSync(mkdtempSync(join(tmpdir(), "vdp-selftest-")));

function tearDown() {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
process.on("exit", tearDown);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    tearDown();
    process.exit(130);
  });
}

let pass = 0;
let fail = 0;
let n = 0;

function sandbox(workflow, pkg) {
  const dir = join(TMP, `wt-${n++}`);
  mkdirSync(join(dir, ".github/workflows"), { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, ".github/workflows/probe.yml"), workflow);
  if (pkg !== undefined) writeFileSync(join(dir, "package.json"), pkg);
  return dir;
}

/** A package.json whose `scripts` are exactly what is passed. */
const pkgWith = (scripts) =>
  JSON.stringify({ name: "probe", version: "0.0.0", scripts }, null, 2);

function run(dir) {
  try {
    // stdout is captured on the PASS path too: several cases below assert what
    // the sweep says it examined, and a case that cannot read the output can
    // only ever check the exit code — which is the same 0 for a sweep that
    // entered a domain and one that never looked at it.
    const out = execFileSync(process.execPath, [CHECKER, "--cwd", dir], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { rc: 0, out };
  } catch (e) {
    return { rc: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  ok   ${name.padEnd(58)} ${detail}`);
  } else {
    fail++;
    console.log(`  FAIL ${name.padEnd(58)} ${detail}`);
  }
}

const wf = (body) => `name: probe
on: [push]
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: step
        run: |
${body
  .split("\n")
  .map((l) => `          ${l}`)
  .join("\n")}
`;

console.log(
  "assert-no-verdict-destroying-pipelines self-test — plants each shape\n"
);

// --- REJECT A: the original finding, single line ---------------------------
{
  const r = run(
    sandbox(wf(`npx tsc --noEmit 2>&1 | grep -E "error TS" | head -3`))
  );
  check(
    "tsc piped into grep|head is refused",
    r.rc !== 0 && /R1/.test(r.out ?? ""),
    r.rc !== 0 ? "(refused)" : "(PASSED — vacuous)"
  );
}

// --- REJECT B: grep over coloured output -----------------------------------
{
  const r = run(sandbox(wf(`npx tsc --noEmit 2>&1 | grep -c "error TS"`)));
  check(
    "grep -c over coloured output is refused",
    r.rc !== 0 && /R2/.test(r.out ?? ""),
    r.rc !== 0 ? "(refused)" : "(PASSED — vacuous)"
  );
}

// --- REJECT C: the shape that defeated the first version --------------------
{
  const r = run(
    sandbox(
      wf(`LISTED="$(pnpm exec playwright test --list --project=visual 2>/dev/null \\
  | grep -cE '^\\s+\\[visual\\]' || true)"`)
    )
  );
  check(
    "a pipeline split across a line continuation is refused",
    r.rc !== 0,
    r.rc !== 0
      ? "(refused — the hole that shipped once)"
      : "(PASSED — the original bug)"
  );
}

// --- REJECT D: a shell script, not a workflow step --------------------------
{
  const dir = sandbox(wf(`echo ok`));
  writeFileSync(
    join(dir, "scripts/thing.sh"),
    `#!/usr/bin/env bash\nnpx vitest run | tail -1\n`
  );
  const r = run(dir);
  check(
    "a script under scripts/ is swept too",
    r.rc !== 0,
    r.rc !== 0 ? "(refused)" : "(PASSED — scripts unswept)"
  );
}

// --- ACCEPT A: the safe form the issue prescribes ---------------------------
{
  const r = run(
    sandbox(
      wf(
        `npx tsc --noEmit > /tmp/out.txt 2>&1; code=$?\ngrep -E "error TS" /tmp/out.txt || true\nexit $code`
      )
    )
  );
  check(
    "capture-then-filter passes",
    r.rc === 0,
    r.rc === 0 ? "(accepted)" : "(refused — over-broad)"
  );
}

// --- ACCEPT B: pipefail makes the pipeline sound ----------------------------
{
  const r = run(sandbox(wf(`set -euo pipefail\nnpx tsc --noEmit | head -3`)));
  check(
    "pipefail passes",
    r.rc === 0,
    r.rc === 0 ? "(accepted)" : "(refused — over-broad)"
  );
}

// --- ACCEPT C: an ordinary pipe that carries no verdict ---------------------
{
  const r = run(sandbox(wf(`echo hello | grep hello`)));
  check(
    "a pipe with no verdict in it passes",
    r.rc === 0,
    r.rc === 0 ? "(accepted)" : "(refused — over-broad)"
  );
}

// --- REJECT E: a sweep that examined nothing ------------------------------
{
  const empty = join(TMP, "empty");
  mkdirSync(empty, { recursive: true });
  const r = run(empty);
  check(
    "a sweep that finds no files is refused, not passed",
    r.rc !== 0,
    r.rc !== 0
      ? "(refused)"
      : "(PASSED — a green proving only that it looked in the wrong place)"
  );
}

/* ── package.json scripts (#730) ────────────────────────────────────────────
 *
 * THE POINT THESE CASES HAVE TO CARRY. Widening a checker's DOMAIN over an
 * EMPTY set is green before and after: at the time of writing there are 201
 * script entries across 18 package.json files in this repo and not one contains
 * a pipe. So "package.json is in the file list" has no witness in the repo, and
 * the only thing that can supply one is a PLANTED pipeline being caught here.
 *
 * The pair is what makes it a witness rather than an assertion about a list: the
 * SAME line is planted in a location swept before this change and in a
 * package.json script, and both must be refused under the same rule. One arm
 * alone would leave "caught because package.json is swept" and "caught because
 * the fixture happens to trip something else" indistinguishable.
 */
const PIPELINE = `npx tsc --noEmit 2>&1 | grep -E "error TS" | head -3`;

// --- REJECT F: the paired witness ------------------------------------------
{
  const inWorkflow = run(sandbox(wf(PIPELINE)));
  const inPackage = run(
    sandbox(wf(`echo ok`), pkgWith({ typecheck: PIPELINE }))
  );
  const wOK = inWorkflow.rc !== 0 && /R1/.test(inWorkflow.out ?? "");
  const pOK = inPackage.rc !== 0 && /R1/.test(inPackage.out ?? "");
  check(
    "the same pipeline is caught in package.json as in a run: block",
    wOK && pOK,
    `(workflow rc=${inWorkflow.rc} R1=${/R1/.test(inWorkflow.out ?? "")}; ` +
      `package rc=${inPackage.rc} R1=${/R1/.test(inPackage.out ?? "")})`
  );
}

// --- REJECT G: the finding names the script, not just the file --------------
{
  // `typecheck` sits on line 5 of pkgWith's output (name, version, "scripts:",
  // then the first entry). The header claims a finding points at the script the
  // reader has to go and edit; this is that claim, asserted.
  const r = run(sandbox(wf(`echo ok`), pkgWith({ typecheck: PIPELINE })));
  const located = /package\.json:5\b/.test(r.out ?? "");
  check(
    "a package.json finding points at the script's own line",
    r.rc !== 0 && located,
    located
      ? "(located at package.json:5)"
      : `(rc=${r.rc}; no package.json:5 in output)`
  );
}

// --- ACCEPT D: the safe forms pass inside a package script too --------------
{
  const r = run(
    sandbox(
      wf(`echo ok`),
      pkgWith({
        a: "set -o pipefail; npx tsc --noEmit | head -3",
        b: "npx tsc --noEmit > /tmp/o 2>&1; code=$?; grep -E 'error TS' /tmp/o || true; exit $code",
        c: "echo hello | grep hello",
      })
    )
  );
  check(
    "safe package scripts are accepted, so this is not a blanket ban on pipes",
    r.rc === 0,
    r.rc === 0 ? "(accepted)" : `(refused — over-broad: rc=${r.rc})`
  );
}

// --- ACCEPT E: a clean package.json is ENTERED, not merely not-failed -------
{
  // The distinction this case exists for: a domain that is never entered and a
  // domain entered with nothing wrong both exit 0. Only the output separates
  // them, which is why the PASS line reports its composition.
  const r = run(sandbox(wf(`echo ok`), pkgWith({ build: "tsc -b" })));
  const counted = /\b1 package\.json\b/.test(r.out ?? "");
  check(
    "a clean package.json is reported as swept, not silently skipped",
    r.rc === 0 && counted,
    counted
      ? "(counted in the sweep)"
      : `(rc=${r.rc}; composition line does not name package.json)`
  );
}

// --- REJECT H: a package.json that cannot be parsed is REFUSED, not skipped --
{
  const r = run(sandbox(wf(`echo ok`), `{ "scripts": { "a": }`));
  check(
    "an unparseable package.json refuses (exit 2), rather than sweeping past it",
    r.rc === 2 && /REFUSING/.test(r.out ?? ""),
    r.rc === 2
      ? "(refused — could not ask, not answered no)"
      : `(rc=${r.rc} — a file that was never read counted as clean)`
  );
}

const total = pass + fail;
if (fail) {
  console.error(
    `\nFAIL: ${fail}/${total} cases wrong. The checker is NOT trustworthy.`
  );
  process.exit(1);
}
console.log(
  `\nPASS: ${pass}/${total}. Each refused shape was watched being refused — including the\n` +
    "      continuation-line form this checker itself once passed over — and the safe forms\n" +
    "      the issue prescribes are accepted, so it is not merely refusing everything."
);
