#!/usr/bin/env node
/**
 * Proves scripts/assert-census-fresh.mjs can FAIL — do not remove.
 *
 * The whole justification for this checker is ONE case: two branches that write
 * the SAME ownedFileCount merge cleanly, and the result is stale. If the
 * selftest cannot construct that case, the checker has no demonstrated reason
 * to exist and its green means only that nothing crashed.
 *
 * So case SILENT below builds it for real — two throwaway branches off one
 * base, each adding one rung-owned file, each frozen with the REAL freeze:all —
 * and asserts BOTH that git merges them without conflict AND that the checker
 * catches what git missed. Either half alone proves nothing: a conflict would
 * mean git already handles it, and a catch without the clean merge would not
 * show the check was needed.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const CHECKER = join(ROOT, "scripts", "assert-census-fresh.mjs");
const git = (a, cwd = ROOT) =>
  execFileSync("git", a, { cwd, encoding: "utf8", maxBuffer: 64 << 20 }).trim();

function run(base, head) {
  try {
    return { code: 0, out: execFileSync("node", [CHECKER, "--base", base, "--head", head], {
      cwd: ROOT, encoding: "utf8",
    }) };
  } catch (e) {
    return { code: e.status, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

/** A throwaway branch off `base` that adds one rung-owned file and freezes. */
function branchAddingOneFile(base, tag) {
  const wt = mkdtempSync(join(tmpdir(), `cfst-${tag}-`));
  git(["worktree", "add", "-q", "--detach", wt, base]);
  writeFileSync(join(wt, "apps", "open-swe", "lib", `zz-probe-${tag}.ts`), "export const x = 1;\n");
  git(["add", "-A"], wt);
  execFileSync("node", [join(wt, "scripts", "freeze-all.mjs")], { cwd: wt, stdio: "ignore" });
  git(["add", "-A"], wt);
  git(["-c", "user.email=selftest@local", "-c", "user.name=selftest", "commit", "-q", "-m", `probe-${tag}`], wt);
  const sha = git(["rev-parse", "HEAD"], wt);
  return { wt, sha };
}

const cleanup = [];
let pass = 0;
const cases = [];

const BASE = git(["rev-parse", "HEAD"]);

// ---- the case the checker exists for -------------------------------------
{
  const a = branchAddingOneFile(BASE, "a");
  const b = branchAddingOneFile(BASE, "b");
  cleanup.push(a.wt, b.wt);

  const mt = (() => {
    try { return execFileSync("git", ["merge-tree", "--write-tree", a.sha, b.sha], { cwd: ROOT, encoding: "utf8" }); }
    catch (e) { return (e.stdout ?? "") + (e.stderr ?? ""); }
  })();
  const mergesCleanly = !/CONFLICT/i.test(mt);

  const r = run(a.sha, b.sha);
  cases.push({
    name: "SILENT   two +1 branches merge CLEANLY and the checker still catches it",
    ok: mergesCleanly && r.code === 1 && /but the merged tree owns/.test(r.out),
    detail: `mergesCleanly=${mergesCleanly} exit=${r.code}`,
    out: r.out,
  });

  // ---- and the control: a branch that IS fresh must pass -----------------
  const fresh = run(BASE, a.sha);
  cases.push({
    name: "FRESH    a branch frozen against the current base passes",
    ok: fresh.code === 0 && /PASS/.test(fresh.out),
    detail: `exit=${fresh.code}`,
    out: fresh.out,
  });
}

// ---- the case that was MISSING, and that false-positived in the wild -----
{
  /*
   * A BRANCH THAT NEVER TOUCHES rungs.json MUST READ AS FRESH.
   *
   * This is the ordinary PR — most changes do not add a rung-owned file — and
   * it is the case the first version of this checker got WRONG. It read the
   * declared count from the BRANCH, so a branch carrying its base's older copy
   * was compared against a stale declaration of its own and reported stale.
   * It false-positived on the first real PR it was pointed at.
   *
   * Both other cases here change rungs.json, so neither could see it. The fix
   * was to read the declaration from the MERGED TREE — which is the file that
   * actually lands — and this case is what holds that fix in place.
   */
  const wt = mkdtempSync(join(tmpdir(), "cfst-untouched-"));
  cleanup.push(wt);
  git(["worktree", "add", "-q", "--detach", wt, BASE]);
  // A file no rung owns and the shared census does not count: changes nothing.
  writeFileSync(join(wt, "README-selftest-probe.md"), "probe\n");
  git(["add", "-A"], wt);
  git(["-c", "user.email=selftest@local", "-c", "user.name=selftest", "commit", "-q", "-m", "untouched-census"], wt);
  const sha = git(["rev-parse", "HEAD"], wt);

  // Now advance the base so the branch's own rungs.json copy is genuinely
  // older than main's — the exact shape that produced the false positive.
  const mover = branchAddingOneFile(BASE, "mover");
  cleanup.push(mover.wt);

  const r = run(mover.sha, sha);
  cases.push({
    name: "UNTOUCHED a branch that never edits rungs.json is FRESH against a moved base",
    ok: r.code === 0 && /PASS/.test(r.out),
    detail: `exit=${r.code}`,
    out: r.out,
  });
}

// ---- a conflicting merge is NOT this check's business --------------------
{
  const c = run("HEAD", "HEAD");
  cases.push({
    name: "IDENTITY a branch merged with itself is trivially fresh",
    ok: c.code === 0,
    detail: `exit=${c.code}`,
    out: c.out,
  });
}

// ---- vacuity ------------------------------------------------------------
{
  const r = run("HEAD", "refs/nonexistent-selftest");
  cases.push({
    name: "VACUOUS  an unresolvable head REFUSES rather than reporting fresh",
    ok: r.code === 2,
    detail: `exit=${r.code}`,
    out: r.out,
  });
}

for (const c of cases) {
  console.log(`  ${c.ok ? "ok  " : "FAIL"}  ${c.name}   [${c.detail}]`);
  if (!c.ok) console.log("        " + c.out.trim().split("\n").join("\n        "));
  if (c.ok) pass++;
}

for (const w of cleanup) {
  try { execFileSync("git", ["worktree", "remove", "--force", w], { cwd: ROOT, stdio: "ignore" }); }
  catch { rmSync(w, { recursive: true, force: true }); }
}
try { execFileSync("git", ["worktree", "prune"], { cwd: ROOT, stdio: "ignore" }); } catch {}

console.log(
  `\n${pass === cases.length ? "PASS" : "FAIL"}: ${pass}/${cases.length}. The checker was watched\n` +
    `      catching a collision that git merges WITHOUT CONFLICT — which is the only\n` +
    `      case it exists for — and watched passing a branch that is genuinely fresh.`
);
process.exit(pass === cases.length ? 0 : 1);
