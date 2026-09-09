#!/usr/bin/env node
/**
 * Property: A SHELL NEVER PARSES A COMMAND STRING IN THIS REPO'S SOURCE.
 *
 * THE FINDING THIS MECHANISES (#736). Two cleanup assertions in the open-swe
 * sandbox E2E verified that containers were gone with
 *
 *     execSync(`docker ps -aq --filter "name=${n}" 2>/dev/null || true`)
 *
 * and then asserted the result was "". `|| true` replaces the exit status,
 * `2>/dev/null` discards the reason, and "" is read as PROOF OF CLEANUP — so
 * "nothing leaked" and "I could not ask docker" produced the identical verdict
 * and the second one passed. `docker` missing from PATH exits 127; `|| true`
 * makes that 0; the assertion goes green having checked nothing.
 *
 * ── Why the check is on the IMPORT, not the call ────────────────────────────
 *
 * A pipeline inside JS lives in a string literal, a template literal, or is
 * assembled from parts, so a checker that greps CALL SITES both over- and
 * under-matches. Measured on this tree, three shapes would have been reported
 * that are not defects at all: a `shell: true` in FIXTURE DATA describing a
 * fake CI job, a `{ stdio: "pipe" }` options key, and `|| true` in a command
 * that is a logical-or and not a pipe. And a command composed from parts hides
 * its verdict-bearing half from any regex.
 *
 * The import is the anchor that dissolves all of it. `exec` and `execSync` take
 * a command STRING that a shell parses; `execFile`, `execFileSync`, `spawn` and
 * `spawnSync` take an argv ARRAY and no shell is involved. So the question
 * "can a shell parse a string here" is answerable from the import line alone,
 * with no parser and no exception list. A file that does not import them cannot
 * commit the defect, and its fixture data becomes invisible by construction.
 *
 * Measured at the time of writing: 91 execFileSync, 12 spawnSync, 4 spawn,
 * 1 execFile — and zero `exec`/`execSync` across 106 importing files. The
 * repo had already converged on the argv form; this keeps it there.
 *
 * ── e2e/ is exempt from R1, and the exemption is an ASSERTION ───────────────
 *
 * E2E specs have a genuine reason to shell out. But an exemption that names a
 * DIRECTORY and nothing else is a mute button: it records where we stopped
 * looking. So e2e/ is exempt from R1 and subject to R2 instead, which is the
 * part of the property that still holds there — THE VERDICT MUST NOT BE
 * DISCARDED. `|| true` and `|| :` replace a command's exit status with success,
 * which is the mechanism of the original defect, and they are refused in a
 * shelled-out command wherever it lives.
 *
 * That is why this checker, run against the tree before #736, FAILS: the
 * offending spec is in e2e/ and R2 catches it there. An exemption that had
 * merely skipped the directory would have reported it clean.
 *
 * ── The two rules ───────────────────────────────────────────────────────────
 *
 * R1  Importing `exec` or `execSync` from child_process, outside e2e/.
 *     Use the argv form: execFileSync(bin, [args]) / spawnSync(bin, [args]).
 *
 * R2  A verdict-discarding construct (`|| true`, `|| :`) in a file that imports
 *     `exec` or `execSync`. Applies everywhere, e2e/ included.
 *
 * ── Honest limit ────────────────────────────────────────────────────────────
 *
 * This makes a shell-parsed command STATICALLY VISIBLE. It cannot see a shell
 * reached some other way — a `shell: true` option on an argv API, a spawned
 * `bash -c`, a command sent to a remote runner. Those are real and are not
 * covered; R1 removes the common path rather than every path.
 *
 * It also reads imports by regex anchored to the start of a line, so an import
 * written at line-start INSIDE a multi-line template literal would be read as
 * code. Both limits are stated so the green is not read as more than it is.
 *
 * Usage: node scripts/assert-child-process-argv-form.mjs [--cwd DIR]
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";
import { reportSubject } from "./lib/subject.mjs";

/*
 * REFUSED, NOT CRASHED, when typescript is absent — this checker now parses, so
 * an unimportable compiler means no file was examined. Same shape as
 * `check-palette` and `assert-no-silent-skips`.
 */
let ts;
try {
  ts = (await import("typescript")).default;
} catch (e) {
  console.error(
    "REFUSE: typescript could not be imported, so no file was parsed and no child_process " +
      `call was looked for. Run \`pnpm install\`.\n       ${e.message}`
  );
  process.exit(2);
}

const argv = process.argv.slice(2);
const ci = argv.indexOf("--cwd");
const CWD =
  ci >= 0
    ? resolve(argv[ci + 1])
    : join(dirname(fileURLToPath(import.meta.url)), "..");

/** Shell-parsing APIs: they take a command string. */
const SHELL_FORM = new Set(["exec", "execSync"]);

/** Replaces a command's exit status with success. */
const DISCARDS_VERDICT = /\|\|\s*(?:true|:)(?:\s|$|[`"'])/;

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build"]);
const EXTS = [".mjs", ".cjs", ".js", ".ts", ".tsx"];

const files = [];
function walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (EXTS.some((e) => name.endsWith(e))) files.push(p);
  }
}
walk(CWD);

/**
 * Blank comments before matching — PARSED, not matched.
 *
 * WHY COMMENTS ARE IGNORED AT ALL, unchanged: the fix for #736 QUOTES the
 * offending `execSync(... || true)` in a docstring explaining why it was wrong.
 * Flagging that would punish writing down the reason, and the next person would
 * delete the explanation to get CI green.
 *
 * WHY THE REGEX WAS REPLACED, AND THIS ONE WAS LIVE. The previous form blanked
 * block comments — deliberately, so line numbers would not shift, which this
 * file had already been bitten by and says so below — but it applied the pattern
 * to RAW TEXT, and text cannot tell a comment from a glob:
 *
 *     census.mjs:73   // inside packages/server/ ** is NOT a census member ...
 *                        the ** / in that glob OPENS a false block comment
 *     census.mjs:80   const tracked = execFileSync("git", [ ls-files, -z ], {
 *                        (the quotes are dropped deliberately — see below)
 *                        blanked entirely — this checker never saw the call
 *
 * THE QUOTES ARE DROPPED FROM THAT EXAMPLE ON PURPOSE, and the reason is the same
 * class this file is being repaired for. `assert-git-subject-stances` decides
 * which scripts ask git about the tree by testing whether the SOURCE CONTAINS a
 * git subcommand name IN DOUBLE QUOTES — a substring match over raw bytes,
 * comments included. Quoting the census line verbatim therefore made this checker
 * look
 * like a git-subject script and demanded a stance declaration for a question it
 * never asks. This paragraph is written without the quoted form for the same
 * reason: my first draft explained the hazard while committing it, and the gate
 * flagged the explanation. A comment describing a call is not a call. Filed separately; the
 * example is written so the docstring states the fact without impersonating it.
 *
 * MEASURED AGAINST A PARSE OVER ALL 1041 TRACKED JS/TS FILES: 24 child_process
 * occurrences were invisible to this checker, in seven files including
 * `scripts/census.mjs`, `scripts/budgeted-routes.selftest.mjs` and THIS
 * CHECKER'S OWN SELFTEST.
 *
 * THE FINDING IS THE SUBJECT, NOT THE VERDICT, and that is the harder half to
 * see. Every one of those 24 calls uses the compliant array form, so no
 * violation was being missed — the gate's answer is right BY LUCK OF WHAT THE
 * REPOSITORY CURRENTLY CONTAINS. It reports a population it did not examine, and
 * the floor that would notice the subject shrinking is 0.
 *
 * THE SECOND DEFECT, which the block-comment blanking did not cover: the line
 * comment pattern was UNANCHORED, so `const u = "https://x"` discarded the rest
 * of that line. `assert-no-missing-workspace-invocations` anchors its equivalent
 * to the start of a line and is therefore safe from this one and not from the
 * other. Each user of this construct has fixed exactly the mode that bit them.
 *
 * A FILE THAT DOES NOT PARSE IS REFUSED rather than yielding no calls, which
 * would read exactly like a file that makes none.
 */
function stripComments(src, file = "f.ts") {
  const sf = ts.createSourceFile(
    file,
    src,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    /x$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  if ((sf.parseDiagnostics ?? []).length > 0) return null;

  // UTF-16 code units, because TypeScript's comment ranges are UTF-16 offsets
  // and `[...src]` splits into code POINTS — one emoji would shift every index
  // after it. Caught on check-palette by the length invariant below, not by
  // reading the code.
  const out = src.split("");
  const seen = new Set();
  const take = (ranges) => {
    for (const r of ranges ?? []) {
      const key = `${r.pos}:${r.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      for (let i = r.pos; i < r.end; i++) if (out[i] !== "\n") out[i] = " ";
    }
  };
  /*
   * LEADING **AND TRAILING**. TypeScript calls a comment on the SAME LINE as the
   * preceding token TRAILING trivia, and `getLeadingCommentRanges` does not return
   * those — six of seven syntactic positions are missed by the leading call alone.
   *
   * I SHIPPED EXACTLY THAT IN #1142 (repaired in #1150), and here it would have
   * been worse than a missed comment. An unblanked `}` inside an import clause
   * truncates the binding capture, so
   *
   *     import {
   *       spawnSync, // } from "decoy"
   *     } from "node:child_process";
   *
   * read as importing NOTHING: the file is swept, reported clean, and its
   * child_process use never examined. Caught by driving the fixture rather than by
   * review — the leading-only version reported `0 importing` where the regex it
   * replaces reported 1.
   */
  const visit = (node) => {
    take(ts.getLeadingCommentRanges(src, node.getFullStart()));
    take(ts.getTrailingCommentRanges(src, node.getEnd()));
    node.getChildren(sf).forEach(visit);
  };
  visit(sf);

  // The property the old blanking was reaching for, now ASSERTED rather than
  // intended: same length and same newline count, so no offset can drift. A
  // blanking bug becomes a refusal instead of a finding at the wrong line.
  const blanked = out.join("");
  const nl = (t) => (t.match(/\n/g) ?? []).length;
  if (blanked.length !== src.length || nl(blanked) !== nl(src)) return null;
  return blanked;
}
/*
 * ANCHORED AT THE START OF A LINE, WHICH IS NOT COSMETIC.
 *
 * This checker's own self-test carries fixture files as one-line template
 * literals: `"scripts/ns.mjs": \`import * as cp from "node:child_process";\n…\``.
 * Without the anchor the checker reads that fixture TEXT as an import and
 * refuses on the very file that proves it works — measured: exit 2 on this repo
 * the moment the self-test landed. Fixture text is data, and a real import is
 * always the first thing on its line.
 *
 * That is a heuristic, not a parse: an import written at the start of a line
 * inside a MULTI-line template literal would still be read as code. Recorded in
 * the honest-limit note above rather than papered over, and preferred to
 * exempting the self-test by name — a rule that excuses the file testing it is
 * not a rule.
 */
const IMPORT_NAMED =
  /^\s*import\s*\{([^}]*)\}\s*from\s*["'](?:node:)?child_process["']/gm;
const REQUIRE_NAMED =
  /^\s*(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*["'](?:node:)?child_process["']\s*\)/gm;
const IMPORT_OPAQUE =
  /^\s*import\s+(?:\*\s+as\s+\w+|\w+)\s*(?:,\s*\{[^}]*\})?\s*from\s*["'](?:node:)?child_process["']/m;
const REQUIRE_OPAQUE =
  /^\s*(?:const|let|var)\s+\w+\s*=\s*require\(\s*["'](?:node:)?child_process["']\s*\)/m;

/** A bare JS identifier, optionally a `type` re-export. */
const IDENTIFIER = /^(?:type\s+)?[A-Za-z_$][\w$]*$/;

/**
 * The names a file pulls out of child_process — or a refusal if it cannot tell.
 *
 * THE SPAN IS BRACE-BOUNDED, NOT LINE-BOUNDED, and the difference is observable.
 * The import patterns are anchored to the start of a line, but their inner
 * `[^}]*` crosses newlines — it has to, because a multi-line import is ordinary
 * and must be read. What stops it running away is that `[^}]*` cannot cross a
 * `}`, and any real JavaScript between an import's braces contains one.
 *
 * That is a genuine bound but not the one it looks like, and an adversarial
 * probe showed the gap: given a malformed import whose brace stayed open across
 * three lines, the capture spanned them and produced a garbage "binding" of
 * `spawnSync\nconst decoy = …`. The VERDICT was right — that garbage is not
 * `execSync` — and the evidence was junk. Getting the right answer is not
 * evidence the mechanism is right (DEV1-lang found the same class in #736 part 2,
 * where a whole-file `[^\]]` bracketed a variable across unrelated lines and
 * scored a perfect result from the wrong evidence).
 *
 * So a binding list that is not a list of identifiers is a REFUSAL: the capture
 * picked up something that is not an import, and reporting "no shell-form
 * binding" over it would be a verdict about a subject that was never read. Same
 * reason as the namespace-import refusal below — the import line stopped
 * answering the question.
 */
function bindingsIn(src, rel, unreadable) {
  const names = new Set();
  for (const re of [IMPORT_NAMED, REQUIRE_NAMED]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) {
      for (const raw of m[1].split(",")) {
        const name = raw.trim();
        if (!name) continue;
        const bound = name.split(/\s+as\s+/)[0].trim();
        if (!IDENTIFIER.test(bound)) {
          unreadable.push({
            rel,
            why:
              `the child_process import list contains ${JSON.stringify(
                bound.slice(0, 60)
              )}, ` +
              "which is not an identifier — the capture spanned something that is " +
              "not an import, so which APIs are in scope was never established",
          });
          return null;
        }
        if (!bound.startsWith("type")) names.add(bound);
      }
    }
  }
  return names;
}

const findings = [];
const unreadable = [];
let importers = 0;

for (const file of files) {
  const rel = relative(CWD, file);
  const src = stripComments(readFileSync(file, "utf8"), rel);
  /*
   * A FILE THAT COULD NOT BE BLANKED IS A REFUSAL, and it uses the channel this
   * file already has. An unparsed file contains no `child_process` string, so
   * without this it would `continue` and read exactly like a file that does not
   * use child_process at all — the same absence-for-emptiness confusion the
   * namespace-import branch below exists to prevent.
   */
  if (src === null) {
    unreadable.push({
      rel,
      why: "did not parse, or blanking it did not preserve its offsets, so no child_process call was looked for in it — which is not the same as it making none",
    });
    continue;
  }
  if (!/["'](?:node:)?child_process["']/.test(src)) continue;

  /*
   * A NAMESPACE OR DEFAULT IMPORT DEFEATS THE ANCHOR.
   *
   * `import * as cp` puts every API in scope under a name this checker cannot
   * follow without parsing, so the import line stops answering the question.
   * That is a REFUSAL, not a pass: reporting "no shell-form import" over a file
   * whose imports were never resolved is a verdict about the wrong subject.
   */
  if (IMPORT_OPAQUE.test(src) || REQUIRE_OPAQUE.test(src)) {
    unreadable.push({
      rel,
      why: "imports child_process as a namespace or default binding, so which APIs are in scope cannot be read off the import line",
    });
    continue;
  }

  const names = bindingsIn(src, rel, unreadable);
  if (names === null) continue; // refusal already recorded
  if (names.size === 0) continue;
  importers += 1;

  const shellForm = [...names].filter((n) => SHELL_FORM.has(n));
  if (shellForm.length === 0) continue;

  const inE2e = rel === "e2e" || rel.startsWith(`e2e${sep}`);
  if (!inE2e) {
    findings.push({
      rel,
      rule: "R1",
      why: `imports ${shellForm.join(
        ", "
      )} — a command STRING a shell parses. Use the argv form: execFileSync(bin, [args]) or spawnSync(bin, [args]).`,
    });
  }

  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!DISCARDS_VERDICT.test(lines[i])) continue;
    findings.push({
      rel,
      rule: "R2",
      line: i + 1,
      why: "`|| true` replaces the command's exit status with success, so a failure and a clean result become the same verdict — the mechanism of #736",
      text: lines[i].trim().slice(0, 110),
    });
  }
}

/*
 * A SWEEP OF NOTHING IS NOT A PASS — the same guard its sibling checker carries,
 * for the same reason: run from the wrong directory this found zero files and
 * printed a green whose only content was that it looked in the wrong place.
 */
if (files.length === 0) {
  console.error(
    `FAIL: swept 0 files under ${CWD}.\n` +
      "  Nothing was examined, so this run proves nothing. Pass --cwd REPO_ROOT."
  );
  process.exit(1);
}

if (unreadable.length) {
  console.error(
    `REFUSING: ${unreadable.length} file(s) import child_process in a form this\n` +
      "  checker cannot resolve, so they were never examined:\n"
  );
  for (const u of unreadable) console.error(`  ${u.rel} — ${u.why}`);
  console.error(
    "\n  Exiting 2: the question could not be asked, not answered."
  );
  process.exit(2);
}

if (findings.length) {
  console.error(`FAIL: ${findings.length} shell-parsed command(s).\n`);
  for (const f of findings) {
    console.error(`  ${f.rel}${f.line ? `:${f.line}` : ""}  [${f.rule}]`);
    if (f.text) console.error(`    ${f.text}`);
    console.error(`    ${f.why}\n`);
  }
  console.error(
    "  The argv form takes the binary and its arguments separately, so no\n" +
      "  shell is involved and nothing can be re-split or interpreted:\n\n" +
      '    const res = spawnSync(bin, ["ps", "-aq", ...filters], { encoding: "utf-8" });\n' +
      "    if (res.error) throw new Error(`could not run ${bin}: ${res.error.message}`);\n" +
      "    if (res.status !== 0) throw new Error(`exited ${res.status}: ${res.stderr}`);\n\n" +
      "  e2e/ may shell out (R1 does not apply there), but R2 does: the verdict\n" +
      "  must survive. Capture the status before filtering, never `|| true`.\n"
  );
  process.exit(1);
}

reportSubject(files.length, "JS/TS file(s) swept for child_process use");
console.log(
  `PASS: ${files.length} JS/TS file(s) swept, ${importers} importing child_process —\n` +
    "      every one reaches it through an argv-form API, so no shell parses a\n" +
    "      command string. e2e/ may shell out; its verdicts are still asserted."
);
