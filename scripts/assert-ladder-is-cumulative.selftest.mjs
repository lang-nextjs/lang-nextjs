#!/usr/bin/env node
/**
 * Proof for assert-ladder-is-cumulative.mjs (#788).
 *
 * THE ACCEPTANCE CASES ARE NOT DECORATION HERE. A checker that refuses every manifest would
 * satisfy every rejection below, and this repo has shipped a rejection-only suite before. Three
 * cases assert exit 0 — the REAL manifest, a shorter chain, and a ONE-RUNG manifest — and the
 * last is load-bearing for a different reason: one rung is the shape of an ejected fork, which
 * is exactly where a checker that spuriously refuses would do the most damage.
 *
 * EVERY REFUSAL IS ASSERTED BY ITS MESSAGE, not by exit 2. This checker has two refusal paths
 * and both print COULD NOT COMPUTE, so the code alone cannot say which one answered — the
 * defect #767 exists to remove, and one its own repair reproduced once.
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
  violations,
  retainSet,
  danglingComplaint,
} from "./assert-ladder-is-cumulative.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHECKER = join(ROOT, "scripts", "assert-ladder-is-cumulative.mjs");

let pass = 0;
const results = [];
const ok = (name, cond, detail) => {
  results.push({ name, ok: !!cond, detail });
  if (cond) pass++;
};

const chain = (ids) =>
  ids.map((id, i) => ({
    id,
    ordinal: i + 1,
    requires: i === 0 ? [] : [ids[i - 1]],
  }));

/** A tree holding only what the checker reads: the script, lib/, and a manifest. */
function stage(manifest) {
  const dir = mkdtempSync(join(tmpdir(), "ladder-"));
  mkdirSync(join(dir, "scripts", "lib"), { recursive: true });
  copyFileSync(
    CHECKER,
    join(dir, "scripts", "assert-ladder-is-cumulative.mjs")
  );
  for (const f of readdirSync(join(ROOT, "scripts", "lib")))
    copyFileSync(
      join(ROOT, "scripts", "lib", f),
      join(dir, "scripts", "lib", f)
    );
  if (manifest !== null)
    writeFileSync(join(dir, "rungs.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

function run(dir) {
  try {
    const out = execFileSync(
      process.execPath,
      [join(dir, "scripts", "assert-ladder-is-cumulative.mjs")],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    return { code: 0, out, err: "" };
  } catch (e) {
    return { code: e.status ?? -1, out: e.stdout ?? "", err: e.stderr ?? "" };
  }
}

/* ── ACCEPTANCE ─────────────────────────────────────────────────────────── */
{
  const r = run(ROOT);
  ok(
    "the REAL manifest in this tree is cumulative",
    r.code === 0,
    `exit ${r.code} ${r.err.slice(0, 120)}`
  );
  ok(
    "...and reports a subject the runner can read",
    /SUBJECT: \d+ rung/.test(r.out),
    r.out.slice(0, 80)
  );
}
{
  const d = stage({ rungs: chain(["a", "b", "c"]) });
  const r = run(d);
  ok(
    "a THREE-rung chain passes — the count is not hardcoded",
    r.code === 0,
    `exit ${r.code}`
  );
  ok(
    "...and its subject is 3, not 5",
    /SUBJECT: 3 rung/.test(r.out),
    r.out.slice(0, 80)
  );
  rmSync(d, { recursive: true, force: true });
}
{
  const d = stage({ rungs: chain(["only"]) });
  const r = run(d);
  ok(
    "a ONE-rung manifest passes — an ejected fork must not refuse",
    r.code === 0,
    `exit ${r.code} ${r.err.slice(0, 120)}`
  );
  rmSync(d, { recursive: true, force: true });
}

/* ── REJECTION, each asserted by its message ────────────────────────────── */
{
  const rungs = chain(["a", "b", "c", "d"]);
  rungs[3].requires = ["a"]; // skips b and c — retain(d) = {d,a}
  const d = stage({ rungs });
  const r = run(d);
  ok(
    "a rung that SKIPS its predecessors fails",
    r.code === 1,
    `exit ${r.code}`
  );
  ok(
    "...and names the rungs it does not retain, not merely that it failed",
    /NOT CUMULATIVE/.test(r.err) && /\bb\b/.test(r.err) && /\bc\b/.test(r.err),
    r.err.slice(0, 160)
  );
  rmSync(d, { recursive: true, force: true });
}
{
  const rungs = chain(["a", "b"]);
  rungs[0].requires = ["b"]; // the base requires the rung above it
  const d = stage({ rungs });
  const r = run(d);
  ok("a rung requiring one ABOVE itself fails", r.code === 1, `exit ${r.code}`);
  ok(
    "...and says it retains above itself",
    /retains ABOVE itself/.test(r.err),
    r.err.slice(0, 160)
  );
  rmSync(d, { recursive: true, force: true });
}
{
  const rungs = chain(["a", "b", "c"]);
  rungs[2].ordinal = 2; // duplicated ordinal
  const d = stage({ rungs });
  const r = run(d);
  ok(
    "a duplicated ordinal REFUSES, it does not fail",
    r.code === 2,
    `exit ${r.code}`
  );
  ok(
    "...and says ORDINALS are what it could not use — not that the manifest was unreadable",
    /COULD NOT COMPUTE/.test(r.err) && /ordinals must be/.test(r.err),
    r.err.slice(0, 160)
  );
  rmSync(d, { recursive: true, force: true });
}
{
  const d = stage(null); // no rungs.json at all
  const r = run(d);
  ok("an absent manifest REFUSES", r.code === 2, `exit ${r.code}`);
  ok(
    "...and says it was UNREADABLE — the other refusal's message must not answer here",
    /COULD NOT COMPUTE/.test(r.err) && /unreadable/.test(r.err),
    r.err.slice(0, 160)
  );
  rmSync(d, { recursive: true, force: true });
}
{
  const d = stage({ rungs: [] });
  const r = run(d);
  ok(
    "an EMPTY rung list refuses rather than passing vacuously",
    r.code === 2,
    `exit ${r.code}`
  );
  ok("...and says so", /declares no rungs/.test(r.err), r.err.slice(0, 160));
  rmSync(d, { recursive: true, force: true });
}

{
  /*
   * A DANGLING `requires` REFUSES RATHER THAN FAILING (#793 review, DEV3-lang).
   *
   * This manifest would otherwise produce a cumulativity FAILURE — retain(c) = {c}, which is
   * not {ordinal <= 3} — with a true sentence about the wrong cause. The refusal has to come
   * first or the diagnosis names the ladder when the defect is a typo.
   */
  const rungs = chain(["a", "b", "c"]);
  rungs[2].requires = ["b-typo"];
  const d = stage({ rungs });
  const r = run(d);
  ok(
    "a dangling requires REFUSES, it does not report a broken ladder",
    r.code === 2,
    `exit ${r.code}`
  );
  ok(
    "...and names the missing id — not ordinals, not unreadable, not cumulativity",
    /COULD NOT COMPUTE/.test(r.err) &&
      /b-typo/.test(r.err) &&
      !/NOT CUMULATIVE/.test(r.err) &&
      !/ordinals must be/.test(r.err),
    r.err.slice(0, 160)
  );
  rmSync(d, { recursive: true, force: true });
}

/* ── THE PURE FUNCTIONS, where the render path cannot reach ─────────────── */
{
  const rungs = chain(["a", "b", "c"]);
  ok(
    "retainSet is the downward closure",
    [...retainSet(rungs, "c")].sort().join(",") === "a,b,c"
  );
  ok(
    "retainSet of the base is the base alone",
    [...retainSet(rungs, "a")].join(",") === "a"
  );
  ok("a cumulative chain has no violations", violations(rungs).length === 0);
  const broken = chain(["a", "b", "c"]);
  broken[2].requires = ["a"];
  const v = violations(broken);
  ok(
    "danglingComplaint passes a manifest whose ids all resolve",
    danglingComplaint(rungs) === null
  );
  ok(
    "a skip is reported against the SKIPPING rung",
    v.length === 1 && v[0].id === "c",
    JSON.stringify(v)
  );
  ok(
    "...naming the rung it fails to retain",
    v[0]?.missing.join(",") === "b",
    JSON.stringify(v[0])
  );
}

/* ── REPORT ─────────────────────────────────────────────────────────────── */
const width = Math.max(...results.map((r) => r.name.length));
for (const r of results)
  console.log(
    `  ${r.ok ? "ok  " : "FAIL"}  ${r.name.padEnd(width)}${
      r.ok ? "" : `   ${r.detail ?? ""}`
    }`
  );
const EXPECTED = 23; // acceptance 5, rejection 12, pure 6
const total = results.length;
if (total !== EXPECTED) {
  console.error(
    `\nFAIL: ${total} cases ran, ${EXPECTED} expected — a case was added or lost.`
  );
  process.exit(1);
}
console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
