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
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  classifyOutput,
  newcomers,
  departed,
  selftestsIn,
  strayScratch,
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
const SAFE = `let n = 0;\nn++;\nprocess.on("exit", () => console.log(\`\\n\${n}/\${n} passed\`));\n`;
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

for (const t of trees) rmSync(t, { recursive: true, force: true });

/*
 * 21 cases. The four added by #1147 are the scratch-file pair and its assembled companions. The count guard is deliberately in an exit hook rather than in line, so an arm
 * appended below it still runs and is still counted — this file must not be a member of the class
 * it polices, and #1119's repair is the shape being copied.
 */
const EXPECTED = 21;
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
