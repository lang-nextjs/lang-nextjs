/**
 * PROOF for assert-eject-subjects-classified.mjs (#755).
 *
 * The gate's whole job is to be TOTAL and CHEAP: every registered checker has a
 * classification, or the census has not been run. So the cases that matter are
 * the ones where it must REFUSE to pass — a missing entry, a stale entry, a
 * `static` with no reason, and an absent census file.
 *
 * THE ACCEPT ARM IS NOT OPTIONAL. A gate that fails on everything satisfies every
 * red case here and is useless. The pass case is what makes the reds mean
 * something.
 */
import {
  reconcile,
  noteComplaints,
  registeredCheckers,
} from "./assert-eject-subjects-classified.mjs";
import { STATIC } from "./lib/eject-classify.mjs";

let pass = 0,
  fail = 0;
const ok = (label, cond, got) => {
  if (cond) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label} — got ${JSON.stringify(got)}`);
  }
};

const CHECKS = {
  checks: [
    {
      name: "alpha",
      checker: "scripts/a.mjs",
      proof: "scripts/a.selftest.mjs",
    },
    { name: "beta", checker: "scripts/b.mjs", proof: "scripts/b.selftest.mjs" },
    { name: "no-checker-entry", proof: "scripts/c.selftest.mjs" },
  ],
};

ok(
  "only entries with a checker are registered — a proof-only entry has no subject to classify",
  JSON.stringify(registeredCheckers(CHECKS)) ===
    JSON.stringify(["alpha", "beta"]),
  registeredCheckers(CHECKS)
);

/* ── THE GATE'S TWO DIRECTIONS ─────────────────────────────────────────────── */

ok(
  "a registered checker with no census entry is UNCLASSIFIED",
  reconcile(["alpha", "beta"], {
    checkers: { alpha: { verdict: "moved" } },
  }).unclassified.join() === "beta",
  reconcile(["alpha", "beta"], { checkers: { alpha: { verdict: "moved" } } })
);

/*
 * THE SECOND DIRECTION, and it is the one a one-way gate would miss. A census
 * that can keep entries for checkers that no longer exist accumulates `static`
 * notes about deleted files — and a stale justification reads exactly like a
 * live one.
 */
ok(
  "a census entry for a checker no longer registered is ORPHANED",
  reconcile(["alpha"], {
    checkers: { alpha: { verdict: "moved" }, gone: { verdict: STATIC } },
  }).orphaned.join() === "gone",
  reconcile(["alpha"], {
    checkers: { alpha: { verdict: "moved" }, gone: { verdict: STATIC } },
  })
);

ok(
  "THE ACCEPT ARM: a census that covers exactly the registry complains about neither",
  (() => {
    const r = reconcile(["alpha", "beta"], {
      checkers: { alpha: {}, beta: {} },
    });
    return r.unclassified.length === 0 && r.orphaned.length === 0;
  })(),
  reconcile(["alpha", "beta"], { checkers: { alpha: {}, beta: {} } })
);

/* ── THE `lifts` CONTRACT ──────────────────────────────────────────────────── */

ok(
  "a `static-under-eject-langchain` with no note is refused — a note that can be omitted is one nobody writes",
  noteComplaints({ checkers: { a: { verdict: STATIC, lifts: null } } })
    .length === 1,
  noteComplaints({ checkers: { a: { verdict: STATIC, lifts: null } } })
);

ok(
  "a `static-under-eject-langchain` whose lifts is neither null nor #NNN is refused",
  noteComplaints({
    checkers: { a: { verdict: STATIC, note: "why", lifts: "later" } },
  }).length === 1,
  noteComplaints({
    checkers: { a: { verdict: STATIC, note: "why", lifts: "later" } },
  })
);

ok(
  'lifts: null (permanent) and lifts: "#785" (pending) are BOTH accepted',
  noteComplaints({
    checkers: {
      a: { verdict: STATIC, note: "domain is fixtures", lifts: null },
      b: { verdict: STATIC, note: "not yet established", lifts: "#785" },
    },
  }).length === 0,
  noteComplaints({
    checkers: {
      a: { verdict: STATIC, note: "domain is fixtures", lifts: null },
      b: { verdict: STATIC, note: "not yet established", lifts: "#785" },
    },
  })
);

/*
 * THE COMPANION THAT STOPS THE NOTE RULE FIRING ON EVERYTHING. Only `static`
 * carries a note — a `moved` needs no justification, and requiring one would
 * make every verdict carry prose and the prose stop being read.
 */
ok(
  "a non-static verdict needs no note",
  noteComplaints({
    checkers: {
      a: { verdict: "moved" },
      b: { verdict: "absent" },
      c: { verdict: "broken" },
    },
  }).length === 0,
  noteComplaints({
    checkers: {
      a: { verdict: "moved" },
      b: { verdict: "absent" },
      c: { verdict: "broken" },
    },
  })
);

const EXPECTED = 8;
const total = pass + fail;
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
  const ran = pass + fail;
  if (code === 0 && ran !== EXPECTED) {
    console.log(
      `\nFAIL: ran ${ran} assertions, expected ${EXPECTED} — a case was added or lost.`
    );
    process.exitCode = 1;
  }
});
console.log(`\n${pass}/${total} passed`);
process.exit(fail === 0 ? 0 : 1);
