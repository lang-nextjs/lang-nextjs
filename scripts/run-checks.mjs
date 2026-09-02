#!/usr/bin/env node
/**
 * Runs every check declared in scripts/checks.json, and RECORDS WHAT IT ACTUALLY RAN.
 *
 * ci.yml grew to 55 `pnpm` steps in one job, hand-written, all appending to the same region —
 * three PRs in one hour collided there. This replaces the six proof-first ones with a list
 * plus a runner. The list is not a description of what CI does; the runner iterates it and
 * ci.yml invokes the runner, so an entry IS an execution.
 *
 * THE RUN RECORD IS THE POINT, more than the consolidation was.
 *
 * assert-checker-proof-pairing.mjs answers "which checkers exist and where is each proved" by
 * regex over workflow YAML, resolving `pnpm <name>` indirection as it goes. What that can
 * establish is that a workflow's TEXT MENTIONS A SCRIPT. It cannot distinguish that from the
 * step having run. Latent in ci.yml today — zero of its checker steps are conditional — and
 * live across workflows: has-rung.mjs gates steps with a shell `if` inside `run:` blocks in
 * cross-version.yml and e2e.yml, which no YAML parse can see.
 *
 * So this writes `.checks-run.json`: name, exit status and duration for each check that
 * actually executed. Pairing reads that instead of inferring, and a declared check the runner
 * never ran shows up as a HOLE rather than as a pass. The record is produced by execution and
 * the declaration is the expectation, which is what keeps the two from being circular.
 *
 * ANNOTATIONS, NOT A SUMMARY TABLE. Collapsing 55 named steps into one costs the step name
 * that used to tell you what broke before you opened a log. `::error title=…::` replaces it
 * with more than it took away — the step name said WHICH STEP, an annotation says which
 * checker and why — and annotations are queryable over GraphQL, which is what made #372 and
 * #368 one query instead of an hour. A runner that swallowed a failure into a printed table
 * would be the regression this refactor exists to prevent, so run-checks.selftest.mjs watches
 * a real failure produce a real annotation rather than assuming it does.
 *
 * Usage: node scripts/run-checks.mjs [--cwd DIR] [--record PATH] [--list PATH]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { invokedAsProgram } from "./lib/is-main.mjs";
/* ------------------------------------------------------------------ *
 * CHANNELS — the closed set of things a check may declare it NEEDS
 * ------------------------------------------------------------------ */

/**
 * A check may declare `"needs": "<channel>"`. This object is the ONLY place a channel can be
 * defined, and the ONLY place its satisfiability is decided.
 *
 * WHY A TOLERANCE EXISTS AT ALL (#404). One check reads branch protection, which requires a
 * token with repository Administration: READ. `administration` is not among the keys a
 * workflow `permissions:` block accepts, so GITHUB_TOKEN cannot carry it in ANY channel — not
 * merely on forks — and a fork pull request cannot reach a repository secret at all. The check
 * therefore cannot compute in channels this repo genuinely runs in. Its only honest options
 * are to refuse or to be skipped; refusing reds a required context for contributors over a
 * permission they can never hold, which is how a gate earns the reflex to be ignored.
 *
 * WHY THIS IS NOT A GENERAL OPT-OUT, which is the risk it would otherwise be. Every future
 * check that finds a channel inconvenient will want one of these, and the four rules below are
 * the whole of what stands between that and a switch any check can flip:
 *
 *   1. CLOSED ENUMERATION. `needs` is matched against these keys by name. An unrecognised
 *      value is FATAL — exit 2 — never treated as unconditional. A closed set that fails open
 *      on an unknown value is not closed, and that is the case the proof pins hardest.
 *   2. SATISFIABILITY IS DERIVED HERE, never declared by the check. A check names a channel;
 *      it cannot assert that the channel is unavailable, so it cannot excuse itself.
 *   3. A SKIP IS NOT A PASS. It is recorded with its own status, counted separately, and
 *      announced. "skipped" and "pass" are never summed — the rule ci-completion.mjs already
 *      enforces for cancelled runs, which are the same shape: an absent measurement rendered
 *      as a weak positive.
 *   4. THE PROOF STILL RUNS. Only the checker is channel-dependent. A checker nobody has
 *      watched fail is worthless whether or not it ran, so the offline half is never skipped.
 */
export const CHANNELS = {
  /**
   * Reading the open issue board. UNLIKE `repo-settings`, GITHUB_TOKEN CAN carry this —
   * `issues: read` is a key a `permissions:` block accepts — so this channel is satisfiable
   * in CI, including on a fork pull request against a public repo, PROVIDED the workflow
   * hands `gh` a token. It is deliberately derived from `gh auth status` alone rather than
   * from a secret name: a check that cannot query must be a visible hole, and a workflow that
   * has not yet been wired should produce that hole rather than a red or a silent pass.
   */
  "board-read": {
    describe: "an authenticated `gh`, to read the open issue board",
    satisfiable(env = process.env) {
      const gh = spawnSync("gh", ["auth", "status"], { encoding: "utf8" });
      return gh.status === 0
        ? { ok: true }
        : {
            ok: false,
            because:
              "`gh auth status` reports no authenticated account, so the open board cannot " +
              "be read. In Actions this means the job has not been given GH_TOKEN",
          };
    },
    provide() {
      return {};
    },
  },
  "repo-settings": {
    describe: "a token carrying repository Administration: READ",
    /**
     * Two conjuncts, both derived from the environment, neither from the check.
     *
     * NOT A FORK PULL REQUEST. Repository secrets are not exposed to forks, so conjunct two
     * already decides this case; it is stated separately so that it keeps deciding it if a
     * workflow ever starts running on `pull_request_target`, where secrets ARE exposed and the
     * head is still untrusted. An unreadable event payload counts as a fork: the lenient
     * reading is safe only because conjunct two is the one doing the work.
     *
     * A CREDENTIAL THAT COULD CARRY THE SCOPE. In Actions that means PROTECTION_READ_TOKEN and
     * nothing else — GITHUB_TOKEN's presence is not evidence, because it provably cannot hold
     * this permission, and accepting it would make the channel look satisfiable everywhere and
     * fail at the API instead. Outside Actions the credential is whatever `gh` is already
     * authenticated with, which is why this still runs for real on a maintainer's machine
     * rather than skipping everywhere and never being exercised.
     */
    satisfiable(env = process.env) {
      if (isForkPullRequest(env))
        return {
          ok: false,
          because:
            "this is a fork pull request; repository secrets are not exposed to forks, so no " +
            "token here can read branch protection",
        };
      if (env.GITHUB_ACTIONS === "true") {
        return env.PROTECTION_READ_TOKEN
          ? { ok: true }
          : {
              ok: false,
              because:
                "PROTECTION_READ_TOKEN is not set. GITHUB_TOKEN cannot substitute — " +
                "`administration` is not a key a workflow `permissions:` block accepts, so it " +
                "cannot read branch protection in any channel",
            };
      }
      const gh = spawnSync("gh", ["auth", "status"], { encoding: "utf8" });
      return gh.status === 0
        ? { ok: true }
        : {
            ok: false,
            because: "`gh auth status` reports no authenticated account",
          };
    },
    /** Extra environment a checker running in this channel is given. */
    provide(env = process.env) {
      return env.PROTECTION_READ_TOKEN
        ? { GH_TOKEN: env.PROTECTION_READ_TOKEN }
        : {};
    },
  },
  "merge-commit": {
    describe: "a HEAD with two parents — i.e. a merge to judge",
    /*
     * DERIVED FROM THE REPOSITORY, and it is a reach question rather than a convenience one.
     * assert-merge-keeps-registrations compares a merge against BOTH ITS PARENTS. On a
     * `pull_request` event the checkout IS the merge commit (`refs/pull/N/merge`) and both
     * parents are present, so the question has a subject. On a push to main — a squash commit
     * with one parent — there is no pair of trees and no claim to make.
     *
     * THE SECOND VALUE IN THIS ENUMERATION, AND I ADDED THE FIRST, so the bar it has to clear
     * is the one I wrote: a channel is legitimate when the answer is genuinely UNOBTAINABLE,
     * not when it is inconvenient. A commit with one parent has no second tree — the check is
     * not being spared an answer it dislikes, it is being spared a question that does not
     * exist. If a future entry here cannot say that sentence about itself, it does not belong.
     */
    satisfiable(env = process.env) {
      // Explicitly the runner's working directory — the tree whose merge is being judged. Left
      // implicit this would follow whatever cwd the process happened to inherit, which is a
      // different tree than the one the checks are about.
      const r = spawnSync("git", ["rev-list", "--parents", "-n", "1", "HEAD"], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      if (r.status !== 0)
        return {
          ok: false,
          because: "git could not resolve HEAD, so its parents are unknown",
        };
      const parents = r.stdout.trim().split(/\s+/).length - 1;
      return parents >= 2
        ? { ok: true }
        : {
            ok: false,
            because:
              `HEAD has ${parents} parent(s), so there is no merge to judge here. A squash ` +
              `commit on main is not a merge of two trees`,
          };
    },
    provide() {
      return {};
    },
  },
};

/** Derived, not declared: is this run a pull request from a fork? */
export function isForkPullRequest(env = process.env) {
  if (!/^pull_request/.test(env.GITHUB_EVENT_NAME ?? "")) return false;
  try {
    const ev = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    const head = ev?.pull_request?.head?.repo?.full_name;
    return !head || head !== env.GITHUB_REPOSITORY;
  } catch {
    // A pull_request event whose payload cannot be read: assume fork. Safe only because the
    // credential conjunct is the one that actually decides.
    return true;
  }
}

const argOf = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const ROOT = resolve(
  argOf("--cwd", join(dirname(fileURLToPath(import.meta.url)), ".."))
);
const LIST = resolve(argOf("--list", join(ROOT, "scripts", "checks.json")));
const RECORD = resolve(argOf("--record", join(ROOT, ".checks-run.json")));

/** One line, enough to know what broke without opening the log. */
function firstMeaningfulLine(text) {
  const line = text
    .split("\n")
    .map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trim())
    .find((l) => /^(FAIL|Error|error|✘|✗)/.test(l) || /\bFAIL\b/.test(l));
  return (line ?? text.split("\n").find((l) => l.trim()) ?? "no output").slice(
    0,
    400
  );
}

/** GitHub swallows a bare newline inside an annotation; %0A is how a multi-line one is sent. */
const esc = (s) =>
  s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

export function runChecks({ root = ROOT, list = LIST, record = RECORD } = {}) {
  if (!existsSync(list)) {
    return { ok: false, fatal: `no check list at ${list}`, ran: [] };
  }
  const declared = JSON.parse(readFileSync(list, "utf8")).checks ?? [];
  if (declared.length === 0) {
    // A list with nothing in it runs nothing and would exit 0. "Nothing declared" and
    // "everything passed" are different answers and must not share an exit code.
    return { ok: false, fatal: `${list} declares no checks`, ran: [] };
  }

  /*
   * EVERY DECLARED CHANNEL IS RESOLVED BY NAME BEFORE ANYTHING RUNS. A pre-pass, not a check
   * inside the loop: an unrecognised value on the fifth entry would otherwise be discovered
   * after four checks had already executed, and the refusal below claims that nothing ran.
   *
   * An unrecognised value is FATAL. Treating it as "no channel" would run a check in a channel
   * nobody vetted; treating it as "skip" would let any string switch a check off. Both are the
   * enumeration failing open, which is the enumeration not being closed.
   */
  const channelOf = new Map();
  for (const c of declared) {
    if (c.needs === undefined) continue;
    const channel = CHANNELS[c.needs];
    if (!channel) {
      return {
        ok: false,
        fatal:
          `check "${c.name}" declares needs: "${c.needs}", which is not one of the channels ` +
          `this runner defines (${Object.keys(CHANNELS).join(
            ", "
          )}). An unrecognised ` +
          `channel is not a reason to run the check anyway, and not a reason to skip it — it ` +
          `is a list this runner cannot execute.`,
        ran: [],
      };
    }
    channelOf.set(c.name, channel);
  }

  const ran = [];
  for (const c of declared) {
    /*
     * Resolved above. Note this is keyed on the DECLARATION only: nothing a check says about
     * its own availability is read here, so a check cannot excuse itself from running.
     */
    const channel = channelOf.get(c.name) ?? null;

    // PROOF FIRST, then the checker — in that order, as one unit. This ordering used to live
    // in six `&&` chains and is now a property of the runner, so the seventh cannot omit it.
    for (const [phase, script] of [
      ["proof", c.proof],
      ["checker", c.checker],
    ]) {
      /*
       * Only the CHECKER is channel-dependent. The proof is offline by construction and is
       * never skipped: a checker nobody has watched fail is worthless whether or not it ran,
       * so the half that establishes it can fail must survive the channel that stops the
       * other half.
       */
      if (phase === "checker" && channel) {
        const verdict = channel.satisfiable();
        if (!verdict.ok) {
          ran.push({
            name: c.name,
            phase,
            script,
            status: "skipped",
            channel: c.needs,
            because: verdict.because,
            exit: null,
            ms: 0,
          });
          console.log(
            `::warning title=${esc(c.name)} (not measured)::${esc(
              script
            )} needs ` +
              `${esc(channel.describe)}. ${esc(
                verdict.because
              )}. This check reported NOTHING ` +
              `on this run — that is not the same as it passing.`
          );
          console.log(
            `  --  ${c.name} (checker)  SKIPPED, needs ${c.needs}: ${verdict.because}`
          );
          break;
        }
      }
      /*
       * A DECLARED SCRIPT THAT IS NOT THERE IS "COULD NOT CHECK", NOT "FAILED".
       *
       * `node missing.mjs` exits 1, and 1 is the status this repo reserves for a property
       * being VIOLATED — exit 2 means the question could not be asked (37 scripts here use
       * it). So a checker that was renamed, moved or never landed arrives in the bucket that
       * says a real defect was found, and the two are indistinguishable from the status
       * alone. Measured: a reviewer read `node scripts/assert-formatted.mjs; echo $?` as a
       * violation when the file simply did not exist on that branch.
       *
       * THIS RUNNER IS THE ONLY PLACE THAT CAN TELL THEM APART, because it holds the
       * declaration and the path BEFORE anything is invoked. Recorded rather than thrown so
       * the remaining checks still run and EVERY absent script is named in one pass — the
       * interesting case is not one failing run, it is a registration that quietly stopped
       * being exercised while checks.json still lists it.
       */
      if (!existsSync(join(root, script))) {
        ran.push({
          name: c.name,
          phase,
          script,
          status: "absent",
          exit: null,
          ms: 0,
        });
        console.error(
          `  --  ${c.name} (${phase})  ABSENT: ${script} is declared in checks.json and is ` +
            `not in the tree. NOTHING was checked here — that is not the same as passing, ` +
            `and not the same as failing.`
        );
        continue;
      }

      const started = Date.now();
      const r = spawnSync(process.execPath, [join(root, script)], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          ...(phase === "checker" && channel ? channel.provide() : {}),
        },
      });
      /*
       * A REFUSAL IS NOT A FAILURE, AND THE RECORD IS WHERE THAT STOPS BEING TRUE (#684).
       *
       * This read `r.status === 0 ? "pass" : "fail"`, so a checker that exited 2 — "I could
       * not ask the question" — was persisted under the same word as one that exited 1, "the
       * property is violated". Thirty-seven scripts in this directory use that split and the
       * runner recording them threw it away.
       *
       * Nothing is currently fooled: pairing keys on `!== "skipped"` so a refusal still counts
       * as having run, and the `exit` field beside this preserves the raw code. The damage is
       * to the ARTIFACT PEOPLE READ — anything computing a pass rate over `status`, which is
       * the obvious use of a record like this, counts refusals as violations. That is exactly
       * the arithmetic ci-completion.mjs refuses for cancelled runs.
       *
       * Same shape as #404 one field over: there, mapping every entry to its script counted a
       * SKIP as an invocation and inflated this file's own PASS line. That separated skipped
       * from executed; this separates refused from failed.
       */
      const status =
        r.status === 0 ? "pass" : r.status === 2 ? "refused" : "fail";
      ran.push({
        name: c.name,
        phase,
        script,
        status,
        exit: r.status ?? -1,
        ms: Date.now() - started,
      });
      if (status !== "pass") {
        const why = firstMeaningfulLine((r.stdout ?? "") + (r.stderr ?? ""));
        console.log(
          `::error title=${esc(c.name)} (${phase})::${esc(script)} exited ${
            r.status
          }. ${esc(why)}`
        );
        console.error(`\n--- ${c.name} (${phase}) FAILED: ${script} ---`);
        console.error((r.stdout ?? "") + (r.stderr ?? ""));
        break; // a checker whose proof failed tells you nothing; do not run it
      }
      console.log(`  ok  ${c.name} (${phase})  ${script}`);
    }
  }

  writeFileSync(record, JSON.stringify({ ran }, null, 2) + "\n");
  // A skip is neither a pass nor a failure. Folding it into either is the defect this whole
  // mechanism exists to avoid, one level up from the check that needed it.
  return {
    ok: !ran.some((r) => r.status === "fail" || r.status === "refused"),
    ran,
    record,
  };
}

function main() {
  const { ok, fatal, ran, record } = runChecks();
  if (fatal) {
    console.error(`FAIL: ${fatal}`);
    console.error(
      `      Nothing was executed, which is not the same as nothing failing.`
    );
    process.exit(2);
  }
  const failed = ran.filter((r) => r.status === "fail");
  const refused = ran.filter((r) => r.status === "refused");
  const absent = ran.filter((r) => r.status === "absent");
  console.log();

  /*
   * ABSENCE TAKES PRECEDENCE OVER FAILURE, and deliberately. A run missing one of its
   * declared checks cannot support "everything else passed" — the summary is drawn from an
   * incomplete list, so the honest status is "could not check" even when something else also
   * failed. Failures are still printed; only the exit code is claimed by the weaker verdict.
   */
  if (absent.length) {
    console.error(
      `FAIL: ${absent.length} declared script(s) are ABSENT from the tree:\n` +
        absent
          .map((a) => `        ${a.name} (${a.phase})  ${a.script}`)
          .join("\n") +
        `\n      checks.json declares them and they are not there, so this run did not ` +
        `execute them.\n      Either restore the script or remove its entry — a declared ` +
        `check nobody runs is a\n      registration that reports nothing while looking ` +
        `like coverage.`
    );
    if (failed.length)
      console.error(
        `      (${failed.length} phase(s) also FAILED: ` +
          `${[...new Set(failed.map((f) => f.name))].join(", ")}.)`
      );
    console.error(
      `      Exiting 2: the question could not be asked, not answered.`
    );
    process.exit(2);
  }
  /*
   * COUNTED APART, EXITED THE SAME. A refusal is still not green and still stops the run, so
   * the exit code is unchanged from before #684 — this says what happened, it does not decide
   * differently. Naming them together as "failed" is the misreport being fixed, one layer up
   * from the record.
   */
  if (failed.length || refused.length) {
    const parts = [];
    if (failed.length)
      parts.push(
        `${failed.length} FAILED — ${[
          ...new Set(failed.map((f) => f.name)),
        ].join(", ")}`
      );
    if (refused.length)
      parts.push(
        `${
          refused.length
        } REFUSED (exit 2, the question could not be asked) — ${[
          ...new Set(refused.map((f) => f.name)),
        ].join(", ")}`
      );
    console.error(
      `FAIL: ${failed.length + refused.length} of ${
        ran.length
      } phase(s) are not green.\n` +
        parts.map((p) => `      ${p}`).join("\n") +
        `\n      Each is annotated above by name; the record is at ${record}.`
    );
    process.exit(1);
  }
  const skipped = ran.filter((r) => r.status === "skipped");
  const executed = ran.filter((r) => r.status === "pass");
  const names = [...new Set(ran.map((r) => r.name))];

  /*
   * THE COUNTS ARE KEPT APART ON PURPOSE. "N phases, all green" over a set that includes
   * skips is a rate over a denominator nobody wants to know — the same arithmetic
   * ci-completion.mjs refuses for cancelled runs. Executed phases are counted; skipped ones
   * are named, with what they needed and why they did not get it.
   */
  console.log(
    `PASS: ${names.length} declared check(s), ${executed.length} phase(s) executed, all green.\n` +
      `      ${names.join(", ")}\n` +
      `      Recorded to ${record} — pairing reads that rather than inferring from YAML.`
  );
  if (skipped.length) {
    console.log(
      `\nNOT MEASURED: ${skipped.length} declared check(s) did not run their checker. This is a\n` +
        `      recorded HOLE, not a pass — nothing below was verified on this run:`
    );
    for (const s of skipped)
      console.log(`      ${s.name}  needs ${s.channel} — ${s.because}`);
  }
}

const isMain = invokedAsProgram(import.meta.url);
if (isMain) main();
