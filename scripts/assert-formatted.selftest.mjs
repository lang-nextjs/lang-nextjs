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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import prettier from "prettier";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHECKER = join(ROOT, "scripts", "assert-formatted.mjs");

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
    `      silent on drift it inherited, and refuses rather than passing when it could\n` +
    `      not compute a subject.`
);
