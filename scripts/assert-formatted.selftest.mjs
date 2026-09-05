/**
 * PROOF FOR assert-formatted.mjs — it fails on drift it must catch, passes where it must
 * not fire, and REFUSES when it could not compute a subject (#463).
 *
 * THE DEFECT IS PLANTED, not described. Adding a `<stem>.selftest.mjs` is not the house
 * rule; making the checker actually go red on a real unformatted file is. Every FAIL case
 * below writes genuinely drifted source into a temp repo and requires exit 1 naming it.
 *
 * THE CASE THAT CARRIES THE DESIGN is "a drifted file the branch did not touch". This gate
 * is scoped deliberately — 651 files in this tree are unformatted (measured at 8c9172bf) and clearing them is a
 * separate commit under #406's detector (#405). If that case ever fails, the gate has
 * quietly become a whole-tree gate and every branch is blocked by a backlog it did not
 * create. It is the presence companion to the FAIL cases: without it, a checker that
 * simply flagged everything would pass all of them.
 *
 * THE POSITIVE CONTROL runs first and is not decorative. Every case here rests on the
 * DIRTY fixture actually being unformatted; if prettier's defaults ever agree with it,
 * the FAIL cases stop planting anything and pass by agreeing with themselves.
 */
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  copyFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import prettier from "prettier";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHECKER = join(ROOT, "scripts", "assert-formatted.mjs");

// The instrument check is a pure function, so it is exercised directly rather
// than by mutating the real package.json — a selftest that edits the repo's own
// dependency declaration to prove a point is a worse trade than importing it.
import { instrument } from "./assert-formatted.mjs";

const DIRTY = "const x = {a:1,   b:2}\n";
const CLEAN = prettier.format(DIRTY, { parser: "babel", printWidth: 80 });

let pass = 0;
let fail = 0;
const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  if (ok) pass++;
  else fail++;
}

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function write(repo, rel, body) {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), body);
}

/**
 * A repo with one base commit, then one branch commit containing `head` files.
 *
 * The base commit carries prettier's config, so the subject of every case is exactly the
 * files named in `head` and nothing else.
 */
function makeRepo({ base = {}, head = {} } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "fmt-gate-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "proof@example.com");
  git(repo, "config", "user.name", "proof");

  write(repo, ".prettierrc.json", '{ "printWidth": 80 }\n');
  write(repo, ".prettierignore", "vendored/\n");
  for (const [rel, body] of Object.entries(base)) write(repo, rel, body);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  const baseSha = git(repo, "rev-parse", "HEAD").trim();

  if (Object.keys(head).length) {
    for (const [rel, body] of Object.entries(head)) {
      if (body === null) rmSync(join(repo, rel), { force: true });
      else write(repo, rel, body);
    }
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "head");
  }
  return { repo, baseSha };
}

/**
 * The checker invoked EXACTLY as a caller would type it, with no `--cwd` supplied.
 * `run()` below always passes one, which is why #722's invocation had no case:
 * every existing case addressed the gate in a spelling it understands.
 */
function runRaw(...args) {
  try {
    return {
      code: 0,
      out: execFileSync("node", [CHECKER, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (e) {
    return { code: e.status, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function run(repo, ...args) {
  try {
    const stdout = execFileSync("node", [CHECKER, "--cwd", repo, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.status, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

console.log(
  "\nassert-formatted — the gate fires on new drift, not on the backlog\n"
);

/* ── POSITIVE CONTROL ─────────────────────────────────────────────────────── */
{
  const reallyDirty = !prettier.check(DIRTY, {
    parser: "babel",
    printWidth: 80,
  });
  const reallyClean = prettier.check(CLEAN, {
    parser: "babel",
    printWidth: 80,
  });
  record(
    "the DIRTY fixture is genuinely unformatted",
    reallyDirty && reallyClean,
    reallyDirty && reallyClean
      ? "planted"
      : "THE FIXTURE IS NOT DRIFTED — every FAIL case below is vacuous"
  );
}

/* ── IT FAILS ON WHAT IT MUST CATCH ───────────────────────────────────────── */
{
  const { repo } = makeRepo({ head: { "src/new.js": DIRTY } });
  const r = run(repo, "--base", "HEAD~1");
  record(
    "a changed file that is unformatted",
    r.code === 1 && r.out.includes("src/new.js"),
    `exit ${r.code}${r.code === 1 ? ", named it" : ""}`
  );
}
{
  const { repo } = makeRepo({
    base: { "src/edited.js": CLEAN },
    head: { "src/edited.js": DIRTY },
  });
  const r = run(repo, "--base", "HEAD~1");
  record(
    "a file the branch MODIFIED into drift",
    r.code === 1 && r.out.includes("src/edited.js"),
    `exit ${r.code}`
  );
}

/* ── IT PASSES WHERE IT MUST NOT FIRE ─────────────────────────────────────── */
{
  const { repo } = makeRepo({ head: { "src/new.js": CLEAN } });
  const r = run(repo, "--base", "HEAD~1");
  record("a changed file that is formatted", r.code === 0, `exit ${r.code}`);
}
{
  /*
   * THE CASE THAT CARRIES THE DESIGN. The backlog is in the BASE commit and untouched by
   * the branch; the branch adds one clean file. A whole-tree gate fails here.
   */
  const { repo } = makeRepo({
    base: { "src/backlog.js": DIRTY },
    head: { "src/new.js": CLEAN },
  });
  const r = run(repo, "--base", "HEAD~1");
  record(
    "a DRIFTED file the branch did not touch is not gated",
    r.code === 0 && !r.out.includes("backlog.js"),
    `exit ${r.code}${
      r.out.includes("backlog.js") ? " — but it named the backlog" : ""
    }`
  );
}
{
  const { repo } = makeRepo({
    base: { "vendored/v.js": CLEAN },
    head: { "vendored/v.js": DIRTY },
  });
  const r = run(repo, "--base", "HEAD~1");
  record(
    "a .prettierignore'd file is not gated",
    r.code === 0,
    `exit ${r.code}`
  );
}
{
  const { repo } = makeRepo({
    base: { "src/gone.js": CLEAN },
    head: { "src/gone.js": null },
  });
  const r = run(repo, "--base", "HEAD~1");
  record(
    "a DELETED file does not crash the gate",
    r.code === 0,
    `exit ${r.code}`
  );
}
{
  const { repo } = makeRepo({ head: { "notes.unknownext": "  x  \n" } });
  const r = run(repo, "--base", "HEAD~1");
  record(
    "a changed set with nothing formattable PASSES and says 0",
    r.code === 0 && /0 formattable/.test(r.out),
    r.code === 0 && /0 formattable/.test(r.out)
      ? "counts printed"
      : `exit ${r.code}, output did not state the empty subject`
  );
}

/* ── IT REFUSES WHEN IT COULD NOT COMPUTE ─────────────────────────────────── */
{
  const bare = mkdtempSync(join(tmpdir(), "fmt-gate-nogit-"));
  const r = run(bare);
  record(
    "not a git repository is exit 2, not a green",
    r.code === 2 && /REFUSE/.test(r.out),
    `exit ${r.code}`
  );
}
{
  const { repo, baseSha } = makeRepo({ head: { "src/new.js": CLEAN } });
  const r = run(repo, "--base", "HEAD", "--head", "HEAD");
  record(
    "base === head is exit 2, not an empty green",
    r.code === 2 && /same commit/.test(r.out),
    `exit ${r.code}`
  );
  void baseSha;
}
{
  const { repo } = makeRepo({ head: { "src/new.js": CLEAN } });
  const r = run(repo, "--base", "refs/heads/does-not-exist");
  record(
    "an unresolvable base is exit 2, not a green",
    r.code === 2 && /could not resolve base/.test(r.out),
    `exit ${r.code}`
  );
}

/* ── THE INSTRUMENT (#577) ────────────────────────────────────────────────── */
/*
 * A count without its instrument is not reproducible: this tree once measured
 * 633 drifted files and 897, and the difference was which prettier resolved.
 * Each way that can go wrong is a separate case, and the ACCEPT case is what
 * keeps a function that refuses everything from scoring 3/3 here.
 */
{
  const ROOT_ = "/repo";
  const inside = "/repo/node_modules/prettier/index.js";

  const ok = instrument({
    declared: "2.8.8",
    resolvedVersion: "2.8.8",
    resolvedPath: inside,
    root: ROOT_,
  });
  record(
    "a declared, in-tree, matching prettier is accepted",
    ok.problem === null &&
      /prettier 2\.8\.8 \(declared 2\.8\.8\)/.test(ok.label),
    ok.problem ? "refused" : ok.label
  );

  const undeclared = instrument({
    declared: undefined,
    resolvedVersion: "3.9.6",
    resolvedPath: inside,
    root: ROOT_,
  });
  record(
    "an UNDECLARED prettier is refused, not annotated",
    undeclared.problem !== null && /not declared/.test(undeclared.problem),
    undeclared.problem ? "refused" : "ACCEPTED"
  );

  const outside = instrument({
    declared: "2.8.8",
    resolvedVersion: "2.8.8",
    resolvedPath: "/usr/local/lib/node_modules/prettier/index.js",
    root: ROOT_,
  });
  record(
    "a prettier resolved OUTSIDE the workspace is refused",
    outside.problem !== null && /OUTSIDE the workspace/.test(outside.problem),
    outside.problem ? "refused" : "ACCEPTED"
  );

  const mismatch = instrument({
    declared: "2.8.8",
    resolvedVersion: "3.9.6",
    resolvedPath: inside,
    root: ROOT_,
  });
  record(
    "declared 2.8.8 while 3.9.6 answers is refused",
    mismatch.problem !== null &&
      /declares prettier 2\.8\.8 and 3\.9\.6 resolved/.test(mismatch.problem),
    mismatch.problem ? "refused" : "ACCEPTED"
  );

  /*
   * A RANGE IS REPORTED, NOT REFUSED — asserted so the distinction cannot be
   * quietly tightened into a dependency policy this file was not asked to make.
   * The label has to SAY it is a range, or the accept is indistinguishable from
   * a pin in the output, which is the whole thing this change exists to fix.
   */
  const range = instrument({
    declared: "^2.8.0",
    resolvedVersion: "2.8.8",
    resolvedPath: inside,
    root: ROOT_,
  });
  record(
    "a RANGE is accepted and named as a range",
    range.problem === null && /a range/.test(range.label),
    range.problem ? "refused" : range.label
  );
}

/* ── THE ARGUMENT IT WAS GIVEN IS THE ARGUMENT IT USES (#722) ─────────────── */
/*
 * The filed defect: `node scripts/assert-formatted.mjs /some/worktree` printed a
 * confident PASS naming a base sha and a file count belonging to the checkout the
 * SCRIPT lives in. The verdict was true and it was about the wrong tree, which is
 * this repo's recurring shape — a check that answered a different question than
 * the one asked, whose success is indistinguishable from success at the asked one.
 *
 * These cases are about SILENCE, not about the positional being unsupported. A
 * refusal naming the argument is a fix; accepting it would also have been a fix;
 * ignoring it is what cannot stand.
 */
{
  const { repo } = makeRepo({ head: { "src/new.js": DIRTY } });
  const r = runRaw(repo); // the exact invocation from #722
  record(
    "a POSITIONAL path is refused, not silently ignored",
    r.code === 2 && r.out.includes(repo),
    r.code === 2
      ? "refused, and named it"
      : `exit ${r.code} — it answered about some other tree`
  );
}
{
  const { repo } = makeRepo({ head: { "src/new.js": CLEAN } });
  const r = run(repo, "--bogus", "zzz");
  record(
    "an UNRECOGNISED flag is refused, not dropped",
    r.code === 2 && /--bogus/.test(r.out),
    `exit ${r.code}`
  );
}
{
  const { repo } = makeRepo({ head: { "src/new.js": CLEAN } });
  const r = run(repo, "--base");
  record(
    "a known flag with no value is refused, not defaulted",
    r.code === 2 && /--base/.test(r.out),
    `exit ${r.code}`
  );
}
{
  /*
   * THE PRESENCE COMPANION. Every case above is a refusal, and a parser that
   * refused everything would score three for three. This one requires the three
   * flags the gate documents to still be accepted together.
   */
  const { repo } = makeRepo({ head: { "src/new.js": CLEAN } });
  const r = run(repo, "--base", "HEAD~1", "--head", "HEAD");
  record(
    "the documented flags are still accepted together",
    r.code === 0,
    `exit ${r.code}`
  );
}
{
  const { repo } = makeRepo({ head: { "src/new.js": CLEAN } });
  const r = run(repo, "--base=HEAD~1");
  record(
    "the --flag=value spelling is refused and names the one that works",
    r.code === 2 && /--base HEAD~1/.test(r.out),
    `exit ${r.code}`
  );
}
{
  const { repo } = makeRepo({ head: { "src/new.js": CLEAN } });
  const r = run(repo, "--base", "HEAD~1");
  record(
    "the verdict names the DIRECTORY it measured",
    r.code === 0 && r.out.includes(repo),
    r.out.includes(repo) ? "named" : "a count and a sha do not identify a tree"
  );
}

/* ── THE SUBJECT INCLUDES WORK THAT IS NOT COMMITTED YET ──────────────────── */
/*
 * The second defect, hit first-hand by TEAMLEAD and independently by me. The
 * gate computed its FILE LIST from the committed diff while reading each file's
 * CONTENT from the working tree, so uncommitted drift was caught if and only if
 * the file happened to appear in some unrelated commit's diff. Measured on this
 * repo at 3d3de727 with one uncommitted unformatted file and nothing else:
 *
 *   scripts/measure-e2e-flake.selftest.mjs   -> PASS, exit 0
 *   apps/open-swe/components/RunFacts.tsx    -> FAIL, exit 1
 *
 * Same tree state, opposite verdicts, and the only difference was whether the
 * file was named in HEAD's own diff. Coverage by coincidence is not coverage.
 */
{
  const { repo } = makeRepo({
    base: { "src/kept.js": CLEAN },
    head: { "src/new.js": CLEAN },
  });
  write(repo, "src/kept.js", DIRTY); // tracked, modified, NOT committed
  const r = run(repo, "--base", "HEAD~1");
  record(
    "an UNCOMMITTED change to a tracked file is gated",
    r.code === 1 && r.out.includes("src/kept.js"),
    `exit ${r.code}`
  );
}
{
  const { repo } = makeRepo({
    base: { "src/kept.js": CLEAN },
    head: { "src/new.js": CLEAN },
  });
  write(repo, "src/kept.js", DIRTY);
  git(repo, "add", "src/kept.js"); // staged, still not committed
  const r = run(repo, "--base", "HEAD~1");
  record(
    "a STAGED but uncommitted change is gated",
    r.code === 1 && r.out.includes("src/kept.js"),
    `exit ${r.code}`
  );
}
{
  /*
   * THE PRESENCE COMPANION for the pair above: widening the subject to the
   * working tree must not widen it to the whole tree. The backlog is dirty, in
   * the base commit, untouched — and the working tree is dirty elsewhere, so
   * the uncommitted path is definitely being walked.
   */
  const { repo } = makeRepo({
    base: { "src/backlog.js": DIRTY, "src/kept.js": CLEAN },
    head: { "src/new.js": CLEAN },
  });
  write(repo, "src/kept.js", CLEAN.replace("a: 1", "a: 2"));
  const r = run(repo, "--base", "HEAD~1");
  record(
    "a DRIFTED file nobody touched is still not gated when the tree is dirty",
    r.code === 0 && !r.out.includes("backlog.js"),
    `exit ${r.code}${
      r.out.includes("backlog.js") ? " — named the backlog" : ""
    }`
  );
}
{
  const { repo } = makeRepo({ head: { "src/new.js": CLEAN } });
  write(repo, "src/scratch.js", DIRTY); // never `git add`ed
  const r = run(repo, "--base", "HEAD~1");
  record(
    "an UNTRACKED file is not gated, and the count says it was set aside",
    r.code === 0 && /1 untracked/.test(r.out),
    r.code === 0
      ? /1 untracked/.test(r.out)
        ? "counted"
        : "passed WITHOUT saying what it skipped"
      : `exit ${r.code}`
  );
}
{
  /*
   * `--head` naming a commit that is NOT the working tree's HEAD. The file LIST
   * comes from that commit, so the file CONTENT has to as well. Reading disk
   * there is the same split that let uncommitted drift through above, pointing
   * the other way: it reports drift the named commit does not contain.
   *
   * The two arms differ only in which commit is asked about; the bytes on disk
   * are identical in both, so a gate reading disk cannot tell them apart.
   */
  const { repo } = makeRepo({
    base: { "src/kept.js": CLEAN },
    head: { "src/new.js": CLEAN },
  });
  write(repo, "src/new.js", DIRTY);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "drift");

  const atHead = run(repo, "--base", "HEAD~1", "--head", "HEAD");
  const atOlder = run(repo, "--base", "HEAD~2", "--head", "HEAD~1");
  record(
    "with --head off the working tree, content comes from that commit",
    atHead.code === 1 && atOlder.code === 0,
    `head-of-tree exit ${atHead.code} (want 1), older commit exit ${atOlder.code} (want 0)`
  );
}

{
  /*
   * A path in the committed diff that the working tree has since deleted. This threw a raw
   * ENOENT out of readFileSync, and node exits 1 for an uncaught throw — the same code this
   * gate uses for "a file is unformatted". A crash was therefore indistinguishable from a
   * verdict by exit status, which is the one thing the runner reads.
   */
  const { repo } = makeRepo({
    base: { "src/kept.js": CLEAN },
    head: { "src/gone-later.js": CLEAN },
  });
  rmSync(join(repo, "src/gone-later.js"));
  const r = run(repo, "--base", "HEAD~1");
  record(
    "a committed file DELETED in the working tree is a verdict, not a crash",
    r.code === 0 && /1 deleted in the working tree/.test(r.out),
    r.code === 0
      ? /1 deleted/.test(r.out)
        ? "counted"
        : "passed without saying it skipped one"
      : `exit ${r.code}${/ENOENT/.test(r.out) ? " — crashed" : ""}`
  );
}

{
  /*
   * And the same rule one level in: when `--head` is not what is checked out, the
   * working tree was not CONSULTED, and printing "0 uncommitted change(s)" there would
   * be a count reading as a measurement of something nobody looked at — this change's
   * own defect, reintroduced by its own output.
   */
  const { repo } = makeRepo({
    base: { "src/kept.js": CLEAN },
    head: { "src/new.js": CLEAN },
  });
  write(repo, "src/later.js", CLEAN);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "later");
  write(repo, "src/kept.js", DIRTY); // the checkout is dirty; the named head is not it

  const r = run(repo, "--base", "HEAD~2", "--head", "HEAD~1");
  const rHere = run(repo, "--base", "HEAD~1");
  record(
    "a head that is not the checkout says the tree was NOT consulted",
    /NOT consulted/.test(r.out) &&
      !/uncommitted change\(s\)/.test(r.out) &&
      /uncommitted change\(s\)/.test(rHere.out),
    /NOT consulted/.test(r.out)
      ? "said so"
      : "printed a count for a tree it never read"
  );
}

/* ── A FALLBACK BASE IS ANNOUNCED, AND NEVER REPLACES A REAL SUBJECT ──────── */
/*
 * `resolveBase` falls through to HEAD's own parent when no candidate ref differs
 * from HEAD. That is RIGHT on a push to main, where the pushed commit is the
 * subject. It is WRONG on a freshly branched checkout whose only work is
 * uncommitted, which is the same shape to git and the opposite thing to a person:
 * the gate measured the PREVIOUS commit's files and printed PASS about them.
 *
 * Measured on this repo, branch at origin/main, one unformatted uncommitted file:
 *   PASS: every changed file is formatted — 3 changed file(s) since 45bf74b
 * Those three files are #715's. The five the operator was about to commit were
 * never looked at.
 */
{
  const { repo } = makeRepo({
    base: { "src/kept.js": CLEAN },
    head: { "src/new.js": CLEAN },
  });
  write(repo, "src/kept.js", DIRTY);
  const r = run(repo); // no --base: every candidate ref IS HEAD
  record(
    "no differing ref + dirty tree gates the DIRTY WORK, not HEAD's parent",
    r.code === 1 && r.out.includes("src/kept.js"),
    `exit ${r.code}`
  );
}
{
  const { repo } = makeRepo({
    base: { "src/kept.js": CLEAN },
    head: { "src/new.js": DIRTY },
  });
  const r = run(repo); // no --base, CLEAN tree: the push-to-main shape
  record(
    "no differing ref + clean tree still falls back to HEAD's parent",
    r.code === 1 && r.out.includes("src/new.js"),
    `exit ${r.code}`
  );
}
{
  /*
   * THE OTHER HALF OF THE SAME ARM, and the reason `dirty` decides it rather than the
   * output merely describing it. HEAD's own commit carries drift the operator did not
   * write. Falling back to HEAD's parent would put that commit's files in the subject and
   * fail a person for a branch they had just created — the inherited backlog this gate
   * exists to NOT gate. Clean tree, one line up, must still gate exactly those files.
   */
  const { repo } = makeRepo({
    base: { "src/kept.js": CLEAN },
    head: { "src/prev.js": DIRTY },
  });
  write(repo, "src/kept.js", CLEAN.replace("a: 1", "a: 2"));
  const r = run(repo);
  record(
    "uncommitted work is not judged against HEAD's own parent",
    r.code === 0 && !r.out.includes("src/prev.js"),
    r.code === 0
      ? "own work only"
      : `exit ${r.code} — blamed the branch for ${
          r.out.includes("src/prev.js") ? "HEAD's own commit" : "something else"
        }`
  );
}

{
  const { repo } = makeRepo({
    base: { "src/kept.js": CLEAN },
    head: { "src/new.js": CLEAN },
  });
  const r = run(repo);
  record(
    "a fallback base SAYS it is a fallback",
    r.code === 0 && /parent/.test(r.out),
    r.code === 0
      ? /parent/.test(r.out)
        ? "announced"
        : "substituted a subject without saying so"
      : `exit ${r.code}`
  );
}

/* ── AN ABSENT INSTRUMENT IS NOT A VERDICT (#752) ─────────────────────────── */
/*
 * The residual #722 left. `resolveInstrument()` refuses at exit 2 when prettier
 * resolves and is the WRONG version — but `import prettier from "prettier"` sits at
 * module scope, so a prettier that is absent entirely throws before that function
 * ever runs, and node exits 1. That is the code this gate uses for "a file is not
 * formatted", so a missing instrument was indistinguishable from a verdict by the
 * status the runner reads.
 *
 * Reproduced first-hand in a fresh worktree with no node_modules, which is how a
 * person actually meets it rather than a contrivance.
 *
 * The tree here carries scripts/lib/ as well, because copying the checker alone
 * would fail on its own relative import and prove nothing about prettier.
 */
{
  const tree = mkdtempSync(join(tmpdir(), "fmt-no-prettier-"));
  mkdirSync(join(tree, "scripts", "lib"), { recursive: true });
  copyFileSync(CHECKER, join(tree, "scripts", "assert-formatted.mjs"));
  for (const f of readdirSync(join(ROOT, "scripts", "lib")))
    copyFileSync(
      join(ROOT, "scripts", "lib", f),
      join(tree, "scripts", "lib", f)
    );
  writeFileSync(
    join(tree, "package.json"),
    JSON.stringify({ devDependencies: { prettier: "2.8.8" } })
  );

  const r = (() => {
    try {
      return {
        code: 0,
        out: execFileSync(
          "node",
          [join(tree, "scripts", "assert-formatted.mjs")],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
        ),
      };
    } catch (e) {
      return { code: e.status, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  })();

  record(
    "an ABSENT prettier is exit 2 naming the instrument, not exit 1",
    r.code === 2 &&
      /prettier/i.test(r.out) &&
      !/ERR_MODULE_NOT_FOUND/.test(r.out),
    r.code === 2
      ? "refused"
      : `exit ${r.code}${
          /ERR_MODULE_NOT_FOUND/.test(r.out)
            ? " — crashed at import, which exit 1 makes look like a drift verdict"
            : ""
        }`
  );
  rmSync(tree, { recursive: true, force: true });
}

{
  /*
   * THE EXPORTED PATH, which the guard above does not cover (#752, finding 1).
   *
   * `analyse()` is exported and dereferences the prettier binding at three sites. The
   * absent-instrument refusal lives in `resolveInstrument()`, which is module-private and
   * reached only by `main()` — so the null is guarded by CALL ORDERING and by nothing else.
   * A caller importing `analyse` directly gets an uncaught TypeError and exit 1, which is
   * #752 restored on the one path its fix did not reach.
   *
   * Nothing reaches it today: exactly one file in the tree imports this module, and it
   * imports `instrument` only. But the module's own header says the design premise is being
   * imported and called directly, and this proof already does that — so an exported function
   * with no consumer is one waiting for the next person to test it the same way, in a tree
   * without node_modules. Fixing one instance of a pattern while creating another one
   * function over is not a fix.
   *
   * NO GIT SCAFFOLDING, DELIBERATELY. An earlier draft built a real repo with a dirty
   * file, justified by "analyse() refuses on git grounds before it reaches prettier".
   * That was true of an earlier ordering and the same commit removed it: the guard sits
   * ABOVE `makeGit`, so git is never reached and the repo was inert — a justification for
   * scaffolding that the change itself made unnecessary, which the next reader preserves
   * believing it is load-bearing.
   *
   * The discrimination the repo was there to buy is bought instead by asserting WHICH
   * refusal, below. That is stronger than an ordering argument and does not rot if the
   * ordering moves.
   */
  const tree = mkdtempSync(join(tmpdir(), "fmt-analyse-no-prettier-"));
  mkdirSync(join(tree, "scripts", "lib"), { recursive: true });
  copyFileSync(CHECKER, join(tree, "scripts", "assert-formatted.mjs"));
  for (const f of readdirSync(join(ROOT, "scripts", "lib")))
    copyFileSync(
      join(ROOT, "scripts", "lib", f),
      join(tree, "scripts", "lib", f)
    );
  writeFileSync(
    join(tree, "package.json"),
    JSON.stringify({ devDependencies: { prettier: "2.8.8" } })
  );
  writeFileSync(
    join(tree, "drive.mjs"),
    [
      'import { analyse } from "./scripts/assert-formatted.mjs";',
      "try {",
      "  await analyse({ cwd: process.cwd() });",
      '  console.log("NO-THROW");',
      "} catch (e) {",
      "  console.log(`${e.constructor.name}: ${e.message}`);",
      "}",
    ].join("\n")
  );

  let out = "";
  try {
    out = execFileSync("node", [join(tree, "drive.mjs")], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  /*
   * THE CLASS NAME IS THE ASSERTION, not merely the absence of TypeError. main() exits 2
   * only for `instanceof Refusal` (:568) and RE-THROWS anything else, which is exit 1 —
   * the code #752 exists to stop this path producing. So `throw new Refusal(...)`
   * simplified to `throw new Error(...)` would restore the defect while still mentioning
   * prettier, and an assertion reading only the message stays green through it.
   *
   * The fixture already printed `e.constructor.name` and nothing read it. Asserting the
   * name is also the honest form: `Refusal` is not exported (:71), so the name is the only
   * handle an importer has for telling a refusal from a crash.
   */
  record(
    "analyse() called directly without prettier REFUSES, not TypeError",
    /^Refusal: prettier could not be imported/m.test(out),
    /TypeError/.test(out)
      ? "TypeError — the null is guarded by call ordering and nothing else"
      : `got: ${out.trim().slice(0, 90)}`
  );
  rmSync(tree, { recursive: true, force: true });
}

/* ── REPORT ───────────────────────────────────────────────────────────────── */
const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
  console.log(
    `  ${r.ok ? "ok  " : "FAIL"} ${r.name.padEnd(width)}  (${r.detail})`
  );
}
console.log();
if (fail) {
  console.error(`FAIL: ${fail}/${results.length} cases wrong.`);
  process.exit(1);
}
console.log(
  `PASS: ${pass}/${results.length}. The gate fails on drift a branch introduces, stays\n` +
    `      silent on drift it inherited, refuses rather than passing when it could not\n` +
    `      compute a subject, and refuses when it cannot say which prettier answered.`
);
