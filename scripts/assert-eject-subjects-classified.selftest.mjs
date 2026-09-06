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
  problemGroups,
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

/* ── #838: a remediation is a claim about what will fix THIS failure ────────── */

/*
 * The gate printed one `Fix:` line for every complaint, naming `pnpm eject-audit`. That is
 * true for a census that is merely STALE and false for a STATIC entry with no note, and
 * nothing at the point of the message said which one a reader had.
 *
 * Measured against the producer rather than read off the strings: feeding a newly STATIC
 * classification through merge(), then feeding its own output back in as the message
 * instructs, gives note = null on run 1, run 2 and run 3. A pre-existing note survives the
 * same call — so merge() CARRIES prose and never ORIGINATES it, and the command is
 * inapplicable to that branch rather than insufficient for it.
 *
 * These cases assert the PAIRING, which is the property the issue is about and the one a test
 * of the complaint strings alone cannot see. Both complaint texts were already correct; the
 * defect was entirely in which remedy each was printed beside.
 */
{
  /*
   * THE DISCRIMINATOR IS THE RECOMMENDATION, NOT THE MENTION. The hand-edit remedy NAMES
   * `pnpm eject-audit` on purpose — to say DO NOT RUN it — so a bare search for the command
   * matches the prohibition and the instruction alike. The first version of this case did
   * exactly that and failed on a correct message. What must not appear is the RECOMMENDATION.
   */
  const RECOMMENDS_AUDIT = /Fix: run `pnpm eject-audit`/;
  const FORBIDS_AUDIT = /DO NOT RUN `pnpm eject-audit`/;
  const HAND_FIX = /BY HAND/;

  const noteCase = problemGroups(["a"], {
    checkers: { a: { verdict: STATIC, note: null, lifts: null } },
  });
  const noteFix = noteCase.map((g) => g.fix).join("\n");
  ok(
    "a STATIC entry with no note is NOT told to run the audit",
    noteCase.length === 1 && !RECOMMENDS_AUDIT.test(noteFix),
    noteFix.split("\n")[0]
  );
  ok(
    "...and is told to edit the census by hand, and warned off the audit explicitly",
    HAND_FIX.test(noteFix) && FORBIDS_AUDIT.test(noteFix),
    noteFix.split("\n")[0]
  );

  /*
   * THE COMPANION, and without it the two above are satisfied by a gate that never names the
   * audit at all — which would break the remedy for the failure it is genuinely correct for.
   */
  const staleCase = problemGroups(["b"], { checkers: {} });
  const staleFix = staleCase.map((g) => g.fix).join("\n");
  ok(
    "...while an entry missing from the census IS told to run the audit",
    staleCase.length === 1 && RECOMMENDS_AUDIT.test(staleFix),
    staleFix.split("\n")[0]
  );

  /*
   * BOTH AT ONCE is the case the single line could not express: one reader, two failures, two
   * different remedies. A collapse back to one `Fix:` reds this and the two above.
   */
  const both = problemGroups(["a", "b"], {
    checkers: { a: { verdict: STATIC, note: null, lifts: null } },
  });
  const bothFix = both.map((g) => g.fix).join("\n");
  ok(
    "both kinds together print BOTH remedies, not one of them twice",
    both.length === 2 &&
      RECOMMENDS_AUDIT.test(bothFix) &&
      HAND_FIX.test(bothFix),
    `${both.length} group(s)`
  );
}

const EXPECTED = 12; // +4 for #838's remediation routing
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
