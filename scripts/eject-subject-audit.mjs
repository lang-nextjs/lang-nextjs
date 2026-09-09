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
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  classifierFor,
  isStatic,
  assertTarget,
  NON_TREE,
} from "./lib/eject-classify.mjs";
import { reportSubject } from "./lib/subject.mjs";
/*
 * THE CONSUMER'S OWN COMPARISON, IMPORTED RATHER THAN REWRITTEN (#920). The gate already
 * reconciles checks.json against the census and is the thing that caught the short census
 * after it was written. A second implementation here would be a second definition of
 * "registered", free to drift from the one that decides the verdict — declared in one file
 * and consumed in another, which is the seam this repo keeps finding defects at. The gate
 * imports nothing from this file, so there is no cycle, and it runs nothing on import.
 */
import {
  reconcile,
  registeredCheckers,
} from "./assert-eject-subjects-classified.mjs";

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
   * `dirty` IS THE DISCRIMINATOR, AND `head` CANNOT BE IN ANY REACHABLE STATE. Equal heads is not
   * merely the normal case — it is a PRECONDITION THE PRODUCER ENFORCES: `treeShaComplaints` in
   * eject-audit-run.mjs refuses unless BOTH worktrees sit at the commit being measured, and that
   * refusal throws. A run whose two trees are at different commits never reaches this function.
   *
   * So `head` is constant across every input this can receive, and a guard built on it would be
   * asserting something no reachable state can falsify. `eject` deletes files without committing,
   * so the only field that moves is `dirty`: true means tracked files were removed and the eject
   * took, false means it deleted nothing.
   */
  if (sameCommit && e.dirty === false)
    return (
      `the ejected tree is the FULL tree — same commit ${String(f.head).slice(
        0,
        12
      )}, and ` +
      `nothing was\n        modified in it. Every checker read the same subject twice, so a ` +
      `census from this run\n        would say "nothing varies by rung" on the strength of a ` +
      `comparison with one operand.\n` +
      `        Exit 2: the question could not be asked, not answered.\n` +
      `\n` +
      `        TWO WAYS TO GET HERE, AND ONLY ONE IS A BUG. The eject may have failed. Or the\n` +
      `        target may be the TOP OF THE LADDER — \`eject\` deletes every rung ABOVE its\n` +
      `        argument, so \`--rung software-developer-agent\` has nothing above it to delete\n` +
      `        and leaves an identical tree by design. That is not a broken eject and there is\n` +
      `        nothing to debug; it is a run that cannot produce a census, because comparing a\n` +
      `        tree with itself establishes nothing whatever the reason. Check which case you\n` +
      `        are in before looking for a defect.`
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
 * The checkers that REFUSED in the full tree, as the sentence a reader gets, or null.
 *
 * A REFUSED BASELINE IS NOT A SMALL BASELINE (#920). Every verdict below compares the
 * ejected reading against the full one, so the full reading is the measuring stick. A
 * checker that exits 2 there could not ask its question at all — `classifyOne` correctly
 * records `no-baseline` for it, and a census full of `no-baseline` rows is well formed,
 * reads as ordinary, and asserts nothing about the ladder.
 *
 * THE OCCURRENCE THIS IS FOR. An install reported success — 982 packages, typescript listed
 * — and then checkers could not import typescript from that same tree. The three that say
 * `typescript could not be imported` REFUSE at exit 2 by design, which is right for them and
 * wrong for the run: the audit exited 0 over a tree that could not answer.
 *
 * ONLY THE FULL TREE, AND THAT IS THE WHOLE DISCRIMINATION. A refusal in the EJECTED tree is
 * the ordinary `absent` verdict — the eject deleted what the checker reads, which is a finding
 * rather than a fault. MEASURED, because it is the number that makes this distinction
 * necessary rather than fussy: of the 13 `absent` rows in the census on main, NINE carry
 * "REFUSED in the ejected tree" and the other four are "not present in the ejected reading".
 * So a guard counting refusals on both sides would refuse every run ever taken, and it would
 * do it citing nine checkers that behaved exactly as designed.
 *
 * AND NOT `no-baseline` EITHER, for the same reason one step further. Refusing on any
 * `no-baseline` row looks like the more general guard and is a false refusal today: the census
 * on main carries one, `eject-subjects-classified` at "FAILS on the full tree too", which is
 * the documented self-referential case — this gate is itself one of the checkers the audit
 * runs. Exit 2 is the signal because it means the question could not be ASKED; exit 1 means it
 * was asked and answered.
 */
export function refusedBaselineComplaint(fullCheckers) {
  const refused = Object.entries(fullCheckers ?? {})
    .filter(([, r]) => r?.exit === 2)
    .map(([name]) => name);
  if (refused.length === 0) return null;
  return (
    `${refused.length} checker(s) REFUSED in the FULL tree, so there is no baseline to ` +
    `measure the\n        eject against for them: ${refused
      .slice(0, 8)
      .join(", ")}` +
    `${refused.length > 8 ? ", ..." : ""}.\n` +
    `        Exit 2 is "could not ask", not "failed" — the full tree is the measuring stick ` +
    `here, and a\n        stick that could not be read produces \`no-baseline\` rows that look ` +
    `like ordinary census\n        entries. The tree is the suspect, not the checkers: an ` +
    `install can report success and still\n        leave a package unimportable. Re-run the ` +
    `audit; if it recurs, install in the full tree by\n        hand and check that what these ` +
    `checkers import actually resolves.\n` +
    `        A refusal in the EJECTED tree is not this — that is the ordinary \`absent\` ` +
    `verdict.`
  );
}

/**
 * The registered checkers the census about to be written does not classify, or null.
 *
 * THE PRODUCER MUST NOT WRITE A CENSUS ITS OWN CONSUMER WILL REJECT (#920). A run wrote 54
 * entries against a 62-check registry, exited 0, printed a normal-looking completion, and was
 * about to be committed as a PR's evidence. Nothing in the exit code, the output or the file
 * said anything was wrong. It was caught by a person comparing two numbers by hand.
 *
 * A CENSUS SHORTER THAN ITS REGISTRY IS THE VACUOUS-GREEN SHAPE AT ARTIFACT SCALE: a 54-entry
 * census is well formed and reads no differently from a 62-entry one, so the drop is invisible
 * in the artifact. Both numbers were already in this process — nothing compared them.
 *
 * WHY HERE AND NOT ONLY IN THE GATE. The gate does catch this, and did. But it runs later, on
 * a census already written and possibly already committed, and it reports the shortfall as one
 * registration defect per missing checker — which sends the reader hunting for missing
 * ENTRIES when what happened was a missing MEASUREMENT. The producer knows which it is.
 *
 * MECHANISM-INDEPENDENT ON PURPOSE. This does not model how rows go missing; it compares the
 * artifact against the registry that defines it, so it fires whatever dropped them.
 */
export function totalityComplaint(registered, census) {
  const { unclassified, orphaned } = reconcile(registered, census);
  if (unclassified.length === 0 && orphaned.length === 0) return null;
  const lines = [];
  if (unclassified.length > 0)
    lines.push(
      `${unclassified.length} registered checker(s) have no entry in the census this run ` +
        `would write:\n          ${unclassified.slice(0, 8).join(", ")}${
          unclassified.length > 8 ? ", ..." : ""
        }`
    );
  if (orphaned.length > 0)
    lines.push(
      `${orphaned.length} classified name(s) are not registered in checks.json:\n` +
        `          ${orphaned.slice(0, 8).join(", ")}${
          orphaned.length > 8 ? ", ..." : ""
        }`
    );
  return (
    `the census does not reconcile with checks.json.\n        ` +
    lines.join(`\n        `) +
    `\n        A census SHORT of its registry is not a smaller census, it is a census with ` +
    `holes, and\n        it is invisible in the file: a 54-entry census reads exactly like a ` +
    `62-entry one.\n        NOTHING WAS WRITTEN. Both numbers were already in this run; this ` +
    `is the comparison\n        nobody was making.`
  );
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
 *
 * AND THE FIRST REAL COUNTEREXAMPLE GREW BY THE OTHER MECHANISM, so this paragraph
 * was half right in a way that would misdirect the next reader. `formatted` grows
 * because the EJECTOR WRITES, not because files disappear: its subject is every file
 * the branch touches, and the ejector's edits are changes. The strip is not what
 * enlarges the diff — the rewriting is.
 *
 * THAT DISTINCTION DECIDES WHETHER THE PREMISE ACTUALLY BROKE. Growth from files
 * VANISHING can produce, under a smaller strip, a subject the maximal strip never
 * saw — the premise fails and a second eject target is genuinely needed. Growth from
 * the ejector WRITING is monotone in the strip: more stripping means strictly more
 * change, so the maximal strip is the worst case and still bounds the ladder.
 * Measured across all five rungs, files the ejector touched: 0, 255, 398, 430, 442.
 * So `ejected > full` is a PROXY for the premise, and the two come apart here.
 */
/**
 * Checkers whose subject GROWS WITH THE STRIP ITSELF, each with why that is allowed to stand.
 * Not a suppression list: a name here is a recorded decision, and anything NOT here fires.
 *
 * THE PREMISE ABOVE STILL HOLDS FOR THESE; IT IS THE PROXY THAT DOES NOT. The guard reads
 * `ejected > full` as "the maximal strip does not bound the smaller ones". That inference is
 * sound for a subject counting MISMATCHES or DECLARED-BUT-MISSING, where growth comes from
 * files VANISHING and a smaller strip can produce a subject the maximal one never saw. It is
 * unsound for a subject that grows because the EJECTOR WRITES -- there, more stripping means
 * strictly more change, so the maximal strip is the worst case and still covers the ladder.
 */
export const GROWS_WITH_THE_STRIP = {
  formatted:
    "its subject is every file the branch touches INCLUDING uncommitted drift (#856), and the " +
    "ejector's own edits are drift it must examine -- an eject emitting unformatted files is " +
    "#1123. So the subject is monotone INCREASING in strip size, which is the opposite of the " +
    "case the proxy was built for. MEASURED across all five rungs, files the ejector touched: " +
    "software-developer-agent 0 (a no-op), open-swe 255, deepagents 398, langgraph 430, " +
    "langchain 442. `langchain` is the maximal strip and the maximum, so a classification taken " +
    "there bounds every smaller one and ONE EJECT STILL COVERS THE LADDER. " +
    "THIS ROW WAS INVISIBLE UNTIL #1126 REPAIRED IT: while the checker FAILED under ejection its " +
    "`ejected` count was null, nothing was compared, and the guard never evaluated it. The " +
    "assumption was not holding, it was VACUOUS -- and a vacuous assumption reads exactly like a " +
    "satisfied one. Three rows in the census are `broken` today -- it was four until #1126 repaired this very row -- and each is such a place; " +
    "repairing one can surface a violation latent since it broke, with the repair looking like " +
    "the cause.",
};

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
      ([n, r]) =>
        r.verdict !== NON_TREE &&
        !Object.prototype.hasOwnProperty.call(GROWS_WITH_THE_STRIP, n) &&
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
 * THE SAME THROWING CONTRACT AS `needsFrom`, FOR THE SAME REASON. An empty map
 * and a misread array are the same value and mean opposite things: "nothing
 * declares an external subject" versus "I read the wrong array, and every
 * subject is now treated as tree-derived". The second silently reinstates the
 * assumption this audit exists to question, which is the failure `needsFrom`
 * documents above and which reached main once already.
 *
 * READ SEPARATELY FROM `needs` BECAUSE THEY ARE INDEPENDENT (#844). A checker
 * can declare a channel and a tree subject, or an external subject and no
 * channel; `worktree-inventory` is the second and is why this exists.
 */
export function subjectKindFrom(registry) {
  if (!registry || !Array.isArray(registry.checks))
    throw new Error(
      "scripts/checks.json has no `checks` array, so no checker's `subjectKind` " +
        "declaration could be read. Every subject would be treated as tree-derived, " +
        "which is the assumption this audit exists to avoid making silently."
    );
  return Object.fromEntries(
    registry.checks
      .filter((r) => r.subjectKind)
      .map((r) => [r.name, r.subjectKind])
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
 * A NOTE'S PROVENANCE, WHICH ONLY THE EXILED HALF HAD (#875).
 *
 * `retainedFrom` records the verdict and shas a QUARANTINED note was written for. A note held
 * DIRECTLY carried nothing: `note: keep ? old.note : null` copies prose forward with no record
 * of which tree it described. So the field a reader ACTS ON had no provenance while the field
 * nobody could see had all of it.
 *
 * That is why a note can contradict its own row undetected. The census carries one arguing its
 * domain is 53 beside a `full` of 54, and nothing notices — NOT because prose is unparseable,
 * but because nothing records WHEN the prose was written, so "this note predates the
 * measurement beside it" is not computable even in principle.
 *
 * WHAT IS STAMPED IS THE DERIVED VALUES, NOT A TIME. `measuredAt` changes on every run, so
 * "the stamp differs from the current measurement" would be true for every note after any
 * subsequent audit — a signal that fires on everything, which is the same as firing on
 * nothing. The question worth asking is not HOW OLD the prose is but WHETHER THE THING IT
 * DESCRIBES HAS MOVED, and that is a comparison of `full`/`ejected` against what they were.
 *
 * THE DIGEST IS WHAT MAKES AN EDIT DISTINGUISHABLE FROM A CARRY. merge() holds exactly one
 * prior state — `old` IS `previous.checkers[name]` — so it cannot compare a note against its
 * own earlier self. Without a fingerprint, a human who rewrites a stale note inherits the old
 * stamp and the row flags FOREVER, loudest exactly where the work has already been done. With
 * one, the stamp says which prose it was taken for and one prior state is enough.
 *
 * The digest needs no sha to resolve, which matters: main's own `measuredAt` is unreachable
 * from main under squash-merge and that is the steady state, not a defect. Nothing here
 * depends on the recorded sha resolving.
 */
export const noteDigest = (note) =>
  createHash("sha256")
    .update(String(note ?? ""))
    .digest("hex")
    .slice(0, 16);

export function stampFor(old, note, previous) {
  const held = old?.noteWrittenAt;
  if (held && held.noteDigest === noteDigest(note)) return held;
  return {
    sha: previous?.measuredAt ?? null,
    full: old?.full ?? null,
    ejected: old?.ejected ?? null,
    noteDigest: noteDigest(note),
  };
}

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
 * AND ONE CLASS OF FAILURE IS STRUCTURAL RATHER THAN ENVIRONMENTAL, WHICH MAKES THIS
 * RECURRING RATHER THAN UNLUCKY. `eject-subjects-classified` is inside its own subject: on
 * the one run that registers a new checker it correctly exits 1 on BOTH trees, so no
 * subject, so no baseline, so its authored note is discarded. That is not a flaky endpoint —
 * it happens on every registering run, by design. Measured on the #813 audit, where the
 * retention caught 3238 chars byte-identically (sha256 d7b9a495bdd17009). The retention is
 * therefore load-bearing on a predictable schedule and not only when the network misbehaves.
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
 * AND IT RECORDS BOTH SHAS, BECAUSE `writtenAt` ALONE IS SCOPED IN FORM AND UNSCOPED IN FACT.
 * `writtenAt` is the commit the retained prose was last valid at, which on a branch is routinely
 * a pre-squash commit reachable from no ref once the branch lands — measured on main just now:
 * it resolves in a local clone and `git branch -r --contains` returns ZERO remote refs, while
 * `writtenAgainst` returns nine. A retention scoped only to a sha nobody can fetch gives a
 * reader provenance they cannot act on. `writtenAgainst` is the durable half and `writtenAt`
 * is the exact half; both are recorded and the reader is told which one resolves.
 *
 * THE KEYS SAY `written` RATHER THAN `measured` BECAUSE THEY DESCRIBE A DIFFERENT RUN FROM THE
 * CENSUS'S OWN `measuredAt` (#876). The top-level field means "what THIS run measured"; these
 * mean "the run the retained prose was written for". They were spelt the same, and two readers
 * — one of them this field's author — imported the top-level meaning and concluded a retention
 * had been inherited from somewhere it had not. Correct grammar applied to the wrong scope,
 * with nothing in the artifact able to correct it.
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
export function retentionFor(old, writtenAt, writtenAgainst) {
  if (!old) return null;
  if (hasNote(old.note))
    return {
      note: old.note,
      lifts: old.lifts ?? null,
      /*
       * THE PROVENANCE FIELDS TRAVEL WITH THE VALUE THEY DESCRIBE (#1081).
       *
       * #1071 deliberately kept `liftsRuledAt` OUT of this literal, and pinned the exclusion
       * with a mutation. That was right while nothing restored the pair: a ruling surviving a
       * trip its value did not would silence a row whose premise had been erased. The same
       * paragraph named the alternative it was choosing against -- "worse than LOSING BOTH AND
       * RESTORING BOTH" -- and this is that alternative, now that `restorationFor` returns them
       * together or not at all. The ruling still cannot outlive its subject, because it is not
       * carried without it.
       */
      liftsRuledAt: old.liftsRuledAt ?? null,
      liftsDefaultedAt: old.liftsDefaultedAt ?? null,
      verdict: old.verdict,
      writtenAt: writtenAt ?? null,
      writtenAgainst: writtenAgainst ?? null,
      carriedFor: 0,
    };
  /*
   * No note of its own — carry an EARLIER retention forward rather than dropping it. Without
   * this, STATIC -> transient -> transient loses on the second hop what the first one saved,
   * and two consecutive throttled runs would defeat the whole mechanism.
   *
   * AND COUNT THE CARRY, WHICH IS WHAT MAKES AN UNRESOLVED TRANSIENT VISIBLE (#1040). A verdict
   * moving to `no-baseline` because a registration is pending is CORRECT and resolves on the next
   * audit; nothing asserted that it ever does. `writtenAt` cannot answer it -- it freezes at the
   * moment of quarantine while `measuredAt` advances, so it differs from the current reading on
   * the first hop exactly as it does on the tenth. Ancestry cannot answer it either: this repo
   * squash-merges, so the previous audit's sha is routinely unreachable from main, and the
   * docstring above already says nothing here may depend on a recorded sha resolving.
   *
   * A COUNT NEEDS NEITHER. `carriedFor: 0` is a quarantine taken this audit; 1 or more is one that
   * has survived a full audit without the verdict returning, which is the expectation #1040 asks
   * for -- and `verdict` beside it already records what it is expected to return TO.
   */
  const carried = old.retainedFrom ?? null;
  return carried
    ? { ...carried, carriedFor: (carried.carriedFor ?? 0) + 1 }
    : null;
}

/**
 * WHAT A QUARANTINE GIVES BACK WHEN THE VERDICT RETURNS (#1081), or null when it gives nothing.
 *
 * `keep` requires verdict EQUALITY, so a `static -> no-baseline -> static` round trip fails it on
 * BOTH hops: outbound because the new verdict is transient, inbound because the old one is. The
 * authored `note` becomes null and `lifts` becomes DEFAULT_LIFTS on the way out, and until now
 * nothing restored them on the way back. #834 recorded that mechanism precisely and was closed
 * COMPLETED without the code changing, so no open item tracked it -- which is #1081.
 *
 * IT IS PAID BY A FUTURE EVENT, NOT A VISIBLE ONE. Every registration traverses this path, so the
 * four rulings #1078 transcribed into the census were scheduled to be destroyed by the next one,
 * along with the notes they were transcribed from.
 *
 * ONLY WHEN THE VERDICT COMES BACK THE SAME. Prose written for `static-under-eject-langchain`
 * argues about a different question from one written for another target, and restoring across
 * that would assert something the row no longer claims -- the same rule `retainedRepairs` applies
 * when it offers a note to a reader.
 *
 * ALL OR NOTHING, WHICH IS THE WHOLE SAFETY ARGUMENT. The fields are returned as one unit, so a
 * ruling can never come back beside a value it did not rule on. That is what makes restoring
 * `liftsRuledAt` safe here while carrying it alone would not be.
 *
 * A RESTORE IS NOT A DEFAULT, and the caller must not stamp one. The value came from the
 * quarantine, so writing `liftsDefaultedAt: {value: DEFAULT_LIFTS, ...}` over it would be false
 * provenance of exactly the kind #1071 exists to prevent -- the retained stamp comes back instead.
 *
 * AND IT RETURNS NO NOTE, WHICH IS THE LINE THIS REPAIR MUST NOT CROSS. The docstring above
 * refuses to auto-restore prose, and the reason is not caution: "a round trip through a transient
 * verdict does not make the prose true again -- its counts go stale on every registration in
 * between." Those counts restate the row's own `full`/`ejected`, which move while the row is away,
 * so a verbatim restore ships a note contradicting the fields beside it. That has reached main
 * once already, as `full` reading 50 next to a note still saying 49.
 *
 * ITS DOMAIN IS SET BY `hasNote`, WHICH IS A LIMIT RATHER THAN A GUARD. A static row carrying a
 * ruling and NO note produces no retention at all, so the round trip still destroys it -- #834
 * surviving for the note-less case. There is no live instance (all 31 static rows carry notes) and
 * widening it would mean retaining rows with nothing authored to retain, so it is recorded as a
 * boundary rather than closed here.
 *
 * THE VALUES CARRY NO DERIVED CONTENT AND THAT IS THE WHOLE DISTINCTION. `lifts` is a pointer to
 * an issue; `liftsRuledAt` is a stamp naming the value it ruled on. Neither goes stale because
 * `full` moved. The prose does, so the human still confirms it -- with the rulings already correct
 * beside them rather than four transcriptions to redo.
 */
export function restorationFor(old, verdict) {
  const r = old?.retainedFrom;
  if (!r || !isStatic(verdict)) return null;
  if (r.verdict !== verdict) return null;
  if (!hasNote(r.note)) return null;
  return {
    lifts: r.lifts ?? null,
    liftsRuledAt: r.liftsRuledAt ?? null,
    liftsDefaultedAt: r.liftsDefaultedAt ?? null,
  };
}

/** Emitted only when there is something to retain, so untouched rows gain no field. */
export const withRetention = (r) => (r ? { retainedFrom: r } : {});

export function merge(
  previous,
  fresh,
  sha,
  baseSha,
  shaParents,
  { ejectTarget }
) {
  assertTarget(ejectTarget);
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
      "never has. " +
      "" +
      "AND THE TIP THAT MATTERS IS THE ONE THIS CENSUS WAS MEASURED FROM, NOT MAIN'S. That " +
      "distinction is neither pedantry nor rare: `allow_update_branch` brings a behind branch " +
      "current by MERGING main into it, because GitHub's update-branch API has no rebase " +
      "option. So every branch a merge queue promotes carries a TWO-PARENT TIP, and an audit " +
      "run there records `measuredAtParents: 2` and produces exactly the reading the sentence " +
      "above warns about. " +
      "" +
      "THIS IS NOT A WINDOW THAT OPENS AND CLOSES. It is the DEFAULT STATE of any behind " +
      "branch the queue has touched, so there is nothing to wait out — four branches carried " +
      "such a tip at once on the day this was written. MAIN'S OWN PARENT COUNT TELLS YOU " +
      "NOTHING ABOUT YOURS: run `git rev-list --parents -n 1 HEAD` on the tip you are about to " +
      "measure from, and rebase onto main first if it reports two. " +
      "" +
      "THE SETTING'S NAME DOES NOT SUGGEST ANY OF THIS, which is why it is recorded here " +
      "rather than left to be rediscovered. It was enabled to unblock a merge queue; its " +
      "artefact is a changed COMMIT SHAPE on every branch it touches, and that only matters to " +
      "a file which records parent counts. What a setting unblocks and what it produces are " +
      "different questions, and only the first is in its name. " +
      "" +
      "`measuredAt` IS PROVENANCE, NOT A CHECKABLE CLAIM, AND NOTHING SHOULD BE BUILT TO ENFORCE " +
      "IT (#872). It names the tree the readings came from. It does NOT promise that tree is " +
      "retrievable, and this repository's merge strategy guarantees it usually is not: a branch " +
      "squashes, its commits leave every ref, and the sha recorded here becomes reachable from " +
      "nothing. MEASURED ON MAIN, on the census this note is attached to — `git branch -r " +
      "--contains <measuredAt>` returns ZERO refs while `base` is an ancestor of main. So a " +
      "guard asserting reachability would refuse on main's own committed census the day it " +
      "landed. " +
      "" +
      "AND IT WOULD DO SO INCONSISTENTLY, which is worse than failing. The object survives in " +
      "the local repository of whoever fetched the branch before it squashed, and nowhere else. " +
      "CI clones fresh and fetches `+refs/heads/*`, so it never sees it. The same guard would " +
      "therefore PASS for the person who took the measurement and FAIL in CI — a verdict about " +
      "the runner's fetch history rather than about the repository. " +
      "" +
      "THE TWO REPAIRS THAT LOOK AVAILABLE ARE NOT. Scoping the check to `pull_request` still " +
      "fails on any rebase or force-push of the branch being measured, which is routine, so it " +
      "buys a flaky gate rather than a working one. And re-anchoring to `base` answers a " +
      "DIFFERENT QUESTION: `base` is the main commit the readings were taken AGAINST, while " +
      "`measuredAt` is the tree they were taken FROM, which includes the branch's own changes. " +
      "Substituting one for the other would keep a field that is checkable and lose the fact it " +
      "exists to record. " +
      "" +
      "WHAT IT IS FOR, stated so the next reader does not re-derive this: it is an IDENTITY, not " +
      "a retrieval handle. Its job is to say every row here came from ONE tree and to name which. " +
      "That claim is what `measuredAtParents` and `base` make checkable in the ways they can be. " +
      "Reachability is not among them and never was.",
    ejectTarget,
    checkers: {},
  };
  for (const [name, r] of Object.entries(fresh)) {
    const old = previous?.checkers?.[name];
    const keep = old && old.verdict === r.verdict && isStatic(r.verdict);
    /*
     * AND A ROUND TRIP RETURNS WHAT IT TOOK (#1081). `keep` is false on the way back from a
     * transient verdict, so without this the row is rebuilt as though it were NEW: note null,
     * lifts defaulted, ruling gone. The quarantine already held all of it; nothing read it.
     */
    const restored = keep ? null : restorationFor(old, r.verdict);
    /*
     * THE NOTE IS DELIBERATELY NOT AMONG THEM. `restorationFor` does not return one, and this
     * line is unchanged: a round trip does not make prose true again, because its counts go
     * stale on every registration in between. The gate still stops for a human; what #1081
     * changes is that the human confirming the text no longer has four rulings to re-transcribe
     * beside it.
     */
    const note = keep ? old.note : null;
    /*
     * A DEFAULTED `lifts` SAYS SO, AND SAYS WHAT IT WROTE (#1071).
     *
     * `lifts: keep ? old.lifts : DEFAULT_LIFTS` stamps a premise on a row NOBODY EXAMINED, and
     * the census's own prose names the hazard already -- "LIFTS ON #780 IS EXAMINED, NOT
     * INHERITED ... a default accepted in silence is how a stale premise ships". The artifact
     * documents the danger and the producer performs it.
     *
     * THE VALUE CANNOT CARRY THE DISTINCTION. `"#780"` reads identically whether a human
     * examined it and agreed or the producer typed it. Measured on main: FIVE rows carry it,
     * all five carry a note, and FOUR of those notes say in terms that the value was examined
     * and deliberately kept. Same bytes, opposite meanings, and no predicate over the census
     * separates them because the difference was never written down.
     *
     * AND `keep` CANNOT STAND IN FOR IT. `keep === false` marks the moment a default is
     * stamped; `keep === true` means CARRIED, not examined, and carrying a default forward
     * examines nothing. A value derived at write time is right on the first hop and wrong on
     * every hop after -- the same reason `noteWrittenAt` is a stamp rather than an inference.
     * So the stamp is carried forward, not recomputed.
     *
     * IT RECORDS WHAT, NOT ONLY WHEN AND WHERE. A reader verifying a repair compared it against
     * a quarantine one generation older and read a CORRECT restore as wrong; what saved them
     * was hand-written narration of the value restored FROM. A provenance stamp that records
     * only when and where is not enough, so the defaulted value travels with the stamp.
     *
     * WHY IT CANNOT ORPHAN, which is the failure `worktree-inventory` demonstrates for the
     * note. This object lives inside the `isStatic` branch, so a row leaving static drops it
     * along with `lifts` itself; and `retentionFor` returns a CLOSED literal copying `note` and
     * `lifts` BY NAME, so nothing carries it into a permanent verdict that never returns.
     * Unreachable unless someone adds it to that literal -- a one-line change a reader can see,
     * and this paragraph is here so they meet the reason before making it.
     */
    /*
     * AND A RULING IS CARRIED, NEVER WRITTEN HERE (#1071).
     *
     * `liftsDefaultedAt` says HOW the value arrived; `liftsRuledAt` says WHETHER a person
     * decided it. Only the first is the producer's to write -- a mechanical run has examined
     * nothing, and a producer that could mint a ruling would be the defect this pair exists to
     * prevent, wearing the repair's uniform. So this carries a hand-written ruling across
     * regenerations and can do nothing else with it.
     *
     * CARRIED ONLY UNDER `keep`, which is the same condition `lifts` itself rides. `keep` is
     * false when the verdict CHANGED, and a ruling about a row asking a different question is
     * not a ruling about this one. The consumer independently checks the ruling's `value`
     * against the `lifts` actually present, so a stale one reports rather than silences.
     *
     * IT TRAVELS WITH THE VALUE IT DESCRIBES, AND SINCE #1081 IT COMES BACK WITH IT. A
     * registration moves a row static -> no-baseline -> static, and that round trip used to drop
     * `note` and `lifts`; this went with them. The rule has not changed -- a ruling must never
     * survive a trip its value did not, because it would silence a row whose premise had been
     * erased. What changed is that `restorationFor` now returns them AS ONE UNIT, which is the
     * "losing both and restoring both" this paragraph originally named as the better outcome.
     */
    const liftsDefaultedAt = keep
      ? old?.liftsDefaultedAt ?? null
      : restored
      ? restored.liftsDefaultedAt
      : { value: DEFAULT_LIFTS, sha, at: new Date().toISOString() };
    const liftsRuledAt = keep
      ? old?.liftsRuledAt ?? null
      : restored
      ? restored.liftsRuledAt
      : null;
    const emitted = isStatic(r.verdict)
      ? {
          note,
          lifts: keep ? old.lifts : restored ? restored.lifts : DEFAULT_LIFTS,
          ...(liftsDefaultedAt ? { liftsDefaultedAt } : {}),
          ...(liftsRuledAt ? { liftsRuledAt } : {}),
          ...(hasNote(note)
            ? { noteWrittenAt: stampFor(old, note, previous) }
            : {}),
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
  const ejectTarget = arg("--eject-target");
  if (!fullPath || !ejectedPath || !sha || !baseSha || !ejectTarget) {
    console.error(
      `REFUSE: needs --full <record> --ejected <record> --sha <sha> --base <sha on main>\n` +
        `        --eject-target <rung>.\n` +
        `        THE TARGET IS NOT DEFAULTED. Every static verdict NAMES the target it was\n` +
        `        taken under, and the names are not interchangeable: \`langchain\` is the\n` +
        `        maximal strip and implies every weaker target, so a census produced by a\n` +
        `        weaker run and labelled \`langchain\` asserts more than the run measured.\n` +
        `        Pass what \`pnpm eject\` was actually given.\n` +
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
   * AND A BASELINE THAT COULD NOT BE READ, which is the same argument one step in (#920).
   * `establishedNothingComplaint` above asks whether the two trees differ at all. This asks
   * whether the FULL one answered. A checker refusing there gets `no-baseline` and the run
   * carries on, so the failure arrives as an ordinary-looking census rather than as an error.
   */
  const refused = refusedBaselineComplaint(F);
  if (refused) {
    console.error(`REFUSE: ${refused}`);
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
  let subjectKindOf;
  try {
    needsOf = needsFrom(registry);
    subjectKindOf = subjectKindFrom(registry);
  } catch (e) {
    console.error(`REFUSE: ${e.message}`);
    process.exit(2);
  }

  /*
   * BOUND BEFORE THE LOOP, AND THE THROW IS THE POINT (#855). An unusable target
   * fails here, before fifty-three verdicts exist, rather than at whichever row
   * happens to be static — a run where nothing is static must fail identically to
   * one where something is.
   */
  let classifyOne;
  try {
    classifyOne = classifierFor(ejectTarget);
  } catch (e) {
    console.error(`REFUSE: ${e.message}`);
    process.exit(2);
  }
  const fresh = {};
  for (const name of Object.keys(F))
    fresh[name] = classifyOne(F[name], E[name], {
      needs: needsOf[name] ?? null,
      subjectKind: subjectKindOf[name] ?? null,
    });

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
  const next = merge(previous, fresh, sha, baseSha, parentCountOf(sha), {
    ejectTarget,
  });

  /*
   * THE LAST THING BEFORE THE WRITE, DELIBERATELY (#920). Every guard above asks whether the
   * READING is entitled to produce verdicts; this one asks whether the ARTIFACT is complete,
   * and it can only be asked of the finished object. Refusing after writing would leave the
   * short census on disk for someone to commit, which is exactly what happened.
   */
  const short = totalityComplaint(registeredCheckers(registry), next);
  if (short) {
    console.error(`REFUSE: ${short}`);
    process.exit(2);
  }

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
