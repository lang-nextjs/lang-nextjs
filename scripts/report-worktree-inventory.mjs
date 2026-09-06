/**
 * WHAT WORKTREES EXIST AND WHICH ARE SAFE TO REMOVE — A REPORT, NEVER A CLEANUP (#826, #873).
 *
 * IT REMOVES NOTHING, DELIBERATELY. A path-keyed teardown is safe and immune to #873, and it
 * does not fire in the case that PRODUCES orphans: SIGKILL has no `finally`. The obvious repair
 * for that — a start-up sweep on the script's own mkdtemp prefix — deletes a CONCURRENT peer's
 * in-flight probe, and three sessions ran `eject-audit` in one evening. A PREFIX IS
 * SCRIPT-OWNED, NOT RUN-OWNED: it identifies a CLASS where ownership needs an INSTANCE. So this
 * enumerates and classifies, and a human removes.
 *
 * SELECTION IS BY PATH, NEVER BY SUBSTRING, and #873 is why. Grepping for `eject-audit` matched
 * a live branch; tightening it to `eject-audit-` — what someone writes WHEN BEING CAREFUL, and
 * which looks strictly narrower — matched IDENTICALLY, because the hyphen it was tightened with
 * is the hyphen in `fix/819-eject-audit-produces-its-own-records`. Someone's branch, one grep
 * from a force-remove. `--porcelain` gives the path as a field; a path is compared as a path.
 *
 * CLASSIFICATION IS BY KIND, NOT BY LANDEDNESS, and that is a finding rather than a shortcut.
 * Four tests for "is this work already on main" were tried and ALL FOUR fail under squash-merge
 * — ancestry, patch-id, commit subject, and per-file content, the last disproven against a
 * worktree whose work was KNOWN to be upstream. A report that says "git cannot tell you this,
 * and here is why" beats one that guesses, because a wrong landed verdict is what makes someone
 * delete unpushed work.
 *
 * Exit 0 every worktree classified · 1 the inventory does not reconcile · 2 it could not be read.
 */
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { sep, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { invokedAsProgram } from "./lib/is-main.mjs";
import { reportSubject } from "./lib/subject.mjs";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

/**
 * Resolve symlinks where possible, because the two sides of this comparison come from
 * DIFFERENT SOURCES and disagree by one. On macOS `os.tmpdir()` returns `/var/folders/…` while
 * `git worktree list` prints `/private/var/folders/…` — `/var` is a symlink to `/private/var`,
 * so a correct-looking prefix test matched NOTHING and the class that needs no judgement was
 * silently always empty. Falls back to `resolve` for a path that no longer exists, which is
 * exactly the case a stale worktree registration produces.
 */
function realish(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** True when `p` is AT or BENEATH `dir` — compared as paths, never as substrings (#873). */
export function isUnder(p, dir) {
  if (typeof p !== "string" || typeof dir !== "string" || !p || !dir)
    return false;
  const a = realish(p);
  const b = realish(dir);
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
}

/** `git worktree list --porcelain` into records. One blank-line-separated block each. */
export function parseWorktrees(porcelain) {
  const out = [];
  let cur = null;
  for (const line of String(porcelain ?? "").split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur) out.push(cur);
      cur = { path: line.slice("worktree ".length), head: null, branch: null };
    } else if (!cur) continue;
    else if (line.startsWith("HEAD ")) cur.head = line.slice("HEAD ".length);
    else if (line.startsWith("branch "))
      cur.branch = line.slice("branch refs/heads/".length);
  }
  if (cur) out.push(cur);
  return out;
}

/*
 * THE CLASSES, ORDERED SAFEST FIRST so the rows needing no judgement are read first and the
 * ones needing a human are not buried under them.
 *
 * `pushed` MEANS A REMOTE-TRACKING REF EXISTS LOCALLY, which is a fact about the last fetch and
 * not about origin now. Stated in the output rather than implied, because "the work is safe on
 * the remote" is exactly the sentence someone acts on.
 */
export const CLASSES = [
  "proof-residue",
  "pushed",
  "wip-scaffold",
  "named-unpushed",
];

export function classify(wt, { tmp, remoteBranches, subjectOf }) {
  /*
   * `os.tmpdir()` SPECIFICALLY, not "/tmp" generally. `mkdtemp` puts a script's probe
   * directory under tmpdir; a session scratchpad under /tmp holds someone's DELIBERATE
   * worktrees, and calling those "remove without judgement" is how this report would destroy
   * the work it exists to protect.
   */
  if (isUnder(wt.path, tmp)) return "proof-residue";
  if (wt.branch && remoteBranches.has(wt.branch)) return "pushed";
  const subject = subjectOf(wt.head) ?? "";
  if (/^wip[: ]/i.test(subject.trim())) return "wip-scaffold";
  return "named-unpushed";
}

/**
 * Bucket worktrees by class, KEEPING ANYTHING THAT FALLS THROUGH rather than throwing.
 *
 * WITHOUT THIS THE ONLY FAILURE PATH IS UNREACHABLE. `classify` returns one of four literals
 * and `CLASSES` lists the same four, so a sum over the buckets can never disagree with the
 * total — the reconciliation would be arithmetic that cannot come out wrong, which is a check
 * asserting nothing. The property that CAN fail is that the two lists agree: a class added to
 * `classify` and not to `CLASSES` is declared in one place and consumed in another, and the
 * rows carrying it would vanish from a report that still totalled correctly.
 */
export function bucketize(worktrees, classifyOne, classes = CLASSES) {
  const byClass = new Map(classes.map((c) => [c, []]));
  const unclassified = [];
  for (const wt of worktrees) {
    const cls = classifyOne(wt);
    const bucket = byClass.get(cls);
    if (bucket) bucket.push(wt);
    else unclassified.push({ path: wt.path, cls });
  }
  return { byClass, unclassified };
}

function refuse(what, err) {
  console.error(
    `\nCOULD NOT CHECK: ${what}\n\n  ${String(err?.message ?? err)}\n\n` +
      `  Exiting 2: the question could not be asked, not answered. An EMPTY inventory and an\n` +
      `  unreadable one are the same output, and only one of them means there are no worktrees.\n`
  );
  process.exit(2);
}

function main() {
  let porcelain;
  try {
    porcelain = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 << 20,
    });
  } catch (err) {
    refuse("`git worktree list --porcelain` could not be run.", err);
  }

  const worktrees = parseWorktrees(porcelain);
  const remoteBranches = new Set();
  try {
    const refs = execFileSync(
      "git",
      ["for-each-ref", "--format=%(refname:strip=3)", "refs/remotes/origin"],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 }
    );
    for (const r of refs.split("\n"))
      if (r.trim()) remoteBranches.add(r.trim());
  } catch (err) {
    refuse(
      "the remote-tracking refs could not be listed, so `pushed` is undecidable.",
      err
    );
  }

  const subjects = new Map();
  const subjectOf = (sha) => {
    if (!sha) return null;
    if (subjects.has(sha)) return subjects.get(sha);
    let s = null;
    try {
      s = execFileSync("git", ["log", "-1", "--format=%s", sha], {
        cwd: ROOT,
        encoding: "utf8",
      }).trim();
    } catch {
      s = null; // an unreadable subject is not a refusal: the row is still reportable
    }
    subjects.set(sha, s);
    return s;
  };

  const tmp = tmpdir();
  const { byClass, unclassified } = bucketize(worktrees, (wt) =>
    classify(wt, { tmp, remoteBranches, subjectOf })
  );

  reportSubject(worktrees.length, "worktree(s) inventoried");

  const HEADINGS = {
    "proof-residue": `under ${tmp} — a script's probe directory. REMOVE WITHOUT JUDGEMENT, unless a peer is mid-run`,
    pushed:
      "a remote-tracking ref exists for the branch, as of the last fetch. The work is on origin; removing the worktree loses nothing",
    "wip-scaffold":
      "the HEAD subject begins `wip:` — ask whoever made it, do not assume",
    "named-unpushed":
      "NAMED, NOT JUDGED. No remote ref and not a probe. git cannot tell you whether this landed",
  };
  for (const cls of CLASSES) {
    const rows = byClass.get(cls);
    console.log(`\n${cls}  (${rows.length}) — ${HEADINGS[cls]}`);
    for (const wt of rows)
      console.log(
        `    ${wt.path}${wt.branch ? `  [${wt.branch}]` : "  (detached)"}`
      );
  }

  /*
   * THE COUNT THAT HAS TO RECONCILE. "Be careful with cleanup patterns" is not available as a
   * control; a total that must equal the sum of its parts is. This is what caught the #873
   * near-miss — a line reading "leftover audit worktrees now: 1" where zero was expected — and
   * it is the only thing here that can fail, because a report of what exists cannot be wrong
   * about the world, only about itself.
   */
  const summed =
    CLASSES.reduce((n, c) => n + byClass.get(c).length, 0) +
    unclassified.length;
  console.log(
    `\nmatched ${summed} of ${worktrees.length} worktree(s): ` +
      CLASSES.map((c) => `${c} ${byClass.get(c).length}`).join(", ")
  );
  if (unclassified.length > 0) {
    console.error(
      `\nFAIL: ${unclassified.length} worktree(s) carry a class this report does not list:`
    );
    for (const u of unclassified) console.error(`    ${u.path}  -> "${u.cls}"`);
    console.error(
      `\n  \`classify\` and \`CLASSES\` disagree. The rows above would be MISSING from every\n` +
        `  section while the total still reconciled — declared in one place, consumed in another.`
    );
    process.exit(1);
  }
  if (summed !== worktrees.length) {
    console.error(
      `\nFAIL: ${worktrees.length} worktree(s) were listed and ${summed} classified — ` +
        `${
          worktrees.length - summed
        } fell through every class. The classifier is not total, ` +
        `so this inventory is not a description of the machine.`
    );
    process.exit(1);
  }

  console.log(
    `\nPASS: every worktree is classified. NOTHING WAS REMOVED — this report exists because a\n` +
      `      prefix-keyed sweep cannot tell a peer's live probe from an orphan, and a landedness\n` +
      `      test cannot survive squash-merge.`
  );
}

if (invokedAsProgram(import.meta.url)) main();
