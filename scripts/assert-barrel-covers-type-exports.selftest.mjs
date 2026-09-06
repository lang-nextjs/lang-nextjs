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
import { execFileSync, spawnSync } from "node:child_process";
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
  if (out)
    console.error(
      String(out)
        .split("\n")
        .slice(0, 10)
        .map((l) => `          | ${l}`)
        .join("\n")
    );
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
    return {
      code: 0,
      out: execFileSync(process.execPath, [CHECKER, "--package", dir], {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

console.log("assert-barrel-covers-type-exports selftest\n");

// ── REJECT: a type export the barrel does not re-export ───────────────────────────────────
{
  const d = pkg({
    "src/m.ts":
      "export type Kept = { a: number };\nexport type Dropped = { b: string };\n",
    "src/index.ts": 'export type { Kept } from "./m";\n',
  });
  const r = run(d);
  if (
    r.code === 1 &&
    /FAIL: 1 type export\(s\)/.test(r.out) &&
    /m\.ts\s+Dropped/.test(r.out)
  )
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
  else
    bad(
      "alias resolution",
      `exit=${r.code} — a barrel of 0 types means aliases went unresolved`,
      r.out
    );
  rmSync(d, { recursive: true, force: true });
}

// ── THE TWO INSTRUMENTS DO NOT OVERLAP ────────────────────────────────────────────────────
{
  // A class has BOTH a value and a type side, so it belongs to the runtime guard's subject.
  // Counting it here would make the two instruments overlap and disagree about the same name.
  const d = pkg({
    "src/m.ts": "export class Both { x = 1; }\nexport type Only = { a: 1 };\n",
    "src/index.ts":
      'export { Both } from "./m";\nexport type { Only } from "./m";\n',
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
  const d = pkg(
    { "src/index.ts": "export type A = 1;\n" },
    { tsconfig: false }
  );
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
  /*
   * THE COUNT IS READ OUT, NOT PINNED. This asserted `/21 module\(s\)/`, which is an
   * equality against the number of modules packages/react happened to contain the day it
   * was written — so it was a scheduled failure that fires on whoever adds the next file,
   * and it did: #856 added one module and this case went red naming "real package", which
   * points at the package rather than at the constant. The stated reason was "21 modules
   * and 60 type exports, not a bare PASS", and the type-export half had ALREADY drifted to
   * 62 without anyone noticing, because nothing compared it.
   *
   * WHAT THE NUMBER WAS FOR IS ALREADY PROVEN ABOVE. Its job was to rule out a pass over
   * nothing — and the three REFUSE cases earlier in this file do that directly: a package
   * with no tsconfig, a tsconfig matching no files, and a barrel exporting nothing all exit
   * 2. So the real-package case does not need a magic number to carry non-vacuity; it needs
   * to show the checker works on the real package AND names what it examined.
   *
   * So: require that the output states both counts and that neither is zero, and echo the
   * observed pair into the pass line. A drop to zero still fails; growth does not.
   */
  const m = /(\d+) module\(s\), (\d+) type export\(s\)/.exec(r.out);
  const modules = m ? Number(m[1]) : 0;
  const types = m ? Number(m[2]) : 0;
  // THE PROPERTY, ASSERTED AS TEXT and not inferred from exit 0 alone: a checker that
  // exited 0 because it examined nothing would satisfy the status but not this line.
  const stated = /every module type export is reachable from the barrel/.test(
    r.out
  );
  if (r.code === 0 && stated && m && modules > 0 && types > 0)
    ok(
      "the real package passes, over a subject the output names",
      `${modules} modules and ${types} type exports, not a bare PASS`
    );
  else
    bad(
      "real package",
      `exit=${r.code} parsed=${JSON.stringify(m && m[0])}`,
      r.out
    );
}

/*
 * #842 CLASS A: A MISSING typescript IS A REFUSAL, NOT A VIOLATION.
 *
 * This checker's `import ts from "typescript"` was static, and a static import is RESOLVED
 * BEFORE ANY OF THE FILE'S CODE RUNS — so in a tree without node_modules it could not refuse,
 * could not name what it needed, and exited 1, the code reserved for a property being
 * VIOLATED. An uninstalled tree read as a defect in the repository.
 *
 * PLANTED WITHOUT TOUCHING node_modules. A loader registered via `module.register` makes the
 * one specifier unresolvable for the child process only. Moving `node_modules/typescript`
 * aside would work and is not worth it: a crash mid-plant would leave every checker in the
 * repository broken, and this proof would be the cause.
 *
 * THE NAMING COMPANION IS NOT DECORATION. Exit 2 alone cannot say WHICH refusal fired — this
 * checker has others — so a case asserting only the status would be satisfied by any of them.
 * That is the pair DEV3 broke on #845 to prove the point: two labels on one test.
 */
{
  const dir = mkdtempSync(join(tmpdir(), "hide-ts-"));
  writeFileSync(
    join(dir, "hide.mjs"),
    `export async function resolve(s, c, next) {\n` +
      `  if (s === "typescript") { const e = new Error("Cannot find package 'typescript'"); e.code = "ERR_MODULE_NOT_FOUND"; throw e; }\n` +
      `  return next(s, c);\n}\n`
  );
  writeFileSync(
    join(dir, "register.mjs"),
    `import { register } from "node:module";\nregister("./hide.mjs", import.meta.url);\n`
  );

  const hidden = spawnSync(
    process.execPath,
    ["--import", join(dir, "register.mjs"), CHECKER],
    { encoding: "utf8" }
  );
  ran++;
  hidden.status === 2
    ? ok(
        "typescript being unimportable exits 2, not 1",
        "an absent parser refuses instead of claiming a violation"
      )
    : bad(
        "typescript being unimportable exits 2, not 1",
        `exited ${hidden.status}`,
        (hidden.stdout ?? "") + (hidden.stderr ?? "")
      );

  const said = /typescript could not be imported/.test(
    (hidden.stdout ?? "") + (hidden.stderr ?? "")
  );
  ran++;
  said
    ? ok(
        "...and names typescript rather than refusing anonymously",
        "the refusal says which instrument was missing"
      )
    : bad(
        "...and names typescript rather than refusing anonymously",
        "refused without naming the dependency",
        (hidden.stdout ?? "") + (hidden.stderr ?? "")
      );

  const present = spawnSync(process.execPath, [CHECKER], { encoding: "utf8" });
  const falseAlarm = /typescript could not be imported/.test(
    (present.stdout ?? "") + (present.stderr ?? "")
  );
  ran++;
  !falseAlarm
    ? ok(
        "...and does NOT claim that when typescript is present",
        "the companion: the refusal is caused by absence, not emitted always"
      )
    : bad(
        "...and does NOT claim that when typescript is present",
        "claimed typescript was missing in a tree where it resolves"
      );

  rmSync(dir, { recursive: true, force: true });
}

const EXPECTED = 12; // +3 for #842 class A
console.log();
if (ran !== EXPECTED) {
  console.error(
    `FAIL: ran ${ran} case(s), expected ${EXPECTED} — the harness is broken.`
  );
  process.exit(1);
}
if (fail) {
  console.error(`FAIL: ${fail}/${ran}. The checker is NOT trustworthy.`);
  process.exit(1);
}
console.log(`PASS: ${pass}/${ran}. Watched:`);
for (const w of watched) console.log(`      - ${w}`);
