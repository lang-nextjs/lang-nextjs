/**
 * `pnpm eject-audit` — takes both readings and records what an eject does to
 * every registered checker's subject (#755).
 *
 * THE EXPENSIVE HALF, ON DEMAND. Measured: 178s full + 150s ejected + 2s eject +
 * 5s install + ~30s build, each side. That is why it is not registered in
 * checks.json — `scripts/assert-eject-subjects-classified.mjs` is the cheap gate
 * that runs per PR and tells you to run this.
 *
 * BOTH READINGS COME FROM ONE SHA. A full-tree reading at one commit compared
 * against an ejected reading at another produces differences that look like
 * ejection and are merge — measured: #769 changed the selftests for
 * `check-doc-claims` and `assert-formatted`, and `formatted` is one of the
 * checkers that changes class across an eject. The sha is recorded IN the census
 * so a reader can tell what the classification is about.
 *
 * AND BOTH TREES ARE BUILT. An unbuilt tree makes `readme-quickstart` report
 * "published types entry does not exist" and exit 1, which classifies as
 * `no-baseline` — an artefact, not a finding. The install AND build exit codes
 * are checked DIRECTLY rather than inferred from what the checkers say
 * afterwards: an unprepared tree does not announce itself, it produces a
 * plausible short list naming real checkers.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { classifyOne, STATIC, NON_TREE } from "./lib/eject-classify.mjs";
import { reportSubject } from "./lib/subject.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CENSUS = join(ROOT, "scripts/eject-subject-census.json");

/** Checker-phase entries from a run record, by check name. */
export function checkersOf(record) {
  const rows = Array.isArray(record)
    ? record
    : Object.values(record).find(Array.isArray) ?? [];
  return Object.fromEntries(
    rows.filter((r) => r.phase === "checker").map((r) => [r.name, r])
  );
}

/**
 * THE NON-VACUITY GUARD, AND IT IS A REFUSAL RATHER THAN A COMMENT.
 *
 * If nothing moved, the eject did not take, or an install failed, or the readings
 * were never gathered — none of which is a verdict about rung-scoping. A census
 * recorded from that would be a clean-looking file asserting that no checker
 * responds to the tree.
 *
 * The named movers come from THE READING THIS GUARD WAS BUILT FOR. An earlier
 * draft cited two checkers measured at a different sha against a different eject
 * target; both are `absent` here, so the message would have sent a reader to two
 * files with nothing to say.
 */
export function vacuityComplaint(classified) {
  const movers = Object.entries(classified).filter(
    ([, r]) => r.verdict === "moved"
  );
  if (movers.length > 0) return null;
  return (
    `no checker's subject moved under the eject. That is not a finding about\n` +
    `        rung-scoping — it is what a failed eject, a failed install or an\n` +
    `        ungathered reading looks like. Checks known to move at d41664ca:\n` +
    `          child-process-argv-form   968 -> 599\n` +
    `          no-silent-skips           296 -> 200\n` +
    `          sibling-tests-are-owned    53 -> 1\n` +
    `        If those three did not move, the trees are the problem, not the checkers.`
  );
}

/**
 * A RUN THAT COMPARED A TREE WITH ITSELF ESTABLISHED NOTHING (#843).
 *
 * If the eject silently did nothing, the ejected tree IS the full tree. Every checker then reads
 * the same subject twice, every verdict is `static`, and the census says "nothing varies by rung"
 * — WRONG IN THE MOST CONFIDENT POSSIBLE DIRECTION, from a comparison that had one operand.
 *
 * THE EXISTING VACUITY GUARD ALREADY CATCHES THE PURE CASE, AND ONE ROW DEFEATS IT. Measured,
 * not supposed: a fixture with identical `tree.head`, ejected `dirty: false` and identical
 * checker maps refuses at exit 2 today, because zero verdicts are `moved`. The SAME fixture with
 * ONE subject drifting 5 -> 4 exits 0 and writes a census over two byte-identical trees.
 *
 * So `movers.length > 0` is a PROXY for "the trees differ", and a non-deterministic subject
 * satisfies the proxy without the property. One row out of fifty-three is enough — any checker
 * whose count can vary between two runs of the same tree.
 *
 * THIS ASKS THE DIRECT QUESTION INSTEAD. `ejected.tree.head === full.tree.head` with the ejected
 * tree UNMODIFIED cannot be satisfied by any subject behaviour, deterministic or not. It is the
 * same move this file already makes at the producer boundary, where the sha is read OUT of the
 * tree rather than trusted from `--sha`: a file that has already refused one proxy is the right
 * place to refuse a second.
 *
 * IT SITS BESIDE THE VACUITY GUARD RATHER THAN REPLACING IT. That one catches "the eject took but
 * nothing moved" — a failed install, an ungathered reading — and names the three checkers known
 * to move, which is the right diagnostic for its own case. Two guards, two questions.
 *
 * THE RUNG IS DELIBERATELY NOT CONSULTED. `--rung software-developer-agent` is the top of the
 * ladder and ejects nothing, which the issue treats as a counterexample. It is an INSTANCE: a run
 * comparing a tree with itself, emitting a maximally confident census. Passing the rung down here
 * would buy only the ability to EXCUSE such a run — the parameter would be used to suppress the
 * finding rather than to make it. Whether the no-op came from a bug or from a flag does not change
 * what the census would assert, and the census is what ships.
 *
 * WHAT IT CANNOT SEE. A real eject that happens to leave an IDENTICAL tree would be refused
 * wrongly — but that cannot occur: `eject.mjs` deletes every path owned by a rung outside the
 * retain set, so a non-empty deletion leaves tracked files removed and `dirty` true. A deletion of
 * zero paths IS the no-op. It also cannot see an eject that ran, modified the tree, and produced
 * meaningless readings for some other reason; `dirty` says the tree changed, not that the change
 * was the right one. That second case is the vacuity guard's, which is why both exist.
 */
export function establishedNothingComplaint({
  fullTree,
  ejectedTree,
  fullCheckers,
  ejectedCheckers,
}) {
  /*
   * A missing or malformed `tree` is provenanceComplaints' refusal, and it runs first. Returning
   * null here rather than guessing keeps one failure owned by one guard: two refusals for one
   * cause produce a reader who fixes the wrong thing.
   */
  const f = fullTree,
    e = ejectedTree;
  const sameCommit =
    f &&
    e &&
    typeof f.head === "string" &&
    typeof e.head === "string" &&
    e.head === f.head;

  /*
   * `dirty` IS THE DISCRIMINATOR, NOT `head`. Both worktrees are checked out at the same commit
   * and `eject` deletes files without committing, so EQUAL HEADS IS THE NORMAL CASE and says
   * nothing on its own. What separates a real eject from a no-op is whether tracked files were
   * removed: `dirty` true means the eject took, false means it deleted nothing.
   */
  if (sameCommit && e.dirty === false)
    return (
      `the ejected tree is the FULL tree — same commit ${String(f.head).slice(
        0,
        12
      )}, and ` +
      `nothing was\n        modified in it. The eject did not take, so every checker read the ` +
      `same subject twice\n        and a census from this run would say "nothing varies by rung" ` +
      `on the strength of a\n        comparison with one operand. Exit 2: the question could not ` +
      `be asked, not answered.`
    );

  /*
   * AND AN UNREADABLE `dirty` IS ALSO A REFUSAL, for the reason this whole file exists to defend.
   * `treeProvenance` returns `dirty: null` when `git status` fails, and null is not false — it is
   * "could not ask". provenanceComplaints does not own this: it checks `dirty === true` on the
   * FULL tree only. So without this clause a run whose ejected tree could not be inspected passes
   * both guards and writes a census, on the strength of a question nobody answered.
   */
  if (sameCommit && e.dirty !== true)
    return (
      `could not tell whether the eject took — the ejected record's \`tree.dirty\` is ` +
      `${JSON.stringify(
        e.dirty
      )},\n        not true or false, and both worktrees sit at ` +
      `${String(f.head).slice(
        0,
        12
      )}. \`git status\` failed there.\n        An unreadable tree ` +
      `is not an unchanged one and it is not a changed one; a census from this\n        run would ` +
      `assert a comparison nobody established.`
    );

  /*
   * THE SECOND ROAD TO THE SAME VACUOUS CENSUS, asserted rather than assumed impossible. The
   * tree check above is not about checkers at all, so an empty run cannot satisfy it by accident
   * — but an empty run still measured nothing, and today the producer writes an empty census and
   * calls it a PASS while the registered consumer reports it as 52 separate registration defects.
   * That sends the reader hunting 52 missing entries when the audit measured zero.
   */
  const nF = Object.keys(fullCheckers ?? {}).length;
  const nE = Object.keys(ejectedCheckers ?? {}).length;
  if (nF === 0 || nE === 0)
    return (
      `no checker phases were recorded — full has ${nF}, ejected has ${nE}. An empty ` +
      `reading is\n        not a census of a repository where nothing varies; it is a run that ` +
      `measured nothing.\n        Downstream this surfaces as one registration defect per ` +
      `declared check, which sends the\n        reader to hunt missing entries instead of a ` +
      `missing measurement.`
    );

  return null;
}

/**
 * ONE EJECT SUFFICES ONLY IF SUBJECTS ARE MONOTONE UNDER FILE REMOVAL.
 *
 * `eject langchain` is the maximal strip — eject.mjs deletes every rung ABOVE its
 * argument, so the argument is a RETAIN point and `langchain` retains the fewest.
 * (`eject software-developer-agent` retains all 435 and deletes 0: a no-op that
 * produces a perfectly clean audit saying nothing, reachable by a plausible
 * reading of the interface.)
 *
 * If subjects only shrink when files vanish, a classification under the maximal
 * strip holds under every smaller one and one eject covers the ladder. That is
 * PLAUSIBLE, not proven — it would fail for a subject counting MISMATCHES or
 * DECLARED-BUT-MISSING, which can GROW as files disappear. So the audit asserts
 * it rather than assuming it, and says which checker broke it.
 */
export function monotonicityComplaints(classified) {
  /*
   * `not-tree-derived` IS EXCLUDED, AND THAT IS THE POINT OF THE VERDICT.
   * This guard reads a growing subject as "the one-eject assumption fails here".
   * For a checker whose subject is read over the network, growth means someone
   * filed an issue while the build ran — charging that to the eject would send
   * the reader hunting for a second eject target that does not exist. Excluded
   * because the premise does not hold, not because the complaint is inconvenient.
   */
  return Object.entries(classified)
    .filter(
      ([, r]) =>
        r.verdict !== NON_TREE &&
        r.ejected !== null &&
        r.full !== null &&
        r.ejected > r.full
    )
    .map(
      ([n, r]) =>
        `${n}: subject GREW under ejection, ${r.full} -> ${r.ejected}. The one-eject ` +
        `assumption does not hold for this checker, so a classification from the ` +
        `maximal strip alone does not cover the smaller ones. More eject targets are needed.`
    );
}

/**
 * Merge fresh classifications over the existing census, preserving human notes
 * ONLY where the verdict is unchanged.
 *
 * A note explains why a `static` is legitimate. If the verdict moved, the note
 * describes a state that no longer exists — and the repair for `static -> moved`
 * is to DELETE the note, not to keep it beside a contradicting verdict.
 */
/*
 * THE `lifts` A NEWLY-DISCOVERED STATIC STARTS WITH, AND IT MUST NAME AN OPEN ISSUE.
 * It was "#785", which has since CLOSED, so every new static was being stamped
 * "pending on" a resolved question.
 *
 * WHY THAT ROTTED UNNOTICED, AND WHY IT STILL MATTERS. The value never reaches a
 * merged tree on its own: a new static also gets `note: null`, and noteComplaints
 * fails the gate until a human writes one. So nothing ever failed because of it —
 * but the human who writes that note and leaves `lifts` alone ships the stale
 * premise, and the census then tells every later reader that a closed question is
 * still pending.
 *
 * THE SELFTEST CANNOT CHECK THIS. Asserting the number is open needs the network;
 * asserting the literal is what let it rot, because the test then only fails when
 * someone changes it deliberately. The test below asserts the SHAPE — pending, not
 * a silent null — and the requirement that it be open lives here, with the value,
 * in one place instead of three.
 */
export const DEFAULT_LIFTS = "#780";

/*
 * THE CLAIM IS NOW CHECKABLE, SO IT IS CHECKED (#822).
 *
 * `--sha` is an argument. This function used to have no way to tell whether the two
 * records came from the tree that argument names — feed it any two records with any
 * sha and it wrote a census that was internally consistent and about nothing. Since
 * #822 the record carries `tree.head`, so the claim can be compared against the
 * artifact instead of trusted.
 *
 * WHAT THIS CATCHES THAT NOTHING ELSE DID. A record can be present, parseable,
 * complete and internally consistent WHILE DESCRIBING THE WRONG TREE. That is not a
 * hypothetical: a failed `worktree add` followed by a failed `cd` left a procedure
 * running in the shared checkout, and both halves recorded it — the only tell was a
 * phase count in an artifact nobody read. #819's "did this MEASURE" is a better
 * question than "did this SUCCEED" and it does not catch this either.
 *
 * A MISSING `tree` IS A REFUSAL, NOT A PASS. A record predating #822 cannot vouch for
 * itself, and treating "no provenance" as "provenance fine" is the assumption this
 * whole issue exists to remove. It costs one regeneration of any stale record, which
 * is `pnpm eject-audit`.
 *
 * DIRTY IS FATAL FOR THE FULL HALF, for the same reason the sha is checked at all:
 * HEAD names what was committed, the checks ran against what was on disk, and a dirty
 * tree's sha is a real sha describing something nobody measured.
 *
 * THE EJECTED TREE IS DIRTY BY CONSTRUCTION — see the guard below for why, and for why
 * the converse is not asserted either. Stated here rather than only at the guard,
 * because a reader who arrives there holding "dirty is fatal, full stop" sees
 * `label === "full" &&` as an omission and removes it. That was this function's FIRST
 * version: it refused every `pnpm eject-audit` run, and no unit test caught it.
 */
export function provenanceComplaints({ full, ejected, sha }) {
  const bad = [];
  const seen = {};
  for (const [label, rec] of [
    ["full", full],
    ["ejected", ejected],
  ]) {
    const t = rec?.tree;
    if (!t) {
      bad.push(
        `the ${label} record carries no \`tree\` — it predates #822 and cannot say ` +
          `which tree produced it. Re-record it; a record that cannot vouch for its ` +
          `provenance is not evidence about the sha this census would name.`
      );
      continue;
    }
    if (typeof t.head !== "string" || !/^[0-9a-f]{40}$/.test(t.head)) {
      bad.push(
        `the ${label} record's tree.head is ${JSON.stringify(
          t.head
        )} — git could not ` +
          `answer where it ran, so the reading is unattributable.`
      );
      continue;
    }
    /*
     * DIRTY IS FATAL FOR THE FULL HALF ONLY, AND THE ASYMMETRY IS THE POINT.
     *
     * The full tree must be what its sha says: HEAD names what was committed and the
     * checks ran against what was on disk, so a modified full tree makes the census
     * name a commit nobody measured. That is the failure this issue exists for.
     *
     * THE EJECTED TREE IS DIRTY BY CONSTRUCTION and refusing on it would refuse every
     * run. `pnpm eject` DELETES tracked files — 424 of 435 for `langchain` — so its
     * worktree deliberately no longer matches its sha. The eject IS the intervention
     * being measured; "unchanged" there would be the defect, not the health.
     *
     * SO WHY NOT ASSERT THE EJECTED HALF *IS* DIRTY? Because how much an eject changes
     * is a FUNCTION OF THE RUNG, and this consumer is not told the rung —
     * `software-developer-agent` is the no-op rung, where an ejected tree is
     * legitimately identical and clean. Asserting dirtiness here would be a constant
     * that is right for the default invocation and wrong the first time someone passes
     * `--rung`, which is the same shape as the `--sha` claim this issue removes. Left
     * unchecked deliberately rather than guessed at.
     */
    if (label === "full" && t.dirty === true)
      bad.push(
        `the full record was taken in a DIRTY tree (${t.head.slice(
          0,
          12
        )}). Its sha ` +
          `names what was committed; the checks ran against what was on disk.`
      );
    seen[label] = t.head;
  }

  if (seen.full && seen.ejected && seen.full !== seen.ejected)
    bad.push(
      `the two halves measured DIFFERENT trees — full ${seen.full.slice(
        0,
        12
      )}, ` +
        `ejected ${seen.ejected.slice(
          0,
          12
        )}. Every classification here is a ` +
        `comparison between them, so none of it means anything.`
    );

  for (const [label, head] of Object.entries(seen))
    if (head !== sha)
      bad.push(
        `the ${label} record was produced at ${head.slice(
          0,
          12
        )} but --sha claims ` +
          `${String(sha).slice(
            0,
            12
          )}. The census would name a tree these readings ` +
          `did not come from.`
      );

  return bad;
}

/*
 * EXTRACTED SO IT CAN BE TESTED, because the bug lived exactly here and the
 * selftest could not see it. The first version sniffed for an array with
 * `Object.values(registry).find(Array.isArray)` — a shape borrowed from the run
 * record, which has one array and no ambiguity. checks.json has THREE: `$comment`
 * (prose), `checks` (the registered checkers), `unregistered`. Key order handed it
 * `$comment`: 13 plausible rows, every one a string with no `.name`, and an empty
 * needs map. The audit then refused with the identical message it gave before the
 * fix, and the selftest stayed green on both — a mutation restoring the sniff still
 * passes every case unless this function exists to be called directly.
 *
 * THROWS RATHER THAN RETURNING {}. An empty map and a misread array are the same
 * value, and they mean opposite things: "this repo declares no needs" versus "I
 * read the wrong array and every subject will now be treated as tree-derived".
 * The second silently reinstates the assumption this audit exists to question.
 */
export function needsFrom(registry) {
  if (!registry || !Array.isArray(registry.checks))
    throw new Error(
      "scripts/checks.json has no `checks` array, so no checker's `needs` " +
        "declaration could be read. Every subject would be treated as tree-derived, " +
        "which is the assumption this audit exists to avoid making silently."
    );
  return Object.fromEntries(
    registry.checks.filter((r) => r.needs).map((r) => [r.name, r.needs])
  );
}

/*
 * KEPT OUT OF `merge`, WHICH IS A PURE DATA FUNCTION. Shelling out to git from
 * inside merge would make every one of its cases depend on the ambient repo
 * resolving a hard-coded sha — a test that passes because the sha happens to
 * exist, and flips to `null` in a checkout where it does not. The reading is
 * taken once here, where the sha has already been resolved against a real tree,
 * and passed in as data.
 *
 * NULL MEANS "COULD NOT ASK", NOT "ZERO PARENTS". A root commit has zero; an
 * unresolvable sha has none to report. Those must not collapse.
 */
export function parentCountOf(sha, cwd = ROOT) {
  try {
    // stderr IGNORED, not inherited: an unresolvable sha is an expected input here
    // (it is the "could not ask" case), and git's `fatal: bad object` on the
    // checker's own stderr reads as the checker failing rather than answering.
    const out = execFileSync("git", ["rev-list", "--parents", "-n", "1", sha], {
      encoding: "utf8",
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out === "") return null;
    return out.split(/\s+/).length - 1;
  } catch {
    return null;
  }
}

/** A note that says something. `null`, absent, and whitespace are all "no note". */
export const hasNote = (n) => typeof n === "string" && n.trim().length > 0;

/**
 * THE AUTHORED HALF SURVIVES A VERDICT CHANGE, QUARANTINED RATHER THAN ASSERTED (#834).
 *
 * `note` and `lifts` are emitted only inside the STATIC branch below, so before this they
 * VANISHED whenever a verdict moved off STATIC — silently, and the same non-STATIC verdict
 * exempts the row from assert-eject-subjects-classified.mjs:110, which is the check that would
 * have complained. A full gate ran green over the deletion four times in one night.
 *
 * WHY THE TRIGGER IS USUALLY NOT A RECLASSIFICATION. A verdict leaves STATIC whenever the
 * checker merely FAILS in a run, for any reason. Measured, not supposed: `board-declarations`
 * left it because a GitHub endpoint was throttled, and `readme-quickstart` left it because a
 * tree was unbuilt. Neither is a statement about rung-scoping. So the discard fires on
 * environment facts, and a run that cannot reach GitHub destroys prose.
 *
 * WHY THIS DOES NOT REFUSE INSTEAD. Refusing on a verdict move would make every audit hostage
 * to a flaky endpoint — an environment fact producing a hard stop, which is #784 and #842 one
 * level up. The repair for those was to stop conflating "could not ask" with "violated"; adding
 * that shape to the producer would be the same mistake in a new place.
 *
 * WHY IT CARRIES THE VERDICT AND SHA IT WAS WRITTEN FOR, and not merely a flag saying it is
 * old. A field named only "retained" leaves the reader to supply the missing scope, and they
 * supply "current" — so the note gets copied back on the assumption it still describes this
 * tree, which is the failure this exists to prevent, one round trip later. Named with the
 * verdict and sha it described, it asserts nothing about the present and can be checked against
 * the tree it names. Same principle as `floorObserved` {sha, count, on}: provenance is what
 * makes a claim confirmable, and prose without it is a measurement nobody can re-take.
 *
 * AND IT RECORDS BOTH SHAS, BECAUSE `measuredAt` ALONE IS SCOPED IN FORM AND UNSCOPED IN FACT.
 * `measuredAt` is the commit the readings were taken at, which on a branch is routinely a
 * pre-squash commit reachable from no ref once the branch lands — measured on main just now:
 * its own `measuredAt` resolves in a local clone and `git branch -r --contains` returns ZERO
 * remote refs, while its `base` returns nine. A retention scoped only to a sha nobody can fetch
 * gives a reader provenance they cannot act on. `base` is the durable half and `measuredAt` is
 * the exact half; both are recorded and the reader is told which one resolves.
 *
 * IT DOES NOT VIOLATE THE DELETE-THE-NOTE DOCTRINE ABOVE. That rule is about a field ASSERTING
 * something false about the CURRENT verdict. A field named for the verdict it described asserts
 * nothing about this one.
 *
 * AND IT DOES NOT AUTO-RESTORE. A round trip through a transient verdict does not make the
 * prose true again — its counts go stale on every registration in between. The entry comes back
 * with `note: null`, so the gate still stops for a human; what changes is that the human is
 * asked to CONFIRM OR UPDATE text that is in front of them rather than to write it from scratch
 * from a copy they had to know to take by hand.
 *
 * WHAT IS NOT GUARDED, DEFERRED FOR SCOPE RATHER THAN FOR IMPOSSIBILITY. Nothing asserts that a
 * retention is not silently dropped by a later edit to this function; only the unit cases below
 * would notice. Such a gate needs the PREVIOUS census at check time, and that access exists and
 * is already used twice — `assert-census-fresh-on-merge.mjs` and
 * `assert-merge-keeps-registrations.mjs` both read a parent's tree via `git rev-list --parents`
 * under `needs: "merge-commit"`. So this is a producer fix and that would be a gate, which is a
 * scope line, NOT a claim that the checker cannot see the previous census. Recording the
 * difference because "cannot" reads as settled and stops anyone looking again.
 *
 * One property of that channel for whoever builds it: `merge-commit` is UNSATISFIABLE on a
 * one-parent HEAD, so such a gate SKIPS locally and on a push to main, which squash-merges. It
 * runs on `pull_request`, where the checkout is the merge commit — otherwise someone runs it
 * locally, sees SKIPPED, and concludes it is broken.
 */
export function retentionFor(old, measuredAt, base) {
  if (!old) return null;
  if (hasNote(old.note))
    return {
      note: old.note,
      lifts: old.lifts ?? null,
      verdict: old.verdict,
      measuredAt: measuredAt ?? null,
      base: base ?? null,
    };
  /*
   * No note of its own — carry an EARLIER retention forward rather than dropping it. Without
   * this, STATIC -> transient -> transient loses on the second hop what the first one saved,
   * and two consecutive throttled runs would defeat the whole mechanism.
   */
  return old.retainedFrom ?? null;
}

/** Emitted only when there is something to retain, so untouched rows gain no field. */
export const withRetention = (r) => (r ? { retainedFrom: r } : {});

export function merge(previous, fresh, sha, baseSha, shaParents) {
  /*
   * PROVENANCE THAT SURVIVES A SQUASH. `measuredAt` is the sha the readings were
   * actually taken at, which on a PR branch is a pre-merge commit that does NOT
   * exist in main's history afterwards — this repo squash-merges, and a branch
   * sha resolves to "unknown revision" from main. So `base` records the commit on
   * main the branch was cut from, which is durable, and the two together say what
   * tree was measured: that base with this change applied.
   *
   * Recording only `measuredAt` would leave the census pointing at nothing the
   * day it merges, which is the stale-pointer shape (#760, #782) one file over.
   */
  /*
   * PARENT COUNT IS AN INPUT, NOT A SUBJECT PROPERTY, and that is the line.
   * Provenance describing the measurement's INPUTS gets a field; provenance
   * describing a SUBJECT's nature gets a note on that entry. The commit HAD two
   * parents — that is a fact about what was measured, in the same category as
   * which sha and which base.
   *
   * AND IT IS RECORDED BECAUSE IT DECIDES VERDICTS AND IS OTHERWISE UNRECOVERABLE.
   * `census-survives-the-merge` and `merge-keeps-registrations` refuse on a
   * non-merge HEAD by design, so they classify `static` when measured from a merge
   * commit and `no-baseline` when measured from a squash commit on main — both
   * correct, about different measurement commits. `measuredAt` does not survive the
   * squash and `base` is single-parent, so without this a reader cannot tell whether
   * their re-take is comparable. A fact that decides a verdict should not depend on
   * someone reading prose carefully.
   */
  const out = {
    measuredAt: sha,
    measuredAtParents: shaParents,
    base: baseSha,
    baseNote:
      "readings were taken on `base` WITH this change applied. `measuredAt` is a " +
      "pre-squash commit, so it is NOT in main's history once this lands. It is " +
      "recoverable IF IT SURVIVED INTO THE PUSHED HISTORY: `refs/pull/N/head` keeps the " +
      "branch tip and its ancestors, and fetches over git protocol. It is NOT " +
      "recoverable if the measuring commit was amended or reset away before the final " +
      "push — #792 has both cases, 53a55735 reachable from its PR ref and 00d13e4b, an " +
      "earlier measuredAt from the same PR, reachable from no ref at all. " +
      "TWO EARLIER VERSIONS OF THIS SENTENCE WERE WRONG IN OPPOSITE DIRECTIONS: one " +
      "said measuredAt 'does not survive the merge' (too pessimistic, shipped in " +
      "fb24b13e); its replacement said it 'stays reachable' (too optimistic). A " +
      "durability claim about a sha is a claim about REACHABILITY FROM A REF, and it " +
      "is checkable in one command — `git branch -r --contains <sha>` — which is what " +
      "neither version did before being written. " +
      "`base` NAMES THE COMMIT THE READINGS WERE TAKEN AGAINST, NOT THE BRANCH'S CURRENT " +
      "BASE: a branch that merges main again afterwards is no longer based on it, and the " +
      "readings do not move when that happens. So a reader re-taking on the branch as it " +
      "stands today is measuring a DIFFERENT tree than this field names, and a difference " +
      "they find is not necessarily a change in what was measured. Re-take against `base` " +
      "itself, or record a new one. " +
      "`measuredAtParents` is recorded because two entries classify differently from a " +
      "merge commit than from a squash commit, and that fact is otherwise unrecoverable once " +
      "`measuredAt` is gone. A reading taken from a single-parent commit is the one a " +
      "re-take on main is comparable to, because main squash-merges and its commits have " +
      "one parent; a reading taken from a merge commit answers about a tree shape main " +
      "never has",
    ejectTarget: "langchain",
    checkers: {},
  };
  for (const [name, r] of Object.entries(fresh)) {
    const old = previous?.checkers?.[name];
    const keep = old && old.verdict === r.verdict && r.verdict === STATIC;
    const emitted =
      r.verdict === STATIC
        ? {
            note: keep ? old.note : null,
            lifts: keep ? old.lifts : DEFAULT_LIFTS,
          }
        : {};
    out.checkers[name] = {
      verdict: r.verdict,
      full: r.full,
      ejected: r.ejected,
      why: r.why,
      ...emitted,
      ...(hasNote(emitted.note)
        ? {}
        : withRetention(
            retentionFor(
              old,
              previous?.measuredAt ?? null,
              previous?.base ?? null
            )
          )),
    };
  }
  return out;
}

function main() {
  const arg = (f) => {
    const i = process.argv.indexOf(f);
    return i !== -1 ? process.argv[i + 1] : null;
  };
  const fullPath = arg("--full");
  const ejectedPath = arg("--ejected");
  const sha = arg("--sha");
  const baseSha = arg("--base");
  if (!fullPath || !ejectedPath || !sha || !baseSha) {
    console.error(
      `REFUSE: needs --full <record> --ejected <record> --sha <sha> --base <sha on main>.\n` +
        `        Both records must come from ONE sha and from BUILT trees. Nothing was\n` +
        `        compared, which is not the same as nothing being wrong.`
    );
    process.exit(2);
  }
  const fullRecord = JSON.parse(readFileSync(fullPath, "utf8"));
  const ejectedRecord = JSON.parse(readFileSync(ejectedPath, "utf8"));

  const provenance = provenanceComplaints({
    full: fullRecord,
    ejected: ejectedRecord,
    sha,
  });
  if (provenance.length > 0) {
    console.error(
      `REFUSE: ${provenance.length} provenance problem(s) — the records cannot be ` +
        `attributed to the tree this census would name:`
    );
    provenance.forEach((p) => console.error(`   - ${p}`));
    console.error(`        Nothing was classified.`);
    process.exit(2);
  }

  const F = checkersOf(fullRecord);
  const E = checkersOf(ejectedRecord);

  /*
   * BEFORE ANYTHING IS CLASSIFIED (#843). If the run compared a tree with itself, or measured no
   * checkers at all, then every verdict below would be an artefact of the comparison rather than
   * a fact about the ladder. Classifying first and refusing after would compute fifty-three
   * verdicts nobody should read, and the cost of a wrong census is that it is CONFIDENT.
   */
  const nothing = establishedNothingComplaint({
    fullTree: fullRecord?.tree,
    ejectedTree: ejectedRecord?.tree,
    fullCheckers: F,
    ejectedCheckers: E,
  });
  if (nothing) {
    console.error(`REFUSE: ${nothing}`);
    process.exit(2);
  }

  /*
   * THE KEY IS NAMED, NOT SNIFFED. The first version of this reused the
   * `Object.values(x).find(Array.isArray)` shape that works on a run record, whose
   * one array is unambiguous. checks.json has THREE — `$comment` (13 prose lines),
   * `checks` (the 49), `unregistered` (13) — and key order handed it `$comment`.
   * It produced 13 plausible rows, every one of them a string with no `.name`, and
   * an EMPTY needs map: the exclusion silently did nothing and the audit refused
   * exactly as it had before the fix. A wrong array that returns zero announces
   * itself; one that returns a confident 13 does not.
   *
   * AND THE FALLBACK IS GONE WITH IT. `?? []` cannot tell "this repo declares no
   * needs" from "I read the wrong array", and those must not look alike — the
   * second silently restores the bug this replaced.
   */
  const registry = JSON.parse(
    readFileSync(join(ROOT, "scripts/checks.json"), "utf8")
  );
  let needsOf;
  try {
    needsOf = needsFrom(registry);
  } catch (e) {
    console.error(`REFUSE: ${e.message}`);
    process.exit(2);
  }

  const fresh = {};
  for (const name of Object.keys(F))
    fresh[name] = classifyOne(F[name], E[name], needsOf[name] ?? null);

  const vacuity = vacuityComplaint(fresh);
  if (vacuity) {
    console.error(`REFUSE: ${vacuity}`);
    process.exit(2);
  }
  const mono = monotonicityComplaints(fresh);
  if (mono.length > 0) {
    console.error(`FAIL: ${mono.length} monotonicity violation(s):`);
    mono.forEach((m) => console.error(`   - ${m}`));
    process.exit(1);
  }

  const previous = existsSync(CENSUS)
    ? JSON.parse(readFileSync(CENSUS, "utf8"))
    : null;
  const next = merge(previous, fresh, sha, baseSha, parentCountOf(sha));
  writeFileSync(CENSUS, JSON.stringify(next, null, 2) + "\n");

  const tally = {};
  for (const e of Object.values(next.checkers))
    tally[e.verdict] = (tally[e.verdict] ?? 0) + 1;
  // PER-CHECKER IS THE FINDING. No aggregate subject-count is computed: an
  // aggregate inherits its noisiest component's variance, so a real change in a
  // small-subject checker vanishes inside it.
  reportSubject(
    Object.keys(next.checkers).length,
    "checker(s) compared across the eject boundary"
  );
  console.log(`PASS: census written for ${sha}. ${JSON.stringify(tally)}`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  main();
}
