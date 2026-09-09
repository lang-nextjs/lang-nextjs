#!/usr/bin/env node
/**
 * measure-on-the-merge.mjs — answer a question about the POST-MERGE tree, on the post-merge
 * tree (#922).
 *
 * A review asserts a property of the tree after a pull request lands and derives it from the
 * pull request's diff against its own merge-base. That base goes stale within the hour on this
 * board, and the resulting measurement is INTERNALLY CONSISTENT while being wrong -- #804
 * asserted a pull request CREATED a dual dependency version when main already had one and the
 * pull request CLOSED it. It surfaced only because the reviewer re-read `origin/main` for an
 * unrelated reason.
 *
 * THE OUTPUT IS THE ANSWER, SO THERE IS NOTHING TO REMEMBER. That is the entire point. The rule
 * "re-read origin/main at the moment of writing" is correct, was written down on #804, and did
 * not work: the reviewer who missed it had caught the identical thing an hour earlier on #911.
 * Three agents reproduced that same shape in one night with three different self-authored rules.
 * Nobody forgot; everybody was attending to something else.
 *
 * Usage:
 *   node scripts/measure-on-the-merge.mjs --pr 1165 -- node scripts/assert-formatted.mjs
 *   node scripts/measure-on-the-merge.mjs --head abc123 --base origin/main -- pnpm install --frozen-lockfile
 *   node scripts/measure-on-the-merge.mjs --pr 1165 --no-fetch -- git log --oneline -1
 *
 * EXIT CONVENTION, WHICH IS THE REPOSITORY'S AND IS LOAD-BEARING HERE:
 *
 *   0   the command answered and the property HOLDS
 *   1   the command answered and the property is VIOLATED
 *   2   the question COULD NOT BE ASKED -- a conflicted merge, an unresolvable ref, a shallow
 *       clone, or an inner command that neither passed nor failed cleanly
 *
 * A CONFLICTED MERGE IS A REFUSAL, NOT A FINDING, and collapsing the two is how a green comes to
 * stand for no verification. git blocks a conflicted merge on its own, so nothing lands by this
 * path either way -- but "could not ask" and "the answer is no" are the two states this exists
 * to keep apart.
 *
 * IT NEVER `cd`s. Every subprocess takes `cwd` explicitly. A failed `cd` lands the operation in
 * the SHARED CHECKOUT, which on this machine sits on a feature branch rather than main, and
 * every agent here has measured a feature branch believing it was main. Passing `cwd` makes that
 * failure mode unrepresentable rather than guarded.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { materialiseMerge, describe } from "./lib/merged-tree.mjs";
import { invokedAsProgram } from "./lib/is-main.mjs";

/**
 * Map a finished subprocess to this repository's exit vocabulary. PURE: every fact is passed in,
 * so the proof drives every state without spawning anything.
 *
 * MAPPED, NOT PASSED THROUGH. 0 and 1 mean what they mean and 2 is a refusal that stays one.
 * ANYTHING ELSE -- a crash, a signal, a missing binary, a `git rev-parse` exiting 128 -- is a
 * command that did not answer, which is "could not ask" and NOT "the property is false".
 * Forwarding a 127 unchanged would report a missing executable as a violated property, and that
 * is the single most costly confusion available here: it argues against a change on the strength
 * of a typo in the command.
 */
export function classifyExit({
  status = null,
  signal = null,
  error = null,
} = {}) {
  if (error)
    return {
      exit: 2,
      detail: `could not run the command: ${error.message ?? error}`,
    };
  if (signal)
    return {
      exit: 2,
      detail: `the command was killed by ${signal}; nothing was determined.`,
    };
  if (status === 0)
    return {
      exit: 0,
      detail: "command exited 0 — the property HOLDS on the merged tree.",
    };
  if (status === 1)
    return {
      exit: 1,
      detail: "command exited 1 — the property is VIOLATED on the merged tree.",
    };
  if (status === 2)
    return {
      exit: 2,
      detail: "command exited 2 — the command REFUSED; nothing was determined.",
    };
  return {
    exit: 2,
    detail:
      `the command exited ${status}, which is neither pass (0), violation (1) nor refusal (2). ` +
      "A status outside the convention did not answer the question, so this reports 2 rather " +
      "than guessing which it meant.",
  };
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function usage(msg) {
  console.error(`REFUSING TO REPORT: ${msg}\n`);
  console.error(
    "Usage: node scripts/measure-on-the-merge.mjs (--pr N | --head REF) [--base REF]\n" +
      "                                            [--no-fetch] -- COMMAND [ARGS...]"
  );
  process.exit(2);
}

/*
 * GUARDED SO IMPORTING THIS FILE DOES NOT RUN IT. The proof imports `classifyExit` to
 * drive every exit state directly, and an unguarded module parses argv at import time and
 * exits before a single arm runs -- which is exactly what happened on the first attempt.
 */
function main() {
  const argv = process.argv.slice(2);
  const sep = argv.indexOf("--");
  if (sep === -1) usage("no `--` separator, so there is no command to run.");
  const flags = argv.slice(0, sep);
  const command = argv.slice(sep + 1);
  if (command.length === 0) usage("nothing after `--`.");

  const flag = (name) => {
    const i = flags.indexOf(name);
    return i === -1 ? null : flags[i + 1] ?? null;
  };
  const pr = flag("--pr");
  let head = flag("--head");
  const base = flag("--base") ?? "origin/main";
  const noFetch = flags.includes("--no-fetch");
  if (!pr && !head) usage("one of --pr or --head is required.");
  if (pr && head) usage("--pr and --head are mutually exclusive.");

  /*
   * FETCH BEFORE RESOLVING, because the whole defect is a stale base. `--no-fetch` exists for the
   * proof and for an offline re-run, and it PRINTS that it was used -- a run whose base was never
   * refreshed answers a different question from one whose base was, and the difference must not be
   * invisible in the output.
   */
  if (!noFetch) {
    try {
      execFileSync("git", ["fetch", "--quiet", "origin"], {
        cwd: ROOT,
        stdio: "ignore",
      });
    } catch (e) {
      console.error(
        `REFUSING TO REPORT: could not fetch origin: ${
          String(e).split("\n")[0]
        }\n` +
          "Re-run with --no-fetch to measure against whatever is already local, and say so when " +
          "you paste the result."
      );
      process.exit(2);
    }
  }

  if (pr) {
    if (!/^\d+$/.test(pr))
      usage(`--pr expects a number, got ${JSON.stringify(pr)}.`);
    try {
      head = execFileSync(
        "gh",
        ["pr", "view", pr, "--json", "headRefOid", "-q", ".headRefOid"],
        { cwd: ROOT, encoding: "utf8" }
      ).trim();
    } catch (e) {
      console.error(
        `REFUSING TO REPORT: could not read #${pr}'s head: ${
          String(e).split("\n")[0]
        }`
      );
      process.exit(2);
    }
    if (!/^[0-9a-f]{40}$/.test(head)) {
      console.error(
        `REFUSING TO REPORT: #${pr}'s head did not read as a sha (got ${JSON.stringify(
          head
        )}).`
      );
      process.exit(2);
    }
  }

  const merged = materialiseMerge({
    base,
    head,
    prefix: "measure-merge-",
    cwd: ROOT,
  });
  if (!merged.ok) {
    console.error(`REFUSING TO REPORT (${merged.refusal}): ${merged.message}`);
    if (merged.baseSha) console.error(`  base: ${merged.baseSha}`);
    if (merged.headSha) console.error(`  head: ${merged.headSha}`);
    process.exit(2);
  }

  let inner;
  try {
    console.log(`measure-on-the-merge: ${describe(merged)}`);
    console.log(
      `  base  ${merged.baseSha}${
        noFetch ? "   (NOT re-fetched: --no-fetch)" : ""
      }`
    );
    console.log(`  head  ${merged.headSha}`);
    console.log(
      `  tree  ${merged.probe}  (probe commit, thrown away with the worktree)`
    );
    console.log(`  run   ${command.join(" ")}\n`);
    inner = spawnSync(command[0], command.slice(1), {
      cwd: merged.dir,
      stdio: "inherit",
      encoding: "utf8",
    });
  } finally {
    merged.cleanup();
  }

  const verdict = classifyExit(inner);
  console.log("");
  if (verdict.exit === 2)
    console.error(`REFUSING TO REPORT: ${verdict.detail}`);
  else console.log(`measure-on-the-merge: ${verdict.detail}`);
  process.exit(verdict.exit);
}

if (invokedAsProgram(import.meta.url)) main();
