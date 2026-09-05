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
 * WHAT ITS SUBJECT IS. Every file the branch touches: the committed diff against the
 * base, PLUS the tracked changes that are not committed yet. Those two used to be
 * half-mixed — the file list came from the commits and the content off disk — so
 * uncommitted drift was caught only when the file also appeared in some commit's diff
 * (#722). Untracked files are counted and set aside, not gated.
 *
 * Usage: node scripts/assert-formatted.mjs [--cwd DIR] [--base REF] [--head REF]
 * Anything else is exit 2 naming what it did not understand, never a PASS about ROOT.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
/*
 * THE INSTRUMENT IS IMPORTED GUARDED, BECAUSE ITS ABSENCE IS A REFUSAL (#752).
 *
 * This was a bare `import prettier from "prettier"`. An absent prettier threw at module
 * scope, before any of this file's logic ran, and node exits 1 for an uncaught throw — the
 * same code this gate uses for "a file is not formatted". So a missing instrument was
 * indistinguishable from a drift verdict by the exit status the check runner reads, which
 * is the failure #722 fixed for the MISMATCHED instrument and left open for the absent one.
 *
 * Held as a value rather than exited on here: this module is imported by its own proof for
 * `instrument()`, and a module that calls process.exit on import cannot be tested. The
 * refusal is issued by resolveInstrument() below, on the path that already knows how.
 */
let prettier = null;
let prettierImportError = null;
try {
  prettier = (await import("prettier")).default;
} catch (e) {
  prettierImportError = e?.message ?? String(e);
}

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
  /*
   * ABSENT ENTIRELY — the fourth way the instrument can be wrong, and the one that used to
   * bypass every other check by throwing before this function existed to be called (#752).
   */
  if (!prettier)
    return {
      label: "prettier (could not be imported)",
      problem:
        `prettier could not be imported at all: ${prettierImportError}. This gate measures ` +
        `formatting with prettier, so without it nothing was compared — which is not the ` +
        `same as nothing being wrong. Run \`pnpm install\` in this tree.`,
    };

  const require_ = createRequire(import.meta.url);
  let resolvedPath = "(unresolved)";
  try {
    resolvedPath = require_.resolve("prettier");
  } catch {
    /*
     * REACHABLE NOW, and it was not before. This handler was written for "prettier will not
     * resolve" while the import above guaranteed it already had — the old comment here said
     * so in as many words, a branch carrying the reason for its own unreachability.
     *
     * DEFENSIVE AGAINST A CONFIGURATION PRETTIER DOES NOT CURRENTLY HAVE. An earlier draft
     * of this comment justified the branch with "present as a module but unresolvable
     * through an export map". Measured on the installed package, that cannot happen here:
     *
     *     prettier 2.8.8   main: ./index.js   exports: undefined
     *
     * No export map, so `require.resolve` falls back to `main` and succeeds whenever the
     * package is on disk. Keeping the handler is still right — a dynamic import and a CJS
     * resolve are two different resolvers and need not agree — but the justification would
     * have become TRUE on a prettier 3 bump (v3 is ESM-first with an export map), which this
     * repo has declined. A reason that quietly starts holding is the inverse of a constraint
     * that quietly expires, and no easier to notice, so it is named rather than asserted.
     */
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
 * The ref this branch is measured against, AND WHY IT IS THAT ONE (#722).
 *
 * `git diff A...B` computes the merge-base itself, so this resolves a REF and leaves the
 * merge-base to git rather than doing it by hand.
 *
 * THE FALLBACK IS THE DANGEROUS PART, so it now says which arm it took. When no candidate
 * ref differs from HEAD, two situations look identical to git and are opposite things to a
 * person:
 *
 *   a push to main   HEAD is the commit under test, and its own parent is the right base.
 *   a fresh branch   HEAD is still origin/main and the work is all UNCOMMITTED, so HEAD's
 *                    parent is somebody else's commit.
 *
 * Falling back in the second case is how this gate printed `PASS: ... 3 changed file(s)
 * since 45bf74b` at a checkout with five modified files, one of them unformatted: those
 * three files were the PREVIOUS commit's, and the verdict was true about them. The
 * discriminator is not a heuristic — it is whether the working tree is dirty, which is
 * exactly the difference between the two situations, so `dirty` decides the arm and the
 * arm is named in `basis` either way.
 */
export function resolveBase(git, { base, head, dirty = false }) {
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
    return { baseSha: sha, headSha, basis: `--base ${base}` };
  }

  const candidates = [
    process.env.GITHUB_BASE_REF && `origin/${process.env.GITHUB_BASE_REF}`,
    "origin/main",
    "main",
  ].filter(Boolean);

  for (const c of candidates) {
    const sha = resolve1(c);
    if (sha && sha !== headSha) return { baseSha: sha, headSha, basis: c };
  }

  if (dirty)
    return {
      baseSha: headSha,
      headSha,
      basis:
        "no ref differs from HEAD, so there is no committed diff — the subject is " +
        "the uncommitted work",
    };

  const parent = resolve1(`${head}^`);
  if (parent)
    return {
      baseSha: parent,
      headSha,
      basis:
        "HEAD's own parent — no ref differs from HEAD and the tree is clean",
    };

  throw new Refusal(
    "could not determine a base to compare against — no PR base, no origin/main, and head " +
      "has no parent."
  );
}

/**
 * Work that is not committed yet, which is most of the time a person runs this.
 *
 * WHY THIS EXISTS AT ALL. The gate used to take its file LIST from the committed diff
 * while reading each file's CONTENT off disk, so an uncommitted edit was caught if and
 * only if that file also happened to appear in the committed diff. Measured on this repo
 * at 3d3de727, one unformatted uncommitted file and nothing else:
 *
 *   scripts/measure-e2e-flake.selftest.mjs  ->  PASS, exit 0
 *   apps/open-swe/components/RunFacts.tsx   ->  FAIL, exit 1
 *
 * Same tree, opposite verdicts, and the only difference was whether the file was named in
 * some unrelated commit's diff. Coverage by coincidence is not coverage, and the half that
 * was already true — reading the working tree — is the half worth keeping.
 *
 * STAGED AND UNSTAGED BOTH COUNT; UNTRACKED DOES NOT. A file that has never been `git
 * add`ed is not yet part of the branch, and gating it would fail people for scratch files.
 * It is counted in the output instead, because "not examined" and "nothing there" have to
 * be distinguishable — that is the same rule the rest of this file follows.
 */
export function uncommittedFiles(git) {
  const names = (...args) =>
    git("diff", "--name-only", "--diff-filter=ACMR", ...args)
      .split("\n")
      .filter(Boolean);
  return [...new Set([...names(), ...names("--cached")])].sort();
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
  /*
   * THE INSTRUMENT, CHECKED HERE TOO — this function is EXPORTED and dereferences the
   * prettier binding three times below. `resolveInstrument()` is module-private and reached
   * only by `main()`, so relying on it would leave this path guarded by CALL ORDERING and
   * nothing else: a caller importing `analyse` directly would get an uncaught TypeError and
   * exit 1, which is exactly the defect #752 exists to remove, restored on the one path its
   * first fix did not reach.
   *
   * That matters here more than the current call graph suggests. This module's header says
   * the design premise is being imported and its functions called directly, and its own
   * proof already does that for `instrument()` — so the invitation is live even though
   * nothing takes it up today.
   */
  if (!prettier)
    throw new Refusal(
      `prettier could not be imported (${prettierImportError}), so no file could be ` +
        `checked. Run \`pnpm install\` in ${cwd}.`
    );

  const git = makeGit(cwd);

  try {
    git("rev-parse", "--git-dir");
  } catch {
    throw new Refusal(
      `${cwd} is not a git repository, so nothing could be compared.`
    );
  }

  /*
   * WHETHER THE WORKING TREE IS EVEN THIS HEAD'S. `--head` naming some other commit makes
   * the files on disk irrelevant to the question asked: they belong to whatever is checked
   * out, not to the commit under test. So the uncommitted half is included only when the
   * two coincide, and when they do not the content is read from the commit — otherwise the
   * list and the content come from different places again, pointing the other way.
   */
  let headSha;
  try {
    headSha = git("rev-parse", "--verify", `${head}^{commit}`).trim();
  } catch {
    throw new Refusal(`could not resolve head ref "${head}".`);
  }
  let checkedOut = null;
  try {
    checkedOut = git("rev-parse", "--verify", "HEAD^{commit}").trim();
  } catch {
    /* an unborn HEAD is not this head; reported by being null, not thrown. */
  }
  const headIsWorkingTree = checkedOut !== null && checkedOut === headSha;

  const uncommitted = headIsWorkingTree ? uncommittedFiles(git) : [];
  const untracked = headIsWorkingTree
    ? git("ls-files", "--others", "--exclude-standard")
        .split("\n")
        .filter(Boolean)
    : [];

  const { baseSha, basis } = resolveBase(git, {
    base,
    head,
    dirty: uncommitted.length > 0,
  });

  const committed =
    baseSha === headSha ? [] : changedFiles(git, baseSha, headSha);

  const subject = [];
  const ignored = [];
  const absent = [];
  for (const rel of [...new Set([...committed, ...uncommitted])].sort()) {
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
    /*
     * A path in the committed diff that the working tree has since DELETED. This used to
     * throw ENOENT out of readFileSync, which exits 1 — the same code this gate uses for
     * "a file is unformatted", so a crash was indistinguishable from a verdict.
     */
    if (headIsWorkingTree && !existsSync(join(cwd, rel))) {
      absent.push(rel);
      continue;
    }
    subject.push(rel);
  }

  const unformatted = [];
  for (const rel of subject) {
    const abs = join(cwd, rel);
    const options = (await prettier.resolveConfig(abs)) ?? {};
    const source = headIsWorkingTree
      ? readFileSync(abs, "utf8")
      : git("show", `${headSha}:${rel}`);
    if (!prettier.check(source, { ...options, filepath: abs }))
      unformatted.push(rel);
  }

  return {
    cwd,
    baseSha,
    headSha,
    headIsWorkingTree,
    basis,
    committed,
    uncommitted,
    untracked,
    subject,
    ignored,
    absent,
    unformatted,
  };
}

/**
 * THE ARGUMENT IT WAS GIVEN IS THE ARGUMENT IT USES (#722).
 *
 * The reader here was `process.argv.indexOf(flag)`, which has no notion of an argument it
 * does not recognise. `node scripts/assert-formatted.mjs /some/worktree` therefore examined
 * the checkout THIS SCRIPT lives in and printed a confident PASS naming a base sha and a
 * file count belonging to a tree the caller never asked about. The verdict was true. It
 * was about the wrong subject, which is the failure this whole file is written against.
 *
 * REFUSING RATHER THAN ACCEPTING THE POSITIONAL is the smaller of the two repairs #722
 * offers, and it removes the failure mode outright: there is already a spelling that works
 * (`--cwd`), so the defect was silence, not absence. A second spelling would be a second
 * thing to keep in agreement. The refusal names the argument and the spelling that works,
 * because a refusal a caller cannot act on is only a slower failure.
 */
const KNOWN = new Set(["--cwd", "--base", "--head"]);

export function parseArgs(argv) {
  const opts = { cwd: null, base: null, head: "HEAD" };
  const unknown = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (KNOWN.has(arg)) {
      if (i + 1 >= argv.length) {
        unknown.push(`${arg} was given no value`);
        continue;
      }
      opts[arg.slice(2)] = argv[++i];
      continue;
    }

    const joined = /^(--[a-z-]+)=(.*)$/.exec(arg);
    if (joined && KNOWN.has(joined[1])) {
      unknown.push(
        `${arg} — this reader takes two words: ${joined[1]} ${joined[2]}`
      );
      continue;
    }

    unknown.push(
      arg.startsWith("-")
        ? `${arg} is not a flag this gate knows`
        : `${arg} — a bare path is not read; the directory to measure is --cwd ${arg}`
    );
  }

  return { opts, unknown };
}

function main() {
  const { opts, unknown } = parseArgs(process.argv.slice(2));
  if (unknown.length) {
    console.error(`REFUSE: this gate did not understand what it was given:`);
    unknown.forEach((u) => console.error(`        ${u}`));
    console.error(
      `        Usage: node scripts/assert-formatted.mjs [--cwd DIR] [--base REF] [--head REF]`
    );
    console.error(
      `        Nothing was compared, which is not the same as nothing being wrong.`
    );
    process.exit(2);
  }
  const cwd = resolve(opts.cwd ?? ROOT);

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

  analyse({ cwd, base: opts.base, head: opts.head }).then(
    (r) => {
      /*
       * THE SUBJECT IS THE VERDICT'S SUBJECT, printed on success as well as failure, and it
       * now names the DIRECTORY. A count and a sha do not identify a tree — that is the
       * whole reason #722 went unnoticed through two sessions: the numbers printed were
       * real, and they were another checkout's.
       */
      const scope = [
        `Subject: ${r.cwd}`,
        `         ${
          r.committed.length
        } committed change(s) vs ${r.baseSha.slice(0, 7)} (${r.basis})`,
        /*
         * "0 uncommitted" when the working tree was never CONSULTED would be the same
         * defect this change exists to remove, one level in: a count that reads as a
         * measurement of something nobody looked at.
         */
        r.headIsWorkingTree
          ? `         ${r.uncommitted.length} uncommitted change(s) to tracked files; ` +
            `${r.untracked.length} untracked file(s) not examined`
          : `         working tree NOT consulted — --head names ${r.headSha.slice(
              0,
              7
            )}, which is not what is checked out`,
        `         ${r.subject.length} formattable, ${r.ignored.length} not formattable or ignored` +
          (r.absent.length
            ? `, ${r.absent.length} deleted in the working tree`
            : ""),
        `         measured by ${tool.label}`,
      ].join("\n");

      if (r.unformatted.length) {
        console.error(
          `FAIL: ${r.unformatted.length} file(s) in the subject are not formatted:`
        );
        r.unformatted.forEach((f) => console.error(`        ${f}`));
        console.error(`\n  ${scope}`);
        console.error(`  Fix:   pnpm format`);
        console.error(
          `\n  WHY THIS GATE EXISTS: this repo has checkers and tests that parse source TEXT,\n` +
            `  so whitespace is an input to a verdict. #463 was filed after a re-indent made a\n` +
            `  parity reader find nothing. Only files THIS BRANCH touches are gated; the\n` +
            `  pre-existing backlog is #463's second half and is cleared separately.`
        );
        process.exit(1);
      }

      console.log(`PASS: every file in the subject is formatted.\n${scope}`);
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
