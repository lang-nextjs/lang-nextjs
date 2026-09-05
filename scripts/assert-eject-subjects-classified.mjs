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
 *   THE CENSUS    on demand, `pnpm eject-audit`, ~5 minutes. Produces the entries.
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
import { STATIC } from "./lib/eject-classify.mjs";

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
    if (e.verdict !== STATIC) continue;
    if (typeof e.note !== "string" || e.note.trim().length === 0)
      bad.push(
        `${name}: verdict "${STATIC}" with no note — say why its domain does not vary by rung`
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
  const { unclassified, orphaned } = reconcile(registered, census);
  const notes = noteComplaints(census);

  const problems = [
    ...unclassified.map(
      (n) => `${n}: registered in checks.json, absent from the census`
    ),
    ...orphaned.map(
      (n) => `${n}: in the census, no longer registered in checks.json`
    ),
    ...notes,
  ];

  if (problems.length > 0) {
    console.error(`FAIL: ${problems.length} eject-classification problem(s):`);
    problems.forEach((p) => console.error(`   - ${p}`));
    console.error(
      `\n  Fix: run \`pnpm eject-audit\` and commit what it records. It takes ~5 minutes\n` +
        `  because it runs the full check suite twice — once on this tree and once on a\n` +
        `  tree with a rung ejected — and that is why it is not on the per-PR path.`
    );
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
