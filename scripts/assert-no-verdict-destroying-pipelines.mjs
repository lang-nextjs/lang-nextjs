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
 * R3  A status DESTROYED by `|| true` and BOUND to a variable that nothing in
 *     the file BRANCHES on (#736). `| grep` is one spelling of destroying a
 *     verdict; `|| true` is another, and the file name said "pipelines" while
 *     line 3 said "no shell in this repo discards the verdict it exists to
 *     report". The name shrank the domain by a rule nobody wrote down, and two
 *     real defects sat outside it.
 *
 *     A GUARD IS A BRANCH ON THE VALUE. Not merely a use of it: asserting that
 *     the value EQUALS the success value is not a guard, it is the defect —
 *     `expect(ps).toBe("")` makes "no containers leaked" and "I could not ask
 *     docker" the same string. Everything in this repo's compliant corpus
 *     branches: `[ -z "$CODE" ]`, `[ "$LISTED" -lt 1 ]`, `case`, `${X:-default}`,
 *     and — the two that forced the generalisation — `[ "$__lock_url" =
 *     "$__lock_json" ]`, which names the variable on the RIGHT of a comparison,
 *     and `if printf '%s' "$ANNOT" | grep -q …; then … else`, which is a command
 *     condition rather than a test expression.
 *
 *     SCOPED TO THE VARIABLE, NOT THE FILE, and that is load-bearing. A
 *     file-scoped search accepts e2e/rungs/open-swe/open-swe-sandbox.spec.ts
 *     because it contains `body.stderr ?? ""` — a legitimate default, on an
 *     unrelated value — and both defects live in that file. A file-level rule
 *     would ship green having cleared the file it was written to catch. The
 *     patterns are also matched LINE-WISE for the same reason: `[^\]]` matches
 *     newlines, so a whole-file match lets a `[` far above and a `]` far below
 *     bracket the variable by accident. A detector that reads a file as one
 *     string is a file-level rule wearing a variable-level costume.
 *
 * ── `2>/dev/null` is NOT a third spelling, measured ─────────────────────────
 *
 * It was briefed as one and it is not. Run in `sh`:
 *
 *     false 2>/dev/null            -> exit 1   the status SURVIVES
 *     false || true                -> exit 0   destroyed
 *     false 2>/dev/null | cat      -> exit 0   the PIPE destroyed it, not the redirect
 *     VAR=$(false 2>/dev/null)     -> exit 1   status survives on the assignment
 *
 * THE TWO DESTROY DIFFERENT THINGS, and both e2e sites carry both, which is how
 * they got conflated: `|| true` destroys the VERDICT, and `2>/dev/null` destroys
 * the EVIDENCE you would need to diagnose it. Only the first makes a failure
 * representable as a success, so only the first is a defect by this rule — but
 * the second is why the first is hard to notice, and a site carrying both is
 * worse than a site carrying either.
 *
 * So a bare `2>/dev/null` discards the DIAGNOSTIC, not the verdict. It is an
 * aggravator — it removes the evidence a human would have used to notice — and
 * flagging it alone would fire on 37 sites in this repo that destroy nothing.
 * Its size is stated here rather than omitted, because a domain quietly narrowed
 * by an unstated rule is how "pipelines" happened in the first place: 45
 * occurrences across 10 files in the current domain, 8 of which also carry
 * `|| true` on the same line and are therefore already covered by R3.
 *
 * ── Declared out of scope, and COUNTED rather than skipped ──────────────────
 *
 * Of the 16 `|| true` sites in the swept tree: 3 are comments, 11 are variable
 * bindings (R3's checkable set), and 2 are neither:
 *
 *   scripts/dev-all.sh          statement position, nothing captured — there is
 *                               no variable for a guard to name
 *   scripts/has-rung.selftest.sh  `$(…)` inside a heredoc feeding `while read`;
 *                               its guard is a `$sites -lt 3` loop-counter floor
 *                               that no variable-scoped rule can see, so R3
 *                               would false-positive on a COMPLIANT site
 *
 * They are reported in the summary as out-of-scope-and-counted. Dropping them
 * silently would shrink the domain by a rule nobody wrote down, which is the
 * defect this rule exists to repair, one level up.
 *
 * ── Totality, which is the part that decides whether this is worth having ───
 *
 * EVERY `run:` block in every workflow, EVERY shell script, and EVERY
 * `package.json` script is examined — not the ones matching a shape the author
 * already had in mind. A checker that inspects only known shapes passes
 * vacuously on the shape nobody anticipated, which is the defect class this
 * repo keeps finding rather than a defence against it.
 *
 * WHY package.json WAS ADDED WHILE ITS DOMAIN WAS EMPTY (#730). A package
 * script is a shell command that CI executes and reports the status of, so it
 * carries verdicts exactly as a `run:` block does — and it was not swept. At the
 * time of writing there are 201 script entries across 18 package.json files and
 * none contains a pipe, so nothing went red when the domain widened. That is the
 * argument for doing it then rather than later: a domain gap passes for as long
 * as it stays empty and gives no signal in between, so the day someone writes
 *
 *     "typecheck": "tsc --noEmit | grep -E 'error TS'"
 *
 * it runs in CI, reports grep's status, and the workflow `run:` block that
 * invoked it sweeps clean. The domain was narrower than the property this file
 * names in its own first line.
 *
 * A CONSEQUENCE FOR READING THE OUTPUT. Widening a domain over an empty set
 * produces a green before and after, so the PASS line below reports the sweep's
 * COMPOSITION and not just a total. "18 package.json" in that line is the only
 * way to tell this file's domain from the one it replaced; a bare file count
 * cannot distinguish a widened sweep from a sweep that silently found none.
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
const COLOURING =
  /\b(?:tsc|vitest|playwright|eslint|prettier|jest|pnpm|npm|turbo)\b/;

const COLOUR_DISABLED =
  /NO_COLOR|FORCE_COLOR\s*=\s*0|--no-colors?\b|--color[= ](?:never|false|0)\b/;

/**
 * Offenders that exist today, if any. Each entry is RE-DERIVED every run: one
 * that has since been fixed FAILS and says to delete it, so the list cannot
 * quietly become permanent. Same obligation as the census and rung allowlists.
 */
const KNOWN = [];

/**
 * Directories never descended into.
 *
 * Kept to the two that are wrong to read rather than a tidy-looking list of
 * build outputs: every name here is a place this checker cannot see, so the
 * list is itself a narrowing of the domain and each entry has to earn its
 * place. `node_modules` is other people's code and is skipped BY NAME, which
 * also covers the symlink form a shared install uses; `.git` is not source.
 */
/*
 * `__fixtures__` joins these for #736's JS arm: its contents are recorded
 * DEFECTIVE input, so sweeping them would make the tree permanently red over
 * files that exist to be red.
 */
const SKIP_DIRS = new Set(["node_modules", ".git", "__fixtures__"]);

const files = [];
function walk(dir, filter, kind) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, filter, kind);
    else if (filter(name)) files.push({ path: p, kind });
  }
}
walk(
  join(CWD, ".github/workflows"),
  (n) => n.endsWith(".yml") || n.endsWith(".yaml"),
  "workflow"
);
walk(
  join(CWD, "scripts"),
  (n) => n.endsWith(".sh") || n.endsWith(".bash"),
  "shell"
);
// Repo-wide rather than an enumerated list of workspaces: a list is a second
// declaration of where packages live, and the one that goes stale silently is
// always the copy that is not the source of truth.
walk(CWD, (n) => n === "package.json", "package");
/*
 * FILES THAT HAND A SHELL A STRING (#736). The property is about verdicts
 * destroyed, not about which language spells the destruction:
 * `execSync("… || true")` discards a status exactly as a .sh line does.
 *
 * Measured before widening rather than after: across every tracked
 * .ts/.tsx/.mjs/.js/.cjs, exactly ONE file uses `execSync` with a string. The
 * rest of this repo uses `execFileSync` with an argv array, where no shell
 * parses anything and a pipeline is impossible by construction.
 *
 * A SELFTEST'S JOB IS TO CONTAIN THE SHAPES THIS CHECKER CATCHES, so scanning
 * one reports the checker's own test data as tree defects. Measured: this
 * file's own selftest plants `const out = execSync(\`cmd || true\`)` inside a
 * string, and the sweep counted it as a real binding. It was a GUARDED shape,
 * so it inflated the ledger rather than producing a false finding — but an
 * unguarded inline fixture would have been reported as a defect in the
 * checker's own proof. This is the hazard import-keying avoids by construction
 * and a text scanner cannot: to a regex there is no difference between code and
 * a string that looks like code. The cost is stated rather than hidden — a
 * genuine verdict-destroying line in a selftest's OWN logic is not swept.
 */
const isTestData = (n) => /\.selftest\.(?:mjs|js|cjs)$/.test(n);
const shellStringFile = (n) =>
  !isTestData(n) &&
  (n.endsWith(".ts") ||
    n.endsWith(".mjs") ||
    n.endsWith(".js") ||
    n.endsWith(".cjs"));
walk(join(CWD, "e2e"), shellStringFile, "js");
walk(join(CWD, "scripts"), shellStringFile, "js");

/**
 * Shell blocks to inspect: every `run:` in a workflow, and every shell script
 * whole. Workflow YAML is scanned line-wise rather than parsed, deliberately —
 * a parse failure on one file must not silently drop it from the sweep, which
 * would be a hole exactly where totality is the point.
 */
const unreadable = [];
/**
 * package.json files that actually declare `scripts`, which is what the
 * composition line counts.
 *
 * WHY NOT THE NUMBER OF FILES FOUND. A built tree contains generated
 * package.json files — measured here: eight under the apps' .next output, each
 * holding only `{"type": ...}` — so a raw count reads 18 in a clean checkout and
 * 26 in a built one. That number is load-bearing evidence that this checker's
 * domain includes package.json at all, and evidence that changes with whether
 * somebody has run a build is poor evidence. Files with no `scripts` contribute
 * no blocks either way, so counting the ones that do is both stable and the
 * honest description of what was examined.
 *
 * Deliberately NOT solved by adding `.next`/`dist`/`build` to SKIP_DIRS: that
 * trades a wobbling number for a list of places the checker cannot see, which
 * goes stale silently the first time a build emits somewhere new.
 */
const withScripts = new Set();

/**
 * A package.json script is a shell command a package manager runs, so each one
 * is a block of exactly one line.
 *
 * PARSED, NOT SCANNED LINE-WISE — the opposite of the choice made for workflow
 * YAML above, and for a reason. A workflow is scanned line-wise so a parse
 * failure cannot silently drop a file from a sweep whose whole value is
 * totality. Here the same obligation is met differently: package.json MUST be
 * valid JSON for anything in the repo to work, so a parse failure is a real
 * defect rather than a shape this checker failed to anticipate — and it is
 * reported as a REFUSAL below rather than skipped. Parsing also resolves JSON
 * escapes, so the text scanned is the shell the manager will actually run.
 *
 * The line number is recovered by locating the key in the raw text, so a
 * finding points at the script the reader has to go and edit rather than at the
 * file. If the key cannot be located the finding still reports, at line 1 —
 * a finding with a vague location beats a finding suppressed for want of one.
 */
function packageBlocks(file, text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    unreadable.push({ file, why: `not valid JSON: ${e.message}` });
    return [];
  }
  const scripts = parsed?.scripts;
  if (!scripts || typeof scripts !== "object") return [];
  withScripts.add(file);
  const lines = text.split("\n");
  const lineOf = (name) => {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const want = new RegExp(`^\\s*"${esc}"\\s*:`);
    const i = lines.findIndex((l) => want.test(l));
    return i >= 0 ? i + 1 : 1;
  };
  return Object.entries(scripts)
    .filter(([, v]) => typeof v === "string")
    .map(([name, value]) => ({
      body: [{ n: lineOf(name), text: value }],
      pipefail: /pipefail/.test(value),
    }));
}

function blocksFor(file, kind) {
  const text = readFileSync(file, "utf8");
  if (kind === "package") return packageBlocks(file, text);
  /*
   * A JS/TS FILE IS NOT A SHELL BLOCK, and treating it as one is a defect. R1
   * and R2 read a line as shell; a file that PLANTS a bad pipeline in a string
   * literal would be reported for containing its own fixtures. So a JS file
   * gets R3 only, and only on lines that actually hand a shell a string.
   */
  if (kind === "js") {
    return [
      { startLine: 1, lines: text.split("\n"), pipefail: false, js: true },
    ];
  }
  if (!file.includes(".github/workflows")) {
    return [
      {
        startLine: 1,
        lines: text.split("\n"),
        pipefail:
          /set\s+-[a-z]*o?\s*pipefail|set\s+-\S*e\S*o\s+pipefail|pipefail/.test(
            text
          ),
      },
    ];
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
        if (l.trim() === "") {
          body.push({ n: j + 1, text: "" });
          continue;
        }
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

/*
 * A SWEEP OF NOTHING IS NOT A PASS.
 *
 * Paths resolve from this script's own location unless --cwd says otherwise, so
 * running it from the wrong directory found zero files and printed PASS —
 * observed while checking another branch. That is the same shape as the visual
 * precheck's "matched 0 tests": a green whose only content is that the checker
 * looked in the wrong place.
 */
if (files.length === 0) {
  console.error(
    `FAIL: swept 0 files under ${CWD}.\n` +
      "  Nothing was examined, so this run proves nothing. Pass --cwd REPO_ROOT,\n" +
      "  or check that .github/workflows, scripts/ or a package.json exist where\n" +
      "  expected."
  );
  process.exit(1);
}

/**
 * The variable a destroyed status was bound to, or null for statement position.
 *
 * Shell `X=$(…)` and JS `const x = execSync(…)` alike. Line continuations are
 * already joined by the caller, which matters: a line-oriented split of binding
 * versus statement position UNDERCOUNTS BINDINGS, because several assignments in
 * this repo open two or three lines above their `|| true`.
 */
export function bindingName(text, isJs = false) {
  /*
   * THE LANGUAGE DECIDES WHICH PATTERN MAY RUN, and trying both is a defect.
   * dev-all.sh binds `__lock_json=$(node -e 'const fs=require("node:fs"); …')`
   * — a SHELL assignment whose payload contains a JS one. Reading JS first
   * returned `fs`, nothing branches on `fs`, and a COMPLIANT site was reported
   * as a defect. A false positive on the acceptance corpus is worse than a miss:
   * it is the thing that teaches people to ignore the gate.
   */
  if (isJs) {
    const js = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(text);
    return js ? js[1] : null;
  }
  const sh = /(?:^|\s|\()([A-Za-z_][\w]*)\s*=\s*"?\$\(/.exec(text);
  return sh ? sh[1] : null;
}

/**
 * Does anything in this file take a BRANCH on `v`?
 *
 * Not "use" it — branch on it. `expect(ps).toBe("")` uses the value and asserts
 * it equals the success value, which is the defect rather than the guard.
 *
 * LINE-WISE, and that is not a detail: `[^\]]` matches newlines in JS, so a
 * whole-file match lets a `[` far above and a `]` far below bracket the variable
 * by accident. The first version of this scored full marks from evidence that
 * was not the evidence.
 */
export function branchesOn(text, v) {
  const V = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const D = String.raw`"?\$\{?${V}\}?"?`;
  const pats = [
    new RegExp(String.raw`\[\[?[^\]\n]*${D}[^\]\n]*\]\]?`), // [ -z "$X" ], either side
    new RegExp(String.raw`case\s+${D}`), // case "$X"
    new RegExp(String.raw`^\s*(?:if|while|until)\s.*${D}`), // if printf %s "$X" | grep -q
    new RegExp(String.raw`\$\{${V}:[-=?]`), // ${X:-default}
    new RegExp(String.raw`(?:if|while)\s*\([^)\n]*\b${V}\b`), // JS if (!x)
    new RegExp(String.raw`\b${V}\s*\?\?`), // JS x ?? default
  ];
  for (const line of text.split("\n")) {
    for (const re of pats) if (re.test(line)) return true;
  }
  return false;
}

/*
 * THE `|| true` LEDGER. A green that does not say how many sites it examined is
 * a green nobody can audit, and the two out-of-scope categories would otherwise
 * vanish silently — which is how "pipelines" shrank this checker's domain by a
 * rule nobody wrote down.
 */
const ledger = { comments: 0, bindings: 0, outOfScope: [] };
const findings = [];
for (const { path: file, kind } of files) {
  const rel = relative(CWD, file);
  const blocks = blocksFor(file, kind);
  for (const block of blocks) {
    const rows =
      block.body ?? block.lines.map((text, idx) => ({ n: idx + 1, text }));
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

    /* The whole file's text, for R3's guard search: a guard may sit anywhere. */
    const fileText = readFileSync(file, "utf8");

    for (const { n, text } of joined) {
      const line = String(text);
      const bare = line.replace(/#.*$/, "");

      /*
       * IN A JS FILE, ONLY A LINE THAT HANDS A SHELL A STRING IS IN THE DOMAIN.
       * Without this the ledger counted `|| true` inside fixture STRINGS — this
       * checker's own selftest plants a dozen — and a denominator inflated by
       * the checker's own test data says nothing about the tree. The domain is
       * "a shell was given a string", not "the characters appear in a file".
       */
      const isComment = /^\s*(?:#|\/\/|\*|\/\*)/.test(line);
      const hasOrTrue = /\|\|\s*true\b/.test(bare);
      const jsShellCall =
        !block.js ||
        joined.some(
          (r) =>
            Math.abs(r.n - n) <= 6 &&
            /execSync\s*\(|shell:\s*true/.test(String(r.text))
        );
      if (isComment && /\|\|\s*true\b/.test(line) && !block.js)
        ledger.comments += 1;
      if (!isComment && hasOrTrue && jsShellCall) {
        /*
         * In JS the binding is usually NOT on this line: the shell string sits
         * inside a multi-line `execSync(` call, with no backslash for the
         * joiner above to fasten to. So walk back to the call that opened it —
         * and only accept a call that hands a shell a STRING, which is what
         * puts a JS line in this checker's domain at all.
         */
        let bound0 = bindingName(bare, Boolean(block.js));
        let bound = bound0;
        if (block.js) {
          bound = null;
          for (let b = 0; b <= 6; b++) {
            const prev =
              joined[joined.indexOf(joined.find((r) => r.n === n)) - b];
            if (!prev) break;
            if (/execSync\s*\(|shell:\s*true/.test(String(prev.text))) {
              bound = bindingName(String(prev.text), true);
              break;
            }
          }
        }
        if (bound) {
          ledger.bindings += 1;
          /*
           * VDP_TRACE=1 prints WHICH line bound WHICH name. A total can never
           * reveal a scope bug, because the honest and dishonest runs produce
           * the same total — only a LOCATED match can. This trace is what found
           * the selftest-as-test-data problem above, and a `[^\]]` pattern that
           * spanned newlines before that. Keep it: the next scope bug in this
           * file will be found the same way.
           */
          if (process.env.VDP_TRACE)
            console.error(`  BIND ${rel}:${n} -> ${bound}`);
        } else ledger.outOfScope.push(`${rel}:${n}`);
        if (bound && !branchesOn(fileText, bound)) {
          findings.push({
            rel,
            n,
            rule: "R3",
            why:
              `\`${bound}\` is bound from a command whose status \`|| true\` discarded, ` +
              `and nothing in this file BRANCHES on \`${bound}\` — so a value that could ` +
              `not be computed is indistinguishable from a successful one`,
            line: line.trim().slice(0, 110),
          });
        }
      }

      // R1 and R2 read a line as SHELL. A JS file's lines are not shell.
      if (block.js) continue;
      // R1 and R2 read a line as SHELL. A JS file's lines are not shell.
      if (block.js) continue;
      if (!bare.includes("|")) continue;
      // `||` is not a pipe.
      const piped = bare.replace(/\|\|/g, "  ");
      if (!piped.includes("|")) continue;

      const left = piped.split("|")[0];
      const right = piped.slice(piped.indexOf("|") + 1);

      if (
        new RegExp(VERDICT).test(left) &&
        new RegExp(FILTER).test(right) &&
        !block.pipefail
      ) {
        findings.push({
          rel,
          n,
          rule: "R1",
          why: "a verdict-bearing command is piped into a filter and this block does not set pipefail, so the status reported is the filter's",
          line: line.trim().slice(0, 110),
        });
      }
      if (
        /\bgrep\b/.test(right) &&
        COLOURING.test(left) &&
        !COLOUR_DISABLED.test(line)
      ) {
        findings.push({
          rel,
          n,
          rule: "R2",
          why: "grep over a tool that colours by default; ANSI escapes can sit inside the pattern and the miss reads as a clean result",
          line: line.trim().slice(0, 110),
        });
      }
    }
  }
}

/*
 * A FILE THIS CHECKER COULD NOT READ IS NOT A FILE WITH NOTHING IN IT.
 *
 * Refusing OUTRANKS failing, and both outrank passing: if a package.json did not
 * parse, its scripts were never examined, and reporting on the rest would be a
 * verdict over a subject smaller than the one claimed in the PASS line. Exit 2
 * says the question could not be asked, which is the repo's convention and is
 * distinguishable from exit 1's "asked, and the answer was no".
 */
if (unreadable.length) {
  console.error(
    `REFUSING: ${unreadable.length} file(s) could not be read, so their`
  );
  console.error("  scripts were never examined and this sweep is not total:\n");
  for (const u of unreadable)
    console.error(`  ${relative(CWD, u.file)} — ${u.why}`);
  console.error(
    "\n  Exiting 2: the question could not be asked, not answered."
  );
  process.exit(2);
}

const key = (f) => `${f.rel}:${f.n}:${f.rule}`;
const unexcused = findings.filter((f) => !KNOWN.includes(key(f)));
const staleExcuses = KNOWN.filter((k) => !findings.some((f) => key(f) === k));

if (staleExcuses.length) {
  console.error(
    "STALE ALLOWLIST ENTRIES — these no longer occur. Delete them:\n"
  );
  for (const k of staleExcuses) console.error(`  ${k}`);
  process.exit(1);
}

if (unexcused.length) {
  console.error(`FAIL: ${unexcused.length} verdict-destroying pipeline(s).\n`);
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

/*
 * THE COMPOSITION, NOT JUST THE TOTAL — see the #730 note in the header. A
 * widened domain over an empty set is green before and after, so a bare count
 * cannot tell this sweep from the narrower one it replaced. Naming each kind
 * makes "package.json is in the domain" readable off the output of any run,
 * including one where nothing was wrong.
 */
const counted = (k) => files.filter((f) => f.kind === k).length;
console.log(
  `PASS: ${files.length} file(s) swept — ${counted("workflow")} workflow, ` +
    `${counted("shell")} shell script, ${
      withScripts.size
    } package.json with scripts —\n` +
    `      ${counted("js")} file(s) handing a shell a string —\n` +
    "      every run: block, every shell script, every package script and every\n" +
    "      shell string, not only the shapes this checker already knew. No pipeline\n" +
    "      reports a filter's status in place of the verdict it was asked for, and\n" +
    "      no discarded status reaches a consumer unbranched.\n" +
    `      \`|| true\`: ${ledger.comments} in comments, ${ledger.bindings} bound to a ` +
    `variable and branched on,\n      ${ledger.outOfScope.length} out of scope` +
    (ledger.outOfScope.length
      ? ` (${ledger.outOfScope.join(", ")}) — statement position\n` +
        "      or a construct with no variable for a guard to name. COUNTED, not\n" +
        "      skipped: a domain that shrinks silently is the defect R3 repairs."
      : "")
);
