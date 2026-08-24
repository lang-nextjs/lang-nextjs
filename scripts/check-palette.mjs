#!/usr/bin/env node
/**
 * Fail if a themed surface hardcodes a Tailwind palette colour.
 *
 * WHY. `@digitalfrontier/theme` is the single authority on colour, and
 * `df-theme-check` already refuses a local redefinition of a canonical TOKEN.
 * It cannot see this: `bg-red-500` redefines nothing, it simply bypasses the
 * theme. An app can import the theme, pass df-theme-check, and still paint half
 * its surfaces from the stock Tailwind palette — which is precisely what
 * apps/example did before #60, at 1.12:1 contrast under cream text.
 *
 * WHAT THIS EXISTS TO CATCH, concretely. #60 converted apps/example onto
 * tokens, and six E2E tests broke asserting `bg-red-500` and `bg-blue-600`.
 * The conversion was right; the assertions were a SECOND home for the same
 * hardcoded palette, and the scan that verified the conversion only looked at
 * apps/example. The subject of the check was narrower than the property.
 * So this scans e2e/ too, and takes its roots as arguments rather than
 * hardcoding one.
 *
 *   node scripts/check-palette.mjs                 # default roots
 *   node scripts/check-palette.mjs path [path...]  # explicit
 *
 * NOT SCANNED BY DEFAULT: apps/open-swe. It has never adopted the theme and
 * carries its own dark palette deliberately. Adding it here would report ~9
 * files of known, accepted state as failures, and a check that cries wolf is
 * one somebody turns off. When it adopts the theme, add it to DEFAULT_ROOTS.
 *
 * Exit 0 clean, 1 on any hardcoded palette class, 2 on bad usage.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_ROOTS = ["apps/example", "e2e"];

/** Every Tailwind hue family. Enumerated so a colour cannot hide by being rare. */
const HUES = [
  "slate", "gray", "zinc", "neutral", "stone", "red", "orange", "amber",
  "yellow", "lime", "green", "emerald", "teal", "cyan", "sky", "blue",
  "indigo", "violet", "purple", "fuchsia", "pink", "rose",
];
const PATTERN = new RegExp(
  String.raw`\b(?:bg|text|border|ring|from|via|to|divide|outline|shadow|accent|caret|decoration|fill|stroke)-(?:${HUES.join("|")})-\d{2,3}\b`,
  "g"
);

/**
 * Strip comments before matching.
 *
 * Not cosmetic: the fix for those six E2E tests DOCUMENTS the old class names
 * in a comment explaining why the assertion moved off them. Flagging that would
 * punish writing down the reason, and the next person would delete the
 * explanation to get CI green. df-theme-check strips comments for the same
 * reason.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function sourceFilesUnder(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === "dist" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) sourceFilesUnder(p, acc);
    else if (/\.(tsx?|jsx?)$/.test(entry)) acc.push(p);
  }
  return acc;
}

export function scan(roots) {
  const findings = [];
  for (const root of roots) {
    for (const file of sourceFilesUnder(root)) {
      const stripped = stripComments(readFileSync(file, "utf8"));
      stripped.split("\n").forEach((line, i) => {
        for (const m of line.matchAll(PATTERN)) {
          findings.push({ file, line: i + 1, klass: m[0] });
        }
      });
    }
  }
  return findings;
}

function main(argv) {
  const roots = argv.length ? argv : DEFAULT_ROOTS;
  const missing = roots.filter((r) => !existsSync(r));
  if (missing.length === roots.length) {
    console.error(`check-palette: none of the roots exist: ${roots.join(", ")}`);
    return 2;
  }
  const findings = scan(roots);
  console.log(`check-palette: roots [${roots.join(", ")}], ${HUES.length} hue families`);
  if (findings.length === 0) {
    console.log("clean — no hardcoded Tailwind palette on a themed surface.");
    return 0;
  }
  console.log("\nHardcoded palette classes:");
  for (const f of findings) console.log(`  x ${f.file}:${f.line}  ${f.klass}`);
  console.log(
    "\nThese bypass @digitalfrontier/theme. Use a semantic token instead\n" +
      "(bg-background / bg-card / text-muted-foreground / bg-destructive / bg-success),\n" +
      "and in a test assert the STATE that drives the colour, not the colour."
  );
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
