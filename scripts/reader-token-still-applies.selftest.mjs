#!/usr/bin/env node
/**
 * PROOF for reader-token-still-applies.mjs (#962).
 *
 * The arms that matter are the two guards, because both were written from a wrong answer somebody
 * published tonight: a base taken from an unrelated comparison, and an "AGREE" printed from two
 * empty sets after a shell slip. Neither is hypothetical and neither announces itself.
 */
import {
  SEP,
  Refusal,
  contributionKeys,
  only,
  compare,
  contributionOf,
} from "./reader-token-still-applies.mjs";

let pass = 0, fail = 0;
const t = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.error(`  WRONG ${name}${detail ? `\n        ${detail}` : ""}`); }
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
  t("keys carry the FILE, so the same text in two files is two keys",
    adds.has("a.txt" + SEP + "new line") && adds.has("b.txt" + SEP + "only added"));
  t("context lines are not keys — they are why patch-id moves and this does not",
    ![...adds, ...rems].some((k) => k.endsWith("context stays")));
  t("the +++/--- headers are not read as content",
    ![...adds, ...rems].some((k) => k.includes("a/a.txt") || k.includes("b/a.txt")));
}
t("identical text in DIFFERENT files does not collapse",
  contributionKeys(["+++ b/x", "+same", "+++ b/y", "+same"].join("\n")).adds.size === 2);
t("identical text in the SAME file DOES collapse — a Set, which is the gate's own criterion",
  contributionKeys(["+++ b/x", "+same", "+same"].join("\n")).adds.size === 1);

/* ---- the comparison --------------------------------------------------------------------- */
{
  const a = { adds: new Set(["f" + SEP + "1"]), rems: new Set(["f" + SEP + "2"]) };
  const b = { adds: new Set(["f" + SEP + "1"]), rems: new Set(["f" + SEP + "2"]) };
  const r = compare(a, b);
  t("identical contributions report identical on both halves",
    r.additionsIdentical && r.removalsIdentical);
}
{
  const a = { adds: new Set(["f" + SEP + "1"]), rems: new Set(["f" + SEP + "old"]) };
  const b = { adds: new Set(["f" + SEP + "1"]), rems: new Set([]) };
  const r = compare(a, b);
  t("ADDITIONS IDENTICAL WHILE REMOVALS DIFFER — #962's actual measured case, ten times over",
    r.additionsIdentical && !r.removalsIdentical);
  t("and it names which side the difference is on",
    r.remsOnlyRead.length === 1 && r.remsOnlyHead.length === 0);
}
t("only() is asymmetric, so 'gained' and 'lost' are distinguishable",
  only(new Set(["a"]), new Set([])).length === 1 && only(new Set([]), new Set(["a"])).length === 0);

/* ---- the two guards, each written from a wrong answer published tonight ------------------ */
{
  const io = { git: (a) => {
    if (a[0] === "merge-base" && a[1] === "--is-ancestor") throw new Error("not an ancestor");
    if (a[0] === "merge-base") return "beefbeefbeefbeef\n";
    return "";
  } };
  let msg = "";
  try { contributionOf("cafecafecafecafe", "origin/main", io); } catch (e) { msg = e instanceof Refusal ? e.message : `WRONG TYPE: ${e}`; }
  t("A BASE THAT IS NOT AN ANCESTOR REFUSES — two published tables carried a base from an " +
    "unrelated comparison tonight", /is not an ancestor/.test(msg), msg);
}
{
  const io = { git: (a) => (a[0] === "merge-base" && a[1] !== "--is-ancestor" ? "beef\n" : "") };
  let msg = "";
  try { contributionOf("cafe", "origin/main", io); } catch (e) { msg = e instanceof Refusal ? e.message : `WRONG TYPE: ${e}`; }
  t("AN EMPTY CONTRIBUTION REFUSES — an empty set compares equal to any other empty set, and a " +
    "re-derivation printed AGREE from two of them tonight", /contributes NOTHING/.test(msg), msg);
}
{
  const io = { git: (a) => {
    if (a[0] === "merge-base" && a[1] === "--is-ancestor") return "";
    if (a[0] === "merge-base") return "beef\n";
    return DIFF;
  } };
  const c = contributionOf("cafe", "origin/main", io);
  t("PAIRED CONTROL: a real contribution with a real ancestor base does NOT refuse",
    c.adds.size === 2 && c.rems.size === 1);
}

/* ---- the separator ----------------------------------------------------------------------- */
t("the separator is a NUL, built rather than typed — a literal one in source is invisible",
  SEP.charCodeAt(0) === 0 && SEP.length === 1);

const total = pass + fail;
if (fail !== 0) { console.error(`\nFAIL: ${fail}/${total} cases wrong.`); process.exit(1); }
console.log(
  `\nPASS: ${pass}/${total}. Additions and removals are compared SEPARATELY, because #962 measured\n` +
    `      ten recreates in which every difference was a removal the BASE had made redundant while\n` +
    `      the pull requests had not moved — one combined number would have called those changed.\n` +
    `      Both guards refuse rather than report: a base that is not an ancestor of its sha, and a\n` +
    `      contribution that is empty, which compares equal to every other empty one.`
);
