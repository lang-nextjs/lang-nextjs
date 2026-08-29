#!/usr/bin/env node
/**
 * Property: NO SHELL IN THIS REPO DISCARDS THE VERDICT IT EXISTS TO REPORT.
 *
 * THE FINDING THIS MECHANISES (#216). In one session two agents independently
 * broke rules they had already written down, the same way — a pipeline that
 * throws away the status it is supposed to check:
 *
 *   npx tsc --noEmit 2>&1 | grep -E "error TS" | head -3
 *
 * reported CLEAN over 43 syntax errors. A pipeline's exit status is its LAST
 * command's, so that reports grep's, not tsc's — and `head` can SIGPIPE grep
 * before it finishes. `| head` is a verdict-destroying operation WEARING THE
 * CLOTHES OF PRESENTATION, which is why it survives review: it reads as
 * formatting.
 *
 *   npx tsc --noEmit 2>&1 | grep -c "error TS"
 *
 * returned 0 over COLOURED output: ANSI escapes sit between `error` and `TS`,
 * the substring never matches, and the zero reads as clean.
 *
 * WHY A DOC ENTRY IS NOT THE FIX, in the issue's words: both people who tripped
 * these had written or read the rule. They must be remembered at the moment of
 * typing a pipeline, which is exactly when nobody consults a doc.
 *
 * ── The two rules ───────────────────────────────────────────────────────────
 *
 * R1  A verdict-bearing command piped into a filter, in a block that does not
 *     set `pipefail`. With pipefail the shell propagates the failure and the
 *     construct is sound; without it the status is silently the filter's.
 *     Capturing the status first is the other accepted form.
 *
 * R2  `grep` over a tool that colours its output, without colour disabled.
 *     NO_COLOR / FORCE_COLOR=0 / --no-color all count.
 *
 * ── Totality, which is the part that decides whether this is worth having ───
 *
 * EVERY `run:` block in every workflow and EVERY script is examined — not the
 * ones matching a shape the author already had in mind. A checker that inspects
 * only known shapes passes vacuously on the shape nobody anticipated, which is
 * the defect class this repo keeps finding rather than a defence against it.
 *
 * ── Honest limit ────────────────────────────────────────────────────────────
 *
 * This catches pipelines whose SHAPE destroys a verdict. It cannot catch a
 * check that runs correctly and asserts the wrong property — a reader's job,
 * and a different class. Said here so the green is not read as more than it is.
 *
 * Usage: node scripts/assert-no-verdict-destroying-pipelines.mjs [--cwd DIR]
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const argv = process.argv.slice(2);
const ci = argv.indexOf("--cwd");
const CWD =
  ci >= 0
    ? resolve(argv[ci + 1])
    : join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Commands whose exit status IS the verdict a step reports.
 *
 * Deliberately the runners and checkers, not every binary: `echo x | grep y` is
 * not a verdict, and flagging it would train people to ignore this.
 */
const VERDICT = String.raw`(?:npx\s+)?(?:tsc|vitest|playwright|eslint|prettier|jest)\b|pnpm\s+(?:-s\s+)?(?:run\s+)?[a-z][\w:-]*|npm\s+run\s+[\w:-]+|node\s+\S*scripts/\S+\.mjs|bash\s+\S*scripts/\S+\.sh`;

/** Filters that replace the upstream status with their own. */
const FILTER = String.raw`\b(?:grep|head|tail|cut|wc|awk|sed|sort|uniq|tr)\b`;

/** Tools that colour by default, so a bare grep over them is a coin flip. */
const COLOURING = /\b(?:tsc|vitest|playwright|eslint|prettier|jest|pnpm|npm|turbo)\b/;

const COLOUR_DISABLED =
  /NO_COLOR|FORCE_COLOR\s*=\s*0|--no-colors?\b|--color[= ](?:never|false|0)\b/;

/**
 * Offenders that exist today, if any. Each entry is RE-DERIVED every run: one
 * that has since been fixed FAILS and says to delete it, so the list cannot
 * quietly become permanent. Same obligation as the census and rung allowlists.
 */
const KNOWN = [];

const files = [];
function walk(dir, filter) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, filter);
    else if (filter(name)) files.push(p);
  }
}
walk(join(CWD, ".github/workflows"), (n) => n.endsWith(".yml") || n.endsWith(".yaml"));
walk(join(CWD, "scripts"), (n) => n.endsWith(".sh") || n.endsWith(".bash"));

/**
 * Shell blocks to inspect: every `run:` in a workflow, and every shell script
 * whole. Workflow YAML is scanned line-wise rather than parsed, deliberately —
 * a parse failure on one file must not silently drop it from the sweep, which
 * would be a hole exactly where totality is the point.
 */
function blocksFor(file) {
  const text = readFileSync(file, "utf8");
  if (!file.includes(".github/workflows")) {
    return [{ startLine: 1, lines: text.split("\n"), pipefail: /set\s+-[a-z]*o?\s*pipefail|set\s+-\S*e\S*o\s+pipefail|pipefail/.test(text) }];
  }
  const out = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:-\s+)?run:\s*(\|[-+]?|>[-+]?)?\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    const body = [];
    if (m[3]) body.push({ n: i + 1, text: m[3] });
    if (m[2]) {
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (l.trim() === "") { body.push({ n: j + 1, text: "" }); continue; }
        const ind = l.length - l.trimStart().length;
        if (ind <= indent) break;
        body.push({ n: j + 1, text: l });
      }
    }
    const joined = body.map((b) => b.text).join("\n");
    out.push({ body, pipefail: /pipefail/.test(joined) });
  }
  return out;
}

const findings = [];
for (const file of files) {
  const rel = relative(CWD, file);
  const blocks = blocksFor(file);
  for (const block of blocks) {
    const rows = block.body ?? block.lines.map((text, idx) => ({ n: idx + 1, text }));
    /*
     * JOIN LINE CONTINUATIONS BEFORE SCANNING — THIS CHECKER FAILED ITS OWN
     * TOTALITY RULE WITHOUT IT.
     *
     * The first version scanned line by line and reported PASS on main. The two
     * lines that motivated the rule look like this:
     *
     *     LISTED="$(pnpm exec playwright test --list --project=visual 2>/dev/null \
     *       | grep -cE '^\s+\[visual\]' || true)"
     *
     * The pipe begins the CONTINUATION line, so the scan saw `| grep …` with an
     * empty left-hand side and matched nothing. A checker that passes over the
     * exact shape it was written for is the defect it exists to catch, wearing
     * its own uniform.
     */
    const joined = [];
    for (let k = 0; k < rows.length; k++) {
      let { n, text } = rows[k];
      let acc = String(text);
      while (/\\\s*$/.test(acc) && k + 1 < rows.length) {
        k += 1;
        acc = acc.replace(/\\\s*$/, " ") + String(rows[k].text).trim();
      }
      joined.push({ n, text: acc });
    }

    for (const { n, text } of joined) {
      const line = String(text);
      const bare = line.replace(/#.*$/, "");
      if (!bare.includes("|")) continue;
      // `||` is not a pipe.
      const piped = bare.replace(/\|\|/g, "  ");
      if (!piped.includes("|")) continue;

      const left = piped.split("|")[0];
      const right = piped.slice(piped.indexOf("|") + 1);

      if (new RegExp(VERDICT).test(left) && new RegExp(FILTER).test(right) && !block.pipefail) {
        findings.push({
          rel, n, rule: "R1",
          why: "a verdict-bearing command is piped into a filter and this block does not set pipefail, so the status reported is the filter's",
          line: line.trim().slice(0, 110),
        });
      }
      if (/\bgrep\b/.test(right) && COLOURING.test(left) && !COLOUR_DISABLED.test(line)) {
        findings.push({
          rel, n, rule: "R2",
          why: "grep over a tool that colours by default; ANSI escapes can sit inside the pattern and the miss reads as a clean result",
          line: line.trim().slice(0, 110),
        });
      }
    }
  }
}

const key = (f) => `${f.rel}:${f.n}:${f.rule}`;
const unexcused = findings.filter((f) => !KNOWN.includes(key(f)));
const staleExcuses = KNOWN.filter((k) => !findings.some((f) => key(f) === k));

if (staleExcuses.length) {
  console.error("STALE ALLOWLIST ENTRIES — these no longer occur. Delete them:\n");
  for (const k of staleExcuses) console.error(`  ${k}`);
  process.exit(1);
}

if (unexcused.length) {
  console.error(
    `FAIL: ${unexcused.length} verdict-destroying pipeline(s).\n`
  );
  for (const f of unexcused) {
    console.error(`  ${f.rel}:${f.n}  [${f.rule}]`);
    console.error(`    ${f.line}`);
    console.error(`    ${f.why}\n`);
  }
  console.error(
    "  The safe form captures the verdict BEFORE filtering:\n\n" +
      "    cmd > /tmp/out 2>&1; code=$?     # the verdict\n" +
      "    grep ... /tmp/out                # then filter, for humans\n\n" +
      "  `set -o pipefail` in the block is also accepted: the shell then\n" +
      "  propagates the failure instead of reporting the filter's success.\n" +
      "  For R2, disable colour (NO_COLOR=1 / FORCE_COLOR=0 / --no-color).\n"
  );
  process.exit(1);
}

console.log(
  `PASS: ${files.length} file(s) swept, every run: block and every shell script,\n` +
    "      not only the shapes this checker already knew. No pipeline reports a\n" +
    "      filter's status in place of the verdict it was asked for."
);
