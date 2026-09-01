#!/usr/bin/env node
/**
 * PROVE `pnpm format` USES THE PINNED PRETTIER — IN THE CONFIGURATION THAT BREAKS.
 *
 * The obvious proof is "run it and see 2.8.8". That passes on any machine where
 * install has already run, which is every machine except the one this fixes. The
 * case is a tree with NO node_modules, so every case here builds a synthetic tree
 * and copies scripts/format.mjs into it: the script resolves its root from its own
 * location, so a synthetic tree IS the broken configuration rather than a
 * simulation of one.
 *
 * THE SHARPEST CASE IS THE PATH DECOY. A script that merely stopped crashing would
 * pass a "does it run" test while still picking up whatever `prettier` is first on
 * PATH — which is the actual defect, since npx's cached 3.9.6 is exactly such a
 * binary. So one case puts a DIFFERENT prettier earlier on PATH and requires the
 * workspace one to win. Without it, "it printed a version" proves nothing about
 * WHICH tool answered.
 *
 * Usage: node scripts/format.selftest.mjs
 */
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "format.mjs");

let pass = 0;
let fail = 0;
const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  ok ? pass++ : fail++;
};

const trees = [];
/** A synthetic repo: package.json + scripts/format.mjs, and optionally a prettier. */
function makeTree({ declared = "2.8.8", installed = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fmt-selftest-"));
  trees.push(dir);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  copyFileSync(SCRIPT, join(dir, "scripts", "format.mjs"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: "fixture",
        devDependencies: declared ? { prettier: declared } : {},
      },
      null,
      2
    ) + "\n"
  );
  if (installed) {
    const bin = join(dir, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "prettier"),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${installed}"; else echo "WORKSPACE-RAN $@"; fi\n`
    );
    chmodSync(join(bin, "prettier"), 0o755);
  }
  return dir;
}

/** A decoy `prettier` on PATH, the shape npx's cache leaves behind. */
function makeDecoy(version) {
  const dir = mkdtempSync(join(tmpdir(), "fmt-decoy-"));
  trees.push(dir);
  writeFileSync(
    join(dir, "prettier"),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version}"; else echo "DECOY-RAN $@"; fi\n`
  );
  chmodSync(join(dir, "prettier"), 0o755);
  return dir;
}

function run(dir, args = [], extraPath = null) {
  const env = { ...process.env };
  if (extraPath) env.PATH = `${extraPath}:${env.PATH}`;
  try {
    const out = execFileSync(
      "node",
      [join(dir, "scripts", "format.mjs"), ...args],
      {
        cwd: dir,
        encoding: "utf8",
        env,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    return { code: 0, out };
  } catch (e) {
    return {
      code: e.status ?? 1,
      out: String(e.stdout ?? "") + String(e.stderr ?? ""),
    };
  }
}

/* ── THE CASE THIS EXISTS FOR: no node_modules ────────────────────────────── */
{
  const r = run(makeTree({ installed: null }));
  record(
    "no node_modules refuses by name at exit 2",
    r.code === 2 && /prettier is not installed/.test(r.out),
    `exit ${r.code}`
  );
  record(
    "…and says what to run",
    /pnpm install/.test(r.out),
    /pnpm install/.test(r.out) ? "named it" : "did not"
  );
  /*
   * The load-bearing half. Resolution is not the defect — the cryptic failure is,
   * because its obvious workaround uses a different tool. If the refusal does not
   * warn against npx, this change fixed the symptom and left the class.
   */
  record(
    "…and warns against npx, which is the actual workaround people reach for",
    /npx/.test(r.out) && /--no-install/.test(r.out),
    /npx/.test(r.out) ? "warned" : "SILENT ON NPX"
  );
}

/* ── THE PINNED BINARY IS USED, AND PATH DOES NOT WIN ─────────────────────── */
{
  const tree = makeTree({ declared: "2.8.8", installed: "2.8.8" });
  const decoy = makeDecoy("3.9.6");
  const r = run(tree, ["--write", "."], decoy);
  record(
    "the workspace prettier runs even with another one earlier on PATH",
    r.code === 0 && /WORKSPACE-RAN/.test(r.out) && !/DECOY-RAN/.test(r.out),
    /DECOY-RAN/.test(r.out) ? "THE DECOY RAN" : `exit ${r.code}, workspace ran`
  );
  record(
    "…and it names the version it used",
    /prettier 2\.8\.8 \(declared 2\.8\.8\)/.test(r.out),
    /prettier 2\.8\.8/.test(r.out) ? "named" : "unnamed"
  );
  // The decoy has to be reachable, or the case above passes by having no decoy at
  // all — the same accept/reject pairing the rest of this repo's guards use.
  const decoyWorks = execFileSync(join(decoy, "prettier"), ["--version"], {
    encoding: "utf8",
  }).trim();
  record(
    "the decoy is genuinely runnable (so the case above had something to lose to)",
    decoyWorks === "3.9.6",
    decoyWorks
  );
}

/* ── A PIN THAT IS NOT HONOURED ───────────────────────────────────────────── */
{
  const r = run(makeTree({ declared: "2.8.8", installed: "3.9.6" }));
  record(
    "declared 2.8.8 with 3.9.6 installed refuses at exit 2",
    r.code === 2 &&
      /pins prettier 2\.8\.8 and 3\.9\.6 is installed/.test(r.out),
    `exit ${r.code}`
  );
}

/* ── A RANGE IS ALLOWED, AND SAID TO BE ONE ───────────────────────────────── */
{
  const r = run(makeTree({ declared: "^2.8.0", installed: "2.8.8" }), [
    "--write",
    ".",
  ]);
  record(
    "a RANGE is accepted and named as a range",
    r.code === 0 && /a range/.test(r.out),
    r.code === 0 ? "accepted" : `exit ${r.code}`
  );
}

/* ── DEFAULTS AND PASS-THROUGH ────────────────────────────────────────────── */
{
  const tree = makeTree({ installed: "2.8.8" });
  const dflt = run(tree);
  record(
    "with no arguments it formats the tree (--write .)",
    /WORKSPACE-RAN --write \./.test(dflt.out),
    dflt.out.match(/WORKSPACE-RAN.*/)?.[0] ?? "no invocation"
  );
  const passed = run(tree, ["--check", "src/x.ts"]);
  record(
    "arguments are passed through rather than swallowed",
    /WORKSPACE-RAN --check src\/x\.ts/.test(passed.out),
    passed.out.match(/WORKSPACE-RAN.*/)?.[0] ?? "no invocation"
  );
}

/* ── REPORT ───────────────────────────────────────────────────────────────── */
for (const d of trees) rmSync(d, { recursive: true, force: true });

const width = Math.max(...results.map((r) => r.name.length));
for (const r of results)
  console.log(
    `  ${r.ok ? "ok  " : "FAIL"} ${r.name.padEnd(width)}  (${r.detail})`
  );
console.log();
if (fail) {
  console.error(`FAIL: ${fail}/${results.length} cases wrong.`);
  process.exit(1);
}
console.log(
  `PASS: ${pass}/${results.length}. Proven in a tree with NO node_modules — the\n` +
    `      configuration the fix is for — and against a decoy prettier earlier on PATH.`
);
