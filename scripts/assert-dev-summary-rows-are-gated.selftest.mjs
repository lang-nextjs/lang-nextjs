#!/usr/bin/env node
/**
 * Proof for assert-dev-summary-rows-are-gated.mjs (#878).
 *
 * THE RED ARM IS THE HISTORICAL DEFECT. It removes the guard from the queue-agent row,
 * which is exactly what main carried until #878 — a row printing a URL for a service the
 * script had just said it was skipping.
 *
 * PRINTS EACH CASE AS IT RUNS rather than collecting and rendering at the end. A reporting
 * loop placed above the count constant is how six cases in another proof executed, counted,
 * and printed nothing while the count guard stayed satisfied. There is no loop here to
 * place wrongly.
 *
 * THE MUTANTS LIVE IN A TEMP TREE. A copy under scripts/ would join the subject of
 * assert-formatted and assert-checkers-registered, so proving this checker would fail two
 * others — the trap DEV2 hit on #823.
 */
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { boxOf, GATED_ROWS } from "./assert-dev-summary-rows-are-gated.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = "assert-dev-summary-rows-are-gated.mjs";
const REAL = readFileSync(join(ROOT, "scripts", "dev-all.sh"), "utf8");

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) {
    pass++;
    console.log(`  ok    ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}   ${detail ?? ""}`);
  }
};

function stage(devAll) {
  const dir = mkdtempSync(join(tmpdir(), "devbox-"));
  mkdirSync(join(dir, "scripts", "lib"), { recursive: true });
  copyFileSync(join(ROOT, "scripts", SCRIPT), join(dir, "scripts", SCRIPT));
  for (const f of readdirSync(join(ROOT, "scripts", "lib")))
    copyFileSync(
      join(ROOT, "scripts", "lib", f),
      join(dir, "scripts", "lib", f)
    );
  writeFileSync(join(dir, "scripts", "dev-all.sh"), devAll);
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
  const r = run(stage(REAL));
  ok(
    "the REAL dev-all.sh passes",
    r.code === 0,
    `exit ${r.code} ${r.err.slice(0, 120)}`
  );
  ok(
    "...and reports a subject, so a pass over nothing is distinguishable",
    /SUBJECT: 3 summary row\(s\)/.test(r.out),
    r.out.split("\n")[0]
  );
}

/* ── RED: the historical defect, one row at a time ──────────────────────── */
for (const { label } of GATED_ROWS) {
  const broken = REAL.split("\n")
    .map((l) =>
      l.includes(`"${label}"`) && l.includes('[ "$HAS_OPENSWE" = "1" ] && ')
        ? l.replace('[ "$HAS_OPENSWE" = "1" ] && ', "")
        : l
    )
    .join("\n");
  const r = run(stage(broken));
  ok(
    `RED: an ungated "${label}" row FAILS (exit 1)`,
    r.code === 1,
    `exit ${r.code}`
  );
  ok(
    `...and the failure names that row`,
    r.err.includes(label),
    r.err.slice(0, 140)
  );
}

/*
 * THE COMPANION, and without it every arm above is satisfied by a checker that demands a
 * guard on EVERY row. `model backend` is deliberately ungated — `--no-backend` means "use
 * an already-running :8001 (or none)", so its URL may be live and correct. A checker that
 * failed on it would be wrong about the artifact, not stricter.
 */
{
  const r = run(stage(REAL));
  ok(
    "the deliberately UNGATED `model backend` row does not fail",
    r.code === 0 && REAL.includes(`printf '   %-26s %s\\n' "model backend"`),
    "either the checker over-reaches or that row has changed shape"
  );
}

/* ── REFUSALS: could not ask, not answered no ───────────────────────────── */
{
  /*
   * RENAME THE BOX ROW, NOT THE FIRST MATCH. `"queue agent"` also appears at the
   * `wait_for` call several hundred lines earlier, and a bare `.replace` takes that one —
   * leaving the box untouched and the checker correctly passing, which reads as the
   * refusal failing to fire. Anchored on the printf so it can only hit the row.
   */
  const renamed = REAL.replace(
    /(printf '   %-26s %s\\n' )"queue agent"/,
    '$1"run queue"'
  );
  const r = run(stage(renamed));
  ok(
    "a RENAMED row refuses (2) rather than passing",
    r.code === 2,
    `exit ${r.code}`
  );
  ok(
    "...and says THIS RUN is not evidence it is gated wherever it went",
    /NOT evidence/.test(r.err),
    r.err.slice(0, 140)
  );

  const noBox = REAL.split("\n")
    .filter((l) => !/^echo "\s*─{20,}"$/.test(l.trim()))
    .join("\n");
  const r2 = run(stage(noBox));
  ok(
    "a script with no summary box refuses (2)",
    r2.code === 2,
    `exit ${r2.code}`
  );
}

/* ── PURE ───────────────────────────────────────────────────────────────── */
{
  const box = boxOf(REAL);
  ok(
    "boxOf finds the box by its rules, not by line number",
    box !== null && box.length > 0,
    String(box && box.length)
  );
  ok(
    "...and every gated row it returns is inside the box",
    GATED_ROWS.every(({ label }) =>
      box.some((r) => r.text.includes(`"${label}"`))
    ),
    JSON.stringify(box?.map((r) => r.line))
  );
}

const EXPECTED = 14; // acceptance 2, red 6 (2 per gated row), companion 1, refusal 3, pure 2
const total = pass + fail;
if (total !== EXPECTED) {
  console.log(
    `\nFAIL: ran ${total} cases, expected ${EXPECTED} — a case was added or lost.`
  );
  process.exit(1);
}
console.log(`\n${pass}/${total} passed`);
process.exit(fail === 0 ? 0 : 1);
