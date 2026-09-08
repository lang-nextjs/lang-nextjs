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
 * WHICH ROOTS, AND WHY apps/open-swe IS NOT ONE OF THEM BY DEFAULT — see the
 * DEFAULT_ROOTS block below, which is where that decision is recorded. Short
 * version: it IS checked, from its own package.json, because this script is
 * retained by every eject and the app it would name is not.
 *
 * HISTORY, kept short because it is now history. apps/open-swe was excluded while
 * it carried 237 findings across 9 files (measured at 06725a6: neutral 148, red 28,
 * emerald 28, amber 17, blue 15, indigo 1) — not drift, but an app importing plain
 * Tailwind with its own near-black theme. The exclusion was a RATCHET rather than a
 * blanket pass, and it still grew in silence: AgentModeBanner.tsx contributed 12 of
 * the 237 after the exclusion was written, and nothing objected, because an excluded
 * path cannot fail. The conversion onto @deepagents-nextjs/ui took the count to zero,
 * which was PALETTE-EXCEPTION.md's own stated removal condition, so the ratchet and
 * the doc were retired (#117). The argument for the ratchet is in that file's git log
 * if it is ever needed again — an exclusion is preferable to a check somebody
 * switches off, which is why it was right at the time and wrong afterwards.
 *
 * Exit 0 clean, 1 on any hardcoded palette class, 2 on bad usage.
 */
import {
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// WHY apps/open-swe IS NOT LISTED HERE, THOUGH IT IS FULLY CHECKED.
//
// Its exclusion was retired in #117: it carried 237 hardcoded palette findings
// across 9 files, bounded by a ratchet in the app itself, and the conversion onto
// @deepagents-nextjs/ui took that to 0. An exclusion with no debt behind it is
// just a hole, so the ratchet and PALETTE-EXCEPTION.md are gone.
//
// It is checked from apps/open-swe/package.json — `pnpm palette` there, reached by
// `turbo test` — rather than from this list, and that is a SEVERABILITY constraint,
// not a preference. This script is RETAINED by every eject; apps/open-swe is owned
// by rung 4 and deleted by `eject langchain`. Naming it here would leave a retained
// file referencing a deleted app, which eject's check 2 refuses:
//
//   FAIL: ejecting to "langchain" would leave 1 dangling reference(s):
//          scripts/check-palette.mjs:63 references deleted app "apps/open-swe"
//
// That is not a false positive to work around — the invocation would genuinely
// scan a path that no longer exists. Putting it in the rung's own package.json
// means the wiring is deleted by the same eject that deletes its subject.
//
// The cost is that a bare `pnpm palette` at the root covers less than the whole
// repo, so main() PRINTS the roots it used. A checker that silently narrows its
// own subject is the defect this repo keeps finding; one that states its scope
// is merely partial, which is honest.
/*
 * REFUSED, NOT CRASHED, when typescript is absent. This checker now parses, so
 * an unimportable compiler means no file was examined — and a stack trace at
 * import time is a worse answer than a sentence saying which command fixes it.
 * Same shape `assert-no-silent-skips` and `assert-formatted` use.
 */
let ts;
try {
  ts = (await import("typescript")).default;
} catch (e) {
  console.error(
    "REFUSE: typescript could not be imported, so no file was parsed and no palette class " +
      `was looked for. Run \`pnpm install\`.\n       ${e.message}`
  );
  process.exit(2);
}

const DEFAULT_ROOTS = ["apps/example", "e2e"];

/** Every Tailwind hue family. Enumerated so a colour cannot hide by being rare. */
const HUES = [
  "slate",
  "gray",
  "zinc",
  "neutral",
  "stone",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
];
const PATTERN = new RegExp(
  String.raw`\b(?:bg|text|border|ring|from|via|to|divide|outline|shadow|accent|caret|decoration|fill|stroke)-(?:${HUES.join(
    "|"
  )})-\d{2,3}\b`,
  "g"
);

/**
 * Blank comments before matching — BLANK, not remove, and PARSED, not matched.
 *
 * WHY COMMENTS ARE IGNORED AT ALL, unchanged from the original: the fix for
 * those six E2E tests DOCUMENTS the old class names in a comment explaining why
 * the assertion moved off them. Flagging that would punish writing down the
 * reason, and the next person would delete the explanation to get CI green.
 * Three such comments exist in the tree today, and all three are correct.
 *
 * WHAT WAS WRONG WITH DOING IT BY REGEX. The previous implementation was
 *
 *     src.replace(BLOCK, "").replace(LINE, "")
 *
 *       BLOCK   slash-star, lazily anything, star-slash   REMOVED, not blanked
 *       LINE    slash-slash, then anything but a newline  UNANCHORED
 *
 * The two patterns are named rather than quoted because quoting the second one
 * literally ENDS THIS COMMENT — it contains star-slash — which is the hazard
 * itself, arriving in the paragraph describing it. Node refused the file and
 * said so at the exact character, which is the only reason you are reading a
 * description instead of a defect.
 *
 * and it had three separate defects, two of which SILENTLY LOSE A VIOLATION:
 *
 *     const url = "https://x.test"; const c = "bg-red-500";
 *                      ^^ starts a "comment" — the class is never seen
 *
 *     const alias = "@/*";      opens a false block comment, which closes at
 *     const c = "bg-red-500";   the next REAL star-slash — all of it is gone
 *     [any ordinary block comment supplies that closer]
 *
 *     a block comment    removing rather than blanking DELETES its newlines,
 *     spanning 2 lines   so every later line is reported one number too low
 *     const c = "bg-red-500";        source line 4, reported as line 3
 *
 * All three were reproduced before this was written, and the third is why
 * `assert-no-silent-skips` blanked rather than removed — that file had already
 * learned this lesson in a comment, in this same repository.
 *
 * WHY PARSE RATHER THAN PATCH. `assert-ismain-guards-resolve.mjs` states the
 * trigger: if the stripper needs a third patch, stop patching and parse. This is
 * the fourth glob-eating incident here, and `check-palette` is the worse of the
 * two remaining because it MISSES violations rather than merely mislocating
 * them. TypeScript already knows what a comment is; a better regex would only
 * move the boundary.
 *
 * THE SUBJECT IS DELIBERATELY UNCHANGED. This blanks comments and scans
 * everything else, exactly as before — it does NOT switch to scanning only
 * string literals, which would have been a smaller and more elegant rule but a
 * DIFFERENT question. A repair that quietly narrows what a gate looks at is the
 * defect this repo keeps finding.
 *
 * LINE NUMBERS ARE EXACT BY CONSTRUCTION, and asserted rather than assumed: the
 * returned text has the same length and the same newline count as its input, so
 * a position cannot drift. If either invariant fails the file is REFUSED, which
 * makes a blanking bug loud instead of turning it into an off-by-one.
 *
 * Returns `null` when the file cannot be trusted; the caller records a refusal.
 */
function blankComments(source, file) {
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    /x$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  if ((sf.parseDiagnostics ?? []).length > 0) return null;

  /*
   * UTF-16 CODE UNITS, NOT CODE POINTS, and this was a real bug caught by the
   * length invariant below rather than by reading the code. `[...source]` splits
   * into code POINTS, so one emoji anywhere in a file shifts every index after
   * it and the blanking lands on the wrong characters. TypeScript's comment
   * ranges are UTF-16 offsets. `split("")` agrees with them.
   */
  const out = source.split("");
  const seen = new Set();
  const visit = (node) => {
    for (const r of ts.getLeadingCommentRanges(source, node.getFullStart()) ??
      []) {
      const key = `${r.pos}:${r.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      for (let i = r.pos; i < r.end; i++) if (out[i] !== "\n") out[i] = " ";
    }
    node.getChildren(sf).forEach(visit);
  };
  visit(sf);

  const blanked = out.join("");
  const nl = (t) => (t.match(/\n/g) ?? []).length;
  if (blanked.length !== source.length || nl(blanked) !== nl(source))
    return null;
  return blanked;
}

function sourceFilesUnder(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    if (
      entry === "node_modules" ||
      entry === ".next" ||
      entry === "dist" ||
      entry.startsWith(".")
    )
      continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) sourceFilesUnder(p, acc);
    else if (/\.(tsx?|jsx?)$/.test(entry)) acc.push(p);
  }
  return acc;
}

/**
 * RETURNS BOTH ANSWERS, because "no findings" and "could not look" are different
 * claims and the old signature could not tell them apart. `scan()` returned a
 * bare array, so a file that failed to parse contributed nothing and read
 * exactly like a clean file. That is this repository's own exit vocabulary —
 * 0 pass, 1 violated, 2 could not ask — applied one level down, to the function
 * the checker and its proof both call.
 */
export function scan(roots) {
  const findings = [];
  const unparsed = [];
  for (const root of roots) {
    for (const file of sourceFilesUnder(root)) {
      const source = readFileSync(file, "utf8");
      const blanked = blankComments(source, file);
      if (blanked === null) {
        unparsed.push(file);
        continue;
      }
      blanked.split("\n").forEach((line, i) => {
        for (const m of line.matchAll(PATTERN)) {
          findings.push({ file, line: i + 1, klass: m[0] });
        }
      });
    }
  }
  return { findings, unparsed };
}

function main(argv) {
  const roots = argv.length ? argv : DEFAULT_ROOTS;
  const missing = roots.filter((r) => !existsSync(r));
  if (missing.length === roots.length) {
    console.error(
      `check-palette: none of the roots exist: ${roots.join(", ")}`
    );
    return 2;
  }
  const { findings, unparsed } = scan(roots);
  console.log(
    `check-palette: roots [${roots.join(", ")}], ${HUES.length} hue families`
  );
  /*
   * A REFUSAL OUTRANKS A FINDING, and it outranks a CLEAN result even harder.
   * If a file could not be parsed, "no hardcoded palette" is not a true
   * statement about this tree — it is a statement about the files that happened
   * to parse.
   */
  if (unparsed.length > 0) {
    console.error(
      `\nCOULD NOT CHECK ${unparsed.length} file(s). Each either failed to parse ` +
        `or failed the line-preservation invariant, so no class was looked for in ` +
        `it — which is not the same as it having none:\n` +
        unparsed.map((f) => `  ? ${f}`).join("\n") +
        `\n\nExiting 2: the question could not be asked, not answered.`
    );
    return 2;
  }
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

/**
 * Run only when invoked as the entry point — COMPARING RESOLVED PATHS.
 *
 * The obvious spelling, `import.meta.url === \`file://${process.argv[1]}\``, is
 * broken and fails toward GREEN. `import.meta.url` is realpath-resolved;
 * `process.argv[1]` is not. Invoke through any symlinked path — on macOS
 * `/tmp` -> `/private/tmp` is enough — and the comparison is false, `main()`
 * never runs, and node exits **0 with no output**. A check that reports success
 * by not executing, which is worse than one that reports the wrong answer,
 * because there is nothing to notice.
 *
 * Measured on this repo before the fix: the same script, same arguments, run
 * through `/tmp/...` exited 0 silently and through `/private/tmp/...` exited 1
 * with 237 findings. It was reported as "apps/open-swe is already clean".
 *
 * The selftest spawns this file through a symlink specifically to cover this
 * branch — importing `scan()` directly can never reach it, so the one part that
 * can silently no-op was the one part the selftest did not touch.
 */
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(fileURLToPath(import.meta.url)) ===
      realpathSync(process.argv[1])
    );
  } catch {
    return false; // argv[1] unresolvable: not a normal CLI invocation
  }
}

if (isEntryPoint()) {
  process.exit(main(process.argv.slice(2)));
}
