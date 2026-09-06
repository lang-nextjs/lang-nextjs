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
 * The complaints, GROUPED BY WHAT WOULD ACTUALLY REPAIR THEM (#838).
 *
 * Exported so the pairing of a complaint to its remedy can be asserted. The routing is
 * the property this issue is about, and it lived inside main() where nothing could read
 * it — a remediation that is wrong for the failure it is printed beside is exactly the
 * kind of defect a test of the complaint STRINGS alone cannot see.
 */
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
        `  NOT GONE AND YOU MUST NOT RETYPE IT — copy \`retainedFrom.note\` back into \`note\`\n` +
        `  and assert the bytes are identical. A retyped note that reads plausibly is\n` +
        `  indistinguishable from the original and nothing downstream can tell.\n` +
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
        `  repaired. Verified by driving it: lifts "banana" survived three runs unchanged.`,
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

  if (problems.length > 0) {
    console.error(`FAIL: ${problems.length} eject-classification problem(s):`);
    for (const g of groups) {
      g.items.forEach((p) => console.error(`   - ${p}`));
      console.error(`\n${g.fix}\n`);
    }
    process.exit(1);
  }

  reportSubject(
    registered.length,
    "registered checker(s) with an eject classification"
  );
  console.log(
    `PASS: all ${registered.length} registered checkers are classified.`
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  main();
}
