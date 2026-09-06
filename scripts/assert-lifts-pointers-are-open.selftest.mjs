/**
 * PROOF FOR assert-lifts-pointers-are-open.mjs — it fires on a closed pointer, and stays
 * silent on the cases it must not fire on (#824).
 *
 * `stateOf` is INJECTED in every arm, so the failing paths are driven without touching the
 * board. A checker whose only red requires a live, shared, throttled API is one nobody has
 * watched fail — and tonight that API is refusing calls while reporting full headroom.
 *
 * THE VACUOUS CASE IS AN ARM, not an assumption. Today the tree has zero pointers, so the
 * checker passes over an empty domain. That is the right answer and it is also exactly the
 * shape that hides a broken query, so "no pointers" and "pointers, all open" are separate
 * arms with different expected reasons.
 */
import {
  pointers,
  censusPointers,
  pointerComplaints,
} from "./assert-lifts-pointers-are-open.mjs";

let pass = 0;
const results = [];
const ok = (name, cond, detail) => {
  results.push({ name, ok: cond, detail });
  if (cond) pass++;
};

console.log(
  "\nassert-lifts-pointers-are-open — the pointer half, driven without the board\n"
);

/* ── extracting the pointers ────────────────────────────────────────────── */
{
  const cfg = {
    unregistered: [
      { checker: "scripts/a.mjs", lifts: null },
      { checker: "scripts/b.mjs", lifts: "#780" },
      { checker: "scripts/c.mjs", lifts: "#12" },
    ],
  };
  ok(
    "only entries with a pointer are collected — `null` is not a pointer",
    pointers(cfg).length === 2 &&
      pointers(cfg).every((p) => p.issue.startsWith("#")),
    JSON.stringify(pointers(cfg))
  );
  ok(
    "...and a file with no unregistered list yields none (the companion)",
    pointers({}).length === 0,
    "invented a pointer"
  );
}

/* ── the census source (#835) ───────────────────────────────────────────── */
{
  const census = {
    checkers: {
      a: { verdict: "static-under-eject-langchain", lifts: null },
      b: { verdict: "static-under-eject-langchain", lifts: "#780" },
      c: { verdict: "moved" },
    },
  };
  const fromChecks = pointers({
    unregistered: [{ checker: "x", lifts: "#1" }],
  });
  ok(
    "census pointers are collected; `null` and an ABSENT field are both not pointers",
    censusPointers(census).length === 1 &&
      censusPointers(census)[0].issue === "#780" &&
      censusPointers(census)[0].checker === "b",
    JSON.stringify(censusPointers(census))
  );
  ok(
    "...and a census with no checkers yields none (the companion)",
    censusPointers({}).length === 0,
    "invented a pointer"
  );
  ok(
    "each source TAGS its pointers, so a complaint can say which artifact to open",
    censusPointers(census)[0].source === "scripts/eject-subject-census.json" &&
      fromChecks[0].source === "scripts/checks.json",
    JSON.stringify([censusPointers(census)[0], fromChecks[0]])
  );
  const named = pointerComplaints(
    [
      {
        source: "scripts/eject-subject-census.json",
        checker: "b",
        issue: "#780",
      },
    ],
    () => "CLOSED"
  ).violations;
  ok(
    "a complaint NAMES ITS SOURCE — two files share this field name and the reader has to know which to open",
    named.length === 1 &&
      named[0].includes("scripts/eject-subject-census.json"),
    named[0]
  );
}

/* ── the verdict ────────────────────────────────────────────────────────── */
const OPEN = () => "OPEN";
const CLOSED = () => "CLOSED";
const UNASKABLE = () => null;
const found = [{ checker: "scripts/b.mjs", issue: "#780" }];

ok(
  "a CLOSED issue in `lifts` is caught — #824's own incident, inverted",
  pointerComplaints(found, CLOSED).violations.length === 1 &&
    /is CLOSED/.test(pointerComplaints(found, CLOSED).violations[0]),
  JSON.stringify(pointerComplaints(found, CLOSED))
);
ok(
  "...and an OPEN one is not (the companion)",
  pointerComplaints(found, OPEN).violations.length === 0 &&
    pointerComplaints(found, OPEN).refusals.length === 0,
  "flagged an open issue"
);
ok(
  "a board that could not be asked is a COMPLAINT, not a pass",
  pointerComplaints(found, UNASKABLE).refusals.length === 1 &&
    /could not be asked/.test(pointerComplaints(found, UNASKABLE).refusals[0]),
  "an unanswerable query was treated as agreement — the #810 shape"
);
ok(
  "the message names WHICH entry and WHICH issue, not just that something is wrong",
  /scripts\/b\.mjs/.test(pointerComplaints(found, CLOSED).violations[0]) &&
    /#780/.test(pointerComplaints(found, CLOSED).violations[0]),
  pointerComplaints(found, CLOSED).violations[0]
);
ok(
  "zero pointers raises nothing, and does so WITHOUT asking the board",
  (() => {
    let asked = 0;
    const counting = () => {
      asked++;
      return "OPEN";
    };
    const out = pointerComplaints([], counting);
    return (
      out.violations.length === 0 && out.refusals.length === 0 && asked === 0
    );
  })(),
  "an empty domain still cost a call to a throttled shared API"
);

ok(
  "an unreachable board is a REFUSAL and NOT a violation — exit 2, not exit 1, so a " +
    "throttle cannot report healthy pointers as stale (#844)",
  pointerComplaints(found, UNASKABLE).refusals.length === 1 &&
    pointerComplaints(found, UNASKABLE).violations.length === 0,
  JSON.stringify(pointerComplaints(found, UNASKABLE))
);

/* ── report ─────────────────────────────────────────────────────────────── */
let printed = 0;
for (const r of results) {
  printed++;
  console.log(
    `  ${r.ok ? "ok  " : "FAIL"} ${r.name.padEnd(74)} ${
      r.ok ? "" : `(${r.detail})`
    }`
  );
}

const total = results.length;
const EXPECTED = 12; // 7 + 4 for #835 + 1 for the #844 refusal split
/*
 * THE COUNT GUARD RUNS AT EXIT, NOT IN LINE (#836).
 *
 * It used to sit here as a plain `if`, so it ran at THIS POINT in the file and saw
 * only the cases above it. Both occurrences of the defect were created by appending a
 * case at the END of the file — which is after the guard, because the guard IS the
 * summary block at the end. The count then matched the cases the guard could see and
 * the suite reported "PASS: 14/8".
 *
 * Comparing the tally at the guard rather than via a hoisted binding does NOT fix
 * that: a case appended below the guard still runs after it. Only a hook firing at
 * EXIT sees everything, because nothing can be appended past process exit.
 *
 * `code === 0` MATTERS: without it this overwrites the exit code of a run that already
 * failed for a real reason, turning a genuine defect into a count complaint.
 */
process.on("exit", (code) => {
  const ran = results.length;
  /*
   * THE COUNT GUARD ASSERTS THE ARITHMETIC; THIS ASSERTS THE RENDERING (#881).
   *
   * `ran === EXPECTED` is true of a run whose results were never SHOWN. The report loop is
   * POSITIONAL — a case appended below it is recorded, counted, and invisible — and the count
   * guard was moved to exit precisely to escape that fragility. The loop never was, so the
   * guard bounds the arithmetic and nothing bounded the output.
   *
   * Two properties, two checks. Having built the first is what made the second feel
   * unnecessary.
   */
  if (code === 0 && printed !== ran) {
    console.error(
      `\nFAIL: ${ran} case(s) ran and ${printed} were printed — ${
        ran - printed
      } result(s) ` +
        `are INVISIBLE. A case below the report loop runs and counts; nothing shows it.`
    );
    process.exitCode = 1;
  }
  if (code === 0 && ran !== EXPECTED) {
    console.error(
      `\nFAIL: ran ${ran} case(s), expected ${EXPECTED} — the harness is broken.`
    );
    process.exitCode = 1;
  }
});
if (pass !== total) {
  console.error(`\nFAIL: ${pass}/${total}.`);
  process.exit(1);
}
console.log(
  `\nPASS: ${pass}/${total}. Every verdict is driven with an injected board, so the failing\n` +
    `      path has been watched failing rather than reasoned about.`
);
