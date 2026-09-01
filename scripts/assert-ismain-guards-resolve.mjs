#!/usr/bin/env node
/**
 * NO SCRIPT MAY DECIDE "AM I THE PROGRAM?" BY COMPARING A RESOLVED PATH TO AN UNRESOLVED ONE
 * (#631).
 *
 * `import.meta.url` is fully resolved — node resolves symlinks when it loads a module.
 * `process.argv[1]` is absolutised but NOT symlink-resolved. Comparing them answers "library"
 * whenever the script was reached through a symlinked path, `main()` never runs, and the process
 * EXITS 0 HAVING PRINTED NOTHING. In a CI log that is indistinguishable from a check that passed.
 *
 * WHY THIS EXISTS AS A CHECK AND NOT JUST A REPAIR. Thirty-six scripts carried the broken form
 * and three had independently arrived at the correct one, which is the same fact twice: this is
 * a comparison people write from memory, and the memory is wrong. Repairing thirty-six copies
 * does not stop a thirty-seventh, and the thirty-seventh would be invisible — the broken form
 * agrees with the correct one under every direct invocation, which is how everybody tests.
 *
 * The repair is scripts/lib/is-main.mjs. This file only asserts that nothing has drifted back.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS SCANS TEXT WHILE check-swallowed-test-evidence.mjs PARSES AN AST — AND WHAT WOULD
 * CHANGE THAT (#656).
 *
 * Two checkers in this repo meet the same class and answer it differently, which is worth
 * writing down before someone "unifies" them. #456 walks the real TypeScript AST, and its header
 * explains why: a hand-written scanner reported ZERO on `const re = /it's a trap/;`. That is the
 * identical defect this file hit, and parsing removes the category rather than the instance.
 *
 * This file does NOT parse, for a reason that is about its fixtures rather than its subject. The
 * AST path REFUSES (exit 2) when typescript cannot be resolved, by design — and this checker's
 * proof materialises bare temp directories with mkdtempSync, which have no node_modules. An
 * AST-based census would refuse in every one of its own cases. That cost has been paid once
 * already: #622 made freeze-all require prettier and broke two worktree proofs, and #630 spent a
 * round removing the requirement rather than policing it.
 *
 * WHAT MAKES TEXT-SCANNING ACCEPTABLE HERE IS NOT THE TOKENISER. It is that scanState() reports
 * where the read ENDED, so a construct nobody has anticipated produces a REFUSAL BY NAME instead
 * of a quieter answer. The objection to hand-written scanners is that the next construct gets
 * through; with the read-end check, the next construct announces itself. The residual risk is
 * bounded rather than unknown.
 *
 * THE TRIGGER TO SWITCH, stated so it survives: IF THE STRIPPER EVER NEEDS A THIRD PATCH — a
 * third change to scanState() to teach it a token class — stop patching and parse. Two were
 * needed: regex literals and `${…}` interpolation.
 *
 * COUNT PATCHES, NOT CONSTRUCTS, AND THE DIFFERENCE IS THE WHOLE POINT. A construct that the
 * end-of-read refusal CATCHES is this mechanism working: the file is named, nothing is silently
 * skipped, and no code changes. A construct that requires teaching the stripper again is this
 * mechanism FAILING. The two look identical in a changelog — "another construct broke the
 * scanner" — and mean opposite things. Given that this checker's entire subject is instruments
 * reporting verdicts they did not compute, a trigger that cannot tell its own success from its
 * own failure would be the same defect one level up. A third PATCH means the token classes are
 * not enumerable by hand and #456's answer is the right one, fixture cost included.
 *
 * ONE HONEST CAVEAT ABOUT THE PAST: between #634 (this census landing) and #656 (this fix), the
 * scanner could go blind mid-file. A clean run in that window is weaker evidence than it looks —
 * it means "no offender was found in the part that was read", and how much was read was not
 * reported. Three files were being silently skipped when this was found, and the third is the
 * sharpest illustration of why two instruments were both needed and both insufficient:
 * assert-graph-list-doc-claim.selftest.mjs builds markdown code spans with
 * `.map((n) => \`\\\`${n}\\\`\`)` — a template inside an interpolation containing escaped
 * backticks. #456 met this class through REGEX literals and answered it by parsing; this census
 * met it through TEMPLATE literals and answered it by changing signature; and #456's own
 * selftest was among the files this census could not read. Each instrument was blind to the
 * other's construct.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { invokedAsProgram } from "./lib/is-main.mjs";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));

/**
 * The two spellings, and why each is wrong.
 *
 * The second is wrong TWICE, and the extra way has nothing to do with symlinks: `file://${p}` is
 * string concatenation where `import.meta.url` is a URL, so a path containing a space yields
 * `file:///a b/x.mjs` against a url of `file:///a%20b/x.mjs`. Measured with no symlink present —
 * under a directory named "with space" the first form answers true and this one answers false.
 * A checkout under any path with a space in it silences those scripts outright.
 */
/*
 * `signature` is what the form looks like AFTER strings are stripped, and the two differ for a
 * reason worth keeping: THE SECOND FORM CONTAINS A TEMPLATE LITERAL, so the stripper that makes
 * this scan reliable also erases the thing being scanned for. Searching the stripped code for
 * the literal source text found form 1 and silently never found form 2 — a probe that reported
 * clean because the instrument had removed its own subject.
 *
 * What survives stripping is `import.meta.url === ""`, and that is a better signature than the
 * original anyway: comparing import.meta.url to ANY string literal is the mistake, whatever the
 * literal spells. A quotation of the form cannot be confused with it, because a quotation is
 * itself inside a string and collapses to a bare `""` with no comparison attached.
 */
const BROKEN = [
  {
    form: "fileURLToPath(import.meta.url) === process.argv[1]",
    signature: "fileURLToPath(import.meta.url) === process.argv[1]",
    why: "argv[1] is not symlink-resolved, so this is false through any symlinked path",
  },
  {
    form: "import.meta.url === `file://${process.argv[1]}`",
    signature: 'import.meta.url === ""',
    why: "as above, AND `file://` + a path is not a URL — a space makes it false with no symlink at all",
  },
];

/** @returns {{problems: string[], scanned: number}} */
export function census(dir = SCRIPTS) {
  const problems = [];
  let scanned = 0;

  const walk = (d) => {
    for (const name of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, name.name);
      if (name.isDirectory()) {
        // Fixtures deliberately contain broken forms — they are the specimens. Everything else
        // under scripts/ is real code and is scanned, including lib/.
        if (name.name === "fixtures" || name.name === "__fixtures__") continue;
        walk(abs);
        continue;
      }
      if (!/\.[cm]?js$/.test(name.name)) continue;
      scanned++;
      const raw = readFileSync(abs, "utf8");
      const { code, endedIn } = scanState(raw);
      /*
       * A SCAN THAT ENDED INSIDE A STRING DID NOT SEARCH THE REST OF THE FILE.
       *
       * This is the desync of #656 made loud instead of silent. Whatever the cause — a construct
       * the scanner does not know, an unterminated literal, a regex the division heuristic read
       * the wrong way — the tail of the file was classified as quoted and the signature could
       * never match in it. Reporting "no offender found" about that file would be a verdict over
       * a region nobody looked at, which is this checker's own subject.
       */
      if (endedIn !== "code") {
        problems.push(
          `${relative(
            dir,
            abs
          )} could not be scanned: the reader reached the end of the file ` +
            `still inside a ${endedIn}. Everything after that point was treated as quoted and ` +
            `was never searched, so "no broken guard here" would be a claim about a region this ` +
            `check did not read. Exit 2 territory, not a pass.`
        );
        continue;
      }
      for (const b of BROKEN) {
        if (!code.includes(b.signature)) continue;
        problems.push(
          /*
           * NAMED RELATIVE TO THE DIRECTORY ACTUALLY SCANNED, not to this file's own.
           *
           * This slit `abs` at `SCRIPTS.length + 1`, which is only correct when census() is
           * scanning its own directory. Pointed anywhere else — which is exactly what the proof
           * does, and what a sweep of another checkout does — it cut each path at the wrong
           * offset and reported names like "scripts/-evidence.mjs" and bare "scripts". The
           * offenders were real and correctly counted; the file it named was fabricated by
           * arithmetic. A finding that misnames its subject sends the reader to the wrong file,
           * and the proof did not catch it because its assertions matched on the surviving tail.
           */
          `${relative(dir, abs)} decides isMain with:\n` +
            `      ${b.form}\n` +
            `    ${b.why}.\n` +
            `    Use: import { invokedAsProgram } from "./lib/is-main.mjs"  (adjust the path from lib/)`
        );
      }
    }
  };
  walk(dir);

  /*
   * A census that read nothing agrees with everything — this checker's own subject, one level
   * up. Refusing here is the difference between "no script guards the old way" and "no script
   * was looked at".
   */
  if (scanned === 0)
    problems.push(
      `TOTALITY: scanned ZERO files under ${dir}. The directory moved or the extension filter ` +
        `stopped matching, and "nothing guards the old way" would be true of nothing.`
    );

  return { problems, scanned };
}

/**
 * The source with COMMENTS, STRING LITERALS AND REGEX LITERALS reduced to placeholders, so what
 * is left is code.
 *
 * WHY NOT A LINE HEURISTIC, WHICH IS WHAT THIS WAS FIRST. Two files legitimately contain the
 * broken spellings: the helper explains what it replaces, and the proof WRITES one into a fixture
 * as a negative control. A first attempt classified lines by shape — "does it start with a quote"
 * — and reported all four quotations as live guards. Excluding those two files by name would be
 * the other wrong answer: a skip list, in the check whose job is to notice a 37th script.
 *
 * REGEX LITERALS ARE A TOKEN CLASS AND MUST BE ONE HERE (#656). Without that, `/"([^"]+)"/g`
 * desynchronises the scanner: it meets the `"` inside the pattern, believes a string has opened,
 * and from there classifies code as string until some later quote — or the end of the file. The
 * signature can never match in the erased region, so the scan goes SILENT over everything after
 * the first such regex. It had a live victim: a checker written after #634 shipped with the
 * broken guard form on line 60 of a file whose line 56 is
 * `[...m[1].matchAll(/"([^"]+)"/g)]`, and this census passed over it. The 37th script was written
 * the old way and the guard built to stop that did not stop it.
 *
 * Special-casing `/"…"/` was available and is wrong: it leaves `/'…'/`, a regex containing a
 * backtick, and every future variant. What erases arbitrary code is the STRIPPER, so the stripper
 * is what had to learn the token class.
 *
 * THE DIVISION AMBIGUITY, handled the standard way: `/` opens a regex only in EXPRESSION
 * POSITION — after an operator, an opening bracket, a comma, a semicolon, or one of the keywords
 * that can precede a value. After an identifier, a number, `)` or `]` it is division. This is a
 * heuristic, and rather than trust it silently, scanState() below reports when the scan ends
 * somewhere it should not, so a misread announces itself instead of erasing the rest of a file.
 */
const REGEX_PRECEDERS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "case",
  "do",
  "else",
  "yield",
  "await",
  "throw",
]);

/**
 * One pass over the source. Returns the stripped text AND where the scan ended, because "I fell
 * off the end inside a string" is the signature of a desync and must not be silent.
 *
 * @returns {{code: string, endedIn: "code"|"string"|"template"|"block-comment", at?: number}}
 */
export function scanState(src) {
  let out = "";
  let i = 0;
  let lastSignificant = "";

  const opensRegex = () => {
    if (lastSignificant === "") return true; // start of file
    if (/[)\]}A-Za-z0-9_$]/.test(lastSignificant)) {
      // Could still be a regex after a KEYWORD (`return /x/`), which ends in a letter.
      const m = out.match(/([A-Za-z_$][A-Za-z0-9_$]*)\s*$/);
      return !!(m && REGEX_PRECEDERS.has(m[1]));
    }
    return true;
  };

  while (i < src.length) {
    const two = src.slice(i, i + 2);

    if (two === "//") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (two === "/*") {
      const close = src.indexOf("*/", i + 2);
      if (close === -1) {
        return { code: out + " ", endedIn: "block-comment", at: i };
      }
      i = close + 2;
      out += " ";
      continue;
    }

    const c = src[i];

    if (c === '"' || c === "'") {
      const start = i;
      i++;
      let closed = false;
      while (i < src.length) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === "\n") break; // a plain string cannot span lines
        if (src[i] === c) {
          i++;
          closed = true;
          break;
        }
        i++;
      }
      out += '""';
      if (!closed) return { code: out, endedIn: "string", at: start };
      continue;
    }

    /*
     * TEMPLATES, WITH `${…}` READ AS CODE. Scanning to "the next backtick" is the naive form and
     * it is wrong twice over: an interpolation may CONTAIN a backtick (a nested template), which
     * closes the outer one early and inverts every backtick after it; and it may contain a quote
     * or a brace that a byte-counter has no way to pair.
     *
     * Both of these are live in this repo. assert-graph-list-doc-claim.selftest.mjs desynced the
     * PREVIOUS stripper too — its tail was already being erased before #656 — so those files were
     * silently unscanned and nothing said so. Depth-tracking the interpolation is what makes the
     * count honest rather than lucky.
     */
    if (c === "`") {
      const start = i;
      i++;
      let closed = false;
      while (i < src.length) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === "`") {
          i++;
          closed = true;
          break;
        }
        if (src[i] === "$" && src[i + 1] === "{") {
          // Interpolation: code, possibly containing strings, templates and braces.
          i += 2;
          let depth = 1;
          while (i < src.length && depth > 0) {
            const d = src[i];
            if (d === "\\") {
              i += 2;
              continue;
            }
            if (d === "{") depth++;
            else if (d === "}") depth--;
            else if (d === '"' || d === "'" || d === "`") {
              const q = d;
              i++;
              while (i < src.length) {
                if (src[i] === "\\") {
                  i += 2;
                  continue;
                }
                if (src[i] === q) break;
                i++;
              }
            }
            i++;
          }
          continue;
        }
        i++;
      }
      out += '""';
      if (!closed) return { code: out, endedIn: "template", at: start };
      continue;
    }

    if (c === "/" && opensRegex()) {
      const start = i;
      i++;
      let inClass = false;
      let closed = false;
      while (i < src.length) {
        const d = src[i];
        if (d === "\\") {
          i += 2;
          continue;
        }
        if (d === "\n") break; // a regex literal cannot span lines — this was division after all
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) {
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) {
        // Not a regex: rewind and treat the slash as an ordinary character.
        i = start + 1;
        out += "/";
        lastSignificant = "/";
        continue;
      }
      while (i < src.length && /[a-z]/.test(src[i])) i++; // flags
      out += "/RE/";
      lastSignificant = "/";
      continue;
    }

    out += c;
    if (!/\s/.test(c)) lastSignificant = c;
    i++;
  }
  return { code: out, endedIn: "code" };
}

/** Backwards-compatible wrapper: the stripped code alone. */
export function stripStringsAndComments(src) {
  return scanState(src).code;
}

function main() {
  const { problems, scanned } = census();
  if (problems.length) {
    console.error(
      `\nFAIL: ${problems.length} script(s) decide "am I the program?" with a comparison that\n` +
        `      is false through a symlink — and a script that answers "library" when it was RUN\n` +
        `      exits 0 having printed nothing, which reads as a pass.\n`
    );
    for (const p of problems) console.error(`  · ${p}\n`);
    process.exit(1);
  }
  console.log(
    `PASS: ${scanned} script(s) under ${
      relative(process.cwd(), SCRIPTS) || SCRIPTS
    } READ TO THE END — ` +
      `no scan stopped early inside a\n` +
      `      literal — and none decides isMain by comparing a resolved path to an unresolved\n` +
      `      one. The repair is scripts/lib/is-main.mjs, which resolves both sides and refuses\n` +
      `      rather than guessing when it cannot.`
  );
}

if (invokedAsProgram(import.meta.url)) main();
