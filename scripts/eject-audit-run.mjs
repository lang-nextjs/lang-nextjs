#!/usr/bin/env node
/**
 * eject-audit-run.mjs — `pnpm eject-audit`: PRODUCE the two records, then classify them.
 *
 * WHY THIS EXISTS. `scripts/eject-subject-audit.mjs` is a CONSUMER: it takes two run
 * records, a sha and a base, and classifies. It refuses without them, correctly. But
 * `pnpm eject-audit` was wired straight to that consumer with no arguments, so the
 * gate's own remediation — "run `pnpm eject-audit` and commit what it records" —
 * could not be carried out. The producer was a procedure held in one person's head:
 * no workflow invoked it, the selftest drives the pure functions with fixture objects
 * rather than the CLI, and there was no working example anywhere in the tree (#819).
 *
 * A CONSUMER WITH NO PRODUCER IS NOT A HALF-BUILT FEATURE, it is an instruction that
 * cannot be followed — and the first person to hit it did the right thing and stopped,
 * because the audit's own header warns that an unprepared tree "produces a plausible
 * short list naming real checkers" rather than announcing itself. A census assembled
 * by guessing at the four arguments would be exactly that defect.
 *
 * WHAT IT DOES. Two worktrees at ONE commit, both fully built, one of them ejected:
 *
 *   1. FULL      install, build, run-checks --record
 *   2. EJECTED   eject <rung> FIRST, then install, build, run-checks --record
 *   3. CLASSIFY  hand both records to the consumer with --sha and --base
 *
 * EJECT BEFORE INSTALL, and that ordering is not stylistic. `eject.mjs` prunes the
 * lockfile as its step 3, so installing first and ejecting after leaves a lockfile
 * describing packages the tree no longer has, and `--frozen-lockfile` then fails for
 * a reason that looks nothing like its cause.
 *
 * A NON-ZERO CHECK RUN IS EXPECTED ON BOTH HALVES, which is why neither is judged by
 * its exit status:
 *
 *   - the EJECTED tree refuses and fails all over. That IS the measurement: twelve
 *     checkers are `absent` and four `broken` there by design.
 *   - the FULL tree usually exits 1 TOO, because the gate failing is the reason
 *     anyone runs this at all. Requiring exit 0 would refuse in precisely the case
 *     the tool exists for.
 *
 * So the discriminator is WHETHER A RECORD WAS PRODUCED, not what the process
 * returned. `run-checks.mjs` writes its record after the loop regardless of verdict;
 * a run that died earlier leaves no file, or one with no `ran` array. Exit status
 * answers "did this command succeed"; the question here is "did it MEASURE".
 *
 * AND THAT IS THE SHAPE THAT HID THIS BUG. The audit was run as `... | tail -40`, and
 * the completion notice reported TAIL's exit 0 while the refusal sat unread in the
 * body. A positive control on the artifact survives that; a reading of the pipeline's
 * status does not. Every stage here is spawned directly, with nothing between it and
 * its verdict.
 *
 * THE CLEANUP RUNS ON EVERY ENDING (#763/#764, learned expensively). Two worktrees are
 * materialised. `process.exit` terminates synchronously and does NOT run a pending
 * `finally`, so an exit inside the try would leak a directory AND git's admin entry on
 * every failure path — which is how 163 stale probe worktrees accumulated before #764
 * fixed this same shape one file over. Every ending RECORDS a code; the single
 * `process.exit` is after the finally.
 *
 * Usage: pnpm eject-audit [--keep] [--rung <name>]
 *          --keep   leave both worktrees for inspection (they are large)
 *          --rung   eject target, default "langchain" (the maximal strip)
 *
 * Exit: 0 classified and written · 1 the audit found a violation · 2 could not ask
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const KEEP = argv.includes("--keep");
const RUNG = (() => {
  const i = argv.indexOf("--rung");
  return i !== -1 ? argv[i + 1] : "langchain";
})();

const git = (args, cwd = ROOT) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function stage(label, cmd, args, cwd) {
  process.stdout.write(`\n=== ${label} ===\n`);
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.error) return { ok: false, why: `${label}: ${r.error.message}` };
  if (r.signal) return { ok: false, why: `${label}: killed by ${r.signal}` };
  return { ok: true, status: r.status };
}

/*
 * A RECORD IS THE PROOF A HALF RAN — the positive control on the artifact, rather
 * than a reading of a status a pipeline may already have discarded. Each record is
 * written into a FRESH temp directory, so a leftover from an earlier run cannot be
 * mistaken for this one's: a stale record reads as a perfectly good measurement of
 * the wrong tree, which is the failure this whole audit exists to avoid making.
 */
export function recordComplaint(path) {
  if (!existsSync(path))
    return "no record was written — the run did not reach the end";
  try {
    const r = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(r.ran))
      return "record has no `ran` array — the runner did not finish";
    if (r.ran.length === 0) return "record is empty — nothing executed";
    return null;
  } catch (e) {
    return `record is not readable JSON (${e.message})`;
  }
}

/*
 * VALIDATED BEFORE ANYTHING EXPENSIVE HAPPENS. A bad `--rung` used to surface from
 * `pnpm eject` — after a full install and build of the other half had already run,
 * five minutes in, for a typo knowable at the first instruction. Fail-fast is worth
 * more here than anywhere else in this script because every other error costs the
 * caller only the stage that produced it.
 */
export function rungComplaint(rungsJson, rung) {
  const names = (rungsJson?.rungs ?? []).map((r) => r.name).filter(Boolean);
  if (names.length === 0)
    return "rungs.json declares no rungs, so `--rung` cannot be checked at all";
  if (!names.includes(rung))
    return `unknown rung ${JSON.stringify(rung)} — rungs.json declares ${names.join(", ")}`;
  return null;
}

let trees = [];
let code = 2;

try {
  /*
   * REFUSE ON A DIRTY TREE. Both halves are checked out at a COMMIT, so uncommitted
   * work is invisible to the measurement while the census would name this sha. This
   * is the one precondition a reader cannot detect afterwards, because the resulting
   * census looks entirely normal. Untracked files are fine — they are not part of
   * any tree either way, and refusing on them would refuse on the caller's own notes.
   */
  const dirty = git(["status", "--porcelain"])
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("?? "));

  const rungBad = rungComplaint(
    JSON.parse(readFileSync(join(ROOT, "rungs.json"), "utf8")),
    RUNG
  );

  if (dirty.length > 0) {
    console.error(
      `REFUSE: ${dirty.length} uncommitted change(s) to tracked files.\n` +
        `        Both halves are checked out at a COMMIT, so uncommitted work would be\n` +
        `        absent from the measurement while the census named this sha. Commit\n` +
        `        first, then re-run. Nothing was measured.`
    );
  } else if (rungBad) {
    console.error(`REFUSE: ${rungBad}.\n        Nothing was measured.`);
  } else {
    const sha = git(["rev-parse", "HEAD"]);
    const base = git(["merge-base", "HEAD", "origin/main"]);
    console.log(`  sha  (measurement) : ${sha}`);
    console.log(`  base (on main)     : ${base}`);
    console.log(`  eject target       : ${RUNG}`);
    console.log(
      `\n  Roughly 7-8 minutes: two full check runs at ~193s each, plus an eject,\n` +
        `  an install and a build for the ejected half.`
    );

    const full = mkdtempSync(join(tmpdir(), "eject-audit-full-"));
    const ejected = mkdtempSync(join(tmpdir(), "eject-audit-ejected-"));
    trees = [full, ejected];
    git(["worktree", "add", "-q", "--detach", full, sha]);
    git(["worktree", "add", "-q", "--detach", ejected, sha]);

    const fullRecord = join(full, "record.json");
    const ejectedRecord = join(ejected, "record.json");

    const steps = [
      ["FULL — install", "pnpm", ["install", "--frozen-lockfile"], full],
      ["FULL — build", "pnpm", ["build"], full],
      // eject FIRST in this tree: it prunes the lockfile (see header)
      ["EJECTED — eject", "pnpm", ["eject", RUNG], ejected],
      ["EJECTED — install", "pnpm", ["install", "--frozen-lockfile"], ejected],
      ["EJECTED — build", "pnpm", ["build"], ejected],
    ];

    let failed = null;
    for (const [label, cmd, args, cwd] of steps) {
      const r = stage(label, cmd, args, cwd);
      if (!r.ok) {
        failed = r.why;
        break;
      }
      if (r.status !== 0) {
        failed =
          `${label} exited ${r.status}. PREPARATION must succeed on both halves — ` +
          `an unbuilt tree does not announce itself, it produces a plausible short ` +
          `list naming real checkers.`;
        break;
      }
    }

    if (failed) {
      console.error(`\nREFUSE: ${failed}\n        Nothing was classified.`);
    } else {
      /*
       * EACH TREE'S OWN RUNNER, FROM INSIDE THAT TREE, and neither judged by status.
       * `--cwd` would also work today — it sets both the root and the checks.json
       * path — but it runs THIS tree's run-checks.mjs against THAT tree's registry,
       * and the ejected tree is one an eject has rewritten. Running the runner the
       * measured tree actually has is the procedure that was verified by hand, and
       * it stays correct if a future eject ever touches the runner itself.
       */
      stage(
        "FULL — checks",
        "node",
        ["scripts/run-checks.mjs", "--record", fullRecord],
        full
      );
      stage(
        "EJECTED — checks",
        "node",
        ["scripts/run-checks.mjs", "--record", ejectedRecord],
        ejected
      );

      const fullBad = recordComplaint(fullRecord);
      const ejectedBad = recordComplaint(ejectedRecord);
      const bad = [
        fullBad && `full: ${fullBad}`,
        ejectedBad && `ejected: ${ejectedBad}`,
      ].filter(Boolean);

      if (bad.length > 0) {
        console.error(
          `\nREFUSE: a check run did not produce a usable record.\n` +
            bad.map((b) => `        - ${b}\n`).join("") +
            `        A non-zero exit is EXPECTED on both halves and is not the problem;\n` +
            `        a missing or truncated record is. Nothing was classified.`
        );
      } else {
        const r = stage("CLASSIFY", "node", [
          join(ROOT, "scripts/eject-subject-audit.mjs"),
          "--full",
          fullRecord,
          "--ejected",
          ejectedRecord,
          "--sha",
          sha,
          "--base",
          base,
        ]);
        code = r.ok ? r.status : 2;

        if (code === 0) {
          console.log(
            `\n  Written. If this run REGISTERED a new checker, expect to run it ONCE\n` +
              `  MORE: a failing gate means run-checks never read that checker's own\n` +
              `  subject, so it classifies as \`no-baseline\` until a cycle where the\n` +
              `  gate passes. That recurrence is SEPARATE from the runtime above — it\n` +
              `  is a second pass, not a slower first one.`
          );
        }
      }
    }
  }
} catch (e) {
  console.error(`REFUSE: ${e.message}`);
  code = 2;
} finally {
  /*
   * ON EVERY ENDING, NOT ONLY A THROW (#764). Remove, then prune: `rmSync` alone
   * leaves git's admin entry, and the next `git worktree list` then shows a phantom
   * that `git worktree prune` reports as 0 prunable.
   *
   * MATCHED BY PATH, NEVER BY A PATTERN OVER `git worktree list`. That listing prints
   * the BRANCH in brackets beside the path, so a grep for a project name matches
   * worktrees whose branch merely mentions it — which is how I deleted the worktree
   * this file was being written in, `--force`, with the file untracked. The paths are
   * held in `trees` precisely so nothing has to be matched at all.
   */
  if (KEEP && trees.length > 0) {
    console.log(
      `\n  --keep: left in place\n${trees.map((t) => `    ${t}\n`).join("")}`
    );
  } else {
    for (const t of trees) {
      try {
        execFileSync("git", ["worktree", "remove", "--force", t], {
          cwd: ROOT,
          stdio: "ignore",
        });
      } catch {
        rmSync(t, { recursive: true, force: true });
      }
    }
    try {
      execFileSync("git", ["worktree", "prune"], { cwd: ROOT, stdio: "ignore" });
    } catch {
      /* prune is best-effort; the remove above is the load-bearing half */
    }
  }
}

process.exit(code);
