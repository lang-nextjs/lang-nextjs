/**
 * PROOF for eject-subject-audit.mjs (#755).
 *
 * The audit's guards are the point, not its arithmetic. Two of them exist because
 * the failure they prevent produces a CLEAN-LOOKING result:
 *
 *   vacuity        zero movers is what a failed eject or a failed install looks
 *                  like, and a census recorded from it asserts that no checker
 *                  responds to the tree.
 *   monotonicity   "one eject covers the ladder" is a plausible unproven premise.
 *                  Asserting it here is what makes it falsifiable.
 *
 * Each has a COMPANION, because a guard that fires on everything is a guard that
 * gets removed.
 */
import {
  checkersOf,
  vacuityComplaint,
  monotonicityComplaints,
  merge,
} from "./eject-subject-audit.mjs";
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

ok(
  "checkersOf keeps checker phases and drops proofs — a proof failing says nothing about a subject",
  JSON.stringify(
    Object.keys(
      checkersOf([
        { name: "a", phase: "checker" },
        { name: "a", phase: "proof" },
        { name: "b", phase: "checker" },
      ])
    )
  ) === JSON.stringify(["a", "b"]),
  Object.keys(
    checkersOf([
      { name: "a", phase: "checker" },
      { name: "a", phase: "proof" },
      { name: "b", phase: "checker" },
    ])
  )
);

/* ── VACUITY ───────────────────────────────────────────────────────────────── */

ok(
  "zero movers REFUSES, and the message names checks known to move",
  (() => {
    const m = vacuityComplaint({
      a: { verdict: STATIC },
      b: { verdict: "absent" },
    });
    return m !== null && /sibling-tests-are-owned/.test(m) && /53 -> 1/.test(m);
  })(),
  vacuityComplaint({ a: { verdict: STATIC }, b: { verdict: "absent" } })
);

ok(
  "THE COMPANION: one mover is enough, so the guard does not fire on a real census",
  vacuityComplaint({ a: { verdict: "moved" }, b: { verdict: STATIC } }) ===
    null,
  vacuityComplaint({ a: { verdict: "moved" }, b: { verdict: STATIC } })
);

/* ── MONOTONICITY ──────────────────────────────────────────────────────────── */

ok(
  "a subject that GREW under ejection is a violation, named by checker",
  (() => {
    const c = monotonicityComplaints({
      big: { verdict: "moved", full: 10, ejected: 12 },
    });
    return (
      c.length === 1 && /big/.test(c[0]) && /one-eject assumption/.test(c[0])
    );
  })(),
  monotonicityComplaints({ big: { verdict: "moved", full: 10, ejected: 12 } })
);

ok(
  "THE COMPANION: shrinking and unchanged subjects are not violations",
  monotonicityComplaints({
    a: { verdict: "moved", full: 10, ejected: 4 },
    b: { verdict: STATIC, full: 7, ejected: 7 },
    c: { verdict: "absent", full: 5, ejected: null },
  }).length === 0,
  monotonicityComplaints({
    a: { verdict: "moved", full: 10, ejected: 4 },
    b: { verdict: STATIC, full: 7, ejected: 7 },
    c: { verdict: "absent", full: 5, ejected: null },
  })
);

/* ── NOTE LIFECYCLE ────────────────────────────────────────────────────────── */

const prev = {
  checkers: {
    keeps: { verdict: STATIC, note: "domain is fixtures", lifts: null },
    moves: { verdict: STATIC, note: "stale reason", lifts: null },
  },
};

ok(
  "a note survives a re-run when the verdict is unchanged",
  merge(
    prev,
    { keeps: { verdict: STATIC, full: 5, ejected: 5, why: "w" } },
    "sha"
  ).checkers.keeps.note === "domain is fixtures",
  merge(
    prev,
    { keeps: { verdict: STATIC, full: 5, ejected: 5, why: "w" } },
    "sha"
  ).checkers.keeps
);

/*
 * THE ONE THAT MATTERS. `static -> moved` means the note describes a state that
 * no longer exists. The repair is to DELETE it, not to keep it beside a verdict
 * it contradicts — so the merge must not carry it across.
 */
ok(
  "a note is DROPPED when static-under-eject-langchain becomes moved — the repair is deletion, not tolerance",
  merge(
    prev,
    { moves: { verdict: "moved", full: 9, ejected: 4, why: "w" } },
    "sha"
  ).checkers.moves.note === undefined,
  merge(
    prev,
    { moves: { verdict: "moved", full: 9, ejected: 4, why: "w" } },
    "sha"
  ).checkers.moves
);

ok(
  "a NEW static-under-eject-langchain gets lifts #785 rather than a silent null — pending by default, not permanent",
  merge(
    null,
    { fresh: { verdict: STATIC, full: 3, ejected: 3, why: "w" } },
    "sha"
  ).checkers.fresh.lifts === "#785",
  merge(
    null,
    { fresh: { verdict: STATIC, full: 3, ejected: 3, why: "w" } },
    "sha"
  ).checkers.fresh
);

ok(
  "the census records BOTH the measurement sha and the durable base it was cut from",
  merge(
    null,
    { a: { verdict: "moved", full: 2, ejected: 1, why: "w" } },
    "d41664ca"
  ).measuredAt === "d41664ca" &&
    merge(
      null,
      { a: { verdict: "moved", full: 2, ejected: 1, why: "w" } },
      "d41664ca",
      "70fb8afa"
    ).base === "70fb8afa",
  merge(
    null,
    { a: { verdict: "moved", full: 2, ejected: 1, why: "w" } },
    "d41664ca"
  )
);

const EXPECTED = 9;
const total = pass + fail;
if (total !== EXPECTED) {
  console.log(
    `\nFAIL: ran ${total} assertions, expected ${EXPECTED} — a case was added or lost.`
  );
  process.exit(1);
}
console.log(`\n${pass}/${total} passed`);
process.exit(fail === 0 ? 0 : 1);
