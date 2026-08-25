#!/usr/bin/env node
/**
 * Selftest for check-palette.mjs.
 *
 * BASELINE-ACCEPT RUNS FIRST, and that ordering is the point. A checker that
 * rejects EVERY input looks identical to one that rejects the right inputs if
 * you only ever run rejection cases. That is not hypothetical here: rungs.json
 * failed its own schema for exactly that reason, and the prohibition looked
 * like it held while doing nothing, because nobody had run the accept case.
 *
 * Exit 0 all pass, 1 on any failure.
 */
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scan } from "./check-palette.mjs";

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(
    `  ${
      ok ? "OK  " : "FAIL"
    } ${name}  (findings=${actual}, expected=${expected})`
  );
}

const dir = mkdtempSync(join(tmpdir(), "palette-selftest-"));
function fixture(name, contents) {
  const p = join(dir, name);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, contents, "utf8");
  return p;
}

try {
  console.log("check-palette selftest");

  // 1. THE ACCEPT CASE, FIRST. Without this every rejection below is unfalsifiable.
  check(
    "baseline: the real repo roots are clean",
    scan(["apps/example", "e2e"]).length,
    0
  );

  // 2. Semantic tokens must NOT be flagged — they are the correct answer.
  fixture(
    "ok-tokens.tsx",
    `
    export const A = <div className="bg-background text-foreground" />;
    export const B = <div className="bg-destructive text-primary-foreground" />;
    export const C = <div className="bg-success border-border ring-ring" />;
  `
  );
  check("accepts semantic tokens", scan([dir]).length, 0);
  rmSync(join(dir, "ok-tokens.tsx"));

  // 3. A hardcoded class must be rejected.
  fixture("bad.tsx", `export const A = <div className="bg-red-500" />;`);
  check("rejects bg-red-500", scan([dir]).length, 1);
  rmSync(join(dir, "bad.tsx"));

  // 4. A RARE hue must be rejected too — the enumeration must not be
  //    "the colours whoever wrote this happened to think of".
  fixture(
    "rare.tsx",
    `export const A = <div className="text-fuchsia-300 border-lime-700" />;`
  );
  check("rejects rare hues (fuchsia, lime)", scan([dir]).length, 2);
  rmSync(join(dir, "rare.tsx"));

  // 5. Non-bg prefixes must be rejected — this is where the E2E specs lived.
  fixture(
    "prefix.tsx",
    `export const A = <div className="text-emerald-400 ring-sky-200" />;`
  );
  check("rejects non-bg prefixes", scan([dir]).length, 2);
  rmSync(join(dir, "prefix.tsx"));

  // 6. A class named only inside a COMMENT must be accepted. The fix for the
  //    six broken E2E tests documents the old class names in a comment
  //    explaining why the assertion moved off them; flagging that would punish
  //    writing the reason down, and the reason is the durable part.
  fixture(
    "comment.ts",
    `
    // This asserted bg-red-500 until #60 reskinned the app.
    /* and bg-blue-600 stood in for "selected" */
    export const A = "bg-destructive";
  `
  );
  check("accepts hardcoded names inside comments", scan([dir]).length, 0);
  rmSync(join(dir, "comment.ts"));

  // 7. A non-existent root contributes nothing rather than throwing.
  check("tolerates a missing root", scan([join(dir, "nope")]).length, 0);

  // ── 8-10. THE CLI ENTRY POINT ────────────────────────────────────────────
  //
  // Everything above imports scan() directly, which can NEVER reach the
  // `isEntryPoint()` branch. That left the one part of this script capable of
  // silently doing nothing as the one part with no coverage — and it did
  // exactly that: the original guard compared `import.meta.url` (realpath-
  // resolved) against `process.argv[1]` (not), so invoking through any
  // symlinked path skipped main() and exited 0 in silence. It was reported as
  // a clean result on a directory holding 237 findings.
  //
  // So these spawn the real script as a subprocess, and case 10 goes through a
  // symlink on purpose. A selftest that only exercises the library half cannot
  // catch a broken entry point.
  const SCRIPT = fileURLToPath(new URL("./check-palette.mjs", import.meta.url));
  const run = (scriptPath, roots) =>
    spawnSync(process.execPath, [scriptPath, ...roots], { encoding: "utf8" });

  const cleanRoot = join(dir, "cliclean");
  mkdirSync(cleanRoot, { recursive: true });
  writeFileSync(
    join(cleanRoot, "ok.tsx"),
    'export const A = <div className="bg-card" />;'
  );
  const okRun = run(SCRIPT, [cleanRoot]);
  check("CLI exits 0 on a clean root", okRun.status, 0);
  check(
    "CLI actually PRODUCED OUTPUT (it ran at all)",
    okRun.stdout.trim().length > 0 ? 1 : 0,
    1
  );

  const dirtyRoot = join(dir, "clidirty");
  mkdirSync(dirtyRoot, { recursive: true });
  writeFileSync(
    join(dirtyRoot, "bad.tsx"),
    'export const A = <div className="bg-red-500" />;'
  );
  check("CLI exits 1 on a violating root", run(SCRIPT, [dirtyRoot]).status, 1);

  // The regression test for the guard. Same script, same input, reached
  // through a symlink — must behave identically.
  const linked = join(dir, "linked-check-palette.mjs");
  symlinkSync(SCRIPT, linked);
  const viaLink = run(linked, [dirtyRoot]);
  check("CLI exits 1 when invoked THROUGH A SYMLINK", viaLink.status, 1);
  check(
    "CLI produced output through a symlink (did not silently no-op)",
    viaLink.stdout.trim().length > 0 ? 1 : 0,
    1
  );

  console.log(
    failures === 0
      ? "\nall selftests passed."
      : `\n${failures} selftest(s) FAILED.`
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failures === 0 ? 0 : 1);
