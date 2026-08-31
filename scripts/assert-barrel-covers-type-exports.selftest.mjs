#!/usr/bin/env node
/**
 * Proof for assert-barrel-covers-type-exports.mjs.
 *
 * EVERY CASE ASSERTS WHICH RULE SPOKE, not merely that something did. A fixture that drops a
 * type export from a barrel can easily violate more than one rule at once, and an exit code
 * cannot attribute a failure — so a case matching only on non-zero would pass while the rule it
 * names never fired. ARCHITECT hit exactly this on #512 tonight: removing their retraction check
 * left the suite green, because the planted row also broke a pre-existing rule that failed
 * first. That gets WORSE as a checker gets better, since a richer checker has more rules that
 * can fire first.
 *
 * The fixtures are whole miniature packages — tsconfig and all — because the instrument is a
 * PROGRAM, and a program is what the refusals are about.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { check } from "./assert-barrel-covers-type-exports.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CHECKER = join(HERE, "assert-barrel-covers-type-exports.mjs");

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

const TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      skipLibCheck: true,
      noEmit: true,
    },
    include: ["src"],
  },
  null,
  2
);

/** A miniature package: { "src/index.ts": "...", ... }. `tsconfig:false` omits it. */
function pkg(files, { tsconfig = TSCONFIG } = {}) {
  const d = mkdtempSync(join(tmpdir(), "typeexp-"));
  mkdirSync(join(d, "src"), { recursive: true });
  if (tsconfig !== false) writeFileSync(join(d, "tsconfig.json"), tsconfig);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(d, rel)), { recursive: true });
    writeFileSync(join(d, rel), body);
  }
  return d;
}
function run(dir) {
  ran++;
  try {
    return { code: 0, out: execFileSync(process.execPath, [CHECKER, "--package", dir], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

console.log("assert-barrel-covers-type-exports selftest\n");

// ── REJECT: a type export the barrel does not re-export ───────────────────────────────────
{
  const d = pkg({
    "src/m.ts": "export type Kept = { a: number };\nexport type Dropped = { b: string };\n",
    "src/index.ts": 'export type { Kept } from "./m";\n',
  });
  const r = run(d);
  if (r.code === 1 && /FAIL: 1 type export\(s\)/.test(r.out) && /m\.ts\s+Dropped/.test(r.out))
    ok(
      "REJECT  a dropped type export is named, by THIS rule",
      "exit 1 with the missing-type rule speaking and the symbol named"
    );
  else bad("REJECT dropped type export", `exit=${r.code}`, r.out);
  rmSync(d, { recursive: true, force: true });
}

// ── ACCEPT: a barrel that covers them ─────────────────────────────────────────────────────
{
  const d = pkg({
    "src/m.ts": "export type Kept = { a: number };\n",
    "src/index.ts": 'export type { Kept } from "./m";\n',
  });
  const r = run(d);
  if (r.code === 0 && /1 type export\(s\) checked/.test(r.out))
    ok(
      "ACCEPT  a covered barrel passes, and says how many it checked",
      "the subject printed on success, so a guard that lost it cannot print PASS"
    );
  else bad("ACCEPT covered barrel", `exit=${r.code}`, r.out);
  rmSync(d, { recursive: true, force: true });
}

// ── THE ALIAS PIN — the mistake that made this checker confidently wrong ───────────────────
{
  /*
   * `export type { X } from "./m"` yields an ALIAS symbol whose own flags say Alias and nothing
   * else. Classifying on those reported the barrel as exporting ZERO types — which would have
   * called every type export missing, and here would REFUSE with "resolved to ZERO exports".
   * Asserting the exit code alone would not tell those apart, so the message is asserted.
   */
  const d = pkg({
    "src/m.ts": "export type A = { a: 1 };\nexport type B = { b: 2 };\n",
    "src/index.ts": 'export type { A, B } from "./m";\n',
  });
  const r = run(d);
  if (r.code === 0 && /barrel of 2 type \+ 0 value/.test(r.out))
    ok(
      "ALIAS   a re-exported type is SEEN as a barrel export, not counted as zero",
      "the barrel read as 2 types rather than 0 — the wrong answer would have been confident"
    );
  else bad("alias resolution", `exit=${r.code} — a barrel of 0 types means aliases went unresolved`, r.out);
  rmSync(d, { recursive: true, force: true });
}

// ── THE TWO INSTRUMENTS DO NOT OVERLAP ────────────────────────────────────────────────────
{
  // A class has BOTH a value and a type side, so it belongs to the runtime guard's subject.
  // Counting it here would make the two instruments overlap and disagree about the same name.
  const d = pkg({
    "src/m.ts": "export class Both { x = 1; }\nexport type Only = { a: 1 };\n",
    "src/index.ts": 'export { Both } from "./m";\nexport type { Only } from "./m";\n',
  });
  const r = run(d);
  if (r.code === 0 && /1 type export\(s\) checked/.test(r.out))
    ok(
      "SUBJECT a class is NOT a type-only export — it is the runtime guard's",
      "1 counted, not 2: the two instruments keep disjoint subjects"
    );
  else bad("class is not type-only", `exit=${r.code}`, r.out);
  rmSync(d, { recursive: true, force: true });
}

// ── REFUSE: no program ────────────────────────────────────────────────────────────────────
{
  const d = pkg({ "src/index.ts": "export type A = 1;\n" }, { tsconfig: false });
  const r = run(d);
  if (r.code === 2 && /no tsconfig at/.test(r.out))
    ok("REFUSE  a package with no tsconfig exits 2", "no program, no verdict");
  else bad("REFUSE no tsconfig", `exit=${r.code}`, r.out);
  rmSync(d, { recursive: true, force: true });
}
{
  const d = pkg(
    { "src/index.ts": "export type A = 1;\n" },
    { tsconfig: JSON.stringify({ include: ["nothing-here"] }) }
  );
  const r = run(d);
  if (r.code === 2 && /ZERO files/.test(r.out))
    ok(
      "REFUSE  a tsconfig matching no files exits 2, not 'no missing types'",
      "an empty program refusing rather than reporting a clean barrel"
    );
  else bad("REFUSE zero files", `exit=${r.code}`, r.out);
  rmSync(d, { recursive: true, force: true });
}
{
  const d = pkg({
    "src/m.ts": "export type A = 1;\n",
    "src/index.ts": "const internal = 1;\nexport {};\n",
  });
  const r = run(d);
  if (r.code === 2 && /resolved to ZERO exports/.test(r.out))
    ok(
      "REFUSE  a barrel exporting nothing exits 2 rather than failing on everything",
      "zero-export barrel told apart from a barrel that dropped one"
    );
  else bad("REFUSE empty barrel", `exit=${r.code}`, r.out);
  rmSync(d, { recursive: true, force: true });
}

// ── the exception list works, and only for what it names ──────────────────────────────────
{
  ran++;
  const d = pkg({
    "src/m.ts": "export type Internal = 1;\nexport type AlsoMissing = 2;\n",
    "src/index.ts": "export {};\nexport type Anchor = 0;\n",
  });
  const r = check({ pkg: d, notPublic: { Internal: "stated reason" } });
  const names = r.missing.map((m) => m.name);
  if (names.length === 1 && names[0] === "AlsoMissing")
    ok(
      "NOT_PUBLIC excuses exactly what it names and nothing else",
      "one excused, one still reported — an exception list that cannot over-reach"
    );
  else bad("NOT_PUBLIC scope", `missing=${JSON.stringify(names)}`);
  rmSync(d, { recursive: true, force: true });
}

// ── AND THE REAL PACKAGE ──────────────────────────────────────────────────────────────────
{
  const r = run(join(ROOT, "packages/react"));
  if (r.code === 0 && /21 module\(s\)/.test(r.out))
    ok(
      "the real package passes, over a subject the output names",
      "21 modules and 60 type exports, not a bare PASS"
    );
  else bad("real package", `exit=${r.code}`, r.out);
}

const EXPECTED = 9;
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
