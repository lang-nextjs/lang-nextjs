#!/usr/bin/env node
/**
 * assert-selftest-arms-are-visible.mjs — a selftest may not JOIN the #1122 class unnoticed.
 *
 * THE CLASS. An arm appended below a selftest's verdict is either never executed (the suite exits
 * in line before reaching it) or executed and not counted (the banner was already printed). Both
 * mean a test can be added to a file and contribute nothing, and the suite reports the same green
 * either way. Measured behaviourally at `c7ffd84e`: 106 of 106 selftests, 42 shape 1, 64 shape 2,
 * ZERO safe.
 *
 * WHY THIS IS A RATCHET AND NOT A GATE. Every selftest is affected, so a check that failed on the
 * class would be red on an untouched tree forever and would be excluded within a day. What can be
 * held is the EDGE: the roster freezes what is already known, and this refuses a selftest that
 * joins the class after it.
 *
 * THE ARGUMENT FOR EXISTING AT ALL IS THE RATCHET, NOT DRIFT — and it is worth stating because the
 * opposite was predicted. Re-measuring across six merges moved NOTHING: 42 stayed 42, zero files
 * changed category. What happened instead is that the population GREW by one, and the joiner was
 * `assert-workflow-failures-are-surfaced.selftest.mjs` — a file I had added six arms to that same
 * day, under #1133, while the class was invisible to me. The class grows through the hands of the
 * people who know about it. A number in a comment cannot notice a 106th member.
 *
 * HOW A FILE IS CLASSIFIED, AND WHY NOT BY READING IT. Three people measured this class with three
 * source patterns and got three different numbers (78 of 104, 56 of 105, 104 of 105), because a
 * pattern counts an exit that is PRESENT and the property is about an exit that FIRES:
 * `if (fail !== 0) process.exit(1)` does not fire on a green run, so an appended arm still runs.
 * So this plants a statement and observes what happens.
 *
 * THE PLANT IS A `console.log`, NOT AN ASSERTION, AND THAT IS LOAD-BEARING. The obvious probe is a
 * failing arm through the file's own helper. Driven on #1119, that plant SILENTLY PASSED: the
 * helper is `ok(label, cond)`, the plant was `ok(false, "…")`, and the string is truthy. Helpers
 * differ per file, so a generic assertion measures the prober's assumption about the helper. A
 * marker measures the file.
 *
 * SHAPE 2 IS READ FROM OUTPUT ORDER, for the same reason: the counters are module-local and named
 * differently everywhere. If the suite's own banner is printed BEFORE the marker, the verdict was
 * computed before the arm ran, so the arm cannot have been counted.
 *
 * THE ORIGINAL IS NEVER MUTATED. The probe writes a sibling copy and runs that, so a crash or a
 * timeout cannot leave a repository file altered — the failure mode this repo has paid for three
 * times with `git checkout --`.
 *
 * Usage: node scripts/assert-selftest-arms-are-visible.mjs [--refresh]
 *          --refresh   re-measure EVERY selftest and rewrite the roster
 */
import {
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { reportSubject } from "./lib/subject.mjs";
import { refuseUnanticipated } from "./lib/refusal.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = join(ROOT, "scripts");
const ROSTER = join(SCRIPTS, "selftest-arm-visibility.json");

export class Refusal extends Error {}

const MARKER = "SELFTEST_ARM_VISIBILITY_PROBE_RAN";
/*
 * THE SCRATCH FILE'S NAME IS PART OF THE CONTRACT (#1147).
 *
 * The probe writes a sibling copy so the original is never mutated. That copy necessarily
 * ends in `.selftest.mjs` — it has to, because some suites resolve paths from their own
 * filename — so it is enumerable BY THIS CHECKER as a selftest of its own.
 *
 * `finally` covers a throw and a return. It does not cover a SIGNAL. Measured: SIGINT and
 * SIGTERM both leave the copy behind, and the next run then reports it as a NEW selftest that
 * joined the class — a fabricated finding naming a file nobody wrote, produced by pressing
 * Ctrl-C. Driven: with one planted, the subject read 108 instead of 106 and the run failed.
 *
 * Three layers, because the first is the one that must not depend on cleanup working:
 *   1. enumeration EXCLUDES the prefix, so a survivor can never be mistaken for a subject;
 *   2. every run sweeps strays first, so they cannot accumulate;
 *   3. signals are handled, so the ordinary interruption leaves nothing.
 */
const SCRATCH_PREFIX = ".arm-visibility-probe.";

/** Every selftest in scripts/, by basename. */
export function selftestsIn(dir = SCRIPTS, read = readdirSync) {
  return read(dir)
    .filter((f) => f.endsWith(".selftest.mjs") && !f.startsWith(SCRATCH_PREFIX))
    .sort();
}

/** Scratch copies a signalled run left behind. Named separately so an arm can see them. */
export function strayScratch(dir = SCRIPTS, read = readdirSync) {
  return read(dir)
    .filter((f) => f.startsWith(SCRATCH_PREFIX))
    .sort();
}

/**
 * The three outcomes, from output rather than from source.
 *
 * `banner` is any line carrying an `N/M passed`-shaped tally or a leading PASS:/FAIL:. If the
 * marker appears after the last of those, the verdict had not been computed when the arm ran.
 */
export function classifyOutput(out, markerSeen) {
  const lines = String(out).split("\n");
  let bannerAt = -1;
  lines.forEach((l, i) => {
    if (/\d+\s*\/\s*\d+\s+passed|^PASS:|^FAIL:/.test(l)) bannerAt = i;
  });

  /*
   * A SUITE THAT NEVER RAN IS NOT AN INERT SUITE, AND THE FIRST VERSION OF THIS CONFLATED THEM.
   *
   * Driven, not predicted: run in a tree with no `node_modules`, this classified 52 files `inert`
   * where the same probe in an installed tree says 42. The extra ten import prettier or typescript,
   * died on ERR_MODULE_NOT_FOUND before executing a line, and produced no marker — which the
   * original `if (!markerSeen) return "inert"` read as the property under test.
   *
   * That direction is the dangerous one for a ratchet: in an uninstalled tree EVERY file looks
   * inert, so a new selftest would be reported as having joined the class when the truth is that
   * nothing was measured. The evidence separating them is already in hand — a file that genuinely
   * exits before the marker still PRINTS ITS BANNER on the way out; a file that never ran prints
   * nothing.
   */
  if (bannerAt === -1) return "unreadable";
  if (!markerSeen) return "inert";
  const markerAt = lines.findIndex((l) => l.includes(MARKER));
  return bannerAt > markerAt ? "counted" : "uncounted";
}

/*
 * THE COPY IN FLIGHT, so a signal can remove it (#1147) -- and why that works only because `probe`
 * YIELDS (#1190).
 *
 * `finally` does not run on SIGINT or SIGTERM, so the ordinary Ctrl-C needs its own path. But a
 * signal listener is a JS callback, and a JS callback runs only when the event loop turns. The
 * probe used to run each selftest through `execFileSync` inside a `main` that was synchronous from
 * start to finish, so the loop never turned: the callback stayed queued, the run went on to print
 * PASS, and `process.exit(main())` fired first. Measured (#1190): SIGTERM mid-probe left the process
 * ALIVE a second later and it exited 0 with the full PASS banner, where the same checker without a
 * listener died at once with 143. Registering the listener had made the run uninterruptible.
 *
 * So the probe is asynchronous over `spawn`, `main` awaits each probe in turn, and the callback
 * runs when the signal arrives. It kills the in-flight CHILD as well as removing its copy -- a
 * signal to the parent alone would orphan a selftest for up to the probe timeout -- and then
 * re-raises with the default disposition, so an interrupted run still LOOKS interrupted.
 *
 * Still the least load-bearing of three layers: enumeration excludes the prefix and every run
 * sweeps first, so a signal that outruns even this leaves something inert rather than something
 * that accuses a file.
 */
let inFlight = null;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (inFlight) {
      inFlight.child?.kill(sig);
      rmSync(inFlight.copy, { force: true });
    }
    process.removeAllListeners(sig);
    process.kill(process.pid, sig);
  });
}

/**
 * Run one selftest with a marker appended, without touching the original. Asynchronous so that the
 * signal handler above can run while a probe is in flight (#1190).
 *
 * The output rule is the one `execFileSync` imposed, kept on purpose: stdout alone on a clean exit,
 * stdout then stderr on a failing one, and a timeout or a death by signal is the `timeout` verdict.
 */
export async function probe(name, dir = SCRIPTS, timeout = 180000) {
  const original = join(dir, name);
  const copy = join(dir, `${SCRATCH_PREFIX}${name}`);
  let out = "";
  try {
    inFlight = { copy, child: null };
    writeFileSync(
      copy,
      readFileSync(original, "utf8") + `\nconsole.log("${MARKER}");\n`
    );
    const r = await new Promise((resolve) => {
      const child = spawn(process.execPath, [copy], {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
      });
      inFlight.child = child;
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
      child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeout);
      child.on("error", () => {
        clearTimeout(timer);
        resolve({ stdout, stderr, code: null, signal: null, timedOut });
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, code, signal, timedOut });
      });
    });
    if (r.timedOut || r.signal) return { name, verdict: "timeout" };
    out = r.code === 0 ? r.stdout : `${r.stdout}${r.stderr}`;
  } finally {
    rmSync(copy, { force: true });
    inFlight = null;
  }
  return { name, verdict: classifyOutput(out, out.includes(MARKER)) };
}

export function loadRoster(read = readFileSync) {
  let raw;
  try {
    raw = read(ROSTER, "utf8");
  } catch {
    throw new Refusal(
      `no roster at ${ROSTER}. This check compares the tree against a frozen measurement; ` +
        `without it every selftest reads as new and the finding would be the whole class`
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Refusal(`the roster could not be parsed (${e.message})`);
  }
  if (!parsed || typeof parsed.affected !== "object")
    throw new Refusal("the roster carries no `affected` map");
  return parsed;
}

/** Files present in the tree and absent from the roster — the only ones probed. */
export function newcomers(present, roster) {
  return present.filter((f) => !(f in roster.affected));
}

/** Rostered files no longer in the tree. Not a finding: the roster is a record, not a claim. */
export function departed(present, roster) {
  const here = new Set(present);
  return Object.keys(roster.affected).filter((f) => !here.has(f));
}

export async function main(argv = []) {
  const refresh = argv.includes("--refresh");
  /*
   * SWEEP FIRST (#1147). A stray cannot be enumerated any more, but leaving it would let strays
   * accumulate silently and would leave an untracked file in the tree that no .gitignore matches.
   */
  for (const stray of strayScratch())
    rmSync(join(SCRIPTS, stray), { force: true });
  const present = selftestsIn();
  if (present.length === 0)
    throw new Refusal(
      `no *.selftest.mjs under ${SCRIPTS} — a pass over an empty subject asserts nothing, ` +
        `and an absent set is not a clean one`
    );

  if (refresh) {
    const affected = {};
    const unmeasured = [];
    for (const name of present) {
      const { verdict } = await probe(name);
      if (verdict === "unreadable" || verdict === "timeout")
        unmeasured.push(name);
      else if (verdict !== "counted") affected[name] = verdict;
    }
    /*
     * A ROSTER IS A MEASUREMENT, SO IT REFUSES TO RECORD ONE IT DID NOT TAKE. In an uninstalled
     * tree this used to write 106 confident entries, ten of which were files that never executed.
     */
    if (unmeasured.length)
      throw new Refusal(
        `${unmeasured.length} selftest(s) produced no verdict at all — they did not run, rather ` +
          `than running and exiting early:\n` +
          unmeasured.map((n) => `        - ${n}`).join("\n") +
          `\n        Usually an uninstalled tree. Install, then re-take. A roster written here ` +
          `would record "inert" for files nothing measured.`
      );
    writeFileSync(
      ROSTER,
      JSON.stringify(
        {
          measuredAt: execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: ROOT,
            encoding: "utf8",
          }).trim(),
          on: new Date().toISOString().slice(0, 10),
          method:
            "a console.log appended to a sibling copy; shape 2 read from output order. " +
            "Helper-independent on purpose: a generic ok(false, …) plant silently PASSES where " +
            "the signature is ok(label, cond).",
          affected,
        },
        null,
        2
      ) + "\n"
    );
    console.log(
      `roster refreshed: ${Object.keys(affected).length} of ${
        present.length
      } selftests are in the class.`
    );
    return 0;
  }

  const roster = loadRoster();
  const fresh = newcomers(present, roster);
  /*
   * PROBED ONCE. An earlier draft called `probe` separately for the failures and for the
   * timeouts, which is not merely wasteful: the two partitions would have come from two
   * different runs, so a file that behaved differently between them could appear in neither.
   */
  const probed = [];
  for (const name of fresh) probed.push(await probe(name));
  const stalled = probed.filter(
    (r) => r.verdict === "timeout" || r.verdict === "unreadable"
  );
  const joined = probed.filter(
    (r) => r.verdict === "inert" || r.verdict === "uncounted"
  );

  /*
   * THE REFUSAL REPORTS NO SUBJECT, AND THE FAILURE DOES (#1030). A run that could not classify a
   * file did not examine the set it would otherwise be claiming; a run that FOUND something did,
   * and the record has to say over what.
   */
  if (stalled.length) {
    console.error(
      `REFUSING: ${stalled.length} new selftest(s) did not terminate under the probe, so their ` +
        `verdict is unknown:\n` +
        stalled.map((r) => `        - ${r.name}`).join("\n") +
        `\n        A run that produced no verdict is not a pass.`
    );
    return 2;
  }

  reportSubject(
    present.length,
    `selftest(s), each rostered as known-affected or probed as new`
  );

  const gone = departed(present, roster);
  if (gone.length)
    console.log(
      `NOTE: ${gone.length} rostered file(s) are no longer in the tree; the roster records a ` +
        `measurement, not a claim about today. Re-take it with --refresh.`
    );

  if (joined.length === 0) {
    console.log(
      `PASS: ${present.length} selftest(s); ${fresh.length} new since the roster, none of which ` +
        `joined the class.\n` +
        `      ${
          Object.keys(roster.affected).length
        } are known-affected and tracked by #1122 — ` +
        `this holds the edge, it does not clear the backlog.`
    );
    return 0;
  }

  console.error(
    `FAIL: ${joined.length} new selftest(s) joined the #1122 class:`
  );
  for (const r of joined)
    console.error(
      `  - ${r.name}  (${
        r.verdict === "inert"
          ? "an arm appended below the verdict NEVER RUNS"
          : "an arm appended below the verdict runs but is NOT COUNTED"
      })`
    );
  console.error(
    `\n      A test added to one of these files can contribute nothing while the suite reports\n` +
      `      the same green. Emit the verdict and the banner from a process exit hook, so an arm\n` +
      `      below them still runs and is still counted, and DO NOT CALL process.exit AT ALL —\n` +
      `      scripts/assert-armed-prs-are-covered-by-a-review.selftest.mjs is the worked example,\n` +
      `      measured: of 40 selftests probed it is the only one reaching \`counted\`. Moving the\n` +
      `      count guard into a hook is NOT enough on its own — eject-subject-audit.selftest.mjs\n` +
      `      does that under #1119 and still probes \`inert\`, because it still exits. If the file\n` +
      `      is genuinely exempt, add it to\n` +
      `      ${ROSTER} with --refresh and say why on #1122.`
  );
  return 1;
}

if (
  process.argv[1] &&
  process.argv[1].endsWith("assert-selftest-arms-are-visible.mjs")
) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      if (e instanceof Refusal) {
        console.error(`REFUSING: ${e.message}`);
        process.exit(2);
      }
      refuseUnanticipated(e);
    }
  );
}
