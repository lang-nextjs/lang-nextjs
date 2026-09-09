#!/usr/bin/env node
/**
 * PROOF for reader-token-still-applies.mjs (#962).
 *
 * The arms that matter are the two guards, because both were written from a wrong answer somebody
 * published tonight: a base taken from an unrelated comparison, and an "AGREE" printed from two
 * empty sets after a shell slip. Neither is hypothetical and neither announces itself.
 */
import {
  Refusal,
  contributionKeys,
  only,
  compare,
  contributionOf,
  filesFromDiff,
} from "./reader-token-still-applies.mjs";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

/** The gate keys on a NUL; built rather than typed. */
const NUL = String.fromCharCode(0);

let pass = 0,
  fail = 0;
const t = (name, ok, detail = "") => {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.error(`  WRONG ${name}${detail ? `\n        ${detail}` : ""}`);
  }
};

const DIFF = [
  "diff --git a/a.txt b/a.txt",
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -1,2 +1,2 @@",
  "-old line",
  "+new line",
  " context stays",
  "diff --git a/b.txt b/b.txt",
  "--- a/b.txt",
  "+++ b/b.txt",
  "@@ -0,0 +1 @@",
  "+only added",
].join("\n");

/* ---- key extraction --------------------------------------------------------------------- */
{
  const { adds, rems } = contributionKeys(DIFF);
  t("additions and removals are separated", adds.size === 2 && rems.size === 1);
  t(
    "keys carry the FILE, so the same text in two files is two keys",
    adds.has("a.txt" + NUL + "new line") &&
      adds.has("b.txt" + NUL + "only added")
  );
  t(
    "context lines are not keys — they are why patch-id moves and this does not",
    ![...adds, ...rems].some((k) => k.endsWith("context stays"))
  );
  t(
    "the +++/--- headers are not read as content",
    ![...adds, ...rems].some(
      (k) => k.includes("a/a.txt") || k.includes("b/a.txt")
    )
  );
}
/*
 * REAL GIT OUTPUT, INCLUDING THE `diff --git` HEADER. The first drafts of these two used bare
 * `+++ b/x` lines, which the old parser accepted because it keyed off exactly that — so the
 * fixtures were shaped by the implementation rather than by git, and could not have caught the
 * deletion defect. Anything git emits carries the header.
 */
const oneFile = (f, ...body) =>
  [
    `diff --git a/${f} b/${f}`,
    `--- a/${f}`,
    `+++ b/${f}`,
    "@@ -0,0 +1 @@",
    ...body,
  ].join("\n");

t(
  "identical text in DIFFERENT files does not collapse",
  contributionKeys([oneFile("x", "+same"), oneFile("y", "+same")].join("\n"))
    .adds.size === 2
);
t(
  "identical text in the SAME file DOES collapse — a Set, which is the gate's own criterion",
  contributionKeys(oneFile("x", "+same", "+same")).adds.size === 1
);

/* ---- the comparison --------------------------------------------------------------------- */
{
  const a = {
    adds: new Set(["f" + NUL + "1"]),
    rems: new Set(["f" + NUL + "2"]),
  };
  const b = {
    adds: new Set(["f" + NUL + "1"]),
    rems: new Set(["f" + NUL + "2"]),
  };
  const r = compare(a, b);
  t(
    "identical contributions report identical on both halves",
    r.additionsIdentical && r.removalsIdentical
  );
}
{
  const a = {
    adds: new Set(["f" + NUL + "1"]),
    rems: new Set(["f" + NUL + "old"]),
  };
  const b = { adds: new Set(["f" + NUL + "1"]), rems: new Set([]) };
  const r = compare(a, b);
  t(
    "ADDITIONS IDENTICAL WHILE REMOVALS DIFFER — #962's actual measured case, ten times over",
    r.additionsIdentical && !r.removalsIdentical
  );
  t(
    "and it names which side the difference is on",
    r.remsOnlyRead.length === 1 && r.remsOnlyHead.length === 0
  );
}
/*
 * THE ADDITIONS HALF WAS ASSERTED AND NEVER TESTED. Every arm above expects
 * `additionsIdentical` to be TRUE, so hardcoding it to `true` broke nothing -- measured by
 * mutation, not supposed. The PASS banner has claimed since #962 that additions and removals are
 * compared SEPARATELY, and the removals half was the only one a wrong answer could reach.
 *
 * Each of these fails under a DIFFERENT mutation, which is what makes them three arms rather than
 * one written three ways: dropping `addsOnlyHead` from the additions half breaks only the first,
 * dropping `remsOnlyHead` from the removals half breaks only the third, and replacing the whole
 * additions half with `true` breaks the first two.
 */
{
  const r = compare(
    { adds: new Set(["f" + NUL + "1"]), rems: new Set() },
    { adds: new Set(["f" + NUL + "1", "f" + NUL + "2"]), rems: new Set() }
  );
  t(
    "THE HEAD GAINED AN ADDITION SINCE THE READ - the case this tool exists to catch, and the one no arm reached",
    !r.additionsIdentical &&
      r.addsOnlyHead.length === 1 &&
      r.addsOnlyRead.length === 0
  );
}
{
  const r = compare(
    { adds: new Set(["f" + NUL + "1", "f" + NUL + "2"]), rems: new Set() },
    { adds: new Set(["f" + NUL + "1"]), rems: new Set() }
  );
  t(
    "an addition PRESENT at the read and WITHDRAWN since - the direction a one-sided compare reports as identical",
    !r.additionsIdentical &&
      r.addsOnlyRead.length === 1 &&
      r.addsOnlyHead.length === 0
  );
}
{
  const r = compare(
    { adds: new Set(), rems: new Set() },
    { adds: new Set(), rems: new Set(["f" + NUL + "x"]) }
  );
  t(
    "a removal the HEAD gained - the removals half is asymmetric in this direction too, which the arm above does not cover",
    !r.removalsIdentical &&
      r.remsOnlyHead.length === 1 &&
      r.remsOnlyRead.length === 0
  );
}

t(
  "only() is asymmetric, so 'gained' and 'lost' are distinguishable",
  only(new Set(["a"]), new Set([])).length === 1 &&
    only(new Set([]), new Set(["a"])).length === 0
);

/* ---- the two guards, each written from a wrong answer published tonight ------------------ */
{
  const io = {
    git: (a) => {
      if (a[0] === "merge-base" && a[1] === "--is-ancestor")
        throw new Error("not an ancestor");
      if (a[0] === "merge-base") return "beefbeefbeefbeef\n";
      return "";
    },
  };
  let msg = "";
  try {
    contributionOf("cafecafecafecafe", "origin/main", io);
  } catch (e) {
    msg = e instanceof Refusal ? e.message : `WRONG TYPE: ${e}`;
  }
  t(
    "A BASE THAT IS NOT AN ANCESTOR REFUSES — two published tables carried a base from an " +
      "unrelated comparison tonight",
    /is not an ancestor/.test(msg),
    msg
  );
}
{
  const io = {
    git: (a) =>
      a[0] === "merge-base" && a[1] !== "--is-ancestor" ? "beef\n" : "",
  };
  let msg = "";
  try {
    contributionOf("cafe", "origin/main", io);
  } catch (e) {
    msg = e instanceof Refusal ? e.message : `WRONG TYPE: ${e}`;
  }
  t(
    "AN EMPTY CONTRIBUTION REFUSES — an empty set compares equal to any other empty set, and a " +
      "re-derivation printed AGREE from two of them tonight",
    /contributes NOTHING/.test(msg),
    msg
  );
}
{
  const io = {
    git: (a) => {
      if (a[0] === "merge-base" && a[1] === "--is-ancestor") return "";
      if (a[0] === "merge-base") return "beef\n";
      return DIFF;
    },
  };
  const c = contributionOf("cafe", "origin/main", io);
  t(
    "PAIRED CONTROL: a real contribution with a real ancestor base does NOT refuse",
    c.adds.size === 2 && c.rems.size === 1
  );
}

/* ---- the separator ----------------------------------------------------------------------- */
/*
 * THE OLD ARM HERE WAS TAUTOLOGICAL ONCE THE MODULE STOPPED OWNING THE SEPARATOR. It asserted
 * that this file's own NUL constant has char code 0 — true by construction, and silent about the
 * subject. The gate owns the separator now, and the arms above exercise it through real keys,
 * which is the only way it matters.
 */
t(
  "the gate's keys really do separate on a NUL, exercised rather than asserted",
  [...contributionKeys(DIFF).adds][0].includes(NUL)
);

/* ---- deletions, which the first version got wrong and no arm could see -------------------- */

const del = (f) =>
  [
    `diff --git a/${f} b/${f}`,
    "deleted file mode 100644",
    `--- a/${f}`,
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-gone",
  ].join("\n");

t(
  "a DELETED file's removals are keyed to the DELETED file's own name",
  [...contributionKeys(del("zdoomed.txt")).rems][0] ===
    "zdoomed.txt" + NUL + "gone",
  JSON.stringify([...contributionKeys(del("zdoomed.txt")).rems])
);

t(
  "A DELETION SORTING FIRST IS NOT DROPPED — git emits `+++ /dev/null`, which the first version " +
    "matched against `+++ b/(.*)` and silently skipped",
  contributionKeys(del("aaa.txt")).rems.size === 1
);

t(
  "and a deletion AFTER another file is not attributed to that file's name",
  (() => {
    const both = [
      "diff --git a/akeep.txt b/akeep.txt",
      "--- a/akeep.txt",
      "+++ b/akeep.txt",
      "@@ -1 +1 @@",
      "-was",
      "+is",
      del("zdoomed.txt"),
    ].join("\n");
    const { rems } = contributionKeys(both);
    return (
      rems.has("zdoomed.txt" + NUL + "gone") &&
      !rems.has("akeep.txt" + NUL + "gone")
    );
  })()
);

t(
  "DEV1'S CONSTRUCTION: two heads deleting DIFFERENT files are NOT identical — a false identical " +
    "invites a reader to sign for a head the gate considers different",
  !compare(contributionKeys(del("aaa.txt")), contributionKeys(del("aab.txt")))
    .removalsIdentical
);

t(
  "PAIRED CONTROL: two heads deleting the SAME file ARE identical, so the arm above is not " +
    "satisfied by a comparison that never agrees",
  compare(contributionKeys(del("aaa.txt")), contributionKeys(del("aaa.txt")))
    .removalsIdentical
);

t(
  "a NEW file's additions are keyed to it — the `--- /dev/null` side, the other direction",
  (() => {
    const add = [
      "diff --git a/n.txt b/n.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/n.txt",
      "@@ -0,0 +1 @@",
      "+fresh",
    ].join("\n");
    return contributionKeys(add).adds.has("n.txt" + NUL + "fresh");
  })()
);

t(
  "and a diff the GATE would refuse is refused here rather than answered — reporting a " +
    "comparison it would not make is the third opinion this exists to avoid",
  (() => {
    const many = Array.from({ length: 300 }, (_, i) =>
      [
        `diff --git a/f${i}.txt b/f${i}.txt`,
        `--- a/f${i}.txt`,
        `+++ b/f${i}.txt`,
        "@@ -1 +1 @@",
        "-a",
        "+b",
      ].join("\n")
    ).join("\n");
    try {
      contributionKeys(many);
      return false;
    } catch (e) {
      return (
        e instanceof Refusal && /contribution\(\) cannot read/.test(e.message)
      );
    }
  })()
);

/*
 * PARSED, NOT MATCHED — AND THE REGEX VERSION OF THIS ARM WAS VACUOUS TWICE OVER.
 *
 * The first version asserted `f(x) === f(x)`. The second matched the module's SOURCE TEXT for
 * `contribution(` and for NUL-joining, and DEV1 drove a copy past it that scores 26/26:
 *
 *     keep the import, never CALL contribution(), build keys locally with an escaped-NUL
 *     template literal, and reproduce the gate's null-return path so the refusal arm is
 *     satisfied too
 *
 * A text arm hunting `contribution(` finds it at :34 and :53 — in the COMMENTS. **The
 * documentation satisfies the check the code was supposed to satisfy**, and this repository runs
 * a quarter to a third commentary, so that is the normal case rather than an unlucky one.
 *
 * `ts.createSourceFile` is immune to prose by construction. It is imported DYNAMICALLY and the
 * arm REFUSES rather than failing when typescript is absent, which is the pattern the other
 * compiler-API checkers here use: a static import is resolved before any of this file runs, so
 * an uninstalled tree would report a defect in the repository instead of an unusable instrument.
 *
 * NOT regex comment-stripping instead: this repo has already had one eat a valid glob — `/*`
 * inside a path pattern opened a comment and swallowed valid JSON, silently.
 */
{
  let ts = null;
  try {
    ts = (await import("typescript")).default;
  } catch {
    ts = null;
  }
  const srcPath = new URL("./reader-token-still-applies.mjs", import.meta.url);
  const text = readFileSync(srcPath, "utf8");

  if (ts === null) {
    t(
      "REFUSING rather than asserting: typescript is not installed, so the structural arm " +
        "cannot run — an absent instrument is not a passing one",
      false,
      "install dependencies and re-run; this arm is the only check on where the keys come from"
    );
  } else {
    const sf = ts.createSourceFile("m.mjs", text, ts.ScriptTarget.Latest, true);
    const GATE = "./assert-armed-prs-are-covered-by-a-review.mjs";

    let importsContribution = false;
    let callsContribution = false;
    const walk = (n) => {
      if (ts.isImportDeclaration(n) && n.moduleSpecifier.text === GATE) {
        const b = n.importClause?.namedBindings;
        if (b && ts.isNamedImports(b))
          for (const e of b.elements)
            if ((e.propertyName ?? e.name).text === "contribution")
              importsContribution = true;
      }
      if (
        ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        n.expression.text === "contribution"
      )
        callsContribution = true;
      ts.forEachChild(n, walk);
    };
    walk(sf);

    t(
      "PARSED: `contribution` is IMPORTED from the gate — an ImportDeclaration, not a string in " +
        "a comment",
      importsContribution
    );
    t(
      "PARSED: and it is CALLED — a CallExpression on that identifier. DEV1's drift keeps the " +
        "import and never calls it, which a text arm cannot see and this one can",
      callsContribution
    );
  }
}

/* ---- press 3: a fixture CAPTURED from git, not composed from my idea of git ---------------- */

/*
 * THE /dev/null DEFECT SURVIVED BECAUSE FIXTURE AND PARSER CAME FROM ONE WRONG IDEA OF THE
 * FORMAT. Composed strings agree with the implementation by construction; only output the real
 * producer emitted can disagree. My scratch-repo check settled the question and left no arm
 * behind, so the format stayed an unpinned premise — this converts it into one that outlives me.
 */
{
  const dir = mkdtempSync(join(tmpdir(), "rtsa-git-"));
  const g = (...a) =>
    execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
  g("init", "-q", ".");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  writeFileSync(join(dir, "doomed.txt"), "gone\n");
  writeFileSync(join(dir, "keep.txt"), "keep\n");
  g("add", "-A");
  g("commit", "-qm", "one");
  g("rm", "-q", "doomed.txt");
  g("commit", "-qm", "two");
  const realDeletion = g("diff", "HEAD~1", "HEAD");

  t(
    "CAPTURED FROM GIT: a real `git rm` diff keys its removal to the deleted file",
    contributionKeys(realDeletion).rems.has("doomed.txt" + NUL + "gone"),
    realDeletion
  );
  t(
    "and the real deletion header carries the SAME path on both sides, which is why no " +
      "/dev/null fallback is needed — driven, not reasoned",
    /^diff --git a\/doomed\.txt b\/doomed\.txt$/m.test(realDeletion),
    realDeletion
  );

  g("mv", "keep.txt", "renamed.txt");
  g("commit", "-qm", "three");
  const realRename = g("diff", "HEAD~1", "HEAD");
  t(
    "and a real rename puts the NEW name on the b/ side, which is what the compare endpoint " +
      "reports as `filename` too",
    /^diff --git a\/keep\.txt b\/renamed\.txt$/m.test(realRename),
    realRename
  );
  rmSync(dir, { recursive: true, force: true });
}

/*
 * THE VERDICT COMES FROM AN EXIT HOOK, AND NOTHING CALLS `process.exit` (#1122). Written the
 * ordinary way the banner prints HERE, so an arm appended below it still RUNS but is not counted --
 * the tally is already out. That is the `uncounted` half of the class rather than the `inert` half,
 * and it is the harder one to notice because the arm executes. Changed by DEV3 while bringing
 * #1145's ratchet up onto main, which flagged this file the moment #1120 landed; the file is DEV2's
 * and the edit is mechanical, so say if you would rather own it.
 *
 * NOTE THAT THIS GIVES `counted` AND NOT `declared` -- an arm appended here now runs and is tallied
 * and still passes silently, because there is no EXPECTED to disagree with. That gap is #1173 and
 * is deliberately not closed here: a derived count is a real change to a proof, not a mechanical one.
 */
process.exitCode = 0;
process.on("exit", () => {
  const total = pass + fail;
  if (fail !== 0) {
    console.error(`\nFAIL: ${fail}/${total} cases wrong.`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `\nPASS: ${pass}/${total}. Additions and removals are compared SEPARATELY, because #962 measured\n` +
      `      ten recreates in which every difference was a removal the BASE had made redundant while\n` +
      `      the pull requests had not moved — one combined number would have called those changed.\n` +
      `      Both guards refuse rather than report: a base that is not an ancestor of its sha, and a\n` +
      `      contribution that is empty, which compares equal to every other empty one.`
  );
});
