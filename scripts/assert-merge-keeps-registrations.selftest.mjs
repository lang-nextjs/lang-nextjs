#!/usr/bin/env node
/**
 * Proof for assert-merge-keeps-registrations.mjs.
 *
 * THE REJECT ARM IS A PRESERVED REAL MERGE, not a constructed one. The tree was clean when
 * this was written — all 21 open PRs merged without conflict — so a check written today has
 * nothing live to be red against, which is the defect it exists to prevent reproduced by its
 * own fix. scripts/fixtures/specimen-merge-loses-registration-467.bundle carries three real
 * commits:
 *
 *   refs/specimens/467-parent-main     35211da  main, with `undeclared-reverts` declared
 *   refs/specimens/467-parent-branch   c20a84c  PR #462's head, which predates #427 and so has
 *                                               never seen that entry; it adds its own
 *   refs/specimens/467-lost-entry-merge f273a42  the two, resolved by taking the branch's file
 *                                               wholesale — the action the issue describes
 *
 * The ACCEPT arm is the SAME TWO PARENTS merged correctly, which is the control that matters:
 * a checker that fired on any merge of those trees would be satisfied by the reject case and
 * useless. Git merges them cleanly to the union — the conflict is what a human introduces by
 * resolving a file wholesale, not something git forces.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CHECKER = join(HERE, "assert-merge-keeps-registrations.mjs");
const BUNDLE = join(ROOT, "scripts/fixtures/specimen-merge-loses-registration-467.bundle");

let pass = 0,
  fail = 0,
  ran = 0;
const watched = [];
const ok = (n, w) => {
  console.log(`  ok      ${n}`);
  watched.push(w);
  pass++;
};
const bad = (n, why, out) => {
  console.error(`  FAIL    ${n}\n          ${why}`);
  if (out) console.error(String(out).split("\n").map((l) => `          | ${l}`).join("\n"));
  fail++;
};

const git = (cwd, ...a) =>
  execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/**
 * A scratch clone carrying the specimen.
 *
 * The bundle is THIN — it requires b1a606d, a commit on main — so it is unbundled into a clone
 * of this repository rather than an empty one. Same arrangement as #427's specimen.
 */
function repo() {
  const d = mkdtempSync(join(tmpdir(), "merge-reg-"));
  git(d, "clone", "--quiet", "--no-checkout", "--local", ROOT, "r");
  const r = join(d, "r");
  git(r, "fetch", "--quiet", BUNDLE, "+refs/specimens/*:refs/specimens/*");
  return { dir: d, r };
}

function run(r, args) {
  try {
    return { code: 0, out: execFileSync("node", [CHECKER, "--cwd", r, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/**
 * TEARDOWN MUST NOT PRODUCE A VERDICT.
 *
 * This failed in CI as `ENOTEMPTY: directory not empty, rmdir '/tmp/merge-reg-XXXX/r/.git'` and
 * halted a drain batch. Nothing about that red is a statement about the checker: every case had
 * already run and reported. A harness that can fail while cleaning up emits a red whose subject
 * is the harness, and this one guards MERGES — so a spurious red here stops a batch, which is
 * exactly what it did.
 *
 * WHY IT HAPPENS HERE AND NOT IN THE OTHER SELFTESTS I OWN: this is the only one that CLONES A
 * REAL GIT REPOSITORY. `git clone --local` hardlinks thousands of small objects, and removing
 * that tree is where a transient ENOTEMPTY, EBUSY or EPERM appears — a directory refilling
 * between the walk and the rmdir. `maxRetries`/`retryDelay` exist on rmSync for precisely this
 * family of errors.
 *
 * RETRY, THEN ANNOUNCE — NOT SWALLOW. A bare try/catch would hide a temp directory that has
 * started leaking on every run, and leaked worktrees are a problem this repo has measured
 * before (classify.selftest.mjs records 312 MB from two interrupted runs). So a failure to
 * clean up prints a WARNING naming the path and does not touch the verdict. The suite's exit
 * code answers "is the checker trustworthy"; it does not answer "did /tmp get tidy".
 */
function removeTree(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch (e) {
    console.error(
      `  warn    could not remove ${dir} — ${e.code ?? e.message.split("\n")[0]}. ` +
        `Not a verdict about the checker; the cases above already reported.`
    );
  }
}

function withRepo(name, body) {
  const { dir, r } = repo();
  try {
    ran++;
    body(r, name);
  } catch (e) {
    bad(name, `threw: ${e.message.split("\n")[0]}`);
  } finally {
    removeTree(dir);
  }
}

console.log("assert-merge-keeps-registrations selftest\n");

// ── REJECT: the preserved real merge ──────────────────────────────────────────────────────
withRepo("SPECIMEN a real merge that dropped a declared check is REJECTED", (r, name) => {
  const { code, out } = run(r, ["--merged", "refs/specimens/467-lost-entry-merge"]);
  const namesIt = /scripts\/checks\.json\s+"undeclared-reverts"/.test(out);
  const signature = /merged == one parent, union is larger/.test(out);
  const counts = /scripts\/checks\.json\s+11\s+11\s+10\s+12\s+11/.test(out);
  if (code === 1 && namesIt && signature && counts)
    ok(name, "the real dropped entry named, with 11/11/10/12/11 and the signature called out");
  else
    bad(name, `exit=${code} names=${namesIt} signature=${signature} counts=${counts}`, out);
});

// ── ACCEPT: the SAME two parents, merged correctly ────────────────────────────────────────
withRepo("ACCEPT the same two parents merged to the UNION pass", (r, name) => {
  git(r, "checkout", "--quiet", "-B", "probe", "refs/specimens/467-parent-main");
  git(r, "-c", "user.email=t@t", "-c", "user.name=t", "merge", "--quiet", "--no-ff", "-m",
    "union merge", "refs/specimens/467-parent-branch");
  const { code, out } = run(r, ["--merged", "HEAD"]);
  // 12 is the union: main's undeclared-reverts plus the branch's swallowed-evidence.
  if (code === 0 && /scripts\/checks\.json\s+11\s+11\s+10\s+12\s+12/.test(out))
    ok(name, "a correct union of the very trees the reject arm uses, at 12");
  else bad(name, `exit=${code} — a checker that fires on any merge of these trees is useless`, out);
});

// ── ACCEPT: a DELIBERATE removal is not a loss ────────────────────────────────────────────
withRepo("ACCEPT an entry a parent SAW and removed is a decision, not a loss", (r, name) => {
  git(r, "checkout", "--quiet", "-B", "probe", "refs/specimens/467-parent-main");
  const p = join(r, "scripts/checks.json");
  const d = JSON.parse(readFileSync(p, "utf8"));
  const dropped = d.checks.find((c) => c.name === "parity-tsconfig");
  d.checks = d.checks.filter((c) => c.name !== "parity-tsconfig");
  writeFileSync(p, JSON.stringify(d, null, 2) + "\n");
  git(r, "add", "-A");
  git(r, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--quiet", "-m",
    "retire the parity-tsconfig checker on purpose");
  // The merge CONFLICTS — both sides edited this list, which is the situation the whole issue
  // is about. Resolve it the correct way: union of both parents, minus the one entry this side
  // deliberately retired. That is the resolution a careful person makes, and it must pass.
  try {
    git(r, "-c", "user.email=t@t", "-c", "user.name=t", "merge", "--no-ff", "-m",
      "merge the branch", "refs/specimens/467-parent-branch");
  } catch {
    const mine = JSON.parse(git(r, "show", "HEAD:scripts/checks.json"));
    const theirs = JSON.parse(
      git(r, "show", "refs/specimens/467-parent-branch:scripts/checks.json")
    );
    const seen = new Set();
    const union = [...mine.checks, ...theirs.checks].filter(
      (c) => c.name !== "parity-tsconfig" && !seen.has(c.name) && seen.add(c.name)
    );
    writeFileSync(p, JSON.stringify({ ...mine, checks: union }, null, 2) + "\n");
    git(r, "add", "-A");
    git(r, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--quiet", "--no-verify",
      "-m", "resolve by union, minus the retired checker");
  }
  // The other parent still declares it, so it is missing from the union's perspective — but
  // the commit that introduced it is an ancestor of the parent that dropped it. Seen, then
  // removed: a decision. Firing here is how a check makes every legitimate deletion unmergeable.
  const { code, out } = run(r, ["--merged", "HEAD"]);
  if (code === 0 && dropped && !/parity-tsconfig/.test(out.split("FAIL")[1] ?? ""))
    ok(name, "a retired checker NOT reported as lost");
  else bad(name, `exit=${code} — a deliberate removal must pass or nothing can ever be deleted`, out);
});

// ── REFUSE: nothing to judge ──────────────────────────────────────────────────────────────
withRepo("REFUSE a non-merge commit exits 2 rather than reporting nothing lost", (r, name) => {
  const { code, out } = run(r, ["--merged", "refs/specimens/467-parent-branch"]);
  if (code === 2 && /is not a merge/.test(out)) ok(name, "no merge, no verdict");
  else bad(name, `exit=${code}`, out);
});

// ── REFUSE: a list this checker cannot read ───────────────────────────────────────────────
withRepo("REFUSE an unparseable list exits 2 rather than comparing what it could read", (r, name) => {
  git(r, "checkout", "--quiet", "-B", "probe", "refs/specimens/467-parent-main");
  git(r, "-c", "user.email=t@t", "-c", "user.name=t", "merge", "--quiet", "--no-ff", "-m", "m",
    "refs/specimens/467-parent-branch");
  writeFileSync(join(r, "scripts/checks.json"), "{ this is not json");
  git(r, "add", "-A");
  git(r, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--quiet", "-m", "break the list");
  // HEAD is now a non-merge child; point the checker at the merge but with a broken tree is not
  // reachable, so break it AT the merge instead by amending.
  const { code, out } = run(r, ["--merged", "HEAD", "--parents",
    "refs/specimens/467-parent-main,refs/specimens/467-parent-branch"]);
  if (code === 2 && /could not be read as a registration list/.test(out))
    ok(name, "an unreadable list refusing rather than comparing a subset");
  else bad(name, `exit=${code}`, out);
});

const EXPECTED = 5;
console.log();
if (ran !== EXPECTED) {
  console.error(`FAIL: ran ${ran} case(s), expected ${EXPECTED} — the harness is broken.`);
  process.exit(1);
}
if (fail) {
  console.error(`FAIL: ${fail}/${ran}. The checker is NOT trustworthy.`);
  process.exit(1);
}
console.log(`PASS: ${pass}/${ran}. Watched:`);
for (const w of watched) console.log(`      - ${w}`);
