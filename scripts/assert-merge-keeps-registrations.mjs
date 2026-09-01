#!/usr/bin/env node
/**
 * assert-merge-keeps-registrations.mjs — a merge must not lose a registration either parent had.
 *
 * THE DEFECT (#467). Two branches append to a REGISTRATION LIST at the same anchor. Git
 * conflicts. Taking either side wholesale silently drops the other's entry, and the result is
 * a well-formed file that reviews cleanly.
 *
 * WHY THIS IS NOT A REVIEW PROBLEM. The merged hunk is PLAUSIBLE — it is a list of the right
 * shape with the right syntax, missing one line nobody is looking for. What identifies it is
 * arithmetic, not reading: A MERGED COUNT EQUAL TO ONE PARENT'S COUNT while the union is
 * larger. Every correct resolution on the night this was filed was reached by taking that set
 * difference, and every one of them was done by hand.
 *
 * A LIVE INSTANCE, MEASURED, AND IT IS THE WORST SHAPE:
 *
 *   main    11 entries, including `undeclared-reverts`
 *   pr/462  11 entries, including `swallowed-evidence`   and NOT undeclared-reverts
 *   pr/465  11 entries, including `behavioural-evidence` and NOT undeclared-reverts
 *
 * Both branches predate #427, so neither ever saw that entry. Merge either one by taking the
 * branch and `undeclared-reverts` is gone — and the count still reads 11, the same as both
 * parents, while the union is 12.
 *
 * IN THIS REPO AN ENTRY IN scripts/checks.json IS AN EXECUTION. run-checks.mjs iterates the
 * list and writes .checks-run.json; pairing reads WHAT RAN. So a dropped entry does not fail —
 * the checker simply never runs, every downstream report is computed over a set that silently
 * shrank, and the artifact that would notice is the pairing gate, WHICH READS THE SAME LIST
 * THAT LOST THE ENTRY. A dropped export eventually breaks an import; a dropped `include` is
 * typechecked by nobody and stays green forever.
 *
 * A CLAIM ABOUT THREE TREES, which is why nothing catches it today: both parents and the
 * result. On a `pull_request` event the checkout IS the merge commit — `refs/pull/N/merge` —
 * so its two parents are exactly the trees to compare, and ci.yml already fetches full history
 * for #427. Where there is no merge commit there is no claim to make, and this REFUSES rather
 * than inventing one.
 *
 * DELIBERATE REMOVAL IS LEGITIMATE AND MUST PASS. Deleting a stale allowlist entry or retiring
 * a checker is ordinary work. The two are told apart by ANCESTRY, not by intent: if the commit
 * that introduced an entry to one parent is an ancestor of the OTHER parent, that parent saw
 * the entry and removed it on purpose. If it is not an ancestor, the other parent never knew
 * the entry existed, and its absence from the merge is a LOSS rather than a decision.
 *
 * Exit codes:  0  the merge keeps every entry both parents had
 *              1  an entry was lost
 *              2  there is no merge to judge, or a list could not be read
 *
 * Usage: node scripts/assert-merge-keeps-registrations.mjs [--merged REF] [--parents A,B] [--cwd DIR]
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { invokedAsProgram } from "./lib/is-main.mjs";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 || !argv[i + 1] ? d : argv[i + 1];
};
const CWD = resolve(arg("cwd", ROOT));

const git = (...a) =>
  execFileSync("git", a, {
    cwd: CWD,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

/* ------------------------------------------------------------------ *
 * THE LISTS, AND HOW EACH IS READ
 * ------------------------------------------------------------------ */

/**
 * NOT ONE SHAPE. checks.json is objects with names, the barrel is export statements, the
 * tsconfigs are filename strings, rungs.json is per-rung FIELDS. A checker that handled one
 * and silently skipped the rest would report on a subject smaller than its name, which is the
 * defect class this repo keeps removing — so an unreadable list REFUSES instead.
 *
 * Each extractor returns a Set of stable identifiers. What an identifier means differs per
 * list; what matters is that the same entry produces the same string in all three trees.
 */
const stripJsonComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

export const LISTS = [
  {
    file: "scripts/checks.json",
    what: "declared checks — AN ENTRY IS AN EXECUTION (#395), so a lost one is a checker that never runs",
    extract(text) {
      return new Set((JSON.parse(text).checks ?? []).map((c) => c.name));
    },
  },
  {
    file: "packages/react/src/index.ts",
    what: "the public barrel — a lost export eventually breaks a consumer's import",
    extract(text) {
      const out = new Set();
      // `export { a, b as c }` / `export type { X }` / `export function f` / `export const k`
      for (const m of text.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g))
        for (const part of m[1].split(","))
          if (part.trim())
            out.add(
              part
                .trim()
                .split(/\s+as\s+/)
                .pop()
                .trim()
            );
      for (const m of text.matchAll(
        /export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|class|type|interface|enum)\s+([A-Za-z0-9_$]+)/g
      ))
        out.add(m[1]);
      return out;
    },
  },
  {
    file: "packages/test-utils/tsconfig.json",
    what: "the exclude list — its complement is tsconfig.parity.json's include (#430/#431)",
    extract(text) {
      const d = JSON.parse(stripJsonComments(text));
      return new Set([
        ...(d.include ?? []).map((v) => `include:${v}`),
        ...(d.exclude ?? []).map((v) => `exclude:${v}`),
      ]);
    },
  },
  {
    file: "packages/test-utils/tsconfig.parity.json",
    what: "the include list — a lost entry is a suite TYPECHECKED BY NOBODY, and it stays green",
    extract(text) {
      const d = JSON.parse(stripJsonComments(text));
      return new Set([
        ...(d.include ?? []).map((v) => `include:${v}`),
        ...(d.exclude ?? []).map((v) => `exclude:${v}`),
      ]);
    },
  },
  {
    file: "rungs.json",
    what: "per-rung FIELDS — the case where neither side was correct, because one parent's count and the other's new field are both right",
    extract(text) {
      const d = JSON.parse(text);
      const out = new Set();
      // Field-level, not entry-level: the observed loss was `reach` disappearing from a rung
      // that both parents still declared. An entry-level set would have called that identical.
      // VALUES ARE DELIBERATELY EXCLUDED — ownedFileCount legitimately changes with the tree,
      // and a check that demanded a parent's number back would be demanding a stale census.
      for (const r of d.rungs ?? [])
        for (const k of Object.keys(r)) out.add(`${r.id}.${k}`);
      for (const k of Object.keys(d.shared ?? {})) out.add(`shared.${k}`);
      return out;
    },
  },
];

/* ------------------------------------------------------------------ *
 * READING A LIST AT A TREE
 * ------------------------------------------------------------------ */

class Refusal extends Error {}

/** The file's contents at a commit, or null when it does not exist there. */
function fileAt(sha, path) {
  try {
    return git("show", `${sha}:${path}`);
  } catch {
    return null;
  }
}

function setAt(list, sha) {
  const text = fileAt(sha, list.file);
  // ABSENT IS AN EMPTY SET, NOT A REFUSAL: a branch that introduces a list is ordinary, and its
  // other parent legitimately has none. Absent from the MERGE while present in a parent is the
  // whole list being lost, which the comparison below reports on its own.
  if (text === null) return new Set();
  try {
    return list.extract(text);
  } catch (e) {
    throw new Refusal(
      `${list.file} at ${sha.slice(
        0,
        9
      )} could not be read as a registration list — ` +
        `${
          e.message.split("\n")[0]
        }. A list this check cannot parse is a list it cannot ` +
        `compare, which is not the same as one that lost nothing.`
    );
  }
}

/**
 * Did `other` ever see this entry?
 *
 * The newest commit in `owner`'s history that changed the entry's occurrence count is taken as
 * where it entered. If that commit is an ancestor of `other`, then `other` had it and dropped
 * it — a decision. If not, `other` never knew about it, and the merge losing it is an accident.
 *
 * A KNOWN LIMIT, STATED: `-S` finds a commit where the string's count CHANGED, which for an
 * entry that was added, removed and re-added names the latest such change. That is the right
 * commit for the question being asked. An entry whose identifier never appears literally in
 * the file — rungs.json's `id.field` form — cannot be located this way, so those are treated as
 * never-seen, which errs toward reporting a loss. Erring the other way would excuse one.
 */
function sawIt(entry, owner, other, file) {
  let introducing;
  try {
    introducing = git(
      "log",
      "-1",
      "--format=%H",
      `-S${entry}`,
      owner,
      "--",
      file
    ).trim();
  } catch {
    return false;
  }
  if (!introducing) return false;
  try {
    git("merge-base", "--is-ancestor", introducing, other);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * THE COMPARISON
 * ------------------------------------------------------------------ */

export function compareMerge({ merged, parents, cwd = CWD }) {
  const rows = [];
  const losses = [];
  const [a, b] = parents;

  for (const list of LISTS) {
    const A = setAt(list, a);
    const B = setAt(list, b);
    const M = setAt(list, merged);
    if (A.size === 0 && B.size === 0 && M.size === 0) {
      throw new Refusal(
        `${list.file} yielded ZERO entries in all three trees. Either the file moved or the ` +
          `extractor stopped matching it; both mean this list was not compared.`
      );
    }
    const union = new Set([...A, ...B]);
    const overlap = new Set([...A].filter((x) => B.has(x)));
    const missing = [...union].filter((x) => !M.has(x));

    for (const entry of missing) {
      const owner = A.has(entry) ? a : b;
      const other = owner === a ? b : a;
      // Deliberate iff the parent that lacks it had SEEN it. Otherwise it never knew.
      const deliberate =
        !A.has(entry) || !B.has(entry)
          ? sawIt(entry, owner, other, list.file)
          : false;
      if (!deliberate)
        losses.push({ list: list.file, entry, owner, what: list.what });
    }
    rows.push({
      file: list.file,
      a: A.size,
      b: B.size,
      overlap: overlap.size,
      union: union.size,
      merged: M.size,
      lost: missing.length,
    });
  }
  return { rows, losses };
}

/** Two parents of a merge commit, or a refusal that says why there is nothing to judge. */
export function parentsOf(ref, cwd = CWD) {
  let line;
  try {
    line = git("rev-list", "--parents", "-n", "1", ref).trim();
  } catch (e) {
    throw new Refusal(`cannot resolve "${ref}" — ${e.message.split("\n")[0]}`);
  }
  const [sha, ...ps] = line.split(/\s+/);
  if (ps.length < 2) {
    throw new Refusal(
      `${ref} (${sha.slice(0, 9)}) has ${
        ps.length
      } parent(s), so it is not a merge and there ` +
        `is no pair of trees to compare. This check is about what a MERGE kept; on a tree that ` +
        `is not one it has no subject, and reporting "nothing lost" would be a verdict over ` +
        `no comparison.`
    );
  }
  return [sha, ps.slice(0, 2)];
}

function main() {
  const explicit = arg("parents", null);
  let merged, parents;
  try {
    if (explicit) {
      parents = explicit
        .split(",")
        .map((s) => git("rev-parse", s.trim()).trim());
      merged = git("rev-parse", arg("merged", "HEAD")).trim();
      if (parents.length !== 2)
        throw new Refusal("--parents needs exactly two refs");
    } else {
      [merged, parents] = parentsOf(arg("merged", "HEAD"));
    }
    const { rows, losses } = compareMerge({ merged, parents });

    console.log(
      `merge ${merged.slice(0, 9)} of ${parents[0].slice(
        0,
        9
      )} + ${parents[1].slice(0, 9)}\n`
    );
    console.log(
      `  ${"list".padEnd(42)} ${"A".padStart(4)} ${"B".padStart(
        4
      )} ${"A∩B".padStart(4)} ` + `${"A∪B".padStart(4)} ${"merged".padStart(6)}`
    );
    for (const r of rows) {
      // THE SIGNATURE, NAMED IN THE OUTPUT: merged equal to a parent while the union is bigger.
      const flag =
        r.merged < r.union
          ? r.merged === r.a || r.merged === r.b
            ? "  <-- merged == one parent, union is larger"
            : "  <-- short of the union"
          : "";
      console.log(
        `  ${r.file.padEnd(42)} ${String(r.a).padStart(4)} ${String(
          r.b
        ).padStart(4)} ` +
          `${String(r.overlap).padStart(4)} ${String(r.union).padStart(4)} ` +
          `${String(r.merged).padStart(6)}${flag}`
      );
    }

    if (losses.length === 0) {
      console.log(
        `\nOK — ${rows.length} registration list(s) compared across three trees; the merge ` +
          `keeps every entry\n     either parent had. Entries a parent had SEEN and removed are ` +
          `deliberate and not counted.`
      );
      return;
    }
    console.error(
      `\nFAIL: ${losses.length} registration(s) lost in the merge:\n`
    );
    for (const l of losses) {
      console.error(`  ${l.list}  "${l.entry}"`);
      console.error(
        `      present in ${l.owner.slice(
          0,
          9
        )}, absent from the merge, and the`
      );
      console.error(
        `      other parent never saw it — so this is a resolution that dropped a`
      );
      console.error(`      line, not a decision to remove one.`);
      console.error(`      ${l.what}\n`);
    }
    console.error(
      `      Resolve by UNION and verify by set difference against BOTH parents. Taking\n` +
        `      either side wholesale is what produces this, and the merged file reads fine.`
    );
    process.exit(1);
  } catch (e) {
    if (e instanceof Refusal) {
      console.error(`REFUSING TO REPORT: ${e.message}`);
      console.error(
        `      Exit 2, not 0 — no comparison was made, which is a different answer from\n` +
          `      "the merge lost nothing".`
      );
      process.exit(2);
    }
    throw e;
  }
}

const isMain = invokedAsProgram(import.meta.url);
if (isMain) main();
