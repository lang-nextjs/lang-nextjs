#!/usr/bin/env node
/**
 * Proof for assert-vocabulary-checker-has-its-dependency.mjs (#779).
 *
 * THE REFUSALS ARE ASSERTED BY MESSAGE, never by exit 2 alone. There are three, all printing
 * COULD NOT COMPUTE, so the code cannot say which one answered — the defect #767 exists to
 * remove and one its own repair reproduced once.
 *
 * THE COMMENTED-INSTALL CASE IS NOT DECORATION. A line-scanning checker that counted a `#`
 * line would be satisfied by ci.yml's own prose about the install, which is exactly how three
 * findings today were made and unmade. It is a rejection case here because prose must not pay.
 */
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  jobsIn,
  stepsIn,
  stepGuards,
  locate,
  shellCommand,
} from "./assert-vocabulary-checker-has-its-dependency.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = "assert-vocabulary-checker-has-its-dependency.mjs";

let pass = 0;
const results = [];
const ok = (name, cond, detail) => {
  results.push({ name, ok: !!cond, detail });
  if (cond) pass++;
};

const INSTALL = `      - name: FastAPI backend tests
        working-directory: apps/fastapi-backend
        run: pip install -r requirements.txt
`;
const CHECK = `      - name: The approval vocabulary
        working-directory: .
        run: node scripts/assert-approval-vocabulary-agrees.mjs --python python
`;
const wf = (body) => `name: CI\non:\n  push:\n  pull_request:\njobs:\n${body}`;
const twoJobs = (pyBody) =>
  wf(
    `  ci:\n    steps:\n      - name: build\n        run: pnpm build\n  python:\n    steps:\n${pyBody}`
  );

function stage(source) {
  const dir = mkdtempSync(join(tmpdir(), "vocdep-"));
  mkdirSync(join(dir, "scripts", "lib"), { recursive: true });
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  copyFileSync(join(ROOT, "scripts", SCRIPT), join(dir, "scripts", SCRIPT));
  for (const f of readdirSync(join(ROOT, "scripts", "lib")))
    copyFileSync(
      join(ROOT, "scripts", "lib", f),
      join(dir, "scripts", "lib", f)
    );
  if (source !== null)
    writeFileSync(join(dir, ".github", "workflows", "ci.yml"), source);
  return dir;
}
function run(dir) {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [join(dir, "scripts", SCRIPT)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
      err: "",
    };
  } catch (e) {
    return { code: e.status ?? -1, out: e.stdout ?? "", err: e.stderr ?? "" };
  }
}

/* ── ACCEPTANCE ─────────────────────────────────────────────────────────── */
{
  const r = run(ROOT);
  ok(
    "the REAL ci.yml satisfies the coupling",
    r.code === 0,
    `exit ${r.code} ${r.err.slice(0, 140)}`
  );
  ok(
    "...and names BOTH steps, so a reader can check it",
    /FastAPI backend tests/.test(r.out) && /approval vocabulary/i.test(r.out),
    r.out.slice(0, 120)
  );
}
{
  const d = stage(twoJobs(INSTALL + CHECK));
  const r = run(d);
  ok(
    "a synthetic workflow with install-then-check passes",
    r.code === 0,
    `exit ${r.code} ${r.err.slice(0, 140)}`
  );
  rmSync(d, { recursive: true, force: true });
}

/* ── REJECTION ──────────────────────────────────────────────────────────── */
{
  const d = stage(
    wf(`  ci:\n    steps:\n${INSTALL}  python:\n    steps:\n${CHECK}`)
  );
  const r = run(d);
  ok("an install in ANOTHER job fails", r.code === 1, `exit ${r.code}`);
  ok(
    "...and says no step installs earlier IN THAT JOB",
    /NO step installs/.test(r.err) && /job "python"/.test(r.err),
    r.err.slice(0, 200)
  );
  rmSync(d, { recursive: true, force: true });
}
{
  const d = stage(twoJobs(CHECK + INSTALL));
  const r = run(d);
  ok("an install AFTER the checker fails", r.code === 1, `exit ${r.code}`);
  ok(
    "...and reports where the install actually is",
    /LOST ITS DEPENDENCY/.test(r.err) && /FastAPI backend tests/.test(r.err),
    r.err.slice(0, 200)
  );
  rmSync(d, { recursive: true, force: true });
}
{
  const d = stage(twoJobs(CHECK));
  const r = run(d);
  ok("no install anywhere fails", r.code === 1, `exit ${r.code}`);
  ok(
    "...and says none was found anywhere",
    /none anywhere in this workflow/.test(r.err),
    r.err.slice(0, 200)
  );
  rmSync(d, { recursive: true, force: true });
}
{
  const commented = `      - name: FastAPI backend tests\n        # run: pip install -r requirements.txt\n        run: echo skipped\n`;
  const d = stage(twoJobs(commented + CHECK));
  const r = run(d);
  ok(
    "an install that exists only in a COMMENT does not pay",
    r.code === 1,
    `exit ${r.code}`
  );
  ok(
    "...and reports none found, not one found",
    /none anywhere in this workflow/.test(r.err),
    r.err.slice(0, 200)
  );
  rmSync(d, { recursive: true, force: true });
}

{
  /*
   * A TRAILING comment must not pay either (#813 review, DEV3-lang).
   *
   * The first version dropped lines that START with `#`, so `run: echo hi  # pip install …`
   * survived the filter and the predicate matched the prose inside it — a rejection arm with a
   * hole in the very category it rejects. Inside a run block we are reading SHELL, so the
   * command is what precedes a line-initial or whitespace-preceded `#`.
   */
  const trailing = `      - name: x\n        run: echo hi  # pip install -r requirements.txt\n`;
  const d = stage(twoJobs(trailing + CHECK));
  const r = run(d);
  ok(
    "an install in a TRAILING comment does not pay",
    r.code === 1,
    `exit ${r.code}`
  );
  ok(
    "...and reports none found, not one found",
    /none anywhere in this workflow/.test(r.err),
    r.err.slice(0, 200)
  );
  rmSync(d, { recursive: true, force: true });
}

{
  /*
   * THE COMPANION TO THE REPAIR, and the case a naive fix breaks. ci.yml's real install is FOUR
   * LINES INSIDE a `run: |` block, so a rule keyed on the `run:` line itself would reject the
   * only workflow this checker exists for. Membership is the block, not the line.
   */
  const block = `      - name: x\n        run: |\n          set -e\n          pip install -r requirements.txt\n`;
  const d = stage(twoJobs(block + CHECK));
  const r = run(d);
  ok(
    "an install INSIDE a `run: |` block still counts",
    r.code === 0,
    `exit ${r.code} ${r.err.slice(0, 140)}`
  );
  rmSync(d, { recursive: true, force: true });
}

/* ── REFUSAL, each by its own message ───────────────────────────────────── */
{
  const d = stage(wf(`  python:\n    steps:\n${INSTALL}${CHECK}`));
  const r = run(d);
  ok(
    "a ONE-JOB workflow refuses — same-job would be tautological",
    r.code === 2,
    `exit ${r.code}`
  );
  ok(
    "...and says the job scanner is the reason, not the coupling",
    /found 1 job/.test(r.err) && /trivially true/.test(r.err),
    r.err.slice(0, 200)
  );
  rmSync(d, { recursive: true, force: true });
}
{
  const d = stage(twoJobs(INSTALL));
  const r = run(d);
  ok(
    "a workflow that no longer invokes the checker refuses",
    r.code === 2,
    `exit ${r.code}`
  );
  ok(
    "...and says THIS RUN is not evidence — a different message from the others",
    /no step in .* invokes/.test(r.err) && /NOT evidence/.test(r.err),
    r.err.slice(0, 200)
  );
  rmSync(d, { recursive: true, force: true });
}
{
  const d = stage(null);
  const r = run(d);
  ok("an absent workflow refuses", r.code === 2, `exit ${r.code}`);
  ok(
    "...and says UNREADABLE, not that a job or step was missing",
    /is unreadable/.test(r.err) && !/found 0 job/.test(r.err),
    r.err.slice(0, 200)
  );
  rmSync(d, { recursive: true, force: true });
}

/* ── THE PURE FUNCTIONS ─────────────────────────────────────────────────── */
{
  const lines = twoJobs(INSTALL + CHECK).split("\n");
  ok(
    "jobsIn skips `on:` keys, which have the same shape as jobs",
    jobsIn(lines)
      .map((j) => j.name)
      .join(",") === "ci,python",
    JSON.stringify(jobsIn(lines))
  );
  ok(
    "stepsIn finds every named step",
    stepsIn(lines).length === 3,
    String(stepsIn(lines).length)
  );
  const l = locate(
    twoJobs(
      `      - name: x\n        # run: pip install -r requirements.txt\n` +
        CHECK
    )
  );
  ok(
    "shellCommand cuts at a trailing shell comment",
    shellCommand("echo hi  # pip install -r requirements.txt").trim() ===
      "echo hi"
  );
  ok(
    "shellCommand is empty for a whole-line comment",
    shellCommand("   # pip install -r requirements.txt") === ""
  );
  ok(
    "locate ignores a commented install",
    l.installs.length === 0,
    JSON.stringify(l.installs)
  );
}

/* ── REPORT ─────────────────────────────────────────────────────────────── */
/* ── #879: DECLARED BEFORE IS NOT RAN BEFORE ────────────────────────────── */
/*
 * The coupling this file asserts is "same job, and before" — both facts about the FILE.
 * Two step attributes break the inference to the RUN, and each is a REFUSAL rather than a
 * failure: the install may still have run and succeeded, so the workflow can no longer be
 * READ to decide it, which is what the three refusals above already mean.
 *
 * These arms exist because a planted `continue-on-error: true` left the real checker
 * reporting the coupling SATISFIED, which is the state that made #879 a demonstration
 * rather than an argument.
 */
{
  const guard = (attr) =>
    twoJobs(`      - name: FastAPI backend tests\n        ${attr}\n        run: pip install -r requirements.txt\n${CHECK}`);

  const coe = run(stage(guard("continue-on-error: true")));
  ok(
    "an install with `continue-on-error: true` REFUSES (2), not passes",
    coe.code === 2,
    `exit ${coe.code}`
  );
  ok(
    "...and names the attribute and its line, so the reader can see what it read",
    /continue-on-error: true/.test(coe.err) && /line \d+/.test(coe.err),
    coe.err.slice(0, 160)
  );

  const cond = run(stage(guard("if: ${{ github.event_name == 'push' }}")));
  ok(
    "an install behind an `if:` REFUSES (2) — it may be skipped",
    cond.code === 2,
    `exit ${cond.code}`
  );

  /*
   * THE COMPANION, and without it the two above are satisfied by a checker that refuses on
   * ANY step attribute. `continue-on-error: false` is the default written out; it restores
   * nothing and breaks nothing, so it must NOT refuse.
   */
  const benign = run(stage(guard("continue-on-error: false")));
  ok(
    "`continue-on-error: false` is the default spelled out and does NOT refuse",
    benign.code === 0,
    `exit ${benign.code} ${benign.err.slice(0, 120)}`
  );

  /*
   * A SHELL `if` INSIDE `run:` IS NOT A STEP CONDITION. stepGuards reads at the step's own
   * attribute indent for exactly this reason; matching the keyword would refuse on a
   * perfectly ordinary install script.
   */
  const shellIf = run(
    stage(
      twoJobs(
        `      - name: FastAPI backend tests\n        run: |\n          if [ -f requirements.txt ]; then pip install -r requirements.txt; fi\n${CHECK}`
      )
    )
  );
  ok(
    "a shell `if` inside a run block is NOT read as a step condition",
    shellIf.code === 0,
    `exit ${shellIf.code} ${shellIf.err.slice(0, 140)}`
  );

  /* stepGuards in isolation, so a change to it fails here rather than three layers up. */
  const L = [
    "      - name: install",
    "        continue-on-error: true",
    "        run: pip install -r requirements.txt",
    "      - name: next",
  ];
  ok(
    "stepGuards reads only within its own step and reports key, value and line",
    stepGuards(L, 1, 4).length === 1 &&
      stepGuards(L, 1, 4)[0].key === "continue-on-error" &&
      stepGuards(L, 1, 4)[0].line === 2,
    JSON.stringify(stepGuards(L, 1, 4))
  );
}

const width = Math.max(...results.map((r) => r.name.length));
for (const r of results)
  console.log(
    `  ${r.ok ? "ok  " : "FAIL"}  ${r.name.padEnd(width)}${
      r.ok ? "" : `   ${r.detail ?? ""}`
    }`
  );
const EXPECTED = 31; // acceptance 4, rejection 10, refusal 6, pure 5, #879 6
if (results.length !== EXPECTED) {
  console.error(`\nFAIL: ${results.length} cases ran, ${EXPECTED} expected.`);
  process.exit(1);
}
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
