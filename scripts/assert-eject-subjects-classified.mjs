/**
 * EVERY REGISTERED CHECKER HAS AN EJECT CLASSIFICATION, OR THE AUDIT HAS NOT BEEN RUN (#755).
 *
 * #741's RED 3: a subject count can be PRINTED rather than computed, and nothing
 * in #741 catches it. The property that would is that ejecting a rung must change
 * a rung-scoped checker's reported subject — the parent cannot check the child's
 * arithmetic, but it can check that the arithmetic RESPONDS.
 *
 * TAKING THAT MEASUREMENT COSTS FIVE MINUTES. Measured, not estimated: a full
 * `run-checks` pass is 178s on the full tree and 150s on the ejected one, plus a
 * 2s eject and a 5s install. That is the "minutes" branch, so it does NOT belong
 * in the per-PR path — a five-minute job on every PR buys one measurement of a
 * small changing subset at the cost of measuring all 47.
 *
 * SO THE WORK IS SPLIT, AND THIS FILE IS THE CHEAP HALF:
 *
 *   THIS GATE     per-PR, registered, milliseconds. Asserts every checker in
 *                 checks.json has an entry in the census. JSON against JSON. A new
 *                 checker with no entry fails instantly and is told what to run.
 *   THE CENSUS    on demand, `pnpm eject-audit`, ~7-8 minutes (twice if this PR
 *                 registers a checker). Produces the entries.
 *                 Run by whoever adds a checker, because this gate just told them.
 *
 * That is #741's and #773's shape: the gate is cheap and TOTAL, the measurement is
 * done once and recorded, and the registry connects them. It also answers who pays
 * the five minutes — the person adding the checker, once.
 *
 * WHAT THIS FORGOES, STATED AS FORGONE RATHER THAN DEFERRED. A checker whose
 * subject silently stops varying WITHOUT ANYONE TOUCHING IT — because the tree
 * changed around it — is caught only when the census is next re-taken. This gate
 * catches NEW checkers and checkers whose entry was removed. It does not catch
 * drift under a stationary checker. Closing that needs a schedule, and a
 * five-minute job failing on a schedule fails where nobody looks, which is #742
 * verbatim. It becomes closable the day #742's ambient reporter exists.
 *
 * NOT A SCHEDULE, THEREFORE, AND NOT AN ACCIDENT.
 *
 * ── THIS GATE IS SELF-REFERENTIAL, AND THAT COSTS TWO AUDIT RUNS PER CHECKER ──
 *
 * The audit runs every registered checker in both trees, and this gate is one of
 * them. So registering ANY new checker X produces:
 *
 *   1. the gate FAILS during the audit run, because X is absent from the census;
 *   2. `reportSubject` sits after the failure exit in every checker, so a failing
 *      checker emits no subject — this gate's own reading degrades to `no-baseline`;
 *   3. committing that census makes the gate pass, and a SECOND audit run restores
 *      its real verdict.
 *
 * Two audit runs, roughly fourteen minutes, for every checker anyone adds. That is
 * a real cost and it is written here rather than left to be discovered, because the
 * first symptom is this gate's own entry turning `no-baseline` in a diff about
 * somebody else's checker.
 *
 * IT TERMINATES AT CYCLE 2. The gate's subject is the REGISTERED-CHECKER COUNT,
 * which does not depend on the census's contents — so once its entry exists, a
 * third run records the same subject and the same verdict. Fixpoint, not a chase.
 *
 * AND IT IS NOT AN EXCEPTION TO THE WORKFLOW, IT IS THE WORKFLOW. Cycle 1 is "the
 * gate tells you to run the audit"; cycle 2 is "you ran it and committed". This
 * gate was its own first user and went through it unmodified. The alternative —
 * special-casing this checker inside the classifier — would have been an asymmetry
 * invisible in the artifact, which is the failure this whole audit exists to catch.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { reportSubject } from "./lib/subject.mjs";
import { isStatic, STATIC_PREFIX } from "./lib/eject-classify.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Checker script paths declared in checks.json, by entry name. */
export function registeredCheckers(checksJson) {
  const list = checksJson.checks ?? checksJson;
  const entries = Array.isArray(list) ? list : Object.values(list).flat();
  return entries
    .filter((e) => typeof e.checker === "string" && e.checker.length > 0)
    .map((e) => e.name);
}

/**
 * Which registered checkers the census does not classify, and which classified
 * names the registry no longer has.
 *
 * BOTH DIRECTIONS, because a one-way check leaves the census free to accumulate
 * entries for checkers that no longer exist — and a stale `static` note for a
 * deleted checker reads as a live justification. #774's ruling: reconcile both
 * ways so totality is a consequence rather than a second thing to remember.
 */
export function reconcile(registered, census) {
  const classified = new Set(Object.keys(census.checkers ?? {}));
  return {
    unclassified: registered.filter((n) => !classified.has(n)),
    orphaned: [...classified].filter((n) => !registered.includes(n)),
  };
}

/**
 * A `static` entry must say WHY the domain does not vary by rung, and whether
 * that is permanent.
 *
 * `lifts: null` is permanent and is furniture on purpose. `lifts: "#NNN"` is a
 * pending hole with an owner. Without the split every note reads permanent, which
 * is how an exception list becomes a mute button — the failure #755's companion
 * clause exists to prevent, arriving through the companion.
 */
export function noteComplaints(census) {
  const bad = [];
  for (const [name, e] of Object.entries(census.checkers ?? {})) {
    /*
     * BY PREFIX, NOT BY THE CENSUS'S OWN `ejectTarget` (#855). The static verdict
     * names its target, so there is no single string to compare against once the
     * target can vary — but deciding WHICH string by reading `ejectTarget` would
     * make this gate switchable by a field: a census whose target is absent, stale
     * or misspelt would match no row, skip every one, and pass while asserting
     * nothing. The prefix is a property of the verdict itself and is right at every
     * target.
     */
    if (!isStatic(e.verdict)) continue;
    if (typeof e.note !== "string" || e.note.trim().length === 0)
      bad.push(
        `${name}: verdict "${e.verdict}" with no note — say why its domain does not vary by rung`
      );
    else if (!(e.lifts === null || /^#\d+$/.test(e.lifts)))
      bad.push(
        `${name}: lifts must be null (permanent) or "#NNN" (pending), got ${JSON.stringify(
          e.lifts
        )}`
      );
  }
  return bad;
}

/**
 * THE RETAINED PROSE A FAILING ENTRY CAN BE REPAIRED FROM, RENDERED WHERE THE READER IS (#1067).
 *
 * WHAT WAS BROKEN WAS DELIVERY, NOT RETENTION. `retentionFor` quarantines a note on the way out
 * of STATIC and deliberately does not restore it on the way back in, because a round trip does
 * not make stale prose true again — that is argued at length on the producer and it is right.
 * But the prose then sat one level inside the artifact while the gate stopped for a human, and
 * the only place it was mentioned was an INFORMATION line on the PASS path, which a failing run
 * never reaches and `grep FAIL` would never read. The answer was present and unreachable.
 *
 * SO IT IS PRINTED IN THE FAILURE, AND NOT RESTORED INTO THE FILE. The human still decides; what
 * changes is that they are confirming text in front of them instead of knowing to go and find it.
 *
 * AND THE DERIVED COUNTS ARE PRINTED BESIDE IT, because the prose is routinely stale by exactly
 * the amount that matters. Measured on #1065: the retained note said "Both arms of this audit
 * read 8" while the entry's own `full` had reached 10 — already stale by one when it was
 * quarantined, by two when it came back. A verbatim restore would have shipped "8" beside
 * `full: 10`, which main has already shipped twice at 49-vs-50 and 52-vs-53.
 *
 * THE WORKED EXAMPLE IS WHY THIS IS NOT PEDANTRY. DEV3's correct restore on #1065 differs from
 * the retained bytes by ONE CHARACTER, and that character is the digit: 1268 chars saying 8,
 * 1269 saying 10. The whole distance between the right outcome and a false one is the
 * re-derivation a person performs and a copy does not.
 */
export function retainedRepairs(census) {
  const out = [];
  for (const [name, e] of Object.entries(census?.checkers ?? {})) {
    if (!isStatic(e?.verdict)) continue;
    if (typeof e.note === "string" && e.note.trim().length > 0) continue;
    const r = e.retainedFrom;
    if (!r || typeof r.note !== "string" || r.note.trim().length === 0)
      continue;
    /*
     * ONLY WHEN THE RETAINED VERDICT MATCHES THE ONE NOW HELD. Prose written for a different
     * verdict argues about a different question, and offering it would invite a restore that
     * asserts something the entry no longer claims.
     */
    if (r.verdict !== e.verdict) continue;
    out.push({
      name,
      verdict: e.verdict,
      note: r.note,
      chars: r.note.length,
      writtenAgainst: r.writtenAgainst ?? null,
      writtenAt: r.writtenAt ?? null,
      full: e.full ?? null,
      ejected: e.ejected ?? null,
    });
  }
  return out;
}

/**
 * ROWS WHOSE `lifts` NOBODY HAS RULED ON (#1071).
 *
 * WHY THIS REPORTS RATHER THAN FAILS. A newly static row is SUPPOSED to arrive with a
 * defaulted `lifts` — that is the producer doing its job, and on day one nobody has examined
 * anything. Failing would red-light every new registration for the ordinary state of being
 * new, which is the scheduled-failure shape #768 records. What is missing is not a rule being
 * broken; it is a decision nobody has recorded.
 *
 * TWO KINDS, KEPT APART, because they send a reader to different places:
 *
 *   STAMPED    the producer wrote it from DEFAULT_LIFTS and said so. The stamp names the
 *              value and the tree, so a reader knows exactly what they are ruling on.
 *   UNRECORDED `lifts` is set and carries no stamp — every row predating #1071. Absent
 *              provenance must NOT read as examined: that is the permissive direction, and
 *              it is how five rows carrying `"#780"` became indistinguishable from each
 *              other in the first place.
 *   SUPERSEDED a ruling IS recorded and names a different value from the one now in `lifts`.
 *              It decided a question the row no longer asks, so it cannot silence the row —
 *              and it must not report as UNRECORDED either, which would tell the reader
 *              nobody had ever looked.
 *
 * IT ASKS FOR A RULING, NOT A CLEARING, AND BOTH RULINGS MUST BE EXPRESSIBLE — which is where
 * the first cut of this was wrong, on its own stated goal. It offered two answers, KEEP the
 * value with a reason or set `lifts: null` for permanent, and only the second silenced the
 * row: nothing here could represent "a person examined this and decided to keep it", so an
 * examined row reported identically to one nobody had opened. The incentive that leaves is the
 * exact one the paragraph warns against, one level down — of the two rulings, only the one
 * asserting PERMANENCE makes the report stop.
 *
 * It was not a hypothetical. Measured on main the moment it was written: FIVE rows carry
 * `"#780"`, and FOUR of their notes say in terms that the value was examined and deliberately
 * kept — "LIFTS IS EXAMINED AND DELIBERATELY KEPT AT #780", "LIFTS ON #780 IS EXAMINED, NOT
 * INHERITED ... Checked". The report was wrong about four fifths of its own subject on its
 * first live run.
 *
 * SO A RULING IS A RECORD, `liftsRuledAt: {value, by, at}`, AND NOT A PROPERTY OF THE NOTE.
 * Every one of those five rows HAS a note, and the four that ruled did so in three different
 * phrasings, so note-presence would silence all five and a regex over prose would be a match
 * boundary standing in for a statement. The two stamps answer genuinely different questions
 * and both are needed: `liftsDefaultedAt` says HOW the value got there — producer, or unknown
 * — and `liftsRuledAt` says WHETHER anyone decided it. Conflating them is what this amends.
 *
 * A RULING IS ABOUT A VALUE, so it carries the value it ruled on and is checked against the
 * one actually present. A stamp that outlived its subject would silence a row whose premise
 * had since been rewritten — a constraint expiring unnoticed, which is the failure this file
 * exists to make visible rather than one to reproduce in its own repair.
 *
 * WHAT IT DOES NOT DO. It does not exempt the pointer from `assert-lifts-pointers-are-open`:
 * ruling KEEP on `"#780"` still obliges #780 to be open, and that check fires independently
 * if it closes. Deciding to keep a pointer is not deciding it will stay valid.
 */
export function unruledLifts(census) {
  const out = [];
  for (const [name, e] of Object.entries(census?.checkers ?? {})) {
    if (!isStatic(e?.verdict)) continue;
    const lifts = e?.lifts;
    if (typeof lifts !== "string" || lifts.trim().length === 0) continue;
    const ruling = e?.liftsRuledAt;
    if (ruling && typeof ruling === "object") {
      // A ruling silences the row ONLY while it is about the value that is actually there.
      if (ruling.value === lifts) continue;
      out.push({
        name,
        lifts,
        kind: "superseded",
        value: ruling.value ?? null,
        sha: null,
        by: ruling.by ?? null,
      });
      continue;
    }
    const stamp = e?.liftsDefaultedAt;
    if (stamp && typeof stamp === "object") {
      out.push({
        name,
        lifts,
        kind: "stamped",
        value: stamp.value ?? null,
        sha: stamp.sha ?? null,
        by: null,
      });
    } else {
      out.push({
        name,
        lifts,
        kind: "unrecorded",
        value: null,
        sha: null,
        by: null,
      });
    }
  }
  return out;
}

/**
 * THE LINES FOR `unruledLifts`, EXPORTED SO THE GUIDANCE IS PINNED RATHER THAN ONLY WRITTEN.
 *
 * The first cut of #1071 put this text inline in `main()`, where nothing could reach it — and
 * the sentence it printed named a repair the checker did not implement: "keep the value with the
 * reason in that row's note". Every one of the five rows HAS a note, none of which the predicate
 * read, so a reader following the instruction exactly would watch the row keep reporting. An
 * unreachable message is not a smaller defect than an unreachable predicate; it is the same
 * defect in the half a person actually acts on.
 *
 * THE GUIDANCE ONCE, THE ROWS AS A LIST. Repeating a paragraph per row is how a report becomes a
 * line nobody reads — five identical blocks bury the one fact that differs, which is WHICH ROW
 * and WHAT VALUE.
 */
export function renderUnruledLifts(unruled) {
  if (!unruled || unruled.length === 0) return [];
  const why = {
    stamped: (u) =>
      `written from DEFAULT_LIFTS at ${String(u.sha).slice(
        0,
        12
      )}, and no ruling is recorded`,
    unrecorded: () =>
      `provenance UNRECORDED, predating the stamp, and no ruling is recorded`,
    superseded: (u) =>
      `and the recorded ruling is about ${
        u.value === null ? "NO VALUE" : JSON.stringify(u.value)
      }${
        u.by ? ` (${u.by})` : ""
      }, so it decided a question this row no longer asks`,
  };
  const lines = unruled.map(
    (u) =>
      `  INFORMATION: ${u.name} carries lifts ${JSON.stringify(u.lifts)} — ` +
      `${(why[u.kind] ?? why.unrecorded)(u)}.`
  );
  lines.push(
    `  INFORMATION: those ${unruled.length} row(s) need a DECISION, and BOTH answers are ` +
      `recordable — that symmetry is the whole point. To KEEP the value,\n` +
      `               add \`liftsRuledAt: { value: <the value being kept>, by: <who>, ` +
      `at: <when> }\` to the row and put the reasoning in its note.\n` +
      `               To rule the static PERMANENT, set \`lifts: null\`. Only the absence of a ` +
      `ruling is the gap. Do not clear it merely to silence the\n` +
      `               line: four of the five rows this first reported had ALREADY concluded the ` +
      `default was RIGHT, so the answer is not known in advance.`
  );
  return lines;
}

/** The retained prose block appended to the note-complaint remedy, or "" when there is none. */
/**
 * EVERY NUMBER IN A RETAINED NOTE, WITH ENOUGH CONTEXT TO RULE ON IT (#1067, DEV3's finding).
 *
 * THE INSTRUCTION THIS REPLACES WAS A REGRESSION, AND IT WAS MINE. "Re-derive every count from
 * `full`" applied literally to the note that blocked #1066 rewrites SIX numbers, and they are
 * not one kind:
 *
 *     #834 #827 #811 #822 #780   issue citations            hash-marked, safe
 *     262, 270, 107              CODE LINE NUMBERS          bare
 *     50, 49                     HISTORICAL EVIDENCE        bare
 *     53, 53                     restate this entry's full  bare - the only ones to re-derive
 *     1                          an exit code               bare
 *
 * `53` and `49` are the SAME QUANTITY - counts of registered checkers - one to re-derive and
 * one to preserve, and no lexical rule separates them. Only a reader can.
 *
 * THE ERROR DIRECTION IS WHAT DECIDES IT. Copying verbatim fails toward STALE, which is
 * DETECTABLE because the derived field is printed beside it and disagrees. Re-deriving
 * everything fails toward CORRUPTION, which is not - a line number rewritten to 66 is just a
 * number, and nothing ever compares it to anything again. The mitigation this file already had,
 * printing the derived counts, guards the failure the instruction no longer had.
 *
 * The sentence also destroyed its own evidence: it cited "49-against-50 and 52-against-53" as
 * the justification for re-deriving, and a reader following it literally rewrites those four.
 * Third time tonight that remedy prose performed the defect it exists to prevent.
 *
 * SO: ENUMERATE, DO NOT INSTRUCT. The list is of fixed length and the reader rules on each.
 *
 * WORD BOUNDARIES MATTER. `\b` excludes digits inside hex - the real note cites sha `b2ec766b`,
 * and a naive `\d+` reports a phantom "766" to be ruled on: 18 naive tokens, 16 real ones.
 */
const NUMBER_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
  "hundred",
  "thousand",
];

const NUMBER_TOKEN = new RegExp(
  `#?\\b\\d+\\b|\\b(?:${NUMBER_WORDS.join("|")})\\b`,
  "gi"
);

export function numbersInNote(note, window = 46) {
  const out = [];
  if (typeof note !== "string") return out;
  for (const m of note.matchAll(NUMBER_TOKEN)) {
    const start = Math.max(0, m.index - window);
    const end = Math.min(note.length, m.index + m[0].length + 34);
    out.push({
      token: m[0],
      context: `\u2026${note.slice(start, end).replace(/\s+/g, " ")}\u2026`,
    });
  }
  return out;
}

export function renderRetainedRepairs(repairs) {
  if (!repairs || repairs.length === 0) return "";
  return repairs
    .map(
      (r) =>
        `\n  THE PROSE FOR ${r.name} IS RETAINED AND IS PRINTED BELOW, so you are\n` +
        `  CONFIRMING text rather than writing it. Written against "${r.verdict}"` +
        (r.writtenAgainst ? ` at ${r.writtenAgainst}` : "") +
        `,\n  ${r.chars} chars:\n\n` +
        r.note
          .split("\n")
          .map((l) => `      ${l}`)
          .join("\n") +
        `\n\n  DO NOT COPY IT VERBATIM, AND DO NOT RE-DERIVE EVERY NUMBER EITHER. This entry's\n` +
        `  DERIVED fields now read full=${r.full}, ejected=${r.ejected}.\n` +
        `\n  RULE ON EACH CANDIDATE BELOW. These are the digit-runs and number-words found in\n` +
        `  the prose — CANDIDATES, NOT A COMPLETE LIST, and some are not quantities at all.\n` +
        `  The extractor does not recognise ordinals, hyphenated numbers, or quantities in\n` +
        `  words like "a dozen", so READ THE PROSE TOO rather than treating this as the job.\n` +
        `\n  Re-derive ONLY those that restate this entry's own \`full\`/\`ejected\`. Leave code\n` +
        `  line numbers, issue citations and cited historical values alone: a stale count\n` +
        `  announces itself against the derived field printed above, and a rewritten line\n` +
        `  number never announces itself at all.\n` +
        `\n  AND A COUNT OF OTHER ROWS IN THIS FILE CANNOT BE RULED ON FROM CONTEXT — it must\n` +
        `  be VERIFIED by counting. "twelve entries here are absent" is such a claim and it\n` +
        `  is already wrong (13). Classifying is not enough for that kind; checking is.\n\n` +
        numbersInNote(r.note)
          .map((n) => `      ${n.token.padEnd(6)} ${n.context}`)
          .join("\n") +
        `\n\n  #1065 is the worked example: the retained note said "read 8", the correct\n` +
        `  restore says "read 10", and the ONLY difference between them is that digit.\n`
    )
    .join("");
}

/**
 * The complaints, GROUPED BY WHAT WOULD ACTUALLY REPAIR THEM (#838).
 *
 * Exported so the pairing of a complaint to its remedy can be asserted. The routing is
 * the property this issue is about, and it lived inside main() where nothing could read
 * it — a remediation that is wrong for the failure it is printed beside is exactly the
 * kind of defect a test of the complaint STRINGS alone cannot see.
 */
/**
 * ROWS CARRYING PROSE THIS GATE'S VERDICT CANNOT SEE (#854).
 *
 * `noteComplaints` skips every non-STATIC row, and a row carries `retainedFrom` precisely
 * BECAUSE its verdict left STATIC. So the gate that could not see the deletion cannot see the
 * retention either: a human looking at a moved row sees `note: null` and nothing points at the
 * text one level down. #850 preserved the prose and gave it no reader.
 *
 * REPORTED, NOT COMPLAINED ABOUT. A retention is a correct state — the note is quarantined
 * because it described a verdict that no longer holds — so failing on it would fail on the
 * mechanism working. What was missing is that nobody was TOLD.
 *
 * And the set is not rare: `eject-subjects-classified` is inside its own subject, so every run
 * that registers a new checker moves its verdict and quarantines its note. Observed twice in
 * one night, both times from that structural cause rather than an environmental one.
 */
export function retainedRows(census) {
  return Object.entries(census.checkers ?? {})
    .filter(([, e]) => e && e.retainedFrom)
    .map(([name, e]) => ({
      name,
      verdict: e.retainedFrom.verdict ?? null,
      chars: String(e.retainedFrom.note ?? "").length,
    }));
}

/**
 * NOTES WHOSE ROW HAS MOVED SINCE THE PROSE WAS WRITTEN (#875).
 *
 * Compares the derived values stamped into `noteWrittenAt` against the row's current ones. NOT
 * a time comparison: `measuredAt` changes every run, so any age test fires on every note after
 * any audit, which is the same as firing on none.
 *
 * THIS CATCHES DRIFT, NOT AUTHORING ERRORS. A note that was wrong the day it was written —
 * stamped at `full: 54` while claiming 53 — never appears here, because nothing about it has
 * changed. The question answered is "has the ground moved under this prose", never "is this
 * prose true".
 *
 * IT WILL ALSO FIRE ON NOTES THAT ARE STILL CORRECT, and that is accepted rather than
 * overlooked. Most notes argue about a domain's SHAPE — "this subject does not vary by rung" —
 * and such an argument survives its row's count changing. The delta is reported so a reader
 * dismisses one from the line itself; the alternative is parsing prose for numerals, which
 * fails in both directions and is worse than no instrument.
 */
export function staleNotes(census) {
  const out = [];
  for (const [name, e] of Object.entries(census.checkers ?? {})) {
    const s = e && e.noteWrittenAt;
    if (!s) continue;
    const moved = [];
    if (s.full !== undefined && s.full !== e.full)
      moved.push(`full ${s.full} -> ${e.full}`);
    if (s.ejected !== undefined && s.ejected !== e.ejected)
      moved.push(`ejected ${s.ejected} -> ${e.ejected}`);
    if (moved.length > 0) out.push({ name, moved });
  }
  return out;
}

export function problemGroups(registered, census) {
  const { unclassified, orphaned } = reconcile(registered, census);
  /*
   * A REMEDIATION IS A CLAIM ABOUT WHAT WILL FIX THIS FAILURE (#838).
   *
   * One `Fix:` line was printed for every complaint here and it named
   * `pnpm eject-audit`. That is TRUE for two of the three sources and FALSE for the
   * third, and nothing at the point of the message said which one a reader had.
   *
   * MEASURED AGAINST THE PRODUCER RATHER THAN READ OFF THE STRINGS. Feeding a newly
   * STATIC classification through `merge()`, then feeding its own output back in, as
   * the message instructs:
   *
   *     run 1  note = null     run 2  note = null     run 3  note = null
   *
   * Not slow progress — NO progress, identical every time, which is the most
   * convincing possible sign that a process has converged. Two people paid the eight
   * minutes twice before diagnosing it.
   *
   * THE MECHANISM, NOT ONLY THE OBSERVATION: `merge()` writes
   * `note: keep ? old.note : null`. It CARRIES a note forward and can never ORIGINATE
   * one — confirmed in the same run, where a pre-existing note survived. So the command
   * is not insufficient for this branch, it is INAPPLICABLE, and no number of runs
   * changes that.
   *
   * THE NOTE ARGUMENT DOES NOT TRANSFER TO `lifts`, AND THE REMEDY IS STILL RIGHT — for a
   * different reason on each member, which is worth recording rather than rediscovering.
   * `lifts: keep ? old.lifts : DEFAULT_LIFTS` CAN originate a value. But `keep` is true for
   * exactly the entries able to raise a lifts complaint, so a bad value is carried and never
   * repaired — driven, not reasoned: "banana" survived runs 1, 2 and 3 unchanged. The branch
   * that DOES originate produces DEFAULT_LIFTS, which is valid and cannot complain. So both
   * members of this group are correctly told not to run the audit. A reviewer asked this
   * question expecting to find the fixed defect recurring inside its own fix.
   *
   * The audit genuinely IS the fix for the other two: an entry absent from the census
   * was present after a single merge. So the defect was never the sentence. It was that
   * ONE sentence served three failures while being true of two.
   *
   * NOTHING IS EXCUSED. Every complaint still fails, exit 1, same count; only the
   * remediation attached to each group changes. A gate that suppressed a complaint
   * because its own remedy looked inapplicable would be deriving its verdict from its
   * remedy, which is the inversion this repo keeps removing.
   */
  return [
    {
      items: [
        ...unclassified.map(
          (n) => `${n}: registered in checks.json, absent from the census`
        ),
        ...orphaned.map(
          (n) => `${n}: in the census, no longer registered in checks.json`
        ),
      ],
      fix:
        `  Fix: run \`pnpm eject-audit\` and commit what it records. It takes ~7-8\n` +
        `  minutes: it runs the full check suite twice — once on this tree and once on\n` +
        `  a tree with a rung ejected, which it also has to eject, install and build —\n` +
        `  and that is why it is not on the per-PR path.\n` +
        `\n  IF THIS PR REGISTERS A NEW CHECKER, EXPECT TO RUN IT TWICE, and that is a\n` +
        `  SECOND PASS rather than a slower first one: run-checks reads a subject only\n` +
        `  when the check PASSES, so while this gate is failing it cannot record one\n` +
        `  for the very checker just added. The first pass classifies it \`no-baseline\`\n` +
        `  and the second resolves it. Budgeting the single-run figure for that case is\n` +
        `  how a reader ends up suspecting the tool rather than the design.`,
    },
    {
      items: noteComplaints(census),
      fix:
        `  Fix: EDIT scripts/eject-subject-census.json BY HAND — which line depends on\n` +
        `  which complaint above you have:\n` +
        `\n    ...with no note   ->  add a "note" saying why that subject's domain does\n` +
        `                          not vary by rung\n` +
        `    ...lifts must be  ->  set "lifts" to null (permanent) or "#NNN" (the open\n` +
        `                          issue whose resolution would lift it)\n` +
        `\n  Both live on the named checker's entry, alongside "verdict":\n` +
        `\n      "checker-name": {\n` +
        // The census's own target, because this is a template to be typed back into
        // THAT file. Illustration, not a decision — the check above reads the prefix.
        `        "verdict": "${STATIC_PREFIX}${
          census.ejectTarget ?? "<rung>"
        }",\n` +
        `        "note": "<why this subject cannot vary by rung>",\n` +
        `        "lifts": null\n` +
        `      }\n` +
        `\n  LOOK FOR \`retainedFrom\` ON THE ENTRY FIRST. You are seeing this because the\n` +
        `  entry is STATIC with no note, and that happens whenever this run's verdict\n` +
        `  DIFFERS from the one recorded last time — a first classification, or any change\n` +
        `  of verdict since the last census. If a previous entry carried prose, #850 has\n` +
        `  already quarantined its \`note\` and \`lifts\` into \`retainedFrom\`, stamped with the\n` +
        `  verdict and sha they were written for. WHEN THAT FIELD IS PRESENT THE PROSE IS\n` +
        `  NOT GONE AND YOU MUST NOT RETYPE IT FROM MEMORY — a retyped note that reads\n` +
        `  plausibly is indistinguishable from the original and nothing downstream can tell.\n` +
        `  It is printed in full below when its retained verdict matches the one now held.\n` +
        `\n  BUT DO NOT ASSERT THE BYTES ARE IDENTICAL EITHER, which is what this paragraph\n` +
        `  used to say and it was wrong (#1067). A retained note routinely carries a COUNT,\n` +
        `  and the count describes the tree it was written on. Copying it verbatim ships a\n` +
        `  false number beside a derived field that disagrees — main has done exactly that\n` +
        `  twice, at 49-against-50 and 52-against-53. Re-derive every count from \`full\`.\n` +
        `\n` +
        `  IF \`retainedFrom\` IS ABSENT there are two reasons needing different responses.\n` +
        `  The entry may never have carried a note — a first classification has no history\n` +
        `  to retain, and authoring is the only option. Or it was lost before #850 landed,\n` +
        `  and the bytes may survive in an earlier census:\n` +
        `      git log -p -- scripts/eject-subject-census.json\n` +
        `  A MISSING NOTE AND A DESTROYED NOTE LOOK IDENTICAL HERE. Check before authoring.\n` +
        `\n` +
        `  AND IF YOU ARE ABOUT TO DROP OR REBASE AWAY A CENSUS COMMIT, CAPTURE ANY\n` +
        `  AUTHORED NOTE FIRST, with its sha256. On a first classification there is no\n` +
        `  artifact to recover from anywhere, and this gate cannot tell you one existed.\n` +
        `\n  DO NOT RUN \`pnpm eject-audit\` FOR EITHER. For a missing note the producer\n` +
        `  writes \`note: keep ? old.note : null\` — it CARRIES a note forward and never\n` +
        `  ORIGINATES one, so prose that does not exist cannot be generated by running\n` +
        `  anything, and successive runs return IDENTICAL totals, which reads as\n` +
        `  convergence and is the loop failing to close. That has cost eight minutes\n` +
        `  twice. For a malformed \`lifts\` the producer CAN write the field — but only on\n` +
        `  the branch where no previous entry exists, and \`keep\` is true for exactly the\n` +
        `  entries that can raise this complaint, so a bad value is CARRIED rather than\n` +
        `  repaired. Verified by driving it: lifts "banana" survived three runs unchanged.` +
        /*
         * THE PROSE ITSELF, LAST, BECAUSE IT IS THE LONGEST PART AND THE MOST USEFUL (#1067).
         * Everything above tells the reader what to do; this is the material they do it with.
         * Empty string when nothing is retained, so an ordinary first classification reads
         * exactly as it did before.
         */
        renderRetainedRepairs(retainedRepairs(census)),
    },
  ].filter((g) => g.items.length > 0);
}

function main() {
  const checksPath = resolve(join(ROOT, "scripts/checks.json"));
  const censusPath = resolve(join(ROOT, "scripts/eject-subject-census.json"));

  if (!existsSync(censusPath)) {
    console.error(
      `REFUSE: ${censusPath} does not exist, so nothing was compared.\n` +
        `        Run \`pnpm eject-audit\` to produce it. Exiting 2: the question could not\n` +
        `        be asked, which is not the same as nothing being wrong.`
    );
    process.exit(2);
  }

  const census = JSON.parse(readFileSync(censusPath, "utf8"));
  const registered = registeredCheckers(
    JSON.parse(readFileSync(checksPath, "utf8"))
  );
  const groups = problemGroups(registered, census);

  const problems = groups.flatMap((g) => g.items);

  /*
   * EMITTED BEFORE THE FAILING EXIT (#1030). `run-checks` records the subject line from a
   * FAILING run too, and this sat after `process.exit(1)` -- so every classification finding
   * went into the record without saying what was examined to reach it.
   *
   * ASKED OF THIS FILE RATHER THAN SWEPT: `assert-formatted.mjs` runs a guard before its own
   * emission ON PURPOSE (#765) and hoisting there would have undone it. Here the three consts
   * are pure reads of `census` that exist only to build the LABEL, so they move with the call
   * rather than being left behind it -- the label is the reason they are computed at all.
   */
  const retained = retainedRows(census);
  const stale = staleNotes(census);
  const unruled = unruledLifts(census);
  reportSubject(
    registered.length,
    "registered checker(s) with an eject classification" +
      ` (${retained.length} carrying retained prose, ${stale.length} whose note predates its row,` +
      ` ${unruled.length} whose \`lifts\` nobody has ruled on)`
  );

  if (problems.length > 0) {
    console.error(`FAIL: ${problems.length} eject-classification problem(s):`);
    for (const g of groups) {
      g.items.forEach((p) => console.error(`   - ${p}`));
      console.error(`\n${g.fix}\n`);
    }
    process.exit(1);
  }

  /*
   * ONE SUBJECT EMISSION, SO THESE COUNTS RIDE THE LABEL. `reportSubject` throws if called
   * twice in a process — deliberately, so a running total cannot be emitted from inside a
   * loop — so a second emission for the retained and stale sets is not available. Putting the
   * counts in the label keeps them in the line run-checks records, which is what makes them
   * queryable later rather than scrollback. The per-row DELTAS follow as detail, because a
   * count cannot carry them and a reader dismissing a shape-argument note needs the numbers.
   */
  console.log(
    `PASS: all ${registered.length} registered checkers are classified.`
  );
  for (const r of retained)
    console.log(
      `  INFORMATION: ${r.name} carries ${r.chars} chars of retained prose from ` +
        `"${r.verdict}". This gate's VERDICT cannot see it — non-static rows are skipped — ` +
        `so it is reported here or nowhere.`
    );
  if (unruled.length > 0) {
    for (const line of renderUnruledLifts(unruled)) console.log(line);
  }
  for (const t of stale)
    console.log(
      `  INFORMATION: ${t.name} note was written when ${t.moved.join(", ")}. ` +
        `The row moved; the prose did not. NOT a claim that the note is wrong — most argue ` +
        `about a domain's shape and survive a count change.`
    );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  main();
}
