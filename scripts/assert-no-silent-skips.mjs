#!/usr/bin/env node
/**
 * assert-no-silent-skips.mjs — a test that never runs anywhere must say why, in writing.
 *
 * THE DEFECT THIS EXISTS FOR, with a live instance.
 *
 * A suite reporting `Tests 325 passed | 10 skipped (335)` is GREEN. The skip count sits in a line
 * nobody reads, and a skipped test is indistinguishable from a passing one at the summary. The
 * board saw that number all night and nobody looked.
 *
 * Inside it: `it.skip("stream aborted by client (reader.cancel) propagates to upstream so socket
 * is released")` — a guard against an FD leak on a long-lived streaming endpoint, carrying the
 * comment "Un-skip it as part of the route fix." The route fix landed in #37. The test was never
 * un-skipped. Measured: with the skip removed it PASSES, 11/11.
 *
 * So a test guarding a fixed P0 defect spent days switched off, in a suite that reported success
 * the whole time. That is the same family as a grep that cannot fail and a schema that rejects
 * everything: a check reporting a verdict it did not compute.
 *
 * WHAT IS AND IS NOT FLAGGED, and the distinction is the whole design.
 *
 *   `.skip(` / `.todo(`         UNCONDITIONAL — this test runs NOWHERE, ever.        FLAGGED
 *   `.skipIf(cond)` / `.runIf(` CONDITIONAL — runs when the condition holds, and the
 *                               condition is visible in the source next to it.       allowed
 *
 * The nine `blazing-sandbox.live.test.ts` skips are `describe.skipIf(!LIVE)` gated on
 * BLAZING_API_URL. Those tests run in an environment that has the credentials; they are
 * self-documenting and honest, and flagging them would be the cry-wolf failure that gets a check
 * disabled. A conditional skip declares its condition; an unconditional one declares nothing.
 *
 * Declared skips go in DECLARED below, each with a reason, and each is checked for staleness:
 * an entry naming a skip that no longer exists FAILS, telling you to delete it. Same device as
 * PENDING_RECLASSIFICATION and NOT_PUBLIC — an allowlist that cannot rot silently, because an
 * allowlist nobody revisits is how a temporary suppression becomes permanent.
 *
 * Usage: node scripts/assert-no-silent-skips.mjs [--cwd DIR]
 */
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { reportSubject } from "./lib/subject.mjs";

const argv = process.argv.slice(2);
const ci = argv.indexOf("--cwd");
const CWD =
  ci >= 0
    ? resolve(argv[ci + 1])
    : join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Unconditional skips that are deliberate. `file` is repo-relative; `match` is a distinctive
 * substring of the test name. Every entry needs a `why` a maintainer can act on.
 */
/*
 * A REFUSAL, NOT A CRASH, IF THE PARSER IS ABSENT — the same shape `assert-formatted.mjs` uses
 * for prettier. Without typescript nothing was examined, which must stay distinguishable from
 * nothing being wrong.
 */
let ts;
try {
  ts = (await import("typescript")).default;
} catch (e) {
  console.error(
    "REFUSE: typescript could not be imported, so no test file was parsed and no skip was " +
      `looked for. Run \`pnpm install\` in this tree.\n       ${e.message}`
  );
  process.exit(2);
}

const DECLARED = [
  // (empty — and that is the point. Adding an entry is a visible, reviewable act.)
];

/*
 * PARSED, NOT STRIPPED (#1134). This read the file as TEXT and blanked block comments with
 * `/\*[\s\S]*?\*\/`. A glob in a string literal OPENS a false comment:
 *
 *     const alias = "@/*";                 <- opens
 *     it.skip("this test never runs");     <- blanked
 *     /* an ordinary block comment *\/     <- closes it
 *
 *     it.skip occurrences: before 2, after 1
 *
 * The checker then reported a clean file while a skipped test hid inside the false comment.
 * THIS ONE GATES, so a pull request could carry a silently skipped test through it.
 *
 * WHY PARSE RATHER THAN PATCH THE STRIPPER. `assert-ismain-guards-resolve.mjs` records the
 * switch trigger for this repository: if the stripper needs a third patch, stop patching and
 * parse. Two separate glob-eating incidents preceded this one; it is the third. A parser knows
 * what a comment is, so the class cannot recur here — it is closed by construction rather than
 * by a better pattern.
 *
 * `.skipIf` IS EXCLUDED STRUCTURALLY NOW. The old negative lookahead `(?!If)` carried the whole
 * distinction between "runs nowhere" and "runs when its stated condition holds"; here the
 * property name simply is not `skip`, so no lookahead is needed and none can be dropped.
 */
function skipsIn(file) {
  const source = readFileSync(join(CWD, file), "utf8");
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    /x$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

  /*
   * A FILE THAT DID NOT PARSE YIELDS NO NODES, WHICH READS EXACTLY LIKE A FILE WITH NO SKIPS —
   * the same shape as the defect above, arriving through the repair. Refuse instead.
   */
  const diagnostics = sf.parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    console.error(
      `REFUSE: ${file} did not parse (${diagnostics.length} diagnostic(s)), so it was not ` +
        `examined. An unparsed file yields no skips, which is not the same as having none.`
    );
    process.exit(2);
  }

  const out = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const kind = node.expression.name.text;
      const base = node.expression.expression;
      if (
        (kind === "skip" || kind === "todo") &&
        ts.isIdentifier(base) &&
        (base.text === "describe" || base.text === "it" || base.text === "test")
      ) {
        /*
         * THE FIRST ARGUMENT MUST BE A STRING LITERAL, AND THAT IS THE WHOLE DISCRIMINATOR.
         * The old regex encoded it as `\(\s*["'`]` and I dropped it on the first rewrite;
         * running the result against the tree reported EIGHT findings that are Playwright's
         * CONDITIONAL forms:
         *
         *     test.skip(true, `No model API key set (${names})`)      condition first
         *     test.skip(() => process.env.LIVE_RUNTIME !== "django")  predicate first
         *
         * Those state their condition in the source, which is exactly what this checker does
         * NOT hunt. A declared skipped test names itself first; a runtime skip decides first.
         */
        const arg = node.arguments[0];
        // NOT an early `return` — that would skip `forEachChild` below and stop the walk
        // descending into this subtree, which is the same silent-miss class this file is
        // being repaired for, reintroduced by the repair.
        if (arg && ts.isStringLiteralLike(arg)) {
          out.push({
            file,
            line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
            kind,
            name: arg.text,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const testFiles = execFileSync("git", ["ls-files", "-z"], {
  cwd: CWD,
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean)
  .filter((f) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f))
  .filter((f) => existsSync(join(CWD, f)));

// Non-vacuity: a scan that finds no test files would report a clean bill of health over nothing.
if (testFiles.length < 10) {
  console.error(
    `FAIL: found only ${testFiles.length} test files — the scan is broken, not the tree.`
  );
  process.exit(1);
}

const found = testFiles.flatMap(skipsIn);
const isDeclared = (s) =>
  DECLARED.some((d) => d.file === s.file && s.name.includes(d.match));

const undeclared = found.filter((s) => !isDeclared(s));
const stale = DECLARED.filter(
  (d) => !found.some((s) => s.file === d.file && s.name.includes(d.match))
);

let bad = false;

if (undeclared.length > 0) {
  bad = true;
  console.error(
    `FAIL: ${undeclared.length} test(s) are skipped unconditionally and undeclared.`
  );
  console.error(
    `      A test that runs nowhere is indistinguishable from a passing one in the`
  );
  console.error(
    `      summary. Un-skip it, delete it, or declare it with a reason.\n`
  );
  for (const s of undeclared) {
    console.error(
      `       ${s.file}:${s.line}  .${s.kind}  "${s.name.slice(0, 70)}"`
    );
  }
}

if (stale.length > 0) {
  bad = true;
  console.error(
    `\nFAIL: ${stale.length} DECLARED entr(ies) match no skip — delete them.`
  );
  console.error(
    `      A suppression nobody revisits is how "temporary" becomes permanent.\n`
  );
  for (const d of stale) console.error(`       ${d.file} :: "${d.match}"`);
}

if (bad) process.exit(1);

reportSubject(testFiles.length, "test file(s) scanned for unconditional skips");
console.log(
  `PASS: ${testFiles.length} test files scanned; ${found.length} unconditional skip(s), ` +
    `all ${DECLARED.length} declared. Conditional skips (.skipIf/.runIf) are not counted — ` +
    `they state their condition in the source.`
);
