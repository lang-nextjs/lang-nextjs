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
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECKER = join(ROOT, "scripts", "assert-no-verdict-destroying-pipelines.mjs");
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

function sandbox(workflow) {
  const dir = join(TMP, `wt-${n++}`);
  mkdirSync(join(dir, ".github/workflows"), { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, ".github/workflows/probe.yml"), workflow);
  return dir;
}

function run(dir) {
  try {
    execFileSync(process.execPath, [CHECKER, "--cwd", dir], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { rc: 0 };
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

console.log("assert-no-verdict-destroying-pipelines self-test — plants each shape\n");

// --- REJECT A: the original finding, single line ---------------------------
{
  const r = run(sandbox(wf(`npx tsc --noEmit 2>&1 | grep -E "error TS" | head -3`)));
  check("tsc piped into grep|head is refused", r.rc !== 0 && /R1/.test(r.out ?? ""), r.rc !== 0 ? "(refused)" : "(PASSED — vacuous)");
}

// --- REJECT B: grep over coloured output -----------------------------------
{
  const r = run(sandbox(wf(`npx tsc --noEmit 2>&1 | grep -c "error TS"`)));
  check("grep -c over coloured output is refused", r.rc !== 0 && /R2/.test(r.out ?? ""), r.rc !== 0 ? "(refused)" : "(PASSED — vacuous)");
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
    r.rc !== 0 ? "(refused — the hole that shipped once)" : "(PASSED — the original bug)"
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
  check("a script under scripts/ is swept too", r.rc !== 0, r.rc !== 0 ? "(refused)" : "(PASSED — scripts unswept)");
}

// --- ACCEPT A: the safe form the issue prescribes ---------------------------
{
  const r = run(
    sandbox(wf(`npx tsc --noEmit > /tmp/out.txt 2>&1; code=$?\ngrep -E "error TS" /tmp/out.txt || true\nexit $code`))
  );
  check("capture-then-filter passes", r.rc === 0, r.rc === 0 ? "(accepted)" : "(refused — over-broad)");
}

// --- ACCEPT B: pipefail makes the pipeline sound ----------------------------
{
  const r = run(sandbox(wf(`set -euo pipefail\nnpx tsc --noEmit | head -3`)));
  check("pipefail passes", r.rc === 0, r.rc === 0 ? "(accepted)" : "(refused — over-broad)");
}

// --- ACCEPT C: an ordinary pipe that carries no verdict ---------------------
{
  const r = run(sandbox(wf(`echo hello | grep hello`)));
  check("a pipe with no verdict in it passes", r.rc === 0, r.rc === 0 ? "(accepted)" : "(refused — over-broad)");
}

const total = pass + fail;
if (fail) {
  console.error(`\nFAIL: ${fail}/${total} cases wrong. The checker is NOT trustworthy.`);
  process.exit(1);
}
console.log(
  `\nPASS: ${pass}/${total}. Each refused shape was watched being refused — including the\n` +
    "      continuation-line form this checker itself once passed over — and the safe forms\n" +
    "      the issue prescribes are accepted, so it is not merely refusing everything."
);
