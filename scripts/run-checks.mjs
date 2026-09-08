#!/usr/bin/env node
/**
 * Runs every check declared in scripts/checks.json, and RECORDS WHAT IT ACTUALLY RAN.
 *
 * ci.yml grew to 55 `pnpm` steps in one job, hand-written, all appending to the same region —
 * three PRs in one hour collided there. This replaces the six proof-first ones with a list
 * plus a runner. The list is not a description of what CI does; the runner iterates it and
 * ci.yml invokes the runner, so an entry IS an execution.
 *
 * MEASURE THIS SCRIPT'S EXIT CODE WITH `node` OR BARE `pnpm` — NEVER `pnpm -s` (#691).
 *
 * The exit vocabulary here is 0/1/2, and classify-live-failure.mjs adds 3. `pnpm -s`
 * (and `--silent`, identically) collapses EVERY non-zero code to 1:
 *
 *     code      0   1   2   3   4   5
 *     node      0   1   2   3   4   5
 *     pnpm      0   1   2   3   4   5
 *     pnpm -s   0   1   1   1   1   1
 *
 * So the flag reduces the vocabulary to pass/fail — precisely the binary the 37 scripts
 * in this directory exist to escape. A refusal reads as a violation, and an upstream
 * outage reads as a transport defect.
 *
 * NOT A CURRENT DEFECT, and deliberately not guarded by a check. Measured: 392 tracked
 * files contain `pnpm ` and ZERO use `-s` or `--silent`, so a checker would have no
 * subject and would become an exception list with a known repair. ci.yml:720 runs
 * `pnpm checks` without the flag, and live-transport-with-retry.sh:49 defaults
 * CLASSIFY_CMD to `node scripts/classify-live-failure.mjs` rather than a pnpm script —
 * which is what keeps #400's retry policy intact, since :92 branches on `-ne 3` and a
 * flattened 3 would silently stop the retry from ever engaging.
 *
 * The hazard lives in ad-hoc commands typed by people and agents, and it is easy to hit
 * for a reason worth stating: `-s` is what you reach for when you want a checker's own
 * output without pnpm's banner — which is exactly when you are about to read its status.
 * THE FLAG THAT MAKES THE OUTPUT READABLE IS THE ONE THAT CORRUPTS THE STATUS.
 *
 * NOTE FOR ANYONE RE-MEASURING THE ZERO ABOVE: this comment CONTAINS the string it
 * warns about, so a grep for `pnpm -s` over the working tree now returns 1 — and it
 * is this paragraph, not a usage. Measure against a base that predates it, or exclude
 * this file. That is the citation-versus-claim problem #667 fixed for docs/, arriving
 * unprompted in the note written about a different defect; it cost one wrong reading
 * before it was noticed.
 *
 * THE RUN RECORD IS THE POINT, more than the consolidation was.
 *
 * assert-checker-proof-pairing.mjs answers "which checkers exist and where is each proved" by
 * regex over workflow YAML, resolving `pnpm <name>` indirection as it goes. What that can
 * establish is that a workflow's TEXT MENTIONS A SCRIPT. It cannot distinguish that from the
 * step having run. Latent in ci.yml today — zero of its checker steps are conditional — and
 * live across workflows: has-rung.mjs gates steps with a shell `if` inside `run:` blocks in
 * cross-version.yml and e2e.yml, which no YAML parse can see.
 *
 * So this writes `.checks-run.json`: name, exit status and duration for each check that
 * actually executed. Pairing reads that instead of inferring, and a declared check the runner
 * never ran shows up as a HOLE rather than as a pass. The record is produced by execution and
 * the declaration is the expectation, which is what keeps the two from being circular.
 *
 * ANNOTATIONS, NOT A SUMMARY TABLE. Collapsing 55 named steps into one costs the step name
 * that used to tell you what broke before you opened a log. `::error title=…::` replaces it
 * with more than it took away — the step name said WHICH STEP, an annotation says which
 * checker and why — and annotations are queryable over GraphQL, which is what made #372 and
 * #368 one query instead of an hour. A runner that swallowed a failure into a printed table
 * would be the regression this refactor exists to prevent, so run-checks.selftest.mjs watches
 * a real failure produce a real annotation rather than assuming it does.
 *
 * Usage: node scripts/run-checks.mjs [--cwd DIR] [--record PATH] [--list PATH]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { invokedAsProgram } from "./lib/is-main.mjs";
/* ------------------------------------------------------------------ *
 * CHANNELS — the closed set of things a check may declare it NEEDS
 * ------------------------------------------------------------------ */

/**
 * A check may declare `"needs": "<channel>"`. This object is the ONLY place a channel can be
 * defined, and the ONLY place its satisfiability is decided.
 *
 * WHY A TOLERANCE EXISTS AT ALL (#404). One check reads branch protection, which requires a
 * token with repository Administration: READ. `administration` is not among the keys a
 * workflow `permissions:` block accepts, so GITHUB_TOKEN cannot carry it in ANY channel — not
 * merely on forks — and a fork pull request cannot reach a repository secret at all. The check
 * therefore cannot compute in channels this repo genuinely runs in. Its only honest options
 * are to refuse or to be skipped; refusing reds a required context for contributors over a
 * permission they can never hold, which is how a gate earns the reflex to be ignored.
 *
 * WHY THIS IS NOT A GENERAL OPT-OUT, which is the risk it would otherwise be. Every future
 * check that finds a channel inconvenient will want one of these, and the four rules below are
 * the whole of what stands between that and a switch any check can flip:
 *
 *   1. CLOSED ENUMERATION. `needs` is matched against these keys by name. An unrecognised
 *      value is FATAL — exit 2 — never treated as unconditional. A closed set that fails open
 *      on an unknown value is not closed, and that is the case the proof pins hardest.
 *   2. SATISFIABILITY IS DERIVED HERE, never declared by the check. A check names a channel;
 *      it cannot assert that the channel is unavailable, so it cannot excuse itself.
 *   3. A SKIP IS NOT A PASS. It is recorded with its own status, counted separately, and
 *      announced. "skipped" and "pass" are never summed — the rule ci-completion.mjs already
 *      enforces for cancelled runs, which are the same shape: an absent measurement rendered
 *      as a weak positive.
 *   4. THE PROOF STILL RUNS. Only the checker is channel-dependent. A checker nobody has
 *      watched fail is worthless whether or not it ran, so the offline half is never skipped.
 */
/**
 * The count a checker reported, read off the output the parent ALREADY holds.
 *
 * `spawnSync(..., { encoding: "utf8" })` pipes, so a child's stdout is in
 * `r.stdout` and was being discarded at the ok line — which is #741. Nothing
 * new is captured here; a field is added to a record already written and
 * already read (assert-checker-proof-pairing.mjs reads it).
 *
 * LAST match wins: a checker's summary comes last, and an earlier line may be
 * quoting a fixture. Anchored at line start so a mention inside prose does not
 * count.
 */
export function readSubject(out) {
  let found = null;
  for (const line of String(out).split("\n")) {
    const m = /^SUBJECT:\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (m) found = { count: Number(m[1]), label: m[2] };
  }
  return found;
}

/**
 * Why this passing checker must NOT be recorded as a pass, or null if it may.
 *
 * Nine refusals, and each exists because the obvious implementation without it
 * passes #750:
 *
 *   no floor declared   the producer requirement has to land WITH the consumer.
 *                       Optional means most checks never emit one and the record
 *                       looks complete while being honest about a handful —
 *                       worse than today, when nobody believes the ok line.
 *   no subject emitted  a checker that reported nothing about what it examined
 *                       has not been observed examining anything.
 *   count below floor   the #750 case exactly: 0 restrictions in scope, exit 0.
 *   floor with no tree  #768. A derived floor is a MEASUREMENT, and a measurement
 *                       with no tree attached can be repeated but never confirmed
 *                       or falsified. Thirty floors carried numbers like 83 and 224
 *                       with nothing saying which tree produced them, so a later
 *                       reader hitting the floor could not tell a real regression
 *                       from a number that was always slightly wrong.
 *   record below floor  the record CONTRADICTS the floor. One of the two is wrong,
 *                       and a floor above the only tree anyone measured is a floor
 *                       nothing has ever satisfied. Listed separately because it is
 *                       the one a reader who HITS it will come looking for.
 *   channel, no kind    #811. A check reading through a channel MAY be measuring
 *                       something outside the repository, and the entry has to say
 *                       which. A PROMPT to declare, not a classifier — see below.
 *   kind not tree/ext   a subject is either in the repository or it is not.
 *   external, no source what answered has to be recorded, since no sha can be.
 *   external WITH a sha the field would read as provenance and not be it.
 *
 * SUBJECT KIND, AND WHY THE DISCRIMINATOR IS THE SUBJECT RATHER THAN THE FLOOR (#811).
 * Two of thirty records named a tree for a count that is not in it — `required-contexts`
 * recorded 32 (branch protection) and `board-declarations` 16 (open issues), both at
 * 70fb8afa. Nothing at that sha describes either number, today or ever.
 *
 * The first reading was that a VACUITY floor makes its record decorative. That is wrong,
 * and `ladder-is-cumulative` is the counterexample: vacuity floor 1, record `count: 5` at
 * 70fb8afa, and checking out that tree gives exactly 5 rungs. The record is verifiable; it
 * simply is not what the floor was derived from, which is a different thing from being
 * meaningless — it tells a reader the subject's SIZE, which is what you want when deciding
 * whether a floor is still sensible.
 *
 * So the split is TREE versus EXTERNAL, and the form follows the kind:
 *
 *     tree      { sha, count, on }      verifiable by checkout
 *     external  { source, count, on }   no sha, because none can describe it
 *
 * `on` is kept for both rather than renamed per kind: it is the same fact — when the
 * measurement was taken — and two names for one concept is how a field acquires two
 * meanings. Only the anchor differs, which is the only thing that actually differs.
 *
 * WHY A FLAG BESIDE A SHA WOULD NOT DO. It leaves the sha there and leaves it wrong. A
 * sha field that must be filled for a subject no sha can describe gets filled with
 * whatever sha is to hand — which is precisely how both instances happened.
 *
 * `needs` IS NOT THE CLASSIFIER, and this is now DEMONSTRATED rather than argued. The
 * `merge-commit` checks are git state, whose subject a sha describes perfectly, so a
 * channel has never implied an external subject.
 *
 * THIS PARAGRAPH USED TO PREDICT ITS OWN COUNTEREXAMPLE and #859 supplied it. It said
 * `needs` + floor > 0 selected only external entries, and that this held TODAY ONLY
 * because the merge-commit pair carry `floor: 0` — "give either a floor and a
 * `needs`-based rule would demand an external marker for a tree subject".
 * `action-pin-comments` is that entry: it declares a channel because reading an action's
 * tags needs a token, it carries a real floor because its subject is the pins in
 * .github/workflows, and its `subjectKind` is `tree` because those pins ARE in the
 * repository. Channelled, floored, and tree-subjected at once. A `needs`-based rule would
 * now demand a sha-less external marker for a subject a sha describes exactly.
 *
 * So the channel triggers the QUESTION and the entry gives the ANSWER — and the entry is
 * the only one that can, which is no longer a prediction.
 *
 * DEFAULTING AN ABSENT KIND TO `tree` IS NOT AN ARBITRARY DEFAULT. A checker measuring
 * something outside the repository needs a channel to declare when that source is
 * unreachable, or it cannot be skipped and simply fails when GitHub is down. So "no
 * channel" implies "the subject is in the tree" under the runner's own contract.
 * NOT CHECKED: a checker that reads external state WITHOUT declaring a channel. It is
 * already broken for a different reason and nothing here detects it.
 *
 * THE TEST THAT CLASSIFIES, so a third case does not have to be argued from these two:
 *
 *     CAN A READER HOLDING ONLY THIS RECORD REPRODUCE THE MEASUREMENT?
 *
 * `tree` and `external` are consequences of that question rather than primitives. A sha
 * answers it; an open-issue count does not. And REACHABILITY is part of it: this
 * repository squash-merges — zero merge commits in the last fifty on main, every commit
 * single-parent — so anything recorded against a MERGE commit names an object no reader
 * on main can reach. Tree-class in principle, external-class in practice, and the
 * practice is what the field is for.
 *
 * The distinction that keeps that from swallowing the residual below: a sha that turns
 * out to be unreachable is an accident this cannot detect. A sha KNOWN AT AUTHORING TIME
 * to be unreachable is a choice, and the choice is to record a source instead.
 *
 * WHAT A GREEN HERE DOES AND DOES NOT SHOW. Both external entries sit at vacuity floors
 * and every check passes today, so a passing run after this change proves the new
 * refusals did not WRONGLY fire. It cannot show they WOULD fire. The selftest arms are
 * the only evidence of that, and the mutation on the real entries — restoring a sha to
 * `required-contexts`, and removing its `subjectKind` — is the only evidence they bite on
 * production data. Said here because a green that cannot demonstrate the thing it is
 * green about gets read as agreement.
 *
 * WHAT `floorObserved` IS, AND WHAT IT IS NOT. It records a tree where the subject
 * WAS COUNTED — not the tree where the floor was originally derived, which is
 * unrecoverable for all thirty. Calling it a derivation record would be inventing
 * provenance for someone else's number. It is a re-anchoring: here is a sha you can
 * check out and re-measure. Its value is that the NEXT change to a floor has to
 * carry one, so the unrecoverable case does not recur.
 *
 * THE SHA IS SHAPE-CHECKED, NOT RESOLVED, and the reason is stronger than "forks are
 * special". Resolving would make THE VERDICT DEPEND ON CLONE DEPTH: the same content
 * passing in a shallow fork and failing in a full clone, or the reverse. A check whose
 * answer varies with how the tree was fetched is worse than one accepting a well-formed
 * sha that names nothing. Stated this way because "we weakened it for forks" invites
 * someone to strengthen it later for non-forks, which would reintroduce exactly that.
 *
 * THE RESIDUAL, AND IT IS REAL: a 40-hex string that is not a commit satisfies this. The
 * field can carry a plausible sha nobody can resolve and nothing here will say so.
 *
 * THREE EXEMPTIONS, NOT ONE. `floorPending` is the stated one. `floor: 0` skips the block
 * entirely — correct for `undeclared-reverts` and `formatted`, whose subject is the
 * CHANGED-FILE set rather than the tree, so no floor exists to anchor. And a check whose
 * channel is unsatisfiable never reaches here at all.
 *
 * ZERO MARGIN AND THIS REQUIREMENT ARE A PACKAGE — the coupling matters more than either
 * half. 25 of the 30 floors equal the count observed at 70fb8afa, so each fires on the
 * FIRST legitimate removal. That is a high false-positive rate for a guard whose true
 * positive is collapse toward zero, and it is the shape that trains people to edit the
 * number reflexively — #741's "satisfied by anyone who bumps it". What makes it
 * acceptable is that this change PRICES THE BUMP: lowering a floor was a one-character
 * edit leaving no trace, and now it requires a new sha and a new count naming a tree
 * where the subject was measured. Still possible, no longer free or invisible.
 *
 * SO DO NOT KEEP THE FLOORS AND DROP THE ANCHOR, and do not relax the floors because they
 * fire often, without replacing what the other half was doing. And do NOT split the
 * difference: a floor at "observed minus ten percent" is an invented number with no
 * provenance, which is the third thing this change exists to eliminate. The honest options
 * are zero margin (fires on any shrink, now priced) or a deliberately chosen vacuity floor
 * (fires only on collapse — the two that have one say why in `floorNote`).
 */
/**
 * Why this check's DECLARATION is malformed, or null if it is not (#817 review, DEV3-lang).
 *
 * SEPARATED FROM `subjectComplaint` BECAUSE OF WHERE THAT RUNS. These five read `c` and
 * nothing else — they are properties of checks.json, true or false before any check executes.
 * They were inside `subjectComplaint`, which is reached only by a check that RAN, and a check
 * whose channel is unsatisfiable never gets there. So in CI, where PROTECTION_READ_TOKEN is
 * absent and `repo-settings` is unsatisfiable, four of them were structurally unreachable:
 * they passed locally on a machine with `gh auth`, and could not fail in the environment that
 * gates merges.
 *
 * The file already said so at the exemption note — "a check whose channel is unsatisfiable
 * never reaches here at all" — which is the sentence that predicted this. A VALIDATION PLACED
 * DOWNSTREAM OF A SATISFIABILITY GATE ONLY EVER RUNS WHERE THE CREDENTIAL EXISTS.
 *
 * ALL FIVE MOVED, INCLUDING THE CONTRADICTION ONE. The review proposed keeping that one here
 * on the ground that it compares a measured count against a floor. It does not: it compares
 * `floorObserved.count` with `floor`, and BOTH ARE DECLARED. Nothing about it needs a run, so
 * it belongs upstream with the rest and its fixture needs no channel at all.
 *
 * These are FATAL rather than per-check refusals, matching the two declaration checks beside
 * them: a malformed entry is a property of the list, not a verdict about one check's subject,
 * and nothing should execute against a list this runner cannot trust.
 */
export function declarationComplaint(c) {
  /*
   * `needs` WITHOUT `subjectKind` (#1007). Moved here from `subjectComplaint` for the sixth
   * time on the same argument, and this one was left behind when the other five went.
   *
   * IT SAT AFTER `if (!(c.floor > 0) || c.floorPending) return null;` — so it could not fire
   * for a check declaring `floor: 0`, and it is reached only by a check that RAN. Every check
   * carrying `needs` and no `subjectKind` today evades it, by one of those two routes:
   *
   *     lifts-pointers-open         floor 0                    early return, before the guard
   *     census-survives-the-merge   floor 0, floorPending       early return; and SKIPPED
   *     merge-keeps-registrations   floor 0, floorPending       early return; and SKIPPED
   *
   * THREE OF THREE. A guard that cannot fire for any member of the population it describes is
   * the shape #817 moved five others out for, and the sentence that predicted it is already in
   * this file: a validation placed downstream of a satisfiability gate only ever runs where the
   * credential exists. The floor gate is a second one of the same kind.
   *
   * It reads `c` and nothing else, so it belongs here: true or false before anything executes,
   * fatal rather than a per-check verdict, and independent of floor, skip and channel.
   */
  if (c.needs !== undefined && c.subjectKind === undefined) {
    return (
      `check "${c.name}" declares needs: "${c.needs}" but no subjectKind. A check reading ` +
      `through a channel MAY be measuring something the repository does not contain, and no ` +
      `sha can describe that. Declare "subjectKind": "tree" or "external" — a prompt to say ` +
      `which, not a claim that a channel means external: \`merge-commit\` is about git state, ` +
      `which is IN the repository.`
    );
  }

  /*
   * NO INTEGER `floor` (#825). Moved here from `subjectComplaint`, which is reached only by a
   * check that RAN — so a channelled check declaring no floor was unexamined wherever its
   * channel is unsatisfiable, which in CI is three of the four. Proven rather than reasoned:
   * a `needs: repo-settings` entry with no floor is exit 2 locally and exit 0 under
   * GITHUB_ACTIONS=true with an empty PROTECTION_READ_TOKEN.
   *
   * It reads `c` and nothing the check produced, which is the discriminator #817 established
   * and #825 refined: not "reads only c" — the ABSENT check reads the FILESYSTEM and is a
   * member too — but "reads nothing the check PRODUCED".
   *
   * First in this function deliberately: every other rule here compares against `c.floor`, so
   * a non-integer floor makes them all meaningless rather than merely wrong.
   */
  if (
    typeof c.floor !== "number" ||
    !Number.isInteger(c.floor) ||
    c.floor < 0
  ) {
    return (
      `check "${c.name}" declares no integer \`floor\`. A check that does not say how ` +
      `much it expects to examine cannot be caught examining nothing — declare one, ` +
      `\`floor: 0\` included, which states that an empty domain is the right answer here.`
    );
  }
  if (!(c.floor > 0) || c.floorPending) return null;
  const o = c.floorObserved;
  const kind = c.subjectKind ?? "tree";

  if (kind !== "tree" && kind !== "external") {
    return (
      `check "${c.name}" declares subjectKind "${kind}", which is neither "tree" nor ` +
      `"external". A subject is either in the repository or it is not.`
    );
  }

  if (kind === "tree") {
    if (
      !o ||
      typeof o.sha !== "string" ||
      !/^[0-9a-f]{40}$/.test(o.sha) ||
      !Number.isInteger(o.count)
    ) {
      return (
        `check "${c.name}" declares floor ${c.floor} over a TREE subject but records no ` +
        `tree it was observed against. A measurement with no sha can be repeated but ` +
        `never confirmed or falsified. Add ` +
        `"floorObserved": { "sha": "<40-hex>", "count": <n>, "on": "<date>" }.`
      );
    }
  } else {
    if (
      !o ||
      typeof o.source !== "string" ||
      !o.source ||
      !Number.isInteger(o.count)
    ) {
      return (
        `check "${c.name}" declares floor ${c.floor} over an EXTERNAL subject but ` +
        `records no source it was observed from. Add ` +
        `"floorObserved": { "source": "<what answered>", "count": <n>, "on": "<date>" }.`
      );
    }
    if (o.sha !== undefined) {
      return (
        `check "${c.name}" declares subjectKind "external" and its floorObserved carries ` +
        `a sha. NOTHING AT THAT SHA DESCRIBES THIS SUBJECT — checking it out re-measures ` +
        `nothing, so the field reads as provenance and is not. That is how both original ` +
        `instances happened: a sha field that must be filled for a subject no sha can ` +
        `describe gets filled with whatever sha is to hand. Record "source" instead.`
      );
    }
  }

  if (o.count < c.floor) {
    const where =
      kind === "tree" ? `at ${o.sha.slice(0, 12)}` : `from ${o.source}`;
    return (
      `check "${c.name}" declares floor ${c.floor} but its floorObserved records only ` +
      `${o.count} ${where} — the record CONTRADICTS the floor. One of the two is wrong, ` +
      `and a floor above the only measurement anyone took is a floor nothing has ever ` +
      `satisfied.`
    );
  }
  return null;
}

export function subjectComplaint(c, subject) {
  if (!subject) {
    return (
      `check "${c.name}" passed without reporting a subject. Print one line ` +
      `"SUBJECT: <count> <what>" naming what it examined — a pass over nothing is ` +
      `indistinguishable from a pass over everything without it.`
    );
  }
  if (subject.count < c.floor) {
    return (
      `check "${c.name}" passed having examined ${subject.count} ${subject.label}, ` +
      `below its declared floor of ${c.floor}. A green whose subject is under the ` +
      `floor the check itself declared is a green about nothing.`
    );
  }
  return null;
}

export const CHANNELS = {
  /**
   * Reading the open issue board. UNLIKE `repo-settings`, GITHUB_TOKEN CAN carry this —
   * `issues: read` is a key a `permissions:` block accepts — so this channel is satisfiable
   * in CI, including on a fork pull request against a public repo, PROVIDED the workflow
   * hands `gh` a token. It is deliberately derived from `gh auth status` alone rather than
   * from a secret name: a check that cannot query must be a visible hole, and a workflow that
   * has not yet been wired should produce that hole rather than a red or a silent pass.
   */
  "board-read": {
    describe: "an authenticated `gh`, to read the open issue board",
    satisfiable(env = process.env) {
      const gh = spawnSync("gh", ["auth", "status"], { encoding: "utf8" });
      return gh.status === 0
        ? { ok: true }
        : {
            ok: false,
            because:
              "`gh auth status` reports no authenticated account, so the open board cannot " +
              "be read. In Actions this means the job has not been given GH_TOKEN",
          };
    },
    provide() {
      return {};
    },
  },
  /**
   * Reading a third-party action's tags. Like `board-read` this needs only an authenticated
   * `gh`, and for the same reason it is derived from `gh auth status` rather than from a secret
   * name: the endpoint is public, so any token reaches it, and a workflow that has not wired one
   * should produce a visible hole rather than a red.
   *
   * IT IS A SEPARATE CHANNEL FROM `board-read` DESPITE THE IDENTICAL DERIVATION, because a
   * channel names a SUBJECT and not a credential. Reusing `board-read` would tell a reader this
   * check reads the issue board, and the day the two stop being satisfiable together — a token
   * scoped to this repo's issues but rate-limited against others, which is the shape of tonight's
   * outage — one name for two subjects would skip the wrong check.
   */
  "action-tags": {
    describe: "an authenticated `gh`, to read a pinned action's tags",
    satisfiable(env = process.env) {
      const gh = spawnSync("gh", ["auth", "status"], { encoding: "utf8" });
      return gh.status === 0
        ? { ok: true }
        : {
            ok: false,
            because:
              "`gh auth status` reports no authenticated account, so an action's tags cannot " +
              "be read and no pin comment can be resolved against its sha",
          };
    },
    provide() {
      return {};
    },
  },
  /**
   * Reading OPEN PULL REQUESTS and their auto-merge state. Derived from `gh auth status` for the
   * same reason as the two channels above: a check that cannot query must be a visible hole
   * rather than a red or a silent pass.
   *
   * SEPARATE FROM `board-read` BECAUSE A CHANNEL NAMES A SUBJECT AND NOT A CREDENTIAL, which is
   * the rule `action-tags` states one entry up. The credential is identical today; the subject is
   * not. `board-read` says "this check reads the issue board", and a reader who saw it on a check
   * that reads pull requests would be told the wrong thing about what a skip had skipped.
   */
  "pr-state": {
    describe:
      "an authenticated `gh`, to read open pull requests and their auto-merge state",
    satisfiable(env = process.env) {
      const gh = spawnSync("gh", ["auth", "status"], { encoding: "utf8" });
      return gh.status === 0
        ? { ok: true }
        : {
            ok: false,
            because:
              "`gh auth status` reports no authenticated account, so open pull requests and " +
              "their auto-merge state cannot be read",
          };
    },
    provide() {
      return {};
    },
  },
  "repo-settings": {
    describe: "a token carrying repository Administration: READ",
    /**
     * Two conjuncts, both derived from the environment, neither from the check.
     *
     * NOT A FORK PULL REQUEST. Repository secrets are not exposed to forks, so conjunct two
     * already decides this case; it is stated separately so that it keeps deciding it if a
     * workflow ever starts running on `pull_request_target`, where secrets ARE exposed and the
     * head is still untrusted. An unreadable event payload counts as a fork: the lenient
     * reading is safe only because conjunct two is the one doing the work.
     *
     * A CREDENTIAL THAT COULD CARRY THE SCOPE. In Actions that means PROTECTION_READ_TOKEN and
     * nothing else — GITHUB_TOKEN's presence is not evidence, because it provably cannot hold
     * this permission, and accepting it would make the channel look satisfiable everywhere and
     * fail at the API instead. Outside Actions the credential is whatever `gh` is already
     * authenticated with, which is why this still runs for real on a maintainer's machine
     * rather than skipping everywhere and never being exercised.
     */
    satisfiable(env = process.env) {
      if (isForkPullRequest(env))
        return {
          ok: false,
          because:
            "this is a fork pull request; repository secrets are not exposed to forks, so no " +
            "token here can read branch protection",
        };
      if (env.GITHUB_ACTIONS === "true") {
        return env.PROTECTION_READ_TOKEN
          ? { ok: true }
          : {
              ok: false,
              because:
                "PROTECTION_READ_TOKEN is not set. GITHUB_TOKEN cannot substitute — " +
                "`administration` is not a key a workflow `permissions:` block accepts, so it " +
                "cannot read branch protection in any channel",
            };
      }
      const gh = spawnSync("gh", ["auth", "status"], { encoding: "utf8" });
      return gh.status === 0
        ? { ok: true }
        : {
            ok: false,
            because: "`gh auth status` reports no authenticated account",
          };
    },
    /** Extra environment a checker running in this channel is given. */
    provide(env = process.env) {
      return env.PROTECTION_READ_TOKEN
        ? { GH_TOKEN: env.PROTECTION_READ_TOKEN }
        : {};
    },
  },
  "merge-commit": {
    describe: "a HEAD with two parents — i.e. a merge to judge",
    /*
     * DERIVED FROM THE REPOSITORY, and it is a reach question rather than a convenience one.
     * assert-merge-keeps-registrations compares a merge against BOTH ITS PARENTS. On a
     * `pull_request` event the checkout IS the merge commit (`refs/pull/N/merge`) and both
     * parents are present, so the question has a subject. On a push to main — a squash commit
     * with one parent — there is no pair of trees and no claim to make.
     *
     * THE SECOND VALUE IN THIS ENUMERATION, AND I ADDED THE FIRST, so the bar it has to clear
     * is the one I wrote: a channel is legitimate when the answer is genuinely UNOBTAINABLE,
     * not when it is inconvenient. A commit with one parent has no second tree — the check is
     * not being spared an answer it dislikes, it is being spared a question that does not
     * exist. If a future entry here cannot say that sentence about itself, it does not belong.
     */
    satisfiable(env = process.env) {
      // Explicitly the runner's working directory — the tree whose merge is being judged. Left
      // implicit this would follow whatever cwd the process happened to inherit, which is a
      // different tree than the one the checks are about.
      const r = spawnSync("git", ["rev-list", "--parents", "-n", "1", "HEAD"], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      if (r.status !== 0)
        return {
          ok: false,
          because: "git could not resolve HEAD, so its parents are unknown",
        };
      const parents = r.stdout.trim().split(/\s+/).length - 1;
      return parents >= 2
        ? { ok: true }
        : {
            ok: false,
            because:
              `HEAD has ${parents} parent(s), so there is no merge to judge here. A squash ` +
              `commit on main is not a merge of two trees`,
          };
    },
    provide() {
      return {};
    },
  },
};

/** Derived, not declared: is this run a pull request from a fork? */
export function isForkPullRequest(env = process.env) {
  if (!/^pull_request/.test(env.GITHUB_EVENT_NAME ?? "")) return false;
  try {
    const ev = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    const head = ev?.pull_request?.head?.repo?.full_name;
    return !head || head !== env.GITHUB_REPOSITORY;
  } catch {
    // A pull_request event whose payload cannot be read: assume fork. Safe only because the
    // credential conjunct is the one that actually decides.
    return true;
  }
}

const argOf = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const ROOT = resolve(
  argOf("--cwd", join(dirname(fileURLToPath(import.meta.url)), ".."))
);
const LIST = resolve(argOf("--list", join(ROOT, "scripts", "checks.json")));
const RECORD = resolve(argOf("--record", join(ROOT, ".checks-run.json")));

/**
 * One line, enough to know what broke without opening the log — THE LAST MATCH, NOT THE FIRST
 * (#1045).
 *
 * THIS FUNCTION MADE THE MISREAD IT EXISTS TO PREVENT. It took the FIRST verdict-shaped line,
 * and a selftest that drives a checker over planted fixtures prints the checker's real
 * `FAIL: …` lines as DATA about those fixtures — before any of its own results. Driven on
 * `check-cors-parity.selftest.mjs`, 29 lines of output: the first match is at line 7 and is a
 * planted django case; the verdict is in the last three. So the line printed to save someone
 * opening the log named a fixture.
 *
 * Three readers hit this in one day with the same `FAIL:` query. They were not making an
 * independent mistake on an ambiguous artifact — they were running the tool's own predicate and
 * getting the tool's own answer.
 *
 * WHY LAST, AND WHY NOT A TALLY PATTERN. The obvious repair is to match the tally shape. There
 * is no such shape: 30 DISTINCT FORMS are emitted across the selftests — `FAIL: N/N cases
 * wrong.`, `FAIL: ran N cases, expected N — …`, `FAIL: N/N. The checker is NOT trustworthy.`,
 * `FAIL: N/N wrong.` and more. A pattern over that vocabulary would miss most of them and fall
 * back to first-match SILENTLY, which is the current defect wearing a fix.
 *
 * Last-match needs no vocabulary and rests on a structural fact instead: A TALLY COMES AFTER THE
 * CASES IT COUNTS. Fixture output precedes per-case results, which precede the summary.
 *
 * AND IT DEGRADES TO THE OLD BEHAVIOUR WHERE THE OLD BEHAVIOUR WAS RIGHT. A checker that fails
 * usually prints ONE `FAIL:` line — first and last are the same line, and nothing changes. Where
 * a checker prints several findings, last reports the last finding rather than the first; both
 * are findings and neither is a fixture, so the choice is arbitrary there and consequential only
 * for selftests.
 */
export function firstMeaningfulLine(text) {
  const lines = text
    .split("\n")
    .map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trim());
  const matches = lines.filter(
    (l) => /^(FAIL|Error|error|✘|✗)/.test(l) || /\bFAIL\b/.test(l)
  );
  const line = matches[matches.length - 1];
  return (line ?? lines.find((l) => l) ?? "no output").slice(0, 400);
}

/** GitHub swallows a bare newline inside an annotation; %0A is how a multi-line one is sent. */
const esc = (s) =>
  s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

/*
 * THE RECORD CARRIES WHICH TREE PRODUCED IT (#822).
 *
 * `eject-subject-audit.mjs` takes `--sha` as an ARGUMENT and cannot check it. Feed it
 * two records from anywhere, label them with any sha, and it writes a census that is
 * internally consistent and about nothing. #819 closed that for the one caller that
 * goes through `pnpm eject-audit`, by RESOLVING the sha out of the tree rather than
 * accepting it — but every other caller still asserts a claim nothing verifies.
 *
 * IT HAPPENED, MID-PROCEDURE, AND EVERY EXISTING REFUSAL MISSED IT. A `git worktree
 * add` failed, the following `cd` failed, and a shell leaves you in the PREVIOUS
 * directory — so install, build and run-checks all succeeded in the shared checkout,
 * which sits on an unrelated branch with hundreds of uncommitted changes. Both records
 * were written. Both were present, parseable, complete and internally consistent. The
 * only tell was a phase count: 100 in one cycle, 68 in the next, in an artifact nobody
 * was asked to read.
 *
 * So the fix is not another refusal about the record's SHAPE. It is to make provenance
 * a FACT THE ARTIFACT ASSERTS rather than a flag the caller asserts about it.
 *
 * `dirty` IS RECORDED BECAUSE A SHA ALONE LIES ABOUT A MODIFIED TREE. HEAD names what
 * was committed; the checks ran against what was on disk. In the failure above the
 * shared checkout had 441 uncommitted tracked changes, so its HEAD was a real sha
 * describing a tree nobody measured — the same class as this whole issue, one level in.
 *
 * NULL, NOT A GUESS, WHEN GIT CANNOT ANSWER. A tree that is not a repository is a
 * legitimate place to run checks; it is not a legitimate place to claim provenance
 * from. `head: null` says "this record cannot vouch for its tree", which a consumer
 * can act on. A fabricated or omitted value cannot be told from a real one.
 */
export function treeProvenance(root, run = spawnSync) {
  const git = (args) =>
    run("git", ["-C", root, ...args], { encoding: "utf8", timeout: 10_000 });
  const head = git(["rev-parse", "HEAD"]);
  if (head.status !== 0 || typeof head.stdout !== "string")
    return { head: null, dirty: null };
  const status = git(["status", "--porcelain", "--untracked-files=no"]);
  return {
    head: head.stdout.trim() || null,
    dirty: status.status === 0 ? status.stdout.trim().length > 0 : null,
  };
}

export function runChecks({ root = ROOT, list = LIST, record = RECORD } = {}) {
  if (!existsSync(list)) {
    return { ok: false, fatal: `no check list at ${list}`, ran: [] };
  }
  const declared = JSON.parse(readFileSync(list, "utf8")).checks ?? [];
  if (declared.length === 0) {
    // A list with nothing in it runs nothing and would exit 0. "Nothing declared" and
    // "everything passed" are different answers and must not share an exit code.
    return { ok: false, fatal: `${list} declares no checks`, ran: [] };
  }

  /*
   * EVERY DECLARED CHANNEL IS RESOLVED BY NAME BEFORE ANYTHING RUNS. A pre-pass, not a check
   * inside the loop: an unrecognised value on the fifth entry would otherwise be discovered
   * after four checks had already executed, and the refusal below claims that nothing ran.
   *
   * An unrecognised value is FATAL. Treating it as "no channel" would run a check in a channel
   * nobody vetted; treating it as "skip" would let any string switch a check off. Both are the
   * enumeration failing open, which is the enumeration not being closed.
   */
  /*
   * `floorPending: true` MUST MEAN `floor: 0` (#741).
   *
   * The field marks a floor nobody has derived yet — as opposed to one that can
   * never exist — so a later run on a merge commit can SELECT on it rather than
   * a human remembering. It had no consumer at all when it landed, which is a
   * note describing a mechanism that does not exist, inside a change about
   * checks claiming more than they do. Found by DEV3-lang.
   *
   * This is the cheapest thing that gives it one, and it fires on the drift the
   * field is otherwise defenceless against: somebody derives the floor, sets it,
   * and forgets to clear the flag — leaving a real floor permanently labelled
   * "nobody has taken this run yet". A pending floor that is not 0 is a claim
   * about itself that has already stopped being true.
   */
  for (const c of declared) {
    if (c.floorPending === true && c.floor !== 0) {
      return {
        ok: false,
        fatal:
          `check "${c.name}" declares floorPending: true with floor: ${c.floor}. ` +
          `floorPending means "no run has derived this yet", which is only consistent ` +
          `with floor: 0 — a derived floor should carry the number and clear the flag. ` +
          `Set one or the other, not both.`,
        ran: [],
      };
    }
  }

  for (const c of declared) {
    const why = declarationComplaint(c);
    if (why) return { ok: false, fatal: why, ran: [] };
  }

  const channelOf = new Map();
  for (const c of declared) {
    if (c.needs === undefined) continue;
    const channel = CHANNELS[c.needs];
    if (!channel) {
      return {
        ok: false,
        fatal:
          `check "${c.name}" declares needs: "${c.needs}", which is not one of the channels ` +
          `this runner defines (${Object.keys(CHANNELS).join(
            ", "
          )}). An unrecognised ` +
          `channel is not a reason to run the check anyway, and not a reason to skip it — it ` +
          `is a list this runner cannot execute.`,
        ran: [],
      };
    }
    channelOf.set(c.name, channel);
  }

  const ran = [];
  for (const c of declared) {
    /*
     * Resolved above. Note this is keyed on the DECLARATION only: nothing a check says about
     * its own availability is read here, so a check cannot excuse itself from running.
     */
    const channel = channelOf.get(c.name) ?? null;

    /*
     * BOTH PHASES ARE TESTED FOR PRESENCE BEFORE EITHER RUNS (#833).
     *
     * This used to sit inside the loop below, one test per phase, immediately before that
     * phase was spawned. That reads as equivalent and is not: the CHECKER's test then sits
     * behind the PROOF's execution, and every proof in this directory runs its checker as a
     * subprocess. A deleted checker therefore fails the PROOF first, the loop breaks on a
     * failed proof, and the checker's test is never reached.
     *
     * Measured over all 49 declared checks with the deletion COMMITTED — the only form CI
     * ever sees — 48 exit 1 and never report the absence at all. The one exception is
     * `readme-quickstart`, whose proof names its checker but never runs it; that is the only
     * check where the old placement worked, and it is the shape every fixture in the selftest
     * had. So this branch was covered by a proof stub that exits 0 without touching its
     * checker, which is the one property no real proof has.
     *
     * Exit 1 is the code this repo reserves for a property being VIOLATED. This status exists
     * precisely to keep that apart from "the question could not be asked", and for a missing
     * checker it was reporting the first while meaning the second — the confusion its own note
     * below cites as the reason it exists.
     *
     * HOISTED RATHER THAN DUPLICATED UPSTREAM, AND THAT WAS RULED THE OTHER WAY FIRST. The
     * original ruling was to add an upstream guard BESIDE this status and leave it in place,
     * on the ground that it kept #689 untouched. It was re-ruled on the measurement below
     * rather than on an argument, and the record should show that order. A second copy in the
     * declaration pre-pass
     * closes the same hole and costs more than it looks: every route to this status then runs
     * through a fatal that stops the run, and the six selftest assertions carrying #689's
     * precedence — absence outranking failure, the three statuses kept apart in the record —
     * become reachable only by a check script deleting a later check's script mid-run.
     * Measured, not predicted: applying the upstream form breaks exactly those six, and leaves
     * a seventh green with its subject gone. #689 would stay untouched in the source and go
     * vestigial in reach, which is not what leaving it untouched was meant to buy.
     *
     * IT CANNOT MAKE #834 WORSE, which matters because #834 is live. A check whose verdict
     * leaves STATIC loses its authored fields at eject-subject-audit.mjs:260-269: the
     * `...(r.verdict === STATIC ? {...} : {})` spread omits `note` and `lifts` ENTIRELY once
     * the verdict is not STATIC, and coming back only restores them if `keep` held, which
     * requires STATIC on both sides. assert-eject-subjects-classified.mjs:110 then skips
     * every non-STATIC entry, so nothing reports the loss. This observation moves a verdict exactly as far
     * as a missing checker already moves it today — the check produces no subject either way,
     * so the same input reaches the same place by a better-named route. The upstream form
     * would NOT have been neutral there: a fatal writes no record at all, so an audit run
     * would hand its consumer nothing rather than something classifiable, and what that does
     * downstream is untraced.
     *
     * ABSENCE OUTRANKS AN UNSATISFIABLE CHANNEL, and that ordering is the point rather than a
     * detail. A checker that is not in the tree is not in the tree whether or not a credential
     * exists to run it, and recording the channel skip instead would let a deleted checker
     * report as "not measured here" — a sentence about the environment standing in for a
     * sentence about the repository.
     *
     * A NON-STRING PATH COUNTS AS ABSENT TOO. Nothing validates that `proof` and `checker` are
     * strings, so an entry omitting one reached `join(root, undefined)` and crashed with a
     * TypeError naming neither the check nor the field. Same question, answered in words.
     */
    const absentPhases = new Set();
    for (const [phase, script] of [
      ["proof", c.proof],
      ["checker", c.checker],
    ]) {
      if (typeof script === "string" && existsSync(join(root, script)))
        continue;
      absentPhases.add(phase);
      const named =
        typeof script === "string" ? script : `<no ${phase} path declared>`;
      ran.push({
        name: c.name,
        phase,
        script: named,
        status: "absent",
        exit: null,
        ms: 0,
      });
      console.error(
        `  --  ${c.name} (${phase})  ABSENT: ${named} is declared in checks.json and is ` +
          `not in the tree. NOTHING was checked here — that is not the same as passing, ` +
          `and not the same as failing.`
      );
    }

    // PROOF FIRST, then the checker — in that order, as one unit. This ordering used to live
    // in six `&&` chains and is now a property of the runner, so the seventh cannot omit it.
    for (const [phase, script] of [
      ["proof", c.proof],
      ["checker", c.checker],
    ]) {
      /*
       * Only the CHECKER is channel-dependent. The proof is offline by construction and is
       * never skipped: a checker nobody has watched fail is worthless whether or not it ran,
       * so the half that establishes it can fail must survive the channel that stops the
       * other half.
       */
      if (absentPhases.has(phase)) continue;
      if (phase === "checker" && channel) {
        const verdict = channel.satisfiable();
        if (!verdict.ok) {
          ran.push({
            name: c.name,
            phase,
            script,
            status: "skipped",
            channel: c.needs,
            because: verdict.because,
            exit: null,
            ms: 0,
          });
          console.log(
            `::warning title=${esc(c.name)} (not measured)::${esc(
              script
            )} needs ` +
              `${esc(channel.describe)}. ${esc(
                verdict.because
              )}. This check reported NOTHING ` +
              `on this run — that is not the same as it passing.`
          );
          console.log(
            `  --  ${c.name} (checker)  SKIPPED, needs ${c.needs}: ${verdict.because}`
          );
          break;
        }
      }
      /*
       * A DECLARED SCRIPT THAT IS NOT THERE IS "COULD NOT CHECK", NOT "FAILED".
       *
       * `node missing.mjs` exits 1, and 1 is the status this repo reserves for a property
       * being VIOLATED — exit 2 means the question could not be asked (37 scripts here use
       * it). So a checker that was renamed, moved or never landed arrives in the bucket that
       * says a real defect was found, and the two are indistinguishable from the status
       * alone. Measured: a reviewer read `node scripts/assert-formatted.mjs; echo $?` as a
       * violation when the file simply did not exist on that branch.
       *
       * THIS RUNNER IS THE ONLY PLACE THAT CAN TELL THEM APART, because it holds the
       * declaration and the path BEFORE anything is invoked. Recorded rather than thrown so
       * the remaining checks still run and EVERY absent script is named in one pass — the
       * interesting case is not one failing run, it is a registration that quietly stopped
       * being exercised while checks.json still lists it. The observation itself now happens
       * above, before this check's proof runs, for the reason given there.
       */
      const started = Date.now();
      const r = spawnSync(process.execPath, [join(root, script)], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          ...(phase === "checker" && channel ? channel.provide() : {}),
        },
      });
      /*
       * A REFUSAL IS NOT A FAILURE, AND THE RECORD IS WHERE THAT STOPS BEING TRUE (#684).
       *
       * This read `r.status === 0 ? "pass" : "fail"`, so a checker that exited 2 — "I could
       * not ask the question" — was persisted under the same word as one that exited 1, "the
       * property is violated". Thirty-seven scripts in this directory use that split and the
       * runner recording them threw it away.
       *
       * Nothing is currently fooled: pairing keys on `!== "skipped"` so a refusal still counts
       * as having run, and the `exit` field beside this preserves the raw code. The damage is
       * to the ARTIFACT PEOPLE READ — anything computing a pass rate over `status`, which is
       * the obvious use of a record like this, counts refusals as violations. That is exactly
       * the arithmetic ci-completion.mjs refuses for cancelled runs.
       *
       * Same shape as #404 one field over: there, mapping every entry to its script counted a
       * SKIP as an invocation and inflated this file's own PASS line. That separated skipped
       * from executed; this separates refused from failed.
       */
      const status =
        r.status === 0 ? "pass" : r.status === 2 ? "refused" : "fail";
      /*
       * READ ON ANY STATUS, NOT ONLY ON A PASS (#789).
       *
       * This gated on `status === "pass"` because a subject from a FAILING checker might be
       * PARTIAL — the checker could have died while computing it, and half a count recorded
       * as a count is worse than no count. That is #741's guarantee and it was the right
       * default before anyone had measured whether the partial case exists.
       *
       * IT DOES NOT EXIST BY THE SHAPE THESE CHECKERS HAVE. `reportSubject` is a single call
       * at a determined point: measured across the 48 of 49 registered checkers that emit one,
       * none calls it more than once, so none can emit from inside a loop; and no counted
       * expression is assigned, incremented or pushed to after its own call, checked on the
       * full dotted path. A checker that died BEFORE computing its subject emits no SUBJECT
       * line at all — so the line's PRESENCE is itself evidence the count was completed.
       *
       * THAT COUNT IS A MEASUREMENT WITH A DATE AND IT HAS ALREADY EXPIRED ONCE. It read
       * "47 registered checkers" when this comment was written at bda49289, and it was correct
       * then — 48 registered, 47 emitting. The merge that made this branch current pulled in
       * #792, which registered a 49th checker that emits, so a number in prose went stale
       * inside the same commit that invalidated it. Re-measure rather than trust this
       * sentence: scripts/checks.json names the population.
       *
       * AND THE RECORD WAS ALREADY BUILT TO QUALIFY IT. `status` sits beside `subject` in the
       * same entry, so a consumer reading a subject next to `status: "fail"` knows exactly
       * what it has. Dropping the reading collapsed two states the record has room for —
       * #684's shape a third time.
       *
       * WHAT THIS RECOVERS is real rather than theoretical: assert-fork-python-imports-resolve
       * emits its subject BEFORE its branch, deliberately (see its :197 comment), so a failing
       * run reports the same complete count as a passing one. That reading was being discarded.
       *
       * SAFE HERE BECAUSE A FAILING CHECKER NEVER REACHES subjectComplaint — the
       * `status !== "pass"` branch above breaks first — so this widens what is RECORDED
       * without widening what is REFUSED.
       *
       * ON A REFUSAL (exit 2) THE SUBJECT IS RECORDED TOO, AND THAT IS INTENDED. #789 said a
       * subject there "would be actively false", on the premise that "a checker that could not
       * ask has examined nothing". THE PREMISE IS WHAT FAILS, not the caution behind it: exit 2
       * means the QUESTION could not be asked, which is not the same as nothing having been
       * examined. A checker can read 51 files, report them completely, and only then fail to
       * reach a second query it needed. The three arguments above carry over unchanged — the
       * line's presence is the evidence, `status` beside `subject` qualifies it, and gating on
       * "refused" would collapse two states the record has room for, #684's shape a fourth
       * time.
       *
       * WHAT KEEPS THAT SAFE IS THE SHAPE OF 48 CHECKERS, NOT ANYTHING IN THIS FUNCTION. This
       * code records whatever was emitted. NO REGISTERED CHECKER CAN REACH EXIT 2 AFTER
       * EMITTING A SUBJECT. Most (emit, exit-2) pairs are settled by position alone — the exit
       * sits earlier in the same scope, so it has already run or already not run. FOUR NEEDED
       * REAL ADJUDICATION, and they are named rather than counted, because a four-item list is
       * re-checkable in a minute and a denominator is only quotable:
       *
       *   assert-formatted.mjs                  emit in the onFulfilled arm of a two-argument
       *                                         .then(), exit 2 in onRejected. A promise calls
       *                                         exactly one of them.
       *   assert-merge-keeps-registrations.mjs  emit in `try`, exit 2 in `catch`. NOT trivially
       *                                         exclusive, and the one to re-read whenever a
       *                                         checker grows a try/catch: it is safe only
       *                                         because the emit path runs console.log and
       *                                         `return`, so nothing after it can throw.
       *   assert-sibling-tests-are-owned.mjs    the emit is guarded by `v.code === 0` and the
       *                                         exit is process.exit(v.code) — so emitting
       *                                         IMPLIES exit 0. Invisible to a grep for
       *                                         `process.exit(2)`, which is why a literal count
       *                                         of exit-2 sites is a lower bound.
       *   assert-rung5-security-patches.mjs     exit 2 inside a function passed as a VALUE, so
       *                                         no call site names it; it is reached through
       *                                         assertNothingUnlisted(), before the emit.
       *
       * LINE ORDER IS NOT THE DISCRIMINATOR, AND IT IS ALSO NOT USELESS. It settles the
       * ordinary case and fails on two shapes, in opposite directions: a textually later exit
       * sitting on an arm that cannot run, and `invokedAsProgram` sitting textually AFTER the
       * emit in 33 checkers while evaluating before it. Where the emit and the exit are in
       * different functions it says nothing at all, and the call site decides.
       *
       * But it is a claim about the POPULATION, and populations grow.
       * The selftest's `emits-then-refuses` arm pins what this code DOES with such a checker;
       * it does not establish that none will ever hand it a partial count.
       */
      const subject =
        phase === "checker"
          ? readSubject((r.stdout ?? "") + (r.stderr ?? ""))
          : null;
      ran.push({
        name: c.name,
        phase,
        script,
        status,
        exit: r.status ?? -1,
        ms: Date.now() - started,
        ...(phase === "checker" ? { floor: c.floor, subject } : {}),
      });
      /*
       * A FAILING CHECKER THAT NAMED NO SUBJECT IS REPORTED AS SUCH (#1030).
       *
       * lib/subject.mjs says the emission exists so this runner can "record a subject
       * from a FAILING run instead of discarding it". For most checkers it cannot:
       * `reportSubject` sits after the `process.exit(1)`, so the count is reachable
       * only on the passing path and a failing run carries none. Nine of the eleven
       * checkers measurable in one audit run were silent that way, and #1029 is one
       * symptom -- a proof deadlocked because a legitimately failing checker parsed
       * as subject=0.
       *
       * WHY A WARNING AND NOT A REFUSAL, said plainly so the softness does not read as
       * an oversight: making it fatal would turn each of those checkers red on its
       * first real finding, which is exactly the run where a reader needs the finding
       * rather than a second failure about the reporting of it. The warning names them
       * PER RUN, so the population is measured by this runner instead of inferred from
       * a positional scan -- one scan of 65 files erred in both directions, because
       * line order is not execution order and a branch defeats it. The prose above
       * already says so for exit-2 sites; it is equally true here.
       *
       * WHY IT EXCLUDES `refused`. Exit 2 means the checker could not ask, so it has
       * no subject to name, and demanding one would be asking it to count what it
       * could not read.
       *
       * The idiom is this runner's own for "not measured": a check that reported
       * nothing is not a check that passed, and a check that failed without naming its
       * subject has not said what it was looking at.
       */
      if (phase === "checker" && status === "fail" && !subject) {
        console.log(
          `::warning title=${esc(
            c.name
          )} (failed without naming its subject)::${esc(
            script
          )} exited 1 but printed no SUBJECT line, so the record cannot say WHAT it ` +
            `examined to reach that finding. Move its reportSubject() call above the ` +
            `failing exit (#1030).`
        );
      }

      if (status !== "pass") {
        const why = firstMeaningfulLine((r.stdout ?? "") + (r.stderr ?? ""));
        console.log(
          `::error title=${esc(c.name)} (${phase})::${esc(script)} exited ${
            r.status
          }. ${esc(why)}`
        );
        console.error(`\n--- ${c.name} (${phase}) FAILED: ${script} ---`);
        console.error((r.stdout ?? "") + (r.stderr ?? ""));
        break; // a checker whose proof failed tells you nothing; do not run it
      }
      /*
       * A PASS THAT EXAMINED NOTHING IS NOT A PASS (#741).
       *
       * #684 separated REFUSED from FAILED on this record; this separates
       * EXAMINED-SOMETHING from EXAMINED-NOTHING, one field over, in the same
       * artifact and for the same reason — the damage is to what people read.
       *
       * NOT A FREE-TEXT SUBJECT, and that distinction is the whole bar. #750's
       * checker matched 0 files, excluded all three restrictions it existed to
       * count, printed "0 restriction(s) in scope" and exited 0. It NAMED its
       * subject. A `subject` field would have been satisfied by it. So the
       * subject is a COUNT measured against a floor the check DECLARES, and a
       * pass under that floor is refused here.
       *
       * The floor is PER-ENTRY and never a universal `> 0`: #730's package.json
       * domain was legitimately empty and that was the right finding. A
       * universal floor would be wrong on those and would earn an exception
       * list, which is a mute button. A declared `floor: 0` makes "this check
       * legitimately examines zero" a reviewable sentence instead of an
       * invisible default.
       */
      if (phase === "checker") {
        const bad = subjectComplaint(c, subject);
        if (bad) {
          console.log(`::error title=${esc(c.name)} (${phase})::${esc(bad)}`);
          console.error(`\n--- ${c.name} (${phase}) REFUSED: ${script} ---`);
          console.error(bad);
          ran[ran.length - 1].status = "refused";
          ran[ran.length - 1].exit = 2;
          break;
        }
      }
      console.log(
        `  ok  ${c.name} (${phase})  ${script}` +
          (subject ? `  [${subject.count} ${subject.label}]` : "")
      );
    }
  }

  writeFileSync(
    record,
    JSON.stringify({ tree: treeProvenance(root), ran }, null, 2) + "\n"
  );
  // A skip is neither a pass nor a failure. Folding it into either is the defect this whole
  // mechanism exists to avoid, one level up from the check that needed it.
  return {
    ok: !ran.some((r) => r.status === "fail" || r.status === "refused"),
    ran,
    record,
  };
}

function main() {
  const { ok, fatal, ran, record } = runChecks();
  if (fatal) {
    console.error(`FAIL: ${fatal}`);
    console.error(
      `      Nothing was executed, which is not the same as nothing failing.`
    );
    process.exit(2);
  }
  const failed = ran.filter((r) => r.status === "fail");
  const refused = ran.filter((r) => r.status === "refused");
  const absent = ran.filter((r) => r.status === "absent");
  console.log();

  /*
   * WHAT COULD NOT BE ASKED TAKES PRECEDENCE OVER WHAT WAS ANSWERED WRONGLY (#689).
   *
   * This rule was already written here for ABSENCE: "a run missing one of its declared checks
   * cannot support 'everything else passed' — the summary is drawn from an incomplete list, so
   * the honest status is 'could not check' even when something else also failed. Failures are
   * still printed; only the exit code is claimed by the weaker verdict."
   *
   * A REFUSAL IS THE SAME CATEGORY AND WAS EXITING 1. Exit 2 means "the question could not be
   * asked", which is precisely what a checker exiting 2 has said. #684 stopped the RECORD
   * spelling that as a failure; this stops the EXIT CODE doing it. The argument for leaving it
   * — a refusal is recoverable where an absence is structural — is about the CAUSE, and the
   * exit code describes what was learned, not why.
   *
   * CI DOES NOT MOVE: 1 and 2 are both non-zero, every job that was red stays red. The
   * selftest asserts that rather than assuming it.
   *
   * AND ALL THREE ARE NAMED, which is the reporting bug this found on the way. Measured on a
   * fixture carrying an absence, a refusal and a failure at once: the run exited 2, printed
   * the absence and "1 phase(s) also FAILED", and NEVER MENTIONED THE REFUSAL — it was in the
   * record and absent from the summary. Introduced by #684, which added refusals to the exit-1
   * branch and not to this one.
   */
  const unanswered = [...absent, ...refused];
  if (unanswered.length) {
    if (absent.length) {
      console.error(
        `FAIL: ${absent.length} declared script(s) are ABSENT from the tree:\n` +
          absent
            .map((a) => `        ${a.name} (${a.phase})  ${a.script}`)
            .join("\n") +
          `\n      checks.json declares them and they are not there, so this run did not ` +
          `execute them.\n      Either restore the script or remove its entry — a declared ` +
          `check nobody runs is a\n      registration that reports nothing while looking ` +
          `like coverage.`
      );
    }
    if (refused.length) {
      console.error(
        `${absent.length ? "      " : "FAIL: "}${
          refused.length
        } phase(s) REFUSED ` +
          `(exit 2) — ${[...new Set(refused.map((r) => r.name))].join(
            ", "
          )}.\n` +
          `      A refusal is the checker reporting that it could not ask its question, not ` +
          `that\n      the answer was no. Each is annotated above with its reason.`
      );
    }
    if (failed.length)
      console.error(
        `      (${failed.length} phase(s) also FAILED: ` +
          `${[...new Set(failed.map((f) => f.name))].join(", ")}.)`
      );
    console.error(
      `      Exiting 2: the question could not be asked, not answered.`
    );
    process.exit(2);
  }
  if (failed.length) {
    console.error(
      `FAIL: ${failed.length} of ${ran.length} phase(s) failed — ` +
        `${[...new Set(failed.map((f) => f.name))].join(", ")}.\n` +
        `      Each is annotated above by name; the record is at ${record}.`
    );
    process.exit(1);
  }
  /*
   * NOTHING NOT-GREEN REACHES THE SUMMARY (#689). A tripwire, not a verdict.
   *
   * The branches above claim every status that is not `pass` or `skipped`, and this asserts
   * that they did. Found by calibration rather than foresight: moving refusals out of the
   * exit-1 branch left exactly ONE site catching them, and the mutation that removed them from
   * `unanswered` did not make the run exit 1 — IT MADE IT EXIT 0. A refusal fell through every
   * branch and was reported as all green.
   *
   * That is the failure this repository keeps finding, arriving through a change intended to
   * make reporting more honest. So the fallthrough is now impossible by construction rather
   * than by the branches being right: a status nobody claimed exits 2, because a summary that
   * cannot account for one of its own entries has not established that the rest are fine.
   */
  const unclaimed = ran.filter(
    (r) => r.status !== "pass" && r.status !== "skipped"
  );
  if (unclaimed.length) {
    console.error(
      `FAIL: ${unclaimed.length} phase(s) reached the summary with a status no verdict ` +
        `claimed:\n` +
        unclaimed
          .map((u) => `        ${u.name} (${u.phase})  status=${u.status}`)
          .join("\n") +
        `\n      This is a bug in run-checks.mjs, not in the checks. Exiting 2 rather than ` +
        `printing\n      a green over a run it cannot account for.`
    );
    process.exit(2);
  }

  const skipped = ran.filter((r) => r.status === "skipped");
  const executed = ran.filter((r) => r.status === "pass");
  const names = [...new Set(ran.map((r) => r.name))];

  /*
   * THE COUNTS ARE KEPT APART ON PURPOSE. "N phases, all green" over a set that includes
   * skips is a rate over a denominator nobody wants to know — the same arithmetic
   * ci-completion.mjs refuses for cancelled runs. Executed phases are counted; skipped ones
   * are named, with what they needed and why they did not get it.
   */
  console.log(
    `PASS: ${names.length} declared check(s), ${executed.length} phase(s) executed, all green.\n` +
      `      ${names.join(", ")}\n` +
      `      Recorded to ${record} — pairing reads that rather than inferring from YAML.`
  );
  if (skipped.length) {
    console.log(
      `\nNOT MEASURED: ${skipped.length} declared check(s) did not run their checker. This is a\n` +
        `      recorded HOLE, not a pass — nothing below was verified on this run:`
    );
    for (const s of skipped)
      console.log(`      ${s.name}  needs ${s.channel} — ${s.because}`);
  }
}

const isMain = invokedAsProgram(import.meta.url);
if (isMain) main();
