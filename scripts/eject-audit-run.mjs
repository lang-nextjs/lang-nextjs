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
import {
  mkdtempSync,
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const KEEP = argv.includes("--keep");
const RECLAIM = argv.includes("--reclaim");
const RUNG = (() => {
  const i = argv.indexOf("--rung");
  return i !== -1 ? argv[i + 1] : "langchain";
})();

/** The basenames `mkdtempSync` produces for this audit's two trees. */
const KEPT_TREE = /^eject-audit-(full|ejected)-/;

/**
 * Written into each tree while a run is USING it, and removed when that run stops using it.
 *
 * WITHOUT IT `--reclaim` CANNOT TELL A KEPT TREE FROM A LIVE ONE, and both carry the same
 * prefix by construction — the matcher hunts exactly the names `mkdtempSync` is given. Measured
 * on this board while three of us were running audits: a `--reclaim` issued during a run would
 * have `--force` removed both trees of a measurement somebody was waiting on. It would not
 * present as a deletion; it would surface minutes later as a missing path inside a run that had
 * already spent its full eight minutes.
 *
 * A MARKER RATHER THAN AN AGE FLOOR. "In use" becomes a fact the tree STATES, not one inferred
 * from how recently it was touched — and an age constant chosen from today's board is #768's
 * shape. It also makes the crashed case REPORTABLE rather than invisible: a marker whose pid is
 * gone is a run that died, which is worth saying out loud, and no age test can distinguish that
 * from a run still working.
 *
 * REMOVED ON THE KEEP PATH, NOT ONLY ON SUCCESS. A refusal keeps its trees deliberately, and at
 * that moment the run has stopped using them — so the marker comes off and the tree becomes the
 * reclaimable evidence it is meant to be.
 */
export const INFLIGHT = ".eject-audit-inflight";

/**
 * The audit trees a PREVIOUS run left registered, from `git worktree list --porcelain`.
 *
 * WHY THIS EXISTS. A refusal keeps its trees on purpose -- the tree is the evidence -- and says
 * "Remove them yourself when done" once, into a log nobody re-reads. Six were still registered
 * when #1031 was measured, from refusals on two different days, and nothing recorded whether the
 * instruction had ever been followed. THE RETENTION IS RIGHT; THE SILENCE AFTER IT IS THE DEFECT.
 *
 * PORCELAIN AND THE BASENAME, BECAUSE THIS FILE ALREADY RECORDS WHAT THE OTHER WAY COSTS. The
 * human-readable `git worktree list` prints the BRANCH in brackets beside the path, so matching a
 * name against that line also matches worktrees whose branch merely mentions it -- which is how
 * the worktree this file was being written in got removed, `--force`, with the file untracked.
 * In `--porcelain` the path is alone on its `worktree ` line and the branch is on its own, so a
 * basename test cannot reach it. The proof drives that case.
 */
export function keptTreePaths(porcelain, inFlight = liveInFlight) {
  const out = [];
  for (const line of (porcelain ?? "").split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const path = line.slice("worktree ".length).trim();
    if (!path) continue;
    if (!KEPT_TREE.test(path.split("/").pop() ?? "")) continue;
    /*
     * THERE WAS AN `exclude` PARAMETER HERE AND NEITHER CALL SITE PASSED IT. That is worse than
     * having no guard: the signature reads as evidence that live trees are handled, so a reader
     * asking "does this skip a running audit?" sees the parameter and stops looking. One
     * mechanism, and it is the tree's own marker.
     */
    if (inFlight(path)) continue;
    out.push(path);
  }
  return out;
}

/** Whether a tree says a run is currently using it. */
function liveInFlight(path) {
  return existsSync(join(path, INFLIGHT));
}

/**
 * The trees that CLAIM to be in use, with whether the process that claimed them still exists.
 * A marker whose pid is gone is a crashed run — reportable, and not something an age test can
 * distinguish from a run still working.
 */
export function inFlightTrees(porcelain, read = null) {
  const out = [];
  for (const line of (porcelain ?? "").split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const path = line.slice("worktree ".length).trim();
    if (!path || !KEPT_TREE.test(path.split("/").pop() ?? "")) continue;
    let raw = null;
    try {
      raw = read ? read(path) : readFileSync(join(path, INFLIGHT), "utf8");
    } catch {
      continue;
    }
    let pid = null;
    try {
      pid = JSON.parse(raw).pid ?? null;
    } catch {}
    let alive = null;
    if (typeof pid === "number") {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
    }
    out.push({ path, pid, alive });
  }
  return out;
}

/**
 * Each kept tree with its AGE and its SHA.
 *
 * THE SHA IS THE WHOLE POINT AND IT COSTS NOTHING. When six kept trees were removed by an early
 * version of `--reclaim`, the only question that mattered afterwards was what had actually been
 * lost — and the answer was "tree content is reconstructable from the sha, run state is not".
 * That distinction was knowable only by going and checking, after the directories were gone. A
 * log line that carries the sha answers it for a reader who was not there, and a reconstruction
 * that produces the right sha with none of the run state is NOT a repair: it returns something
 * with the same name rather than the thing that was lost.
 */
export function describeKept(paths, now = Date.now(), probe = null) {
  return paths.map((t) => {
    const p = probe ? probe(t) : liveProbe(t);
    const age =
      p.mtimeMs === null
        ? "age unknown"
        : (() => {
            const d = Math.floor((now - p.mtimeMs) / 86400000);
            return d === 0 ? "today" : `${d}d old`;
          })();
    return `${t}  ${p.sha ?? "sha unknown"}  (${age})`;
  });
}

/** mtime and HEAD sha for a path, or nulls — separated so `describeKept` is drivable without a tree. */
function liveProbe(t) {
  let mtimeMs = null;
  let sha = null;
  try {
    mtimeMs = statSync(t).mtimeMs;
  } catch {}
  try {
    sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: t,
      encoding: "utf8",
    }).trim();
  } catch {}
  return { mtimeMs, sha };
}

const git = (args, cwd = ROOT) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/*
 * `cwd` IS REQUIRED, AND THE GUARD IS HERE RATHER THAN AT THE CALL SITES.
 *
 * `spawnSync` with `cwd: undefined` silently inherits `process.cwd()`, so a forgotten
 * argument does not fail — it runs somewhere else and succeeds. This file's header
 * claimed "every stage gets an explicit cwd" while the LAST stage, CLASSIFY, passed
 * three arguments and no cwd. The claim was false the moment it was written, and it
 * had already been promoted from a PR body into a header comment asserting a property
 * the code did not have.
 *
 * It was benign only by accident: `eject-subject-audit.mjs` derives its ROOT from its
 * own location and reads and writes nothing relative to `cwd`. So the safety came from
 * the callee's self-location, NOT from the mechanism the comment credited — and an
 * edit to that callee introducing one cwd-relative read would break this silently
 * while the comment went on saying it could not.
 *
 * A guard at the entry point makes the sentence TRUE instead of deleting it, and it
 * cannot be forgotten by the next call site added. Same argument as putting a
 * once-only guard at the emitter rather than in a static scan over its callers.
 */
export function stage(label, cmd, args, cwd) {
  if (!cwd)
    throw new Error(
      `${label}: no cwd given. spawnSync would inherit process.cwd() and run this ` +
        `stage in whatever directory the caller happened to be standing in, which is ` +
        `how a run measures the wrong tree and succeeds.`
    );
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
/**
 * The TRACKED changes in `git status --porcelain` output (#866).
 *
 * Extracted from main() so it can be asserted. It was three lines inline, and this module
 * exports four names of which this was not one — so the proof could not reach it, while the
 * registry's justification for leaving this file unregistered claims that proof "covers every
 * decision made before anything expensive runs". This was the exception, and by its own note
 * it is the one whose absence is undetectable afterwards.
 *
 * REFUSING ON A DIRTY TREE is that decision. Both halves are checked out at a COMMIT, so
 * uncommitted work is invisible to the measurement while the census would name this sha. The
 * resulting census looks entirely normal, so nothing downstream can recover the fact.
 *
 * UNTRACKED FILES ARE DELIBERATELY EXEMPT — they are not part of any tree either way, and
 * refusing on them would refuse on the caller's own notes. That exemption has two silent
 * failure directions: lose it and every run refuses over a stray notes file; widen it and a
 * genuinely dirty tree is measured. Neither surfaces as an error.
 *
 * THESE ARMS PROVE THE PREDICATE, NOT THE WIRING, and that limit is worth stating because
 * this file contains the case that makes the distinction. `trackedChanges` takes porcelain
 * TEXT, so no case can see whether main() inspected the right directory — exactly the gap
 * `treeShaComplaints`'s real-worktree arm exists to close, whose own note says "proven against
 * string literals is not the risk; the failure lives in the WIRING".
 *
 * What makes the wiring safe here is OUTSIDE these arms: `git` is `(args, cwd = ROOT)` at :77
 * and the call site omits `cwd`, so it defaults to the module root rather than inheriting
 * `process.cwd()`. That is a property of the helper, not of anything asserted below, and a
 * reader who assumes these arms carry the same weight as the worktree one would be wrong.
 *
 * THE TEST IS `startsWith`, NOT `includes`, AND THAT IS LOAD-BEARING. Porcelain emits two
 * status characters, a space, then the path, so only a line BEGINNING "?? " is untracked; a
 * tracked path that happens to contain those characters is still a change. A substring test
 * would exempt it — the proxy failure this repo keeps finding, where the cheap test agrees
 * with the property on every line anyone has looked at.
 */
export function trackedChanges(porcelain) {
  return String(porcelain ?? "")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("?? "));
}

export function rungComplaint(rungsJson, rung) {
  // `id`, NOT `name` — rungs.json entries are keyed by `id`, which is what
  // `eject.mjs` resolves its argument against. I wrote `.name`, got an empty list,
  // and the refusal below fired with "declares no rungs" on a file declaring five.
  // The empty-list branch existing is the only reason that surfaced as a message
  // rather than as "unknown rung langchain" on a valid rung.
  const names = (rungsJson?.rungs ?? []).map((r) => r.id).filter(Boolean);
  if (names.length === 0)
    return "rungs.json declares no rungs, so `--rung` cannot be checked at all";
  if (!names.includes(rung))
    return `unknown rung ${JSON.stringify(
      rung
    )} — rungs.json declares ${names.join(", ")}`;
  return null;
}

/*
 * THE BODY RUNS ONLY WHEN INVOKED DIRECTLY, so the two complaint functions above can
 * be imported and proven. Without this guard the selftest would materialise two
 * worktrees and spend eight minutes building them as a side effect of `import`.
 */
const INVOKED_DIRECTLY =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

/*
 * `--sha` IS A CLAIM THE CALLER MAKES, AND THIS IS WHERE IT STOPS BEING ONE.
 *
 * `eject-subject-audit.mjs` takes the sha as an ARGUMENT. It checks that both records
 * agree and that the trees were built, but it cannot know WHICH TREE produced them:
 * hand it two records from anywhere, label them with any sha, and it writes a census
 * that is internally consistent and about nothing. The identifier is unverifiable at
 * the point it is consumed.
 *
 * SO THE PRODUCER RESOLVES IT RATHER THAN ASSERTING IT. The sha handed to the consumer
 * is read back OUT of the tree the readings were taken in, after this check proves
 * both trees sit at the same commit. That is what makes being the producer worth
 * anything beyond convenience over four flags: it is the only position from which the
 * provenance is a fact instead of an assertion.
 *
 * AND IT IS CHECKED BEFORE THE EIGHT MINUTES, NOT AFTER. This is the shape that cost a
 * full cycle elsewhere: `git worktree add` refused with "missing but already
 * registered", a shell `cd` then failed and left the script in its PREVIOUS directory,
 * and every following stage succeeded there — installing, building and recording the
 * MAIN CHECKOUT, which sits on an unrelated branch with hundreds of uncommitted
 * changes. Both records were written, both looked normal, and the only tell was a byte
 * count: 100 phases in one cycle and 68 in the next, with nothing in the run saying so.
 *
 * Nothing above can produce that failure here — there is no `cd`, every stage gets an
 * explicit `cwd` (enforced at `stage()` rather than trusted at each call site, because
 * this sentence was FALSE when first written and the exception was the last stage in
 * the run), and a failed `worktree add` throws rather than returning a status someone
 * has to remember to read. But "the command did not error" is an INFERENCE
 * about where the work happened, and this is the direct observation. It costs about
 * ten milliseconds.
 */
export function treeShaComplaints(expected, actual) {
  const bad = [];
  for (const [label, got] of Object.entries(actual)) {
    if (got !== expected)
      bad.push(
        `${label} is at ${
          got || "(unreadable)"
        }, not ${expected} — the readings ` +
          `would describe a tree the census does not name`
      );
  }
  return bad;
}

let trees = [];
let code = 2;

if (!INVOKED_DIRECTLY) {
  // imported for its functions; nothing to do
} else
  try {
    /*
     * REFUSE ON A DIRTY TREE. Both halves are checked out at a COMMIT, so uncommitted
     * work is invisible to the measurement while the census would name this sha. This
     * is the one precondition a reader cannot detect afterwards, because the resulting
     * census looks entirely normal. Untracked files are fine — they are not part of
     * any tree either way, and refusing on them would refuse on the caller's own notes.
     */
    const dirty = trackedChanges(git(["status", "--porcelain"]));
    // computed before the branch below; --reclaim does not read it, deliberately.

    const rungBad = rungComplaint(
      JSON.parse(readFileSync(join(ROOT, "rungs.json"), "utf8")),
      RUNG
    );

    if (RECLAIM) {
      /*
       * RECLAIM IS ITS OWN BRANCH AND RUNS NOTHING ELSE. It is a janitor, and coupling it to an
       * 7-8 minute audit would mean nobody uses it. It sits beside the two refusals because it
       * shares their shape: a reason not to enter the expensive path.
       *
       * NEVER AUTOMATIC. The trees it removes are the evidence of runs that could not measure,
       * so the decision to discard them belongs to a person who has decided they are read. That
       * is also why every other run only REPORTS them.
       */
      const porcelain = git(["worktree", "list", "--porcelain"]);
      const live = inFlightTrees(porcelain);
      if (live.length > 0)
        console.log(
          `  ${live.length} tree(s) say a run is USING them and are NOT candidates:\n` +
            live
              .map(
                (l) =>
                  `    ${l.path}  pid ${l.pid ?? "?"} ${
                    l.alive === true
                      ? "(alive)"
                      : l.alive === false
                      ? "(GONE -- a crashed run; read it, then remove by hand)"
                      : "(liveness unknown)"
                  }\n`
              )
              .join("")
        );
      const kept = keptTreePaths(porcelain);
      if (kept.length === 0) {
        console.log(
          `  --reclaim: no tree from an earlier run is registered. Nothing to do, and the\n` +
            `             audit did NOT run.`
        );
      } else {
        console.log(
          `  --reclaim: ${kept.length} tree(s) kept by earlier runs. The audit will NOT run.\n` +
            describeKept(kept)
              .map((d) => `    ${d}\n`)
              .join("")
        );
        let removed = 0;
        for (const t of kept) {
          // READ THE SHA FIRST. After the removal there is nothing left to ask, and the sha is
          // the one fact that says what is reconstructable and what is not.
          const { sha } = liveProbe(t);
          try {
            execFileSync("git", ["worktree", "remove", "--force", t], {
              cwd: ROOT,
              stdio: "ignore",
            });
            console.log(
              `    removed  ${t}  ${sha ?? "sha unknown"}\n` +
                `             content is reconstructable: git worktree add --detach <path> ${
                  sha ?? "<sha>"
                }\n` +
                `             RUN STATE IS NOT — that is what the retention was keeping.`
            );
            removed += 1;
          } catch (e) {
            console.log(`    COULD NOT REMOVE  ${t}  -- ${e.message}`);
          }
        }
        console.log(`\n  ${removed} of ${kept.length} removed.`);
      }
      code = 0;
    } else if (dirty.length > 0) {
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

      /*
       * WHAT EARLIER RUNS KEPT, REPORTED BEFORE THE EXPENSIVE PART. The reader about to wait
       * 7-8 minutes is the one who can act on it, and a report costs nothing. This does NOT
       * remove anything -- that is `--reclaim`, and it is a person's decision.
       */
      const kept = keptTreePaths(git(["worktree", "list", "--porcelain"]));
      if (kept.length > 0)
        console.log(
          `\n  ${kept.length} tree(s) kept by EARLIER runs are still registered. A refusal keeps\n` +
            `  its tree on purpose, but until now nothing reported that the instruction to\n` +
            `  remove it had never been followed:\n` +
            describeKept(kept)
              .map((d) => `    ${d}\n`)
              .join("") +
            `  Leave them if you are still reading one. Otherwise: pnpm eject-audit --reclaim`
        );

      const full = mkdtempSync(join(tmpdir(), "eject-audit-full-"));
      const ejected = mkdtempSync(join(tmpdir(), "eject-audit-ejected-"));
      trees = [full, ejected];
      git(["worktree", "add", "-q", "--detach", full, sha]);
      git(["worktree", "add", "-q", "--detach", ejected, sha]);
      // SAY SO IN THE TREE, before anything long-running starts. A concurrent --reclaim reads
      // this; nothing else can tell these apart from the trees an earlier refusal kept.
      for (const t of [full, ejected])
        writeFileSync(
          join(t, INFLIGHT),
          JSON.stringify({
            pid: process.pid,
            startedAt: new Date().toISOString(),
            sha,
          })
        );

      const at = (d) => {
        try {
          return git(["rev-parse", "HEAD"], d);
        } catch {
          return null;
        }
      };
      const wrongTree = treeShaComplaints(sha, {
        "the full tree": at(full),
        "the ejected tree": at(ejected),
      });
      if (wrongTree.length > 0) {
        console.error(
          `REFUSE: a worktree is not at the commit being measured.\n` +
            wrongTree.map((w) => `        - ${w}\n`).join("") +
            `        Nothing was measured. The eight minutes were not spent.`
        );
        throw new Error("worktree provenance check failed");
      }
      // RESOLVED out of the measured tree, not asserted from the caller's cwd
      const measuredSha = at(full);

      const fullRecord = join(full, "record.json");
      const ejectedRecord = join(ejected, "record.json");

      const steps = [
        ["FULL — install", "pnpm", ["install", "--frozen-lockfile"], full],
        ["FULL — build", "pnpm", ["build"], full],
        // eject FIRST in this tree: it prunes the lockfile (see header)
        ["EJECTED — eject", "pnpm", ["eject", RUNG], ejected],
        [
          "EJECTED — install",
          "pnpm",
          ["install", "--frozen-lockfile"],
          ejected,
        ],
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
          const r = stage(
            "CLASSIFY",
            "node",
            [
              join(ROOT, "scripts/eject-subject-audit.mjs"),
              "--full",
              fullRecord,
              "--ejected",
              ejectedRecord,
              "--sha",
              measuredSha,
              "--base",
              base,
              // #855: the census records what was ejected, and the audit refuses
              // without it rather than defaulting. RUNG is what `pnpm eject` was
              // given twelve lines up, so the field and the intervention cannot
              // disagree — the literal they replaced could, and silently.
              "--eject-target",
              RUNG,
            ],
            ROOT
          );
          code = r.ok ? r.status : 2;

          if (code === 0) {
            console.log(
              `\n  Written. IF THIS RUN REGISTERED A NEW CHECKER, DO NOT RE-RUN YET —\n` +
                `  READ ITS ROW FIRST. A failing gate means run-checks never read that\n` +
                `  checker's own subject, so the gate's own entry classifies\n` +
                `  \`no-baseline\` until a cycle where the gate passes. That recurrence is\n` +
                `  a SECOND PASS, not a slower first one.\n` +
                `\n` +
                `  THE SEQUENCE IS  run 1 -> WRITE THE NOTE -> run 2.  It is NOT\n` +
                `  run 1 -> run 2 -> write -> run 3, and the difference is a whole cycle:\n` +
                `\n` +
                `    If the new checker landed \`static-under-eject-langchain\` with\n` +
                `    \`note: null\`, WRITE THAT NOTE NOW. A STATIC entry with no note fails\n` +
                `    noteComplaints, so run 2 returns IDENTICAL TOTALS and converges on\n` +
                `    nothing — the blocker is prose only a person can produce, and no\n` +
                `    number of runs produces it. Three people each spent one eight-minute\n` +
                `    cycle discovering that, two of them by following this message's own\n` +
                `    earlier advice to just run it again (#838).\n` +
                `\n` +
                `    AND RE-DERIVE ITS COUNTS FROM \`full\`, DO NOT CARRY THEM. If you are\n` +
                `    restoring or adapting an existing note, any number in it describes the\n` +
                `    tree it was written on. Read the entry's own \`full\` and substitute.\n` +
                `    Main has shipped that contradiction twice — a note saying 49 beside\n` +
                `    fields reading 50, and the same again at 52 against 53.\n` +
                `\n` +
                `  AND BACK UP ANY AUTHORED NOTE BEFORE THE FIRST RUN. Run 1 drops \`note\`\n` +
                `  and \`lifts\` from every entry whose verdict moved, and the same verdict\n` +
                `  exempts that row from the check that would report it (#834). A new\n` +
                `  registration ALWAYS moves the gate's own verdict, so this is not a risk\n` +
                `  to weigh — it is what happens.`
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
    /*
     * AND A REFUSAL KEEPS THE TREES WITHOUT BEING ASKED (#920). An audit that discards its
     * evidence on the path where it could not measure cannot be debugged afterwards, and that
     * is the path where the tree IS the evidence: exit 2 means the instrument could not ask,
     * so the question is what the tree looks like. The occurrence that filed this had its
     * worktrees removed by this very block, and the log survived only because someone saved it
     * by hand before touching anything.
     *
     * NOT ON A PLAIN FAIL (exit 1). That is a property being violated, and the census and the
     * message carry the whole finding — keeping trees there would leave one behind on every
     * ordinary red, which is how a person learns to ignore them.
     */
    const keepForRefusal = code === 2;
    if ((KEEP || keepForRefusal) && trees.length > 0) {
      /*
       * THE MARKER COMES OFF HERE. The run has stopped using these trees; keeping them is the
       * point, and a tree still claiming to be in use would be permanently un-reclaimable.
       */
      for (const t of trees) {
        try {
          rmSync(join(t, INFLIGHT), { force: true });
        } catch {}
      }
      console.log(
        (keepForRefusal && !KEEP
          ? `\n  REFUSED (exit 2), so the trees are KEPT rather than removed — a run that could\n` +
            `  not measure is one whose tree is the evidence. Remove them yourself when done:\n` +
            `    git worktree remove --force <path>\n`
          : `\n  --keep: left in place\n`) +
          `${trees.map((t) => `    ${t}\n`).join("")}`
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
        execFileSync("git", ["worktree", "prune"], {
          cwd: ROOT,
          stdio: "ignore",
        });
      } catch {
        /* prune is best-effort; the remove above is the load-bearing half */
      }
    }
  }

if (INVOKED_DIRECTLY) process.exit(code);
