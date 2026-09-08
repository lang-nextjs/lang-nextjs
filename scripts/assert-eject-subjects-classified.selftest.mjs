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
  retainedRows,
  staleNotes,
  retainedRepairs,
  renderRetainedRepairs,
  numbersInNote,
  unruledLifts,
  renderUnruledLifts,
} from "./assert-eject-subjects-classified.mjs";
import { staticFor } from "./lib/eject-classify.mjs";

// The default target, so the fixtures below read as the census on disk does.
// The #855 case at the bottom is the one that uses a different one.
const STATIC = staticFor("langchain");

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
   *
   * IT PASSES AGAINST THE COLLAPSED IMPLEMENTATION TOO, and saying so is what makes it a
   * GUARD rather than coverage. Restoring the single generic `Fix:` reds the other three and
   * leaves this one green, because the stale group's remedy is the thing that was already
   * right. A case that cannot fail under the mutation is not weak coverage — it is a
   * different instrument, and mislabelling it as coverage overstates what the suite proves.
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
  /*
   * THE DIAGNOSTIC NAMES WHICH TERM MISSED. This is a conjunction of three, and its first
   * version printed `${both.length} group(s)` — under the collapse mutation that renders
   * "2 group(s)", the value that is CORRECT, so the red arrived carrying evidence that reads
   * like a pass. A failure detail must describe the term that failed, not whichever one was
   * convenient to print.
   */
  const bothMissing = [
    both.length === 2 ? null : `groups=${both.length}, expected 2`,
    RECOMMENDS_AUDIT.test(bothFix) ? null : "no audit RECOMMENDATION present",
    HAND_FIX.test(bothFix) ? null : "no BY HAND remedy present",
  ].filter(Boolean);
  ok(
    "both kinds together print BOTH remedies, not one of them twice",
    bothMissing.length === 0,
    bothMissing.join("; ")
  );
}

/*
 * #855 — THE NOTE RULE IS NOT SWITCHABLE BY A FIELD.
 *
 * The static verdict names its target, so once `--rung` can move the target there is
 * no single string for this gate to compare against. Deciding which string by
 * reading the census's own `ejectTarget` was the available shortcut and it fails
 * OPEN: a census whose target is absent, stale or misspelt matches no row, skips
 * every one, and PASSES while asserting nothing. Reading the prefix off the verdict
 * cannot be switched off that way.
 *
 * The companion is the third case: the match must still be a verdict name and not
 * a loose startsWith on anything beginning with those words.
 */
ok(
  "a static verdict at a NON-default target is held to the note rule — a gate keyed to one target would pass a census it never examined",
  noteComplaints({
    ejectTarget: "deepagents",
    checkers: { a: { verdict: "static-under-eject-deepagents", lifts: null } },
  }).length === 1,
  noteComplaints({
    ejectTarget: "deepagents",
    checkers: { a: { verdict: "static-under-eject-deepagents", lifts: null } },
  })
);

ok(
  "...and it fires with a census carrying NO ejectTarget at all, which is the shape the shortcut would have passed silently",
  noteComplaints({
    checkers: { a: { verdict: "static-under-eject-deepagents", lifts: null } },
  }).length === 1,
  noteComplaints({
    checkers: { a: { verdict: "static-under-eject-deepagents", lifts: null } },
  })
);

ok(
  "COMPANION: the bare prefix is not a verdict — a target-less `static-under-eject` is not held to the rule, so the match is not a loose startsWith",
  noteComplaints({
    checkers: { a: { verdict: "static-under-eject", lifts: null } },
  }).length === 0,
  noteComplaints({
    checkers: { a: { verdict: "static-under-eject", lifts: null } },
  })
);

/* ── #854 + #875: the two axes of this checker, reported not complained about ── */
{
  const census = {
    checkers: {
      quiet: { verdict: STATIC, full: 7, ejected: 7, note: "n", lifts: null },
      moved: {
        verdict: "moved",
        full: 9,
        ejected: 3,
        retainedFrom: {
          note: "authored prose",
          lifts: "#780",
          verdict: STATIC,
        },
      },
      drifted: {
        verdict: STATIC,
        full: 54,
        ejected: 54,
        note: "domain is 53",
        lifts: null,
        noteWrittenAt: { sha: "a", full: 53, ejected: 53, noteDigest: "d" },
      },
      steady: {
        verdict: STATIC,
        full: 12,
        ejected: 12,
        note: "shape argument",
        lifts: null,
        noteWrittenAt: { sha: "a", full: 12, ejected: 12, noteDigest: "d" },
      },
    },
  };

  ok(
    "#854 DOMAIN: a row carrying a retention is surfaced, though the VERDICT skips it",
    retainedRows(census).length === 1 &&
      retainedRows(census)[0].name === "moved",
    retainedRows(census)
  );
  ok(
    "...and a row with nothing retained is NOT surfaced (the companion)",
    retainedRows(census).every((r) => r.name !== "quiet"),
    retainedRows(census)
  );
  /*
   * THE PRINTED FIELDS ARE ASSERTED, AND #917 IS THAT THEY WERE NOT. `retainedRows` returns
   * `chars` and `verdict`; the two rows above check only `name` and `length`. Both
   * `chars: 0` and `verdict: null` survived mutation on MERGED code. A value a checker prints
   * but nothing asserts can go wrong in silence, and it is worse than an unprinted one because a
   * reader takes what is printed for measured.
   */
  ok(
    "#917 the retained note's LENGTH is the note's, not a placeholder",
    retainedRows(census)[0].chars === "authored prose".length,
    retainedRows(census)
  );
  ok(
    "...and the retained VERDICT is carried through rather than nulled",
    retainedRows(census)[0].verdict === STATIC,
    retainedRows(census)
  );
  ok(
    "#875 PREDICATE: a note whose row has MOVED since the stamp is reported, with the delta",
    staleNotes(census).length === 1 &&
      staleNotes(census)[0].name === "drifted" &&
      staleNotes(census)[0].moved.join("; ").includes("full 53 -> 54"),
    staleNotes(census)
  );
  ok(
    "...and a note whose row has NOT moved is silent — otherwise it fires on everything",
    staleNotes(census).every((s) => s.name !== "steady"),
    staleNotes(census)
  );
  ok(
    "...and a note with NO stamp is silent rather than assumed stale (pre-#875 rows)",
    staleNotes({
      checkers: { old: { verdict: STATIC, full: 1, ejected: 2, note: "n" } },
    }).length === 0,
    "a row with no noteWrittenAt was reported"
  );
}

/* ── #917: the `ejected` half of the stale-note comparison ─────────────────────────────── */
{
  /*
   * A SEPARATE CENSUS, BECAUSE THE ONE ABOVE CANNOT TEST THIS. Its `drifted` row moves `full`
   * AND `ejected` together, so the `full` branch alone satisfies every assertion there —
   * deleting the `ejected` comparison outright left the whole suite green.
   *
   * Here `full` HOLDS and only `ejected` moves. That is the ordinary severability case, a
   * subject that shrinks under eject while the full tree is unchanged, so the branch with no
   * coverage was the one most likely to fire first in production.
   */
  const census = {
    checkers: {
      shrank: {
        verdict: STATIC,
        full: 12,
        ejected: 9,
        note: "the domain does not vary by rung",
        lifts: null,
        noteWrittenAt: { sha: "a", full: 12, ejected: 12, noteDigest: "d" },
      },
    },
  };
  ok(
    "#917 a note is stale when ONLY `ejected` moved — full holding does not excuse it",
    staleNotes(census).length === 1 &&
      staleNotes(census)[0].name === "shrank" &&
      // EXACT, not `includes`: an equal string also proves the `full` branch did NOT fire,
      // which is what distinguishes this arm from the one that moves both together.
      staleNotes(census)[0].moved.join("; ") === "ejected 12 -> 9",
    staleNotes(census)
  );
}

/* ---- #1067: the retained prose reaches the reader, and is not restored for them ---------- */

const repairCensus = (over = {}) => ({
  ejectTarget: "langchain",
  checkers: {
    subject: {
      verdict: STATIC,
      full: 10,
      ejected: 10,
      note: null,
      retainedFrom: {
        verdict: STATIC,
        note: "Both arms of this audit read 8.",
        writtenAgainst: "19a228d0",
      },
      ...over,
    },
  },
});

ok(
  "the retained prose is OFFERED when its verdict matches the one now held",
  retainedRepairs(repairCensus()).length === 1
);

ok(
  "it is NOT offered when the prose was written for a different verdict — that argues about " +
    "a different question",
  retainedRepairs(
    repairCensus({ retainedFrom: { verdict: "no-baseline", note: "x" } })
  ).length === 0
);

ok(
  "it is NOT offered for a first classification, which has no history to confirm",
  retainedRepairs(repairCensus({ retainedFrom: undefined })).length === 0
);

ok(
  "it is NOT offered when the entry already carries its own note — nothing is blocked",
  retainedRepairs(repairCensus({ note: "already written" })).length === 0
);

ok(
  "the rendered block carries the prose VERBATIM, so the reader is confirming bytes rather " +
    "than recalling them",
  renderRetainedRepairs(retainedRepairs(repairCensus())).includes(
    "Both arms of this audit read 8."
  )
);

ok(
  "...and prints the DERIVED counts beside it, which is what makes the staleness visible " +
    "while someone is editing",
  /full=10, ejected=10/.test(
    renderRetainedRepairs(retainedRepairs(repairCensus()))
  )
);

ok(
  "an ordinary failure with nothing retained renders EMPTY, so this adds no noise to the " +
    "common case",
  renderRetainedRepairs(
    retainedRepairs(repairCensus({ retainedFrom: undefined }))
  ) === ""
);

ok(
  "REGRESSION: the remedy no longer tells the reader to assert the bytes are identical — " +
    "that instruction was the same defect as the proposed auto-restore, and #1065's correct " +
    "repair differs from the retained bytes by exactly one digit",
  (() => {
    const groups = problemGroups(["subject"], repairCensus());
    const fix = groups.map((g) => g.fix).join("\n");
    /*
     * THE OLD IMPERATIVE, not the phrase. The corrected text necessarily CONTAINS
     * "assert the bytes are identical" — in the sentence telling the reader not to — so an
     * absence check on the phrase fails against its own repair. What must be gone is the
     * instruction: "copy `retainedFrom.note` back into `note`".
     */
    return (
      /re-derive/i.test(fix) &&
      /DO NOT COPY IT VERBATIM/.test(fix) &&
      !fix.includes("copy `retainedFrom.note` back into `note`") &&
      fix.includes("Both arms of this audit read 8.")
    );
  })()
);

ok(
  "PINS THE `isStatic` GUARD, which survives every other arm. A NON-static row is not offered " +
    "prose even when its retained verdict matches — without this the guard reads as dead code " +
    "to the next person who mutates it, and the census is HAND-EDITED so a non-static " +
    "`retainedFrom.verdict` is reachable by typing one",
  retainedRepairs({
    ejectTarget: "langchain",
    checkers: {
      x: {
        verdict: "no-baseline",
        full: 4,
        ejected: 4,
        note: null,
        retainedFrom: {
          verdict: "no-baseline",
          note: "prose for a row that is not failing",
        },
      },
    },
  }).length === 0
);

/* ---- #1067: enumerate the numbers, do not instruct a blanket re-derive (DEV3) ----------- */

const NOTE_KINDS =
  "Retained from #834. See eject-subject-audit.mjs:262-270 and " +
  "assert-eject-subjects-classified.mjs:107. Main shipped 50 beside a note saying 49. " +
  "It is 53 in both trees. Would exit 1. Restored from b2ec766b.";

ok(
  "every number is enumerated, hash-marked and bare alike, because no lexical rule separates " +
    "a count to re-derive from a line number to preserve",
  (() => {
    const t = numbersInNote(NOTE_KINDS).map((n) => n.token);
    return ["#834", "262", "270", "107", "50", "49", "53", "1"].every((x) =>
      t.includes(x)
    );
  })()
);

ok(
  "digits INSIDE a hex sha are not reported — `b2ec766b` must not produce a phantom `766` " +
    "for a reader to rule on",
  !numbersInNote(NOTE_KINDS).some((n) => n.token === "766")
);

ok(
  "each number carries CONTEXT, which is the only thing that lets a reader classify it",
  numbersInNote(NOTE_KINDS).every(
    (n) => typeof n.context === "string" && n.context.length > n.token.length
  )
);

ok(
  "a non-string note yields an empty list rather than throwing",
  numbersInNote(null).length === 0 && numbersInNote(undefined).length === 0
);

ok(
  "the rendered block ENUMERATES rather than instructing a blanket re-derive",
  (() => {
    const out = renderRetainedRepairs(
      retainedRepairs(
        repairCensus({ retainedFrom: { verdict: STATIC, note: NOTE_KINDS } })
      )
    );
    return (
      /RULE ON EACH CANDIDATE BELOW/.test(out) &&
      /CANDIDATES, NOT A COMPLETE LIST/.test(out)
    );
  })()
);

ok(
  "REGRESSION: the blanket imperative is gone. `Re-derive every count from full` applied to a " +
    "note citing line numbers and historical evidence fails toward CORRUPTION, which nothing " +
    "detects — unlike a stale count, which disagrees with the derived field printed beside it",
  (() => {
    const out = renderRetainedRepairs(
      retainedRepairs(
        repairCensus({ retainedFrom: { verdict: STATIC, note: NOTE_KINDS } })
      )
    );
    return (
      !/Any count inside that prose describes an earlier tree/.test(out) &&
      /Re-derive ONLY those that restate/.test(out)
    );
  })()
);

/* ---- #1067: the list must BE there, and it must not overclaim (DEV3 + DEV1) ------------- */

ok(
  "DEV3's surviving mutation: the rendered block actually CONTAINS the enumerated tokens — " +
    "deleting the list left all arms green while the block still promised one",
  (() => {
    const out = renderRetainedRepairs(
      retainedRepairs(
        repairCensus({ retainedFrom: { verdict: STATIC, note: NOTE_KINDS } })
      )
    );
    /*
     * MATCH THE LIST'S OWN LINE SHAPE, NOT THE TOKEN. My first version asserted
     * `out.includes("53")`, which is satisfied by the PROSE printed above the list — so the
     * arm passed with the list deleted and the mutation survived a second time. A rendered
     * candidate is six spaces, the token, then a context window in ellipses.
     */
    const rows = out.match(/^ {6}\S+ +\u2026.*\u2026$/gm) || [];
    return rows.length >= 8 && rows.some((l) => /^ {6}#834\s/.test(l));
  })()
);

ok(
  "DEV1's finding: SPELLED-OUT numbers are enumerated. `twelve entries here are absent` was " +
    "invisible to a digits-only extractor, and it is already wrong (13)",
  (() => {
    const t = numbersInNote(
      "twelve entries here are absent and four broken"
    ).map((n) => n.token.toLowerCase());
    return t.includes("twelve") && t.includes("four");
  })()
);

ok(
  "the block no longer claims EXHAUSTIVE — a false completeness claim to a reader told to " +
    "rely on it is worse than the too-strong instruction it replaced",
  (() => {
    const out = renderRetainedRepairs(
      retainedRepairs(
        repairCensus({ retainedFrom: { verdict: STATIC, note: NOTE_KINDS } })
      )
    );
    return !/EXHAUSTIVE/.test(out) && !/absent from the prose/.test(out);
  })()
);

ok(
  "the SIXTH KIND is named as needing VERIFICATION rather than classification — a count of " +
    "other rows in the same file cannot be ruled on from a context window",
  (() => {
    const out = renderRetainedRepairs(
      retainedRepairs(
        repairCensus({ retainedFrom: { verdict: STATIC, note: NOTE_KINDS } })
      )
    );
    return /COUNT OF OTHER ROWS/.test(out) && /VERIFIED by counting/.test(out);
  })()
);

/* ---- #1071: a defaulted `lifts` says so, and an absent stamp is not a ruling ------------ */

const STATIC_V = "static-under-eject-langchain";
const liftsCensus = (over = {}) => ({
  ejectTarget: "langchain",
  checkers: {
    subject: {
      verdict: STATIC_V,
      full: 3,
      ejected: 3,
      note: "n",
      lifts: "#780",
      ...over,
    },
  },
});

ok(
  "POSITIVE: a row whose lifts carries a DEFAULT stamp is reported, and the report names the VALUE and the tree — a stamp recording only when and where lets a verifier on another generation read a correct repair as wrong",
  (() => {
    const r = unruledLifts(
      liftsCensus({
        liftsDefaultedAt: { value: "#780", sha: "abcdef0123", at: "x" },
      })
    );
    return (
      r.length === 1 &&
      r[0].kind === "stamped" &&
      r[0].value === "#780" &&
      r[0].sha === "abcdef0123"
    );
  })()
);

ok(
  "an ABSENT stamp is UNRECORDED, not examined — absent provenance reading as ruled is the permissive direction, and is how four rows carrying the same string became indistinguishable",
  (() => {
    const r = unruledLifts(liftsCensus());
    return r.length === 1 && r[0].kind === "unrecorded" && r[0].sha === null;
  })()
);

ok(
  "lifts set to null is a RULING and is silent — clearing it asserts the static is permanent, which is an answer rather than an absence",
  unruledLifts(liftsCensus({ lifts: null })).length === 0
);

ok(
  "a whitespace-only lifts is silent too, so a blanked field is not reported as a pending decision",
  unruledLifts(liftsCensus({ lifts: "   " })).length === 0
);

ok(
  "a NON-static row is never reported: `lifts` is emitted only for static verdicts, so a row that left cannot be ruled on and must not raise an undischargeable expectation",
  unruledLifts(liftsCensus({ verdict: "no-baseline" })).length === 0
);

ok(
  "a census with no checkers yields nothing rather than throwing",
  unruledLifts({}).length === 0 && unruledLifts(null).length === 0
);

/*
 * BOTH RULINGS MUST BE EXPRESSIBLE, which is where the first cut of #1071 was wrong on its own
 * stated goal. It offered KEEP-with-a-reason or `lifts: null`, and only the second silenced the
 * row -- so the sole way to stop the report was the answer asserting PERMANENCE, the exact
 * incentive the message warns against. DEV1 drove it, DEV2 named the shape: `lifts` had a value
 * and a provenance and no field for a VERDICT. Measured on main when this was written, FIVE rows
 * carried `"#780"` and FOUR of their notes said in terms that it had been examined and kept.
 */
const ruled = (over = {}) => ({ value: "#780", by: "DEV2", at: "t", ...over });

ok(
  "a RULING silences the row — a person examined it and decided KEEP, which is an answer, and until this existed such a row reported identically to one nobody had opened",
  unruledLifts(liftsCensus({ liftsRuledAt: ruled() })).length === 0
);

ok(
  "a ruling naming a DIFFERENT value does not silence: it decided a question the row no longer asks, and a stamp outliving its subject is the expiring premise this file exists to surface",
  (() => {
    const r = unruledLifts(
      liftsCensus({ lifts: "#900", liftsRuledAt: ruled({ value: "#780" }) })
    );
    return (
      r.length === 1 && r[0].kind === "superseded" && r[0].value === "#780"
    );
  })()
);

ok(
  "a SUPERSEDED ruling is not reported as UNRECORDED — the two send a reader to different places, and calling a stale decision 'nobody looked' loses the fact that somebody did",
  (() => {
    const r = unruledLifts(
      liftsCensus({ lifts: "#900", liftsRuledAt: ruled({ value: "#780" }) })
    );
    return r[0].kind !== "unrecorded" && r[0].by === "DEV2";
  })()
);

ok(
  "a ruling that names NO value cannot silence — it cannot be checked against the value present, and an uncheckable record must not be stronger than a checkable one",
  (() => {
    const r = unruledLifts(liftsCensus({ liftsRuledAt: { by: "x", at: "t" } }));
    return r.length === 1 && r[0].kind === "superseded" && r[0].value === null;
  })()
);

ok(
  "a non-object ruling is ignored rather than trusted, so `liftsRuledAt: true` does not buy silence",
  (() => {
    const r = unruledLifts(liftsCensus({ liftsRuledAt: true }));
    return r.length === 1 && r[0].kind === "unrecorded";
  })()
);

ok(
  "a ruling BEATS a default stamp on the same row: the producer wrote the value, then a person ruled on it, and the second fact is the one that answers the question",
  unruledLifts(
    liftsCensus({
      liftsDefaultedAt: { value: "#780", sha: "abcdef0123", at: "x" },
      liftsRuledAt: ruled(),
    })
  ).length === 0
);

ok(
  "the guidance NAMES BOTH REPAIRS — the first cut told readers to put the reason in the note, which the predicate never read, so following the instruction exactly left the row reporting",
  (() => {
    const out = renderUnruledLifts(unruledLifts(liftsCensus())).join("\n");
    return /liftsRuledAt/.test(out) && /lifts: null/.test(out);
  })()
);

ok(
  "and it prints the guidance ONCE for many rows, so the one fact that differs is not buried under identical paragraphs",
  (() => {
    const three = ["a", "b", "c"].map((name) => ({
      name,
      lifts: "#780",
      kind: "unrecorded",
      value: null,
      sha: null,
      by: null,
    }));
    const lines = renderUnruledLifts(three);
    return (
      lines.length === 4 &&
      lines.filter((l) => /liftsRuledAt/.test(l)).length === 1
    );
  })()
);

ok(
  "nothing unruled renders nothing — an empty report must not print a decision request over an empty set",
  renderUnruledLifts([]).length === 0 && renderUnruledLifts(null).length === 0
);

const EXPECTED = 57; // +9 for #1071's ruling channel and its guidance, +8 for #1067's retained-prose surfacing, +4 for #838's remediation routing, +3 for #855, +5 for #854/#875, +3 for #917
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
