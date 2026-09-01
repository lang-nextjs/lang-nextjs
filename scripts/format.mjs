#!/usr/bin/env node
/**
 * THE REPAIR USES THE SAME INSTRUMENT AS THE GATE (#618).
 *
 * `pnpm format` was `prettier --write .`, which resolves through node_modules/.bin
 * and therefore only after an install. On a fresh worktree — which is every agent's
 * worktree and every new contributor's first hour — it died with
 *
 *     sh: prettier: command not found
 *
 * and the next thing anyone types is `npx prettier --write .`. That is the defect:
 * not that the script used the wrong tool, but that it failed in a way whose
 * obvious workaround uses a different one.
 *
 * WHAT THE WORKAROUND ACTUALLY DOES. npx resolves prettier 3.9.6 here while
 * package.json pins 2.8.8, and the two disagree in BOTH directions: 3.9.6
 * reformats files the gate considers clean, and reformats a genuinely drifted file
 * differently from what the gate wants. Measured on one file: 67 added / 29 removed
 * across 16 hunks under 3.9.6 against 25/16 under 2.8.8 — 42 lines of tool
 * disagreement wearing the costume of drift. That commit was pushed before anyone
 * noticed.
 *
 * `--no-install` IS NOT THE SAFEGUARD IT LOOKS LIKE, and this is the part worth
 * knowing: in a tree WITH node_modules, `npx --no-install prettier --version`
 * answers 2.8.8, which is what makes it look safe. In a tree WITHOUT node_modules —
 * exactly the case that sends people to npx — the same command answers 3.9.6 from
 * npx's cache, with no network and no prompt. The flag prevents a DOWNLOAD, not a
 * wrong version. So this cannot be fixed by telling contributors which npx flags to
 * use; it has to be fixed where the repair is invoked.
 *
 * WHY THIS REFUSES RATHER THAN JUST POINTING AT THE BINARY. Naming the path
 * (`node_modules/.bin/prettier --write .`) fixes resolution and leaves the failure
 * mode intact: on a fresh tree it still dies with a cryptic ENOENT, and the reader
 * still invents npx. The cryptic failure IS the defect, so the fix is a refusal
 * that says what is missing and what NOT to reach for.
 *
 * The objection to a refusing `format` is that refusing is more annoying than
 * working. It would be, if the alternative worked — but `prettier --write .`
 * already fails on the tree this addresses, at exit 1, having formatted nothing.
 * The annoyance is unchanged and the information is not: exit 2 here means "the
 * question could not be asked", the same status scripts/assert-formatted.mjs uses
 * when it cannot identify a prettier, and 37 other checkers in this repo use for
 * the same distinction.
 *
 * Usage: node scripts/format.mjs [prettier args…]   (default: --write .)
 */
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "node_modules", ".bin", "prettier");

/** The version package.json asks for, or null if it asks for nothing. */
function declaredVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    return (
      (pkg.devDependencies ?? {}).prettier ??
      (pkg.dependencies ?? {}).prettier ??
      null
    );
  } catch {
    return null;
  }
}

function refuse(lines) {
  console.error("REFUSE: " + lines[0]);
  for (const l of lines.slice(1)) console.error("        " + l);
  process.exit(2);
}

const declared = declaredVersion();

if (!existsSync(BIN)) {
  refuse([
    "prettier is not installed in this workspace, so nothing was formatted.",
    "",
    `  Run:        pnpm install${
      declared ? `   (package.json pins prettier ${declared})` : ""
    }`,
    "",
    "  DO NOT reach for `npx prettier`. It resolves a DIFFERENT prettier — 3.9.6",
    "  here — while this repo pins " +
      (declared ?? "a specific version") +
      ", and the two disagree",
    "  in both directions: 3.9.6 reformats files the gate calls clean, and reformats",
    "  drifted ones differently from what the gate wants. The result looks exactly",
    "  like drift and is a tool disagreement.",
    "",
    "  `npx --no-install` does not help. With node_modules present it answers 2.8.8,",
    "  which is why it looks safe; without node_modules it answers 3.9.6 from npx's",
    "  cache. It prevents a download, not a wrong version.",
  ]);
}

/**
 * The version that will actually run, asked of the binary rather than inferred
 * from a lockfile or a package.json — this is the instrument, so it is measured
 * and not assumed.
 */
let actual;
try {
  actual = execFileSync(BIN, ["--version"], { encoding: "utf8" }).trim();
} catch (e) {
  refuse([
    `the prettier at ${BIN} could not be run, so nothing was formatted.`,
    String(e?.message ?? e).split("\n")[0],
    "",
    "  Run: pnpm install",
  ]);
}

/*
 * A PIN THAT IS NOT HONOURED IS WORSE THAN NO PIN, because both the gate and this
 * script would report a version nobody is running. Only an EXACT pin can be
 * compared without a semver implementation; a range is reported and allowed, for
 * the same reason assert-formatted.mjs allows one — refusing it would be this
 * script inventing a dependency policy it was not asked to make.
 */
const exact = /^\d+\.\d+\.\d+$/.test(declared ?? "");
if (exact && actual !== declared) {
  refuse([
    `package.json pins prettier ${declared} and ${actual} is installed.`,
    "Formatting with it would write a style the gate does not accept.",
    "",
    "  Run: pnpm install --frozen-lockfile",
  ]);
}

const args = process.argv.slice(2);
const passed = args.length ? args : ["--write", "."];

// The repair names its instrument for the same reason the gate does (#612): a
// count — or a rewrite — without the tool that produced it is not reproducible.
console.log(
  `formatting with prettier ${actual}${
    declared ? ` (declared ${declared}${exact ? "" : ", a range"})` : ""
  } from ${BIN.slice(ROOT.length + 1)}`
);

try {
  execFileSync(BIN, passed, { stdio: "inherit" });
} catch (e) {
  process.exit(typeof e?.status === "number" ? e.status : 1);
}
