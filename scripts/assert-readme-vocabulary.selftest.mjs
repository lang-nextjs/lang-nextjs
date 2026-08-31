#!/usr/bin/env node
/**
 * Proof for assert-readme-vocabulary.mjs.
 *
 * THE THREE MUTATIONS THE TASK NAMED, run against whole miniature packages rather than crafted
 * strings, because the instrument is a PROGRAM and the refusals are about programs:
 *
 *   add a field to the type, leave the README      -> red, "in NEITHER"
 *   remove a field the README still describes      -> red, "does not have"
 *   rename on one side only                        -> red BOTH ways at once
 *
 * EVERY CASE ASSERTS WHICH RULE SPOKE. A rename violates both directions simultaneously, so a
 * case matching only on a non-zero exit would pass while the direction it names never fired —
 * and the stale-row direction is the one that rots quietly, so it is the one most likely to be
 * silently missing.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CHECKER = join(HERE, "assert-readme-vocabulary.mjs");

let pass = 0,
  fail = 0,
  ran = 0;
const watched = [];
const ok = (n, w) => {
  console.log(`  ok      ${n}`);
  watched.push(w);
  pass++;
};
const bad = (n, why, out) => {
  console.error(`  FAIL    ${n}\n          ${why}`);
  if (out) console.error(String(out).split("\n").slice(0, 10).map((l) => `          | ${l}`).join("\n"));
  fail++;
};

const TSCONFIG = JSON.stringify({
  compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, skipLibCheck: true, noEmit: true },
  include: ["src"],
});

/** A package with a `Rung`-like type and a README, each varied independently. */
function pkg({ fields, rows, absent = [], readme = null, tsconfig = TSCONFIG }) {
  const d = mkdtempSync(join(tmpdir(), "vocab-"));
  mkdirSync(join(d, "src"), { recursive: true });
  if (tsconfig !== false) writeFileSync(join(d, "tsconfig.json"), tsconfig);
  if (fields !== false)
    writeFileSync(
      join(d, "src/generated.ts"),
      `export interface Rung {\n${fields.map((f) => `  readonly ${f}: string;`).join("\n")}\n}\n`
    );
  const body =
    readme ??
    "# pkg\n\n## The vocabulary\n\n| Field | Meaning |\n| --- | --- |\n" +
      rows.map((r) => `| \`${r}\` | what it means |`).join("\n") +
      "\n\n## What is deliberately not here\n\n" +
      absent.map((a) => `- **\`${a}\`** — a stated reason.`).join("\n") +
      "\n";
  writeFileSync(join(d, "README.md"), body);
  return d;
}
function run(dir) {
  ran++;
  try {
    return { code: 0, out: execFileSync(process.execPath, [CHECKER, "--package", dir], {
      cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}
const kill = (d) => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

console.log("assert-readme-vocabulary selftest\n");

// ── MUTATION 1: a field added to the type, README untouched ───────────────────────────────
{
  const d = pkg({ fields: ["shape", "state", "reach"], rows: ["shape", "state"] });
  const r = run(d);
  if (r.code === 1 && /in NEITHER the table nor/.test(r.out) && /\breach\b/.test(r.out))
    ok("MUTATION a field added to the type and not the README is RED", "the undocumented-field rule speaking, naming `reach`");
  else bad("added field", `exit=${r.code}`, r.out);
  kill(d);
}

// ── MUTATION 2: a field removed from the type, README still describes it ──────────────────
{
  const d = pkg({ fields: ["shape"], rows: ["shape", "state"] });
  const r = run(d);
  if (r.code === 1 && /does not have/.test(r.out) && /\bstate\b/.test(r.out) && !/in NEITHER/.test(r.out))
    ok("MUTATION a row for a field the type lost is RED, by the STALE rule", "the quiet direction firing alone, with no undocumented-field noise");
  else bad("removed field", `exit=${r.code}`, r.out);
  kill(d);
}

// ── MUTATION 3: renamed on one side only — BOTH directions at once ────────────────────────
{
  const d = pkg({ fields: ["shape", "reachability"], rows: ["shape", "reach"] });
  const r = run(d);
  const both = /in NEITHER the table nor/.test(r.out) && /does not have/.test(r.out);
  if (r.code === 1 && both && /reachability/.test(r.out) && /\breach\b/.test(r.out))
    ok("MUTATION a one-sided rename is RED in BOTH directions, each named", "a rename reported as an addition AND a stale row, not as one vague red");
  else bad("one-sided rename", `exit=${r.code} both=${both}`, r.out);
  kill(d);
}

// ── ACCEPT: agreement, and the exclusion mechanism actually excusing ──────────────────────
{
  const d = pkg({ fields: ["shape", "state"], rows: ["shape", "state"] });
  const r = run(d);
  if (r.code === 0 && /2 row\(s\)/.test(r.out) && /2 field\(s\)/.test(r.out))
    ok("ACCEPT  agreement passes, and the counts are in the output", "the subject named on success, not a bare PASS");
  else bad("ACCEPT agreement", `exit=${r.code}`, r.out);
  kill(d);
}
{
  /*
   * THE EXCLUSION MUST ACTUALLY EXCUSE. The first version of the section parser returned the
   * EMPTY STRING — it sliced from the heading and then split on that same heading — so every
   * exclusion silently failed to register. It changed no verdict on the real README only
   * because the one exclusion there names a field the type does not have. This case is what
   * makes the mechanism observable.
   */
  const d = pkg({ fields: ["shape", "secret"], rows: ["shape"], absent: ["secret"] });
  const r = run(d);
  if (r.code === 0 && /1 declared absent/.test(r.out) && /absent: secret/.test(r.out))
    ok("ACCEPT  a field declared absent in the README is excused", "the exclusion path watched working, not assumed");
  else bad("exclusion excuses", `exit=${r.code} — an exclusion that never registers is decoration`, r.out);
  kill(d);
}
{
  // ...and only what it names.
  const d = pkg({ fields: ["shape", "secret", "other"], rows: ["shape"], absent: ["secret"] });
  const r = run(d);
  if (r.code === 1 && /\bother\b/.test(r.out) && !/NEITHER[\s\S]*secret/.test(r.out))
    ok("REJECT  an exclusion excuses only the field it names", "one excused, one still reported");
  else bad("exclusion scope", `exit=${r.code}`, r.out);
  kill(d);
}

// ── REFUSE: could not be checked ──────────────────────────────────────────────────────────
{
  const d = pkg({ fields: ["shape"], rows: [], readme: "# pkg\n\nNo table at all here.\n" });
  const r = run(d);
  if (r.code === 2 && /no table with a `Field` column/.test(r.out))
    ok("REFUSE  a README with no Field table exits 2, not 0", "no table, no comparison, no verdict");
  else bad("REFUSE no table", `exit=${r.code}`, r.out);
  kill(d);
}
{
  const d = pkg({
    fields: ["shape"],
    rows: [],
    readme: "# pkg\n\n## The vocabulary\n\n| Field | Meaning |\n| --- | --- |\n\nnothing\n",
  });
  const r = run(d);
  if (r.code === 2 && /ZERO rows/.test(r.out))
    ok("REFUSE  an EMPTY Field table exits 2 — it documents nothing", "an empty table refusing to read as agreement");
  else bad("REFUSE empty table", `exit=${r.code}`, r.out);
  kill(d);
}
{
  const d = pkg({ fields: ["shape"], rows: ["shape"], tsconfig: false });
  const r = run(d);
  if (r.code === 2 && /no tsconfig at/.test(r.out))
    ok("REFUSE  no program to read the type from exits 2", "the type side unreadable, so no claim about the table");
  else bad("REFUSE no tsconfig", `exit=${r.code}`, r.out);
  kill(d);
}
{
  const d = pkg({ fields: ["shape"], rows: ["shape"] });
  rmSync(join(d, "README.md"));
  const r = run(d);
  if (r.code === 2 && /no README at/.test(r.out))
    ok("REFUSE  no README exits 2 rather than reporting agreement", "an absent document is not an agreeing one");
  else bad("REFUSE no README", `exit=${r.code}`, r.out);
  kill(d);
}

// ── AND THE REAL PACKAGE ──────────────────────────────────────────────────────────────────
{
  const r = run(join(ROOT, "packages/rungs"));
  if (r.code === 0 && /packages\/rungs\/README\.md/.test(r.out))
    ok("the real package agrees, over a subject the output names", "the shipped README and the shipped type, both derived");
  else bad("real package", `exit=${r.code}`, r.out);
}

const EXPECTED = 11;
console.log();
if (ran !== EXPECTED) {
  console.error(`FAIL: ran ${ran} case(s), expected ${EXPECTED} — the harness is broken.`);
  process.exit(1);
}
if (fail) {
  console.error(`FAIL: ${fail}/${ran}. The checker is NOT trustworthy.`);
  process.exit(1);
}
console.log(`PASS: ${pass}/${ran}. Watched:`);
for (const w of watched) console.log(`      - ${w}`);
