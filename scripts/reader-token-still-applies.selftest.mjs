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
import { contribution as gateContribution } from "./assert-armed-prs-are-covered-by-a-review.mjs";

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

/* ---- the anti-drift arm: the keys ARE the gate's, not a copy of them ---------------------- */

t(
  "THE KEYS COME FROM THE GATE'S OWN contribution(), not a mirror of it — build both from the " +
    "same files and they are identical by construction, so the two cannot drift",
  (() => {
    const files = filesFromDiff(del("zdoomed.txt"));
    const mine = contributionKeys(del("zdoomed.txt"));
    const theirs = gateContribution(files);
    return (
      theirs !== null &&
      [...mine.rems].join("|") === [...theirs.rems].join("|") &&
      [...mine.adds].join("|") === [...theirs.adds].join("|")
    );
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

const total = pass + fail;
if (fail !== 0) {
  console.error(`\nFAIL: ${fail}/${total} cases wrong.`);
  process.exit(1);
}
console.log(
  `\nPASS: ${pass}/${total}. Additions and removals are compared SEPARATELY, because #962 measured\n` +
    `      ten recreates in which every difference was a removal the BASE had made redundant while\n` +
    `      the pull requests had not moved — one combined number would have called those changed.\n` +
    `      Both guards refuse rather than report: a base that is not an ancestor of its sha, and a\n` +
    `      contribution that is empty, which compares equal to every other empty one.`
);
