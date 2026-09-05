/**
 * WHICH scripts/* FILES A WORKFLOW ACTUALLY RUNS — parsed from `run:`, never grepped.
 *
 * A workflow almost never names the script it runs. `ci.yml` says `pnpm palette`, and
 * `palette` is a package.json alias whose command is `node scripts/check-palette.mjs`. So a
 * `git grep check-palette .github/workflows` returns NOTHING while the checker runs on every
 * push. That census was built twice and was wrong both times: `check-cors-parity` and
 * `check-topologies` are invisible by name, and `pnpm live-artifact` / `pnpm discriminants`
 * are aliases sharing no substring with the file they run.
 *
 * WHY THIS PARSES `run:` INSTEAD OF SEARCHING THE FILE, and it is the whole reason this module
 * exists rather than a regex at the call site. ARCHITECT-lang found the defeating case: ci.yml
 * carries FIVE comment lines naming checker scripts, and one of them is
 *
 *     :512  # WIRED IN #117. check-palette.mjs and its selftest existed and ran NOWHERE in CI —
 *
 * A text-matching resolver accounts for `check-palette.mjs` USING THE PROSE THAT RECORDS IT
 * RAN NOWHERE. The acceptance test for the gate above this — "could check-palette.mjs, present
 * with a selftest and invoked nowhere, be added today and go green?" — would be satisfied by
 * the historical record of the very bug it tests for.
 *
 * THE RISK IS ASYMMETRIC AND ONLY ONE SIDE MATTERS. A resolver that MISSES an invocation marks
 * a script unaccounted: red, safe, self-announcing. A resolver that OVER-MATCHES marks it
 * accounted: green, silent, and the bar fails. Positive controls prove only that it does not
 * miss. The negative control — a script named in prose and invoked by no step must NOT resolve
 * — is the only one that tests the side that can produce a false green.
 *
 * So: a script is invoked when A STEP RUNS IT. The domain is defined by the property, not by
 * the pattern — the same reason `assert-no-verdict-destroying-pipelines` cannot count its own
 * documentation as an offender.
 *
 * WHAT THIS DOES NOT ANSWER, stated so nothing reads it as more: it resolves INVOCATION, not
 * EXECUTION. A step inside a `push`-gated job, or behind an `if:`, is reported here as invoked
 * — because a step does run it — and nothing about whether it ran on any particular event is
 * knowable from the text.
 */

/**
 * A `scripts/<file>` path named literally.
 *
 * THE TRAILING BOUNDARY IS LOAD-BEARING. Without `(?![A-Za-z0-9])` the `js` branch matches
 * inside `checks.json` and this reports a `scripts/checks.js` that has never existed — the
 * match ending before the token does. Caught by asserting every resolved path exists on disk,
 * which is a control on the QUERY rather than on its subject.
 */
const SCRIPT_RE =
  /(?:^|[^A-Za-z0-9._/-])(?:\.\/)?(scripts\/[A-Za-z0-9._-]+\.(?:mjs|sh|js|cjs))(?![A-Za-z0-9])/g;

/**
 * `pnpm <alias>`, `npm run <alias>`, `pnpm --silent <alias>`.
 *
 * A CANDIDATE IS ONLY AN ALIAS IF package.json DECLARES IT. `pnpm install` and
 * `pnpm --filter foo test` match the shape; membership is what separates an alias from a
 * subcommand, and an undeclared word resolving to an empty command is indistinguishable from
 * an alias whose command is empty.
 */
const ALIAS_RE =
  /\b(?:pnpm|npm|yarn)\s+(?:run\s+|--silent\s+|-s\s+)*([a-zA-Z][\w:.-]*)/g;

/** Drop whole-line shell comments. Never partial lines: `grep '#'` is not a comment. */
export function stripComments(shell) {
  return shell
    .split("\n")
    .map((l) => (/^\s*#/.test(l) ? "" : l))
    .join("\n");
}

/**
 * The shell body of every `run:` step in one workflow, comments removed.
 *
 * Handles `run: cmd`, `run: |`, and `run: >` with their indented block scalars. A YAML parser
 * would be better and there is no yaml dependency in this repo; this is the same block-scalar
 * walk `assert-no-verdict-destroying-pipelines.mjs` already uses on these files.
 */
export function runBlocks(yamlText) {
  const lines = yamlText.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:-\s+)?run:\s*(\|[-+]?|>[-+]?)?\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    const body = [];
    if (m[3]) body.push(m[3]);
    if (m[2])
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (l.trim() === "") {
          body.push("");
          continue;
        }
        if (l.length - l.trimStart().length <= indent) break;
        body.push(l);
      }
    out.push(stripComments(body.join("\n")));
  }
  return out;
}

/** Every script path and every declared alias named in one blob of SHELL. */
export function scriptRefs(shell, packageScripts) {
  const paths = new Set();
  const aliases = new Set();
  for (const m of shell.matchAll(SCRIPT_RE)) paths.add(m[1]);
  for (const m of shell.matchAll(ALIAS_RE))
    if (Object.prototype.hasOwnProperty.call(packageScripts, m[1]))
      aliases.add(m[1]);
  return { paths, aliases };
}

/**
 * Resolve every workflow to the scripts/* files its STEPS run, through any depth of alias.
 *
 * THE ALIAS IS NOT ONE HOP. A script's command can name another alias, which names another,
 * and only the last names a file. Resolving to a FIXPOINT rather than substituting once
 * matters because a single pass answers correctly for the shallow cases and misses the deep
 * ones — the worst available failure, since the shallow cases are the ones anybody spot-checks.
 *
 * @param workflowSources {Record<string, string>} workflow filename -> its YAML text
 * @param packageScripts  {Record<string, string>} package.json "scripts"
 * @returns {Map<string, string[]>} scripts/<file> -> sorted workflow filenames whose steps run it
 */
export function resolveInvocations({ workflowSources, packageScripts }) {
  const invoked = new Map();
  const add = (path, workflow) => {
    if (!invoked.has(path)) invoked.set(path, new Set());
    invoked.get(path).add(workflow);
  };

  /*
   * The queue is keyed on (alias, workflow), not alias. The same alias reached from two
   * workflows must record both; a `seen` set keyed on the alias alone drops the second and
   * reports the script as invoked by whichever workflow was walked first — a true statement
   * answering a narrower question than the one asked.
   */
  const seen = new Set();
  const queue = [];
  for (const [workflow, text] of Object.entries(workflowSources))
    for (const shell of runBlocks(text)) {
      const { paths, aliases } = scriptRefs(shell, packageScripts);
      for (const p of paths) add(p, workflow);
      for (const a of aliases) queue.push([a, workflow]);
    }

  while (queue.length) {
    const [alias, workflow] = queue.pop();
    const key = `${alias} ${workflow}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { paths, aliases } = scriptRefs(
      stripComments(packageScripts[alias] ?? ""),
      packageScripts
    );
    for (const p of paths) add(p, workflow);
    for (const a of aliases) queue.push([a, workflow]);
  }

  return new Map([...invoked].map(([path, set]) => [path, [...set].sort()]));
}
