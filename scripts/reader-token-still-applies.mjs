#!/usr/bin/env node
/**
 * DOES THE REVIEW I ALREADY DID STILL APPLY TO THIS HEAD? (#962)
 *
 * A reader token names a sha. Every branch update moves the sha, so every token dies — and
 * measured on this board, not one of those deaths was because a review had become less true.
 * One reader signed FIVE ranges on one pull request in an evening, every one covering the same
 * contribution, each re-signature caused by a sha moving.
 *
 * THIS AUTOMATES THE ARITHMETIC AND NOT THE CONCLUSION. It prints what changed between two heads
 * and refuses to say whether that matters. "This update changed nothing substantive" is a
 * judgement a reader makes and signs; a tool that concluded it would be issuing signatures on
 * someone's behalf, and the whole value of a token is that a person stands behind it.
 *
 * WHY NOT patch-id, WHICH IS THE OBVIOUS INSTRUMENT AND THE WRONG ONE. `patch-id --stable` is
 * invariant to line NUMBERS and HASHES CONTEXT LINES, so a merge-base advance across the same
 * file moves the digest while the contribution is unchanged. Measured on #1086: `--stat` said
 * identical (234/30 both sides), `patch-id` said DIFFERS, and the line sets said 264 lines each
 * with exactly ONE pair moved. The asymmetry, verified independently:
 *
 *     patch-id IDENTICAL -> contribution identical           SUFFICIENT
 *     patch-id DIFFERS   -> contribution MAY be unchanged     NOT NECESSARY
 *
 * A tool built on it tells a reader to re-read when they need not, which is the direction that
 * wastes the reads this exists to save.
 *
 * ADDITIONS AND REMOVALS ARE REPORTED SEPARATELY BECAUSE THEY MEAN DIFFERENT THINGS. #962's own
 * measurement, ten observations over five branches and two recreates: contributed ADDED lines
 * changed zero times, every difference was in REMOVALS, and every removal difference was a
 * property of the BASE — main dropped an orphan entry, so the branches stopped removing it.
 * Reporting one number would call that "changed" when the pull request did not move.
 *
 * THE KEYS ARE THE GATE'S KEYS: filename, then a NUL, then the line — the same shape
 * assert-armed-prs-are-covered-by-a-review.mjs builds in `contribution()`, so a reader signing on
 * this answer is signing on the quantity the gate compares. A tool with its own notion of "the
 * contribution" would let a reader be right and the gate disagree.
 *
 * Usage:
 *   node scripts/reader-token-still-applies.mjs --read <sha> [--head <sha>] [--base <ref>]
 */
import { execFileSync } from "node:child_process";
import {
  contribution,
  unreadableReason,
} from "./assert-armed-prs-are-covered-by-a-review.mjs";

export class Refusal extends Error {}

const git = (args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 });

/**
 * Git's diff, in the shape the COMPARE ENDPOINT returns — so the gate's own `contribution()` can
 * key it. This mirrors nothing: the keys are built by the gate's code, in the gate's file.
 *
 * A MIRROR THAT REIMPLEMENTS ITS ORIGINAL DRIFTS THE MOMENT EITHER CHANGES, and mine did before
 * it ever shipped. The first version took the filename from the `+++ b/...` line, which git emits
 * as `+++ /dev/null` for a DELETION — so a deleted file's removals were dropped, or attributed to
 * whichever filename came before it. DEV1 constructed the consequence: one head deletes aaa.txt,
 * the other deletes aab.txt, both produce an EMPTY removal set, and the tool reports IDENTICAL
 * while the gate reports DIFFER. A FALSE IDENTICAL INVITES A READER TO SIGN FOR A HEAD THE GATE
 * CONSIDERS DIFFERENT, which is worse than having no tool at all — the third-opinion failure this
 * file's own docstring warns about, committed by the file itself.
 *
 * THE FILENAME COMES FROM THE `diff --git` HEADER, taking the b/ side unconditionally. There is
 * no /dev/null fallback and there should not be: git emits `diff --git a/f b/f` for a deletion,
 * with BOTH paths the same, so the b/ side is already the deleted file's name. Only a RENAME
 * makes them differ, and there b/ is the NEW name — which is what the compare endpoint reports
 * as `filename` too. Driven in a scratch repo, and an earlier draft's fallback was removed as
 * dead code once mutation showed no arm could reach it.
 */
export function filesFromDiff(diffText) {
  const files = [];
  let current = null;
  for (const line of diffText.split("\n")) {
    const h = /^diff --git a\/(.*?) b\/(.*)$/.exec(line);
    if (h) {
      current = { filename: h[2], patchLines: [], inPatch: false };
      files.push(current);
      continue;
    }
    if (!current) continue;
    /*
     * NO /dev/null FALLBACK, AND THE REASON IS MEASURED. My first repair also mapped a
     * `+++ /dev/null` line back to the a/ path, and mutation showed no arm could pin it —
     * because git emits `diff --git a/doomed.txt b/doomed.txt` for a deletion, with BOTH paths
     * the same, so the b/ side is already the deleted file's name. Driven in a scratch repo
     * rather than reasoned: a `git rm` produces identical a/ and b/ paths; only a RENAME makes
     * them differ, and there the b/ side is the new name, which is what the compare endpoint
     * reports as `filename` too. The dead branch is gone; parsing the header is the whole fix.
     */
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    if (line.startsWith("@@")) {
      current.inPatch = true;
      current.patchLines.push(line);
      continue;
    }
    if (current.inPatch) current.patchLines.push(line);
  }
  return files.map((f) => ({
    filename: f.filename,
    patch: f.patchLines.join("\n"),
  }));
}

/**
 * The gate's keys, built by the gate. `contribution` returns null exactly where
 * `unreadableReason` gives one, so a null is reported WITH that reason rather than as an answer.
 */
export function contributionKeys(diffText) {
  const files = filesFromDiff(diffText);
  const c = contribution(files);
  if (c === null)
    throw new Refusal(
      `the gate's own contribution() cannot read this diff: ${unreadableReason(
        files
      )}. ` +
        `Reporting a comparison the gate would refuse is a third opinion, which is the failure ` +
        `this tool exists to avoid`
    );
  return c;
}

export function only(a, b) {
  return [...a].filter((x) => !b.has(x));
}

/**
 * The contribution of `sha` against `baseRef`, with both guards that cost someone a wrong answer
 * tonight: the base must be an ANCESTOR of the sha, and neither set may be empty.
 */
export function contributionOf(sha, baseRef, io = { git }) {
  const base = io.git(["merge-base", sha, baseRef]).trim();
  if (!base) throw new Refusal(`no merge-base between ${sha} and ${baseRef}`);
  try {
    io.git(["merge-base", "--is-ancestor", base, sha]);
  } catch {
    throw new Refusal(
      `${base.slice(0, 12)} is not an ancestor of ${sha.slice(
        0,
        12
      )} — the base belongs to a ` +
        `different comparison, and two published tables tonight carried exactly that mistake`
    );
  }
  const { adds, rems } = contributionKeys(io.git(["diff", base, sha]));
  if (adds.size === 0 && rems.size === 0)
    throw new Refusal(
      `${sha.slice(0, 12)} contributes NOTHING against ${base.slice(
        0,
        12
      )} — an empty set ` +
        `compares equal to any other empty set, so this would report agreement while measuring ` +
        `nothing. A re-derivation printed "AGREE" from two empty sets tonight after a shell slip`
    );
  return { base, adds, rems };
}

export function compare(readC, headC) {
  const addsOnlyRead = only(readC.adds, headC.adds);
  const addsOnlyHead = only(headC.adds, readC.adds);
  const remsOnlyRead = only(readC.rems, headC.rems);
  const remsOnlyHead = only(headC.rems, readC.rems);
  return {
    additionsIdentical: addsOnlyRead.length === 0 && addsOnlyHead.length === 0,
    removalsIdentical: remsOnlyRead.length === 0 && remsOnlyHead.length === 0,
    addsOnlyRead,
    addsOnlyHead,
    remsOnlyRead,
    remsOnlyHead,
  };
}

/** The gate keys on a NUL; built rather than typed, because a literal one travels badly. */
const NUL = String.fromCharCode(0);

const show = (keys, label) => {
  if (!keys.length) return "";
  const lines = keys.slice(0, 8).map((k) => {
    const i = k.indexOf(NUL);
    return `      ${k.slice(0, i)}: ${k.slice(i + 1).slice(0, 88)}`;
  });
  const more = keys.length > 8 ? `\n      … and ${keys.length - 8} more` : "";
  return `\n    ${label} (${keys.length}):\n${lines.join("\n")}${more}`;
};

function main(argv) {
  const arg = (n) => {
    const i = argv.indexOf(n);
    return i === -1 ? null : argv[i + 1];
  };
  const read = arg("--read");
  if (!read)
    throw new Refusal(
      "--read <sha> is required: the sha your existing token names"
    );
  const baseRef = arg("--base") ?? "origin/main";
  const head = arg("--head") ?? git(["rev-parse", "HEAD"]).trim();

  const headBefore = git(["rev-parse", head]).trim();
  const readC = contributionOf(read, baseRef);
  const headC = contributionOf(head, baseRef);
  const headAfter = git(["rev-parse", head]).trim();
  if (headBefore !== headAfter)
    throw new Refusal(
      `${head} moved while this ran (${headBefore.slice(
        0,
        12
      )} -> ${headAfter.slice(0, 12)}). A ` +
        `re-token is a claim about a head, and reporting on one already superseded hands you a ` +
        `signature for a sha nobody will merge`
    );

  const r = compare(readC, headC);
  console.log(
    `read  ${read.slice(0, 12)}  base ${readC.base.slice(0, 12)}  +${
      readC.adds.size
    } -${readC.rems.size}\n` +
      `head  ${headBefore.slice(0, 12)}  base ${headC.base.slice(0, 12)}  +${
        headC.adds.size
      } -${headC.rems.size}\n`
  );
  console.log(
    `  ADDITIONS  ${r.additionsIdentical ? "identical" : "DIFFER"}` +
      show(r.addsOnlyRead, "only in what you read") +
      show(r.addsOnlyHead, "only at the head")
  );
  console.log(
    `  REMOVALS   ${r.removalsIdentical ? "identical" : "DIFFER"}` +
      show(r.remsOnlyRead, "only in what you read") +
      show(r.remsOnlyHead, "only at the head")
  );

  console.log(
    `\n  ADDITIONS are what this branch CONTRIBUTES; REMOVALS also move when the BASE moves —\n` +
      `  #962 measured ten recreates where every difference was a removal the base had made\n` +
      `  redundant, and the pull requests had not changed at all.\n\n` +
      `  THIS TOOL DOES NOT DECIDE WHETHER YOUR REVIEW STILL APPLIES, and it will not print a\n` +
      `  token. Read the differences above; if they are nothing you would have reviewed\n` +
      `  differently, sign for the new head yourself. If you cannot say that, read them.`
  );
  return 0;
}

const invokedDirectly =
  process.argv[1] && process.argv[1].endsWith("reader-token-still-applies.mjs");
if (invokedDirectly) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    if (e instanceof Refusal) {
      console.error(`REFUSING: ${e.message}`);
      process.exit(2);
    }
    throw e;
  }
}
