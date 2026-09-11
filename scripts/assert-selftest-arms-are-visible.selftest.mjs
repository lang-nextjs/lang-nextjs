#!/usr/bin/env node
/**
 * PROOF for assert-selftest-arms-are-visible.mjs (#1122).
 *
 * THE ARMS THAT MATTER ARE THE ONES SEPARATING "did not run" FROM "ran and exited early", because
 * the first version of the checker conflated them and the conflation had a direction: in a tree
 * with no `node_modules` it called TWELVE files inert that had simply died on
 * ERR_MODULE_NOT_FOUND. A ratchet that reports a newcomer as having joined the class when nothing
 * measured it is worse than no ratchet — it accuses the one file somebody just wrote.
 *
 * The assembled arms build a throwaway scripts/ tree and run the real checker against it, because
 * every defect this file has had so far lived in the wiring rather than in the predicates.
 */
import { execFileSync, spawn } from "node:child_process";
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  cpSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  classifyOutput,
  newcomers,
  departed,
  selftestsIn,
  strayScratch,
  declaresCount,
} from "./assert-selftest-arms-are-visible.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKER = join(HERE, "assert-selftest-arms-are-visible.mjs");
const MARKER = "SELFTEST_ARM_VISIBILITY_PROBE_RAN";

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.error(`  WRONG ${name}${detail ? `\n        ${detail}` : ""}`);
  }
};

/* ---- classifyOutput, the four outcomes ---------------------------------------------------- */

/*
 * THE ORDER IS THE OPPOSITE OF THE OBVIOUS ONE, AND I GOT IT BACKWARDS FIRST. The marker is
 * appended at END OF FILE, so it prints when module execution finishes. A banner emitted from an
 * exit hook therefore appears AFTER it — marker first means the tally had not been taken when the
 * arm ran, which is the SAFE case. A banner printed in line appears BEFORE the marker.
 */
ok(
  "marker BEFORE the banner is COUNTED — an exit hook tallies after the appended arm has run",
  classifyOutput(`  ok  one\n${MARKER}\n\n1/1 passed\n`, true) === "counted"
);

ok(
  "marker AFTER the banner is UNCOUNTED — the tally was printed in line and was already fixed",
  classifyOutput(`  ok  one\n\n1/1 passed\n${MARKER}\n`, true) === "uncounted"
);

ok(
  "no marker but a banner present is INERT — the suite completed and exited before reaching it",
  classifyOutput(`  ok  one\n\n1/1 passed\n`, false) === "inert"
);

/*
 * THE ONE THAT WAS WRONG, AND IT IS THE DANGEROUS DIRECTION. A suite that never executed prints
 * neither a marker nor a banner, and the first version returned "inert" for it — the property
 * under test — rather than "I could not measure this".
 */
ok(
  "NO BANNER AT ALL is UNREADABLE, not inert — a suite that never ran is not a suite that exited early",
  classifyOutput(
    `node:internal/modules/…\nError [ERR_MODULE_NOT_FOUND]: Cannot find package 'prettier'\n`,
    false
  ) === "unreadable"
);

ok(
  "THE COMPANION: an empty output is unreadable too, so the distinction is not a property of the error text",
  classifyOutput("", false) === "unreadable"
);

/* ---- the roster set logic ------------------------------------------------------------------ */

const roster = {
  affected: { "a.selftest.mjs": "inert", "b.selftest.mjs": "uncounted" },
};

ok(
  "newcomers are the files the roster has never seen",
  newcomers(
    ["a.selftest.mjs", "b.selftest.mjs", "c.selftest.mjs"],
    roster
  ).join() === "c.selftest.mjs"
);

ok(
  "a rostered file still present is NOT a newcomer, whatever its recorded verdict",
  newcomers(["a.selftest.mjs"], roster).length === 0
);

ok(
  "departed names rostered files gone from the tree — a record, not a finding",
  departed(["a.selftest.mjs"], roster).join() === "b.selftest.mjs"
);

/* ---- assembled: the real checker against a throwaway tree ---------------------------------- */

const trees = [];
/** A scripts/ tree carrying the checker, a roster, and whatever selftests are asked for. */
function tree(files, rosterAffected = {}) {
  const root = mkdtempSync(join(tmpdir(), "arm-visibility-"));
  trees.push(root);
  mkdirSync(join(root, "scripts", "lib"), { recursive: true });
  cpSync(
    CHECKER,
    join(root, "scripts", "assert-selftest-arms-are-visible.mjs")
  );
  cpSync(
    join(HERE, "lib", "subject.mjs"),
    join(root, "scripts", "lib", "subject.mjs")
  );
  cpSync(
    join(HERE, "lib", "refusal.mjs"),
    join(root, "scripts", "lib", "refusal.mjs")
  );
  cpSync(
    join(HERE, "lib", "print-then-rank.mjs"),
    join(root, "scripts", "lib", "print-then-rank.mjs")
  );
  // #1173: the declared check parses with typescript.
  symlinkSync(
    join(HERE, "..", "node_modules"),
    join(root, "node_modules"),
    "dir"
  );
  writeFileSync(
    join(root, "scripts", "selftest-arm-visibility.json"),
    JSON.stringify({
      measuredAt: "0".repeat(40),
      on: "2026-01-01",
      affected: rosterAffected,
    })
  );
  for (const [name, body] of Object.entries(files))
    writeFileSync(join(root, "scripts", name), body);
  return root;
}
function run(root, ...args) {
  try {
    return {
      code: 0,
      out: execFileSync(
        process.execPath,
        [
          join(root, "scripts", "assert-selftest-arms-are-visible.mjs"),
          ...args,
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
      ),
    };
  } catch (e) {
    return { code: e.status, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/** A suite whose banner comes from an exit hook — an appended arm runs AND is counted. */
const SAFE = `const EXPECTED = 1;\nlet n = 0;\nn++;\nprocess.on("exit", () => {\n  if (n !== EXPECTED) process.exitCode = 1;\n  console.log(\`\\n\${n}/\${n} passed\`);\n});\n`;
/** DEV1's F1 (#1173): counted, NOT declared — an appended arm runs, is tallied, and nothing refuses. */
const COUNTED_UNDECLARED = `let n = 0;\nn++;\nprocess.on("exit", () => console.log(\`\\n\${n}/\${n} passed\`));\n`;
/** DEV1's F2 (#1173): declared, NOT counted — the arm never runs, so the declaration is vacuous. */
const DECLARED_INERT = `const EXPECTED = 1;\nlet n = 0;\nn++;\nprocess.on("exit", () => {\n  if (n !== EXPECTED) process.exitCode = 1;\n});\nconsole.log(\`\\n\${n}/\${n} passed\`);\nprocess.exit(0);\n`;
/** A suite that prints its banner and then exits in line — an appended arm never runs. */
const INERT = `let n = 0;\nn++;\nconsole.log(\`\\n\${n}/\${n} passed\`);\nprocess.exit(0);\n`;
/** A suite that prints its banner in line and does not exit — an appended arm runs, uncounted. */
const UNCOUNTED = `let n = 0;\nn++;\nconsole.log(\`\\n\${n}/\${n} passed\`);\n`;
/** A file that cannot run at all. */
const BROKEN = `import "definitely-not-a-real-package";\n`;

{
  const r = run(tree({ "new.selftest.mjs": SAFE }));
  ok(
    "ASSEMBLED: a NEW selftest that is safe passes, so the ratchet is not `flag every newcomer`",
    r.code === 0 && /none of which joined the class/.test(r.out),
    `exit ${r.code}`
  );
}

{
  const r = run(tree({ "new.selftest.mjs": INERT }));
  ok(
    "ASSEMBLED: a NEW selftest whose appended arm never runs FAILS and names it",
    r.code === 1 &&
      r.out.includes("new.selftest.mjs") &&
      /NEVER RUNS/.test(r.out),
    `exit ${r.code}`
  );
}

{
  const r = run(tree({ "new.selftest.mjs": UNCOUNTED }));
  ok(
    "ASSEMBLED: a NEW selftest whose arm runs but is not counted FAILS too — both shapes, not just the loud one",
    r.code === 1 && /NOT COUNTED/.test(r.out),
    `exit ${r.code}`
  );
}

{
  /*
   * THE ARM THIS FILE EXISTS FOR. An unmeasurable newcomer must REFUSE, not be reported as having
   * joined the class. Exit 2 and exit 1 are different answers and only one of them accuses a file.
   */
  const r = run(tree({ "new.selftest.mjs": BROKEN }));
  ok(
    "ASSEMBLED: a NEW selftest that cannot run at all REFUSES (exit 2) rather than being called inert",
    r.code === 2 && /no usable verdict|no verdict/.test(r.out),
    `exit ${r.code}: ${r.out.split("\n")[0]}`
  );
}

{
  const r = run(
    tree({ "old.selftest.mjs": INERT }, { "old.selftest.mjs": "inert" })
  );
  ok(
    "ASSEMBLED: a rostered file is not re-litigated — the backlog is tracked by #1122, not gated here",
    r.code === 0,
    `exit ${r.code}`
  );
}

{
  const root = tree({});
  const r = run(root);
  ok(
    "ASSEMBLED: an empty scripts/ REFUSES — a pass over no selftests asserts nothing",
    r.code === 2 && /asserts nothing|absent set/.test(r.out),
    `exit ${r.code}`
  );
}

{
  const root = tree({ "new.selftest.mjs": SAFE });
  rmSync(join(root, "scripts", "selftest-arm-visibility.json"));
  const r = run(root);
  ok(
    "ASSEMBLED: no roster REFUSES — without it every file reads as new and the finding is the whole class",
    r.code === 2 && /no roster/.test(r.out),
    `exit ${r.code}`
  );
}

{
  const r = run(tree({ "new.selftest.mjs": INERT }));
  ok(
    "a FAILING run reports its subject, so the record says what was examined (#1030)",
    r.out.split("\n").filter((l) => l.startsWith("SUBJECT:")).length === 1,
    r.out.split("\n").find((l) => l.startsWith("SUBJECT:")) ?? "no SUBJECT line"
  );
}

{
  const r = run(tree({ "new.selftest.mjs": BROKEN }));
  ok(
    "...and a REFUSAL reports none, because it did not examine the set it would be claiming",
    r.out.split("\n").filter((l) => l.startsWith("SUBJECT:")).length === 0
  );
}

/* ---- a signalled run's scratch file must not become a finding (#1147) --------------------- */

/*
 * `finally` covers a throw and a return, not a SIGNAL — measured, SIGINT and SIGTERM both leave
 * the sibling copy behind. Its name ends in `.selftest.mjs` because it has to, so before this it
 * was enumerated as a subject, treated as new, classified as whatever it was copied from, and
 * REPORTED AS A FILE THAT JOINED THE CLASS. Driven: one planted stray took the subject from 106
 * to 108 and failed the run, naming a file nobody wrote.
 *
 * The arms below cover the two deterministic layers. The signal handler is the third and is
 * deliberately not the one under test — if it ever fails, these two make the consequence inert
 * rather than accusatory, which is the property worth pinning.
 */
{
  const read = () => [
    "assert-real.selftest.mjs",
    ".arm-visibility-probe.assert-real.selftest.mjs",
  ];
  ok(
    "a scratch copy is NOT enumerated as a subject, though its name ends in .selftest.mjs",
    selftestsIn("ignored", read).join() === "assert-real.selftest.mjs"
  );
  ok(
    "...and strayScratch names exactly the file the other one dropped, so the sweep has a subject",
    strayScratch("ignored", read).join() ===
      ".arm-visibility-probe.assert-real.selftest.mjs"
  );
}

{
  const root = tree({ "new.selftest.mjs": SAFE });
  writeFileSync(
    join(root, "scripts", ".arm-visibility-probe.old.selftest.mjs"),
    INERT
  );
  const r = run(root);
  ok(
    "ASSEMBLED: a stray from an interrupted run does not become a finding — it is swept, not accused",
    r.code === 0 && !r.out.includes(".arm-visibility-probe"),
    `exit ${r.code}`
  );
  ok(
    "...and it is gone afterwards, so strays cannot accumulate across runs",
    strayScratch(join(root, "scripts")).length === 0
  );
}

/* ---- a signal ENDS the run (#1190) -------------------------------------------------------- */

/*
 * THE HANDLER IS UNDER TEST HERE, which the #1147 block above deliberately left out -- and #1190
 * is why that was not enough. A listener registered in a program that never yields cannot run:
 * this checker once went on to print PASS and exit 0 after a SIGTERM, because every probe blocked
 * in `execFileSync`. So a real run is started on a selftest that takes seconds, signalled while
 * its copy is on disk, and must die BY that signal promptly and leave nothing behind. Two arms,
 * not one, so that a failure says which half broke.
 */
{
  const SLOW = `setTimeout(() => console.log("\\n1/1 passed"), 8000);\n`;
  const root = tree({ "slow.selftest.mjs": SLOW });
  const copy = join(root, "scripts", ".arm-visibility-probe.slow.selftest.mjs");
  const child = spawn(
    process.execPath,
    [join(root, "scripts", "assert-selftest-arms-are-visible.mjs")],
    { stdio: "ignore" }
  );
  const ended = new Promise((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal }))
  );
  const t0 = Date.now();
  while (!existsSync(copy) && Date.now() - t0 < 10000)
    await new Promise((r) => setTimeout(r, 25));
  const inFlight = existsSync(copy);
  const sent = Date.now();
  child.kill("SIGTERM");
  const res = await Promise.race([
    ended,
    new Promise((r) => setTimeout(() => r(null), 3000)),
  ]);
  const took = Date.now() - sent;
  const copyAfter = existsSync(copy);
  if (res === null) child.kill("SIGKILL");
  ok(
    "a SIGTERM while a probe is in flight ENDS the run by that signal, promptly -- not a PASS once the probe finishes (#1190)",
    inFlight && res !== null && res.signal === "SIGTERM" && took < 2000,
    `probe in flight: ${inFlight}; ${
      res
        ? `ended code=${res.code} signal=${res.signal}`
        : "NOT ended within 3s"
    } after ${took}ms`
  );
  ok(
    "...and the copy it had in flight is gone, removed by the handler rather than left for the next sweep",
    inFlight && res !== null && !copyAfter,
    `copy on disk afterwards: ${copyAfter}`
  );
}

for (const t of trees) rmSync(t, { recursive: true, force: true });

/*
 * 23 cases. The four added by #1147 are the scratch-file pair and its assembled companions; the
 * two added by #1190 deliver a real SIGTERM to a real run. The count guard is deliberately in an exit hook rather than in line, so an arm
 * appended below it still runs and is still counted — this file must not be a member of the class
 * it polices, and #1119's repair is the shape being copied.
 */

/* ---- #1202: the banners this repo actually prints ------------------------------------------- */
{
  // Verbatim final lines of DEV1's nine, captured from each file's own stdout (as probe() reads it).
  const REAL_PASSING = [
    "9 passed, 0 failed",
    "11 passed, 0 failed",
    "14 passed, 0 failed",
    "10 passed, 0 failed",
    "all selftests passed.",
    "11 passed, 0 failed",
    "all 19 selftest cases passed. Watched: a card that exists with nothing mounting it REJECTED,",
    "all selftest cases passed — 1 recorded HOLE(s), which are NOT passes",
    "31 passed, 0 failed",
  ];
  const unread = REAL_PASSING.filter(
    (b) => classifyOutput(`  ok  one\n${MARKER}\n\n${b}\n`, true) !== "counted"
  );
  ok(
    "#1202: each of the nine real banners is read, and with the marker above it the file is counted",
    unread.length === 0,
    unread.length ? `NOT read: ${JSON.stringify(unread)}` : "9/9"
  );
  // The same files' failing summaries, from their closing statements: a failing run is readable too.
  const FAILING = [
    "3 passed, 2 failed",
    "2 selftest(s) FAILED.",
    "2 case(s) FAILED",
    "2 of 19 selftest case(s) FAILED",
  ];
  const unreadF = FAILING.filter(
    (b) => classifyOutput(`  ok  one\n${MARKER}\n\n${b}\n`, true) !== "counted"
  );
  ok(
    "#1202: ...and so is each form's FAILING summary",
    unreadF.length === 0,
    unreadF.length ? `NOT read: ${JSON.stringify(unreadF)}` : "4/4"
  );
  // Real per-case lines from the same files: a verdict pattern that matched these would make
  // `unreadable` unreachable and read every case as a banner.
  const LOOKALIKES = [
    "  PASS  citing an allowlisted row makes its UNCITED entry STALE and FAILS",
    "  OK   CLI exits 1 when invoked THROUGH A SYMLINK  (findings=1, expected=1)",
    "  ok   8 an unreadable export -> REFUSES -> exit 2",
    "        a tag named only in a comment NOT counted as a mount, another unmounted component NOT",
  ];
  const misread = LOOKALIKES.filter(
    (l) => classifyOutput(`${l}\n${MARKER}\n`, true) !== "unreadable"
  );
  ok(
    "#1202: ...while their real PER-CASE lines are still not banners",
    misread.length === 0,
    misread.length
      ? `read as a banner: ${JSON.stringify(misread)}`
      : "4/4 still unreadable"
  );
}

{
  /*
   * ONE SYNTHETIC LOOKALIKE PER ANCHOR (#1202, DEV1's control gap). The real per-case lines above
   * carry no prose form mid-line, so dropping a column-0 anchor survived the suite 28/28. Each line
   * here holds exactly ONE form, mid-line, so loosening one anchor fails exactly one of these arms.
   */
  const midLine = (l) => classifyOutput(`${l}\n${MARKER}\n`, true);
  const TALLY = "  ok   2 retries: 3 passed, 1 failed before the fix landed";
  const PROSE_PASS = "  note: all selftests passed on a warm cache";
  const PROSE_FAIL = "  ok   3 case(s) FAILED before retry";
  ok(
    "#1202: the TALLY form is anchored: `3 passed, 1 failed` mid-line is not a banner",
    midLine(TALLY) === "unreadable",
    midLine(TALLY)
  );
  ok(
    "#1202: the prose PASS form is anchored: `all selftests passed` mid-line is not a banner",
    midLine(PROSE_PASS) === "unreadable",
    midLine(PROSE_PASS)
  );
  ok(
    "#1202: the prose FAILED form is anchored: `3 case(s) FAILED` mid-line is not a banner",
    midLine(PROSE_FAIL) === "unreadable",
    midLine(PROSE_FAIL)
  );
}

{
  // --refresh names what it could not read, and still writes the rest (#1202).
  const root = tree({
    "readable-inert.selftest.mjs": INERT,
    "silent.selftest.mjs": `console.log("no verdict line here");\n`,
  });
  const g = (...a) => execFileSync("git", a, { cwd: root, stdio: "ignore" });
  g("init", "--quiet");
  g("config", "user.email", "probe@example.invalid");
  g("config", "user.name", "probe");
  g("add", "-A");
  g("commit", "--quiet", "-m", "fixture");
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const r = run(root, "--refresh");
  const roster = JSON.parse(
    readFileSync(join(root, "scripts", "selftest-arm-visibility.json"), "utf8")
  );
  ok(
    "#1202: --refresh NAMES the file it could not read, and says why, instead of dropping it",
    r.code === 2 &&
      /COULD NOT MEASURE 1 selftest/.test(r.out) &&
      r.out.includes("silent.selftest.mjs"),
    `code=${r.code} ${
      r.out.split("\n").find((l) => /COULD NOT|REFUS/.test(l)) ?? ""
    }`
  );
  ok(
    "#1202: ...and still WRITES the rest: re-measured at this head, the unreadable one left out",
    roster.measuredAt === head &&
      roster.affected["readable-inert.selftest.mjs"] === "inert" &&
      !("silent.selftest.mjs" in roster.affected), // never given a verdict
    JSON.stringify({
      measuredAt: roster.measuredAt.slice(0, 8),
      affected: roster.affected,
    })
  );
}

{
  /*
   * DEV1'S S0-S1-S2 (#1202). S0: a roster that has long held old.selftest.mjs as inert, and the real
   * INERT file. S1: --refresh while the file prints no banner. S2: the file restored, then an
   * ordinary run. A member that could not be measured at refresh must NOT come back as a new
   * arrival that joined the class. The run must refuse, naming it and --refresh.
   */
  const root = tree(
    { "old.selftest.mjs": INERT },
    { "old.selftest.mjs": "inert" }
  );
  const g = (...a) => execFileSync("git", a, { cwd: root, stdio: "ignore" });
  g("init", "--quiet");
  g("config", "user.email", "probe@example.invalid");
  g("config", "user.name", "probe");
  g("add", "-A");
  g("commit", "--quiet", "-m", "S0");
  const file = join(root, "scripts", "old.selftest.mjs");
  writeFileSync(file, `console.log("no verdict line here");\n`);
  const s1 = run(root, "--refresh");
  const s1Roster = JSON.parse(
    readFileSync(join(root, "scripts", "selftest-arm-visibility.json"), "utf8")
  );
  writeFileSync(file, INERT);
  const s2 = run(root);
  ok(
    "#1202 S0-S1-S2: a member unmeasured at refresh is REFUSED by name on the next run, not failed as NEW",
    s2.code === 2 &&
      s2.out.includes("old.selftest.mjs") &&
      /--refresh/.test(s2.out) &&
      !/joined the #1122 class/.test(s2.out),
    JSON.stringify({
      s1: s1.code,
      s1Roster: {
        affected: s1Roster.affected,
        unmeasured: s1Roster.unmeasured,
      },
      s2: s2.code,
      s2Says: s2.out.split("\n").find((l) => /REFUS|FAIL/.test(l)) ?? "",
    })
  );
}

{
  /*
   * A STALLED NEWCOMER DOES NOT HIDE ONE THAT JOINED (#1215, DEV1's fixture). The stalled file used
   * to return 2 before `joined` was printed, so the inert newcomer beside it was never reported.
   */
  const r = run(
    tree({ "a-inert.selftest.mjs": INERT, "b-broken.selftest.mjs": BROKEN })
  );
  ok(
    "#1215: an inert newcomer beside one that cannot run exits 1, the inert one REPORTED, no PASS",
    r.code === 1 &&
      /joined the #1122 class/.test(r.out) &&
      /a-inert\.selftest\.mjs/.test(r.out) &&
      !/^PASS:/m.test(r.out),
    `exit ${r.code}: ${r.out
      .split("\n")
      .filter((l) => /FAIL|REFUS|PASS/.test(l))
      .join(" | ")}`
  );
  ok(
    "#1215: ...and the one that cannot run is still named under REFUSING",
    /REFUSING:[\s\S]*b-broken\.selftest\.mjs/.test(r.out),
    r.out.slice(0, 300)
  );
}

/* ---- #1173: declared, not only counted --------------------------------------------------- */
{
  const silent = [
    `const EXPECTED = 3;\nlet pass = 0;\nprocess.on("exit", () => { console.log(pass); });\n`,
    `let pass = 0;\n// const EXPECTED = 3;\nprocess.on("exit", () => { /* EXPECTED */ console.log(pass); });\n`,
    `const NAME = "x";\nlet pass = 0;\nprocess.on("exit", () => { console.log(NAME, pass); });\n`,
  ];
  ok(
    "#1173: declaresCount is FALSE for an unread const, a count only in comments, and a string const",
    silent.every((s) => declaresCount(s) === false)
  );
}
{
  const declared = [
    `const EXPECTED = 3;\nlet pass = 0;\nprocess.on("exit", () => { if (pass !== EXPECTED) process.exitCode = 1; });\n`,
    `const M = "";\nconst EXPECTED = M === "" ? 105 : 102;\nlet pass = 0;\nprocess.on("exit", () => { if (pass !== EXPECTED) process.exitCode = 1; });\n`,
  ];
  ok(
    "#1173: declaresCount is TRUE for a literal count and for eject-subject-audit's TERNARY count",
    declared.every((s) => declaresCount(s) === true)
  );
}
ok(
  "#1173: a hook that reads only its own tallies declares nothing, however it compares them",
  declaresCount(
    `let pass = 0, fail = 0;\nprocess.on("exit", () => { const total = pass + fail; if (fail !== 0) process.exitCode = 1; console.log(total); });\n`
  ) === false
);
{
  const r = run(tree({ "new.selftest.mjs": COUNTED_UNDECLARED }));
  ok(
    "#1173 ASSEMBLED: a selftest that COUNTS but does not DECLARE fails and names it (DEV1's F1)",
    r.code === 1 &&
      r.out.includes("new.selftest.mjs") &&
      /DECLARE no count/.test(r.out) &&
      !/NEVER RUNS/.test(r.out),
    `exit ${r.code}`
  );
}
{
  const r = run(tree({ "new.selftest.mjs": DECLARED_INERT }));
  ok(
    "#1173 ASSEMBLED: DECLARED but inert is still reported NEVER RUNS, so a declaration masks nothing (DEV1's F2)",
    r.code === 1 && /NEVER RUNS/.test(r.out) && !/DECLARE no count/.test(r.out),
    `exit ${r.code}`
  );
}

const EXPECTED = 39;
process.on("exit", (code) => {
  const ran = pass + fail;
  if (fail !== 0) {
    console.log(`\n${pass}/${ran} passed`);
    console.log(`FAIL: ${fail}/${ran} case(s) wrong.`);
    process.exitCode = 1;
    return;
  }
  if (code === 0 && ran !== EXPECTED) {
    console.log(
      `\nFAIL: ran ${ran} cases, expected ${EXPECTED} — a case was added or lost. An arm below ` +
        `this point is NOT inert: every result is counted at exit, so if the new arms pass, ` +
        `update the constant.`
    );
    process.exitCode = 1;
    return;
  }
  if (code !== 0) return;
  console.log(
    `\nPASS: ${pass}/${ran}. A newcomer that cannot be measured REFUSES rather than being\n` +
      `      accused, both shapes of the class are caught, and a safe newcomer passes.`
  );
});
