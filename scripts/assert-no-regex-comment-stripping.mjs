#!/usr/bin/env node
/**
 * Fail if a script strips comments from source text with a regular expression.
 *
 * WHY THIS EXISTS, AND WHY IT IS A CHECK RATHER THAN A FIFTH REPAIR. Five
 * instances of this defect have been found in this repository, and every one was
 * found because a person happened to notice — three of the five only because
 * someone was already working in the neighbouring file. THAT IS NOT A CHANNEL.
 * The class has had four separate repairs and no detector.
 *
 * WHAT GOES WRONG. A regular expression cannot tell a comment from text that
 * merely looks like one, and this repository is full of the latter:
 *
 *     const url = "https://x.test"; const c = "bg-red-500";
 *                      ^^ an UNANCHORED line delimiter discards the rest of the
 *                         line, and the class is never seen
 *
 *     a line comment mentioning a glob such as packages/server/ + star-star
 *     contains slash-star, which OPENS a block comment; it stays open until the
 *     next real star-slash and blanks every line between — including real calls
 *
 *     an include list entry of the form src/star-star/star.ts contains a
 *     COMPLETE false block comment, so it becomes "src *.ts": valid JSON, wrong
 *     value, no error at all
 *
 * THE DELIMITERS ARE NAMED RATHER THAN WRITTEN IN THE THREE CASES ABOVE, and that
 * is not squeamishness. My first draft of this paragraph spelled them out, and the
 * star-slash inside the example CLOSED THIS COMMENT — node refused the file at the
 * exact character. The checker for comment-eating constructs was eaten by the
 * construct it documents. That is the fourth time in two days this repository has
 * done that to prose describing it, and the repair each time is to change the
 * REPRESENTATION rather than to escape the bytes: an invisible escape works, is
 * undetectable in review, and breaks silently under the next edit.
 *
 * The measured consequences were: 24 call sites removed from a gating checker's
 * subject (#1149), a palette class reported inside the comment explaining it
 * (#1142), a skipped test invisible to the gate that exists to find it (#1134),
 * and a cross-tree comparison that stays green on a value present in none of the
 * trees (#1154) — because all three trees corrupt identically.
 *
 * THE RULE IS ABOUT THE HAZARD, NOT THE CONSTRUCT. An ANCHORED pattern —
 * one that pins the delimiter to the start of a line — cannot be opened by a URL
 * or a glob sitting in
 * the middle of a line, because it requires the delimiter to begin the line. Those
 * are reported and do not fail. An UNANCHORED one can, and does.
 *
 * THE REPAIRS ARE ALREADY IN THIS REPOSITORY, so this names them rather than
 * inventing anything:
 *
 *     JS / TS        ts.createSourceFile + getLeadingCommentRanges
 *                    AND getTrailingCommentRanges — a comment on the same line as
 *                    the token before it is TRAILING trivia and the leading call
 *                    does not return it (#1150)
 *     JSON w/ comments   ts.parseConfigFileTextToJson — the reader tsc uses
 *     Python         a character scanner; see maskPythonNonCode in
 *                    check-langfuse-wiring.mjs
 *
 * THIS CHECKER PARSES ITS OWN SUBJECT, DELIBERATELY. A grep for these patterns
 * would match the paragraph above — the file that hunts a construct contains the
 * construct — so the subject is the AST, and only a regex literal in argument
 * position of a `.replace()` call counts. Prose naming the pattern is not a call.
 *
 * EXIT VOCABULARY: 0 pass, 1 the property is violated, 2 the question could not
 * be asked. A file that does not parse is a refusal, not an absence of findings.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { reportSubject } from "./lib/subject.mjs";
import { printThenRank } from "./lib/print-then-rank.mjs";
import { invokedAsProgram } from "./lib/is-main.mjs";

let ts;
try {
  ts = (await import("typescript")).default;
} catch (e) {
  console.error(
    "REFUSE: typescript could not be imported, so no script was parsed and no " +
      `stripper was looked for. Run \`pnpm install\`.\n       ${e.message}`
  );
  process.exit(2);
}

/** A regex literal's source names a JS comment delimiter. */
const namesBlock = (t) => t.includes("\\/\\*");
const namesLine = (t) => t.includes("\\/\\/");

/**
 * ANCHORED means the delimiter can only begin a line.
 *
 * `^` alone is not enough — `(^|[^:])\/\/` accepts a `//` anywhere a non-colon
 * precedes it, which is a guard against `https://` specifically and not against a
 * delimiter mid-line. So this asks whether every alternative in the pattern pins
 * the delimiter to the start, which in practice is the `^[ \t]*` form this
 * repository already uses in three places.
 */
const isAnchored = (t) => /^\/\^\[ \\t\]\*/.test(t) || /\(\?:\^\|\\n\)/.test(t);

export function strippersIn(source, file) {
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    /x$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  if ((sf.parseDiagnostics ?? []).length > 0) return null;

  const out = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "replace"
    ) {
      const arg = node.arguments[0];
      if (arg && ts.isRegularExpressionLiteral(arg)) {
        const text = arg.getText(sf);
        const block = namesBlock(text);
        const line = namesLine(text);
        if (block || line)
          out.push({
            file,
            line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
            pattern: text,
            kind: block && line ? "block+line" : block ? "block" : "line",
            anchored: isAnchored(text),
          });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/*
 * RUN ONLY AS THE ENTRY POINT. The proof imports `strippersIn`, and without this
 * guard that import would execute the whole scan and exit — so the proof could
 * never call the function it exists to test. Same device the rest of scripts/
 * uses; `invokedAsProgram` compares RESOLVED paths, because `import.meta.url` is
 * realpath-resolved and `process.argv[1]` is not, and a symlinked invocation then
 * fails toward GREEN.
 */
function main() {
  const tracked = execFileSync("git", ["ls-files", "-z", "scripts"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter((f) => /\.mjs$/.test(f));

  const findings = [];
  const reported = [];
  const unparsed = [];
  for (const file of tracked) {
    const hits = strippersIn(readFileSync(file, "utf8"), file);
    if (hits === null) {
      unparsed.push(file);
      continue;
    }
    for (const h of hits) (h.anchored ? reported : findings).push(h);
  }

  reportSubject(
    tracked.length,
    "script(s) parsed for a regex comment stripper"
  );

  /*
   * A REFUSAL NO LONGER HIDES A FINDING (#1215). This exited 2 here, after every script had been
   * scanned and before any finding was printed, so one unparseable script hid a real stripper
   * (DEV1, measured). Both are printed now, and a finding decides the exit.
   */
  const printReported = () => {
    if (reported.length) {
      console.log(
        `\n${reported.length} ANCHORED stripper(s), reported and NOT failing — the ` +
          `delimiter must begin the line, so a URL or a glob mid-line cannot open one:`
      );
      for (const r of reported)
        console.log(`  - ${r.file}:${r.line}  [${r.kind}]  ${r.pattern}`);
    }
  };
  process.exitCode = printThenRank({
    refusals: unparsed,
    findings,
    printRefusals: () => {
      console.error(
        `\nCOULD NOT CHECK ${unparsed.length} script(s) — they did not parse, so no ` +
          `stripper was looked for in them, which is not the same as them having none:\n` +
          unparsed.map((f) => `  ? ${f}`).join("\n") +
          `\n\nThe question could not be asked for them, which is not an answer.`
      );
    },
    printFindings: () => {
      printReported();

      console.error(
        `\nFAIL: ${findings.length} unanchored regex comment stripper(s).\n`
      );
      for (const f of findings)
        console.error(
          `  x ${f.file}:${f.line}  [${f.kind}]\n    ${f.pattern}\n`
        );
      console.error(
        "  A regex cannot tell a comment from text that looks like one. Use the reader\n" +
          "  that already exists for the language:\n\n" +
          "    JS / TS         ts.createSourceFile, then getLeadingCommentRanges AND\n" +
          "                    getTrailingCommentRanges — a comment on the same line as\n" +
          "                    the token before it is TRAILING trivia (#1150)\n" +
          "    JSON + comments ts.parseConfigFileTextToJson — the reader tsc uses\n" +
          "    Python          a character scanner; maskPythonNonCode in\n" +
          "                    check-langfuse-wiring.mjs\n\n" +
          "  Blank comments rather than removing them, so line numbers do not shift, and\n" +
          "  assert that the result has the same length and newline count as its input.\n"
      );
    },
    printPass: () => {
      printReported();
      console.log(
        `\nPASS: ${tracked.length} script(s) parsed; no UNANCHORED regex comment ` +
          `stripper. A comment is found by a parser, not by a pattern.`
      );
    },
  });
}

if (invokedAsProgram(import.meta.url)) main();
