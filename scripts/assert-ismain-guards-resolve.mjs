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
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
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
      const code = stripStringsAndComments(readFileSync(abs, "utf8"));
      for (const b of BROKEN) {
        if (!code.includes(b.signature)) continue;
        problems.push(
          `${join(
            "scripts",
            abs.slice(SCRIPTS.length + 1)
          )} decides isMain with:\n` +
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
 * The source with COMMENTS AND STRING LITERALS REMOVED, so what is left is code.
 *
 * WHY NOT A LINE HEURISTIC, WHICH IS WHAT THIS WAS FIRST. Two files legitimately contain both
 * broken spellings: the helper explains what it replaces, and the proof WRITES one into a
 * fixture as a negative control. A first attempt classified lines by shape — "does it start
 * with a quote" — and reported all four quotations as live guards. That is a grep matching more
 * than the question, which is the same defect this file is about wearing different clothes.
 *
 * Excluding those two files by name would be the other wrong answer: a skip list, in the one
 * check whose job is to notice a thirty-seventh script written the old way. The discriminator
 * has to be a property of the text, and it is — a guard that RUNS is not inside a string.
 *
 * Deliberately a scanner rather than a parser. It does not need to understand JavaScript, only
 * to know when it is inside quotes; `${}` interpolation is dropped wholesale with its template,
 * which is correct here because a guard is never written inside one.
 */
export function stripStringsAndComments(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === "//") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (two === "/*") {
      const close = src.indexOf("*/", i + 2);
      i = close === -1 ? src.length : close + 2;
      out += " ";
      continue;
    }
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < src.length) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === c) {
          i++;
          break;
        }
        i++;
      }
      out += '""';
      continue;
    }
    out += c;
    i++;
  }
  return out;
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
    `PASS: ${scanned} script(s) under scripts/ scanned; none decides isMain by comparing a\n` +
      `      resolved path to an unresolved one. The repair is scripts/lib/is-main.mjs, which\n` +
      `      resolves both sides and refuses rather than guessing when it cannot.`
  );
}

if (invokedAsProgram(import.meta.url)) main();
