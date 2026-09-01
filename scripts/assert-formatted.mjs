/**
 * EVERY FILE A BRANCH TOUCHES IS FORMATTED — SCOPED TO THE CHANGE, NOT THE TREE (#463).
 *
 * WHY THIS IS NOT A STYLE CHECK HERE. This repository contains checkers and tests that
 * parse source TEXT, so whitespace is an input to a verdict rather than a matter of taste.
 * #463 was filed because `schema-dispatch-parity.test.ts` sliced its subject on
 * `indexOf("\n    },")` — four spaces exactly — and a re-indent made the reader find
 * nothing. That reader refused, which is the only reason it was caught; one that had
 * silently found nothing would have passed forever.
 *
 * SCOPED TO CHANGED FILES, AND THE REASON IS #405. Measured at 8c9172bf, 651 files
 * in this tree do not match prettier's settings. Formatting them is a single mechanical
 * commit nobody reads line by line, which is precisely the vehicle #405 describes for an
 * invisible revert — so the backlog is cleared separately, under #406's detector, and
 * this gate exists first so that no NEW drift accumulates while that happens. Gating the
 * whole tree today would mean either 651 files of unreviewable diff in this commit or a
 * 633-entry allowlist, and an allowlist edited that often is rubber-stamped.
 *
 * NO PER-FILE WAIVER LIST, DELIBERATELY. `.prettierignore` already answers "never format
 * this file" and is consulted through prettier's own getFileInfo below, so a second waiver
 * mechanism here would be a mute button with no members — the shape this repo deleted from
 * traceability.mjs (RETRACTED_TICKS) the same night, for the same reason: a guard arm with
 * no member has no case proving it works.
 *
 * WHAT IT REFUSES ON, AND WHY THAT MATTERS MORE THAN WHAT IT FAILS ON. A changed-files
 * gate has an obvious vacuous form: compute an empty subject, check nothing, exit 0. That
 * is indistinguishable from a clean branch unless the two are separated deliberately, so
 * a subject that could not be COMPUTED is exit 2 and says nothing was compared, while a
 * subject that is genuinely empty passes and prints the counts it examined. The counts are
 * in the output for the same reason: "PASS" is not falsifiable at a glance, and a gate
 * whose subject silently became empty would read exactly like a formatted branch.
 *
 * Usage: node scripts/assert-formatted.mjs [--cwd DIR] [--base REF] [--head REF]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import prettier from "prettier";

import { invokedAsProgram } from "./lib/is-main.mjs";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

class Refusal extends Error {}

/**
 * WHICH PRETTIER PRODUCED THIS NUMBER (#577).
 *
 * A count without its instrument is not reproducible, and here that is not a
 * hypothetical: the same tree once measured 633 drifted files and 897, and the
 * difference was which prettier resolved — it was reachable only as a HOISTED
 * TRANSITIVE dependency rather than a declared one, so the answer depended on
 * what an unrelated package happened to bring along.
 *
 * That makes the instrument part of the verdict rather than trivia beside it, so
 * this REFUSES rather than annotating. A gate that reports "N files drift" under
 * an unknown prettier has not measured this repository; it has measured whatever
 * turned up, and exit 2 is what this file already uses for "nothing was compared".
 *
 * Three ways the instrument can be wrong, and they are different failures:
 *   undeclared      nothing in package.json asks for prettier at all, so the
 *                   version is whatever a transitive dependency supplied
 *   out-of-tree     it resolved from outside the workspace — a global install or
 *                   a parent directory's node_modules answering for this repo
 *   mismatched      declared exactly, and a different version answered
 *
 * A RANGE IS REPORTED, NOT REFUSED. `^2.8.8` is a legitimate thing to write, and
 * refusing it would be this file inventing a dependency policy it was not asked
 * for. It is named in the output so a reader can see the count is attributable to
 * a range rather than to a pin — which is the distinction that matters when two
 * runs disagree.
 */
export function instrument({ declared, resolvedVersion, resolvedPath, root }) {
  const exact = /^\d+\.\d+\.\d+$/.test(declared ?? "");
  const label = `prettier ${resolvedVersion}${
    declared ? ` (declared ${declared}${exact ? "" : ", a range"})` : ""
  }`;

  if (!declared)
    return {
      label,
      problem:
        `prettier is not declared in this repository's package.json, so ${resolvedVersion} ` +
        `answered as a transitive dependency. The count would be attributable to whatever ` +
        `resolved rather than to a version this repo chose.`,
    };

  if (!resolvedPath.startsWith(root))
    return {
      label,
      problem:
        `prettier resolved from OUTSIDE the workspace (${resolvedPath}), so this ` +
        `count describes a formatter this repository does not control.`,
    };

  if (exact && resolvedVersion !== declared)
    return {
      label,
      problem:
        `package.json declares prettier ${declared} and ${resolvedVersion} resolved. ` +
        `The verdict below would be that version's, not the declared one's.`,
    };

  return { label, problem: null };
}

/** The instrument as it actually is, here, now. */
function resolveInstrument() {
  const require_ = createRequire(import.meta.url);
  let resolvedPath = "(unresolved)";
  try {
    resolvedPath = require_.resolve("prettier");
  } catch {
    /* prettier is imported above, so this cannot normally fail; reported, not thrown. */
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  return instrument({
    declared:
      (pkg.devDependencies ?? {}).prettier ?? (pkg.dependencies ?? {}).prettier,
    resolvedVersion: prettier.version,
    resolvedPath,
    root: ROOT,
  });
}

function makeGit(cwd) {
  return (...args) =>
    execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
}

/**
 * The ref this branch is measured against.
 *
 * `git diff A...B` computes the merge-base itself, so this resolves a REF and leaves the
 * merge-base to git rather than doing it by hand. On a push to main HEAD already IS the
 * candidate, which would make the diff empty and any verdict vacuous — so that case falls
 * through to the commit's own parent, which is a real subject.
 */
export function resolveBase(git, { base, head }) {
  const resolve1 = (ref) => {
    try {
      return git("rev-parse", "--verify", `${ref}^{commit}`).trim();
    } catch {
      return null;
    }
  };

  const headSha = resolve1(head);
  if (!headSha) throw new Refusal(`could not resolve head ref "${head}".`);

  if (base) {
    const sha = resolve1(base);
    if (!sha) throw new Refusal(`could not resolve base ref "${base}".`);
    if (sha === headSha) {
      throw new Refusal(
        `base and head are the same commit (${headSha.slice(
          0,
          7
        )}), so the diff is empty ` + `and any verdict would be about nothing.`
      );
    }
    return { baseSha: sha, headSha };
  }

  const candidates = [
    process.env.GITHUB_BASE_REF && `origin/${process.env.GITHUB_BASE_REF}`,
    "origin/main",
    "main",
  ].filter(Boolean);

  for (const c of candidates) {
    const sha = resolve1(c);
    if (sha && sha !== headSha) return { baseSha: sha, headSha };
  }

  const parent = resolve1(`${head}^`);
  if (parent) return { baseSha: parent, headSha };

  throw new Refusal(
    "could not determine a base to compare against — no PR base, no origin/main, and head " +
      "has no parent."
  );
}

/**
 * Paths added, copied, modified or renamed between base and head.
 *
 * `--diff-filter=ACMR` drops deletions on purpose: a deleted path is not in the working
 * tree, and asking prettier to read it would turn a correct branch into a crash.
 */
export function changedFiles(git, baseSha, headSha) {
  const out = git(
    "diff",
    "--name-only",
    "--diff-filter=ACMR",
    `${baseSha}...${headSha}`
  );
  return out.split("\n").filter(Boolean);
}

export async function analyse({ cwd = ROOT, base, head = "HEAD" } = {}) {
  const git = makeGit(cwd);

  try {
    git("rev-parse", "--git-dir");
  } catch {
    throw new Refusal(
      `${cwd} is not a git repository, so nothing could be compared.`
    );
  }

  const { baseSha, headSha } = resolveBase(git, { base, head });

  const changed = changedFiles(git, baseSha, headSha);

  const subject = [];
  const ignored = [];
  for (const rel of changed) {
    const info = await prettier.getFileInfo(join(cwd, rel), {
      ignorePath: join(cwd, ".prettierignore"),
      resolveConfig: false,
    });
    // Prettier's OWN answer to "do I format this", rather than an extension list here that
    // would drift from .prettierignore and from prettier's parser table independently.
    if (info.ignored || !info.inferredParser) {
      ignored.push(rel);
      continue;
    }
    subject.push(rel);
  }

  const unformatted = [];
  for (const rel of subject) {
    const abs = join(cwd, rel);
    const options = (await prettier.resolveConfig(abs)) ?? {};
    const source = readFileSync(abs, "utf8");
    if (!prettier.check(source, { ...options, filepath: abs }))
      unformatted.push(rel);
  }

  return {
    baseSha,
    headSha,
    changed,
    subject,
    ignored,
    unformatted,
  };
}

function main() {
  const argOf = (flag, dflt) => {
    const i = process.argv.indexOf(flag);
    return i === -1 || i === process.argv.length - 1
      ? dflt
      : process.argv[i + 1];
  };
  const cwd = resolve(argOf("--cwd", ROOT));

  /*
   * Checked BEFORE the subject is computed. A run that cannot say which prettier
   * answered has nothing to report, and finding that out after printing a count
   * would mean the count was already on screen.
   */
  const tool = resolveInstrument();
  if (tool.problem) {
    console.error(`REFUSE: ${tool.problem}`);
    console.error(
      `        Nothing was compared, which is not the same as nothing being wrong.`
    );
    process.exit(2);
  }

  analyse({
    cwd,
    base: argOf("--base", null),
    head: argOf("--head", "HEAD"),
  }).then(
    (r) => {
      /*
       * THE COUNTS ARE THE VERDICT'S SUBJECT, printed on success as well as failure. A gate
       * whose diff silently became empty prints "0 changed" here instead of a bare PASS, so
       * the reader can see it examined nothing.
       */
      const scope =
        `${r.changed.length} changed file(s) since ${r.baseSha.slice(0, 7)}; ` +
        `${r.subject.length} formattable, ${r.ignored.length} not formattable or ignored; ` +
        `measured by ${tool.label}`;

      if (r.unformatted.length) {
        console.error(
          `FAIL: ${r.unformatted.length} changed file(s) are not formatted:`
        );
        r.unformatted.forEach((f) => console.error(`        ${f}`));
        console.error(`\n  Scope: ${scope}.`);
        console.error(`  Fix:   pnpm format`);
        console.error(
          `\n  WHY THIS GATE EXISTS: this repo has checkers and tests that parse source TEXT,\n` +
            `  so whitespace is an input to a verdict. #463 was filed after a re-indent made a\n` +
            `  parity reader find nothing. Only files THIS BRANCH touches are gated; the\n` +
            `  pre-existing backlog is #463's second half and is cleared separately.`
        );
        process.exit(1);
      }

      console.log(`PASS: every changed file is formatted — ${scope}.`);
    },
    (e) => {
      if (e instanceof Refusal) {
        console.error(`REFUSE: ${e.message}`);
        console.error(
          `        Nothing was compared, which is not the same as nothing being wrong.`
        );
        process.exit(2);
      }
      throw e;
    }
  );
}

const isMain = invokedAsProgram(import.meta.url);
if (isMain) main();
