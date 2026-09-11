#!/usr/bin/env node
/**
 * NOBODY'S READER REPORT COVERS THEIR OWN PULL REQUEST (#1058, #1052, #915).
 *
 * #1055 created a fact that did not exist before: `AUTHORING-AGENT` on a pull request. Nothing
 * consumed it. The rule it was created to make enforceable — *never assign someone their own pull
 * request* — was still enforced by a person remembering, which is the shape that reads as done
 * while asserting nothing.
 *
 * THE COST IS MEASURED, NOT PREDICTED. Only `jobordu` is assignable on this repository and every
 * agent commits under it, so **GitHub cannot express agent identity at all**. In one dispatch
 * round: an ownership sweep over `.assignees` reported 44 unowned issues where the real figure was
 * 27; #1095 was filed by one agent and credited to another; #1086's subject was attributed to
 * nobody. `AUTHORING-AGENT` is the only channel that can carry agent identity here, and until this
 * check nothing verified anything about it.
 *
 * WHY A CONSUMER RATHER THAN A STRICTER CONVENTION. A declaration with a canonical parser is a
 * different object from one without: the READER-REPORT channel has a consumer, and that is exactly
 * why its parser is anchored and handles retraction — someone had to decide the hard cases. A
 * convention nothing reads has never been tested against reality. This is that test.
 *
 * IT IMPORTS BOTH PARSERS RATHER THAN RE-IMPLEMENTING EITHER. `DECLARATION` and `identityOf` come
 * from the authorship gate; `reportsFrom` and `liveReports` from the coverage gate. A hand-rolled
 * reader of either format differs from the canonical one exactly where corrections and epitaphs
 * live — measured: an unanchored grep for tokens on one pull request returns NINE where eight
 * exist, because a retraction quotes the token it retracts.
 *
 * THE ROSTER IS WHAT MAKES THE COMPARISON POSSIBLE. `DEV3` in a commit trailer and `DEV3-lang` in
 * a body are the same agent, and before #1058's roster landed nothing could say so. A join on raw
 * strings would miss exactly the self-review that spelled its name the other way.
 *
 * AND AN UNKNOWN NAME NEVER MATCHES AN UNKNOWN NAME. `identityOf` returns null off-roster, and
 * `null === null` would report two different unrecognised agents as the same person — the same
 * defect as an empty set comparing equal to every other empty set. Unknown on either side is
 * reported as uncomparable, never as a match.
 *
 * SUBJECT FLOOR: pull requests carrying a reader token, which this board reliably has. #1053's
 * lesson is that a predicate over ARMED pull requests went green because nothing was armed; a
 * predicate that cannot fail because its population is empty asserts nothing and must say so.
 *
 * EXIT CODES
 *   0  no reader report covers its own author's pull request
 *   1  one does
 *   2  a refusal: an input could not be read
 */
import { execFileSync } from "node:child_process";
import { reportSubject } from "./lib/subject.mjs";
import {
  DECLARATION,
  identityOf,
} from "./assert-pr-authorship-is-attributable.mjs";
import {
  reportsFrom,
  liveReports,
} from "./assert-armed-prs-are-covered-by-a-review.mjs";
import { refuseUnanticipated } from "./lib/refusal.mjs";
import { printThenRank } from "./lib/print-then-rank.mjs";

export class Refusal extends Error {}

export const STATE = {
  OK: "no reader report covers its own author",
  SELF_REVIEW: "A READER REPORT COVERS ITS OWN AUTHOR'S PULL REQUEST",
  UNCOMPARABLE: "an agent name is off-roster, so identity cannot be compared",
  UNDECLARED:
    "no AUTHORING-AGENT declaration, so there is nothing to compare against",
  UNKNOWN_AUTHOR:
    "the AUTHORING-AGENT declaration names an agent the roster does not know, so no reader can be compared against it",
};

export const FINDINGS = new Set([STATE.SELF_REVIEW]);

/**
 * States where the comparison COULD NOT BE COMPUTED. They are refusals, ranked by printThenRank (#1177).
 *
 * A declared author the roster does not know has not been checked, and passing it would say it
 * had. It fails open precisely for the identities nobody has registered yet: the next agent
 * added to the board. An off-roster READER is deliberately NOT here. The author is known in that
 * case, and its UNCOMPARABLE state is announced and passes by an earlier design this issue does
 * not revisit.
 */
export const REFUSALS = new Set([STATE.UNKNOWN_AUTHOR]);

/**
 * The NAME the declaration gives, as written, or null when there is NO declaration. Reads the body
 * and every commit message, the same union the authorship gate reads, because a declaration may
 * live in either channel.
 *
 * SEPARATE FROM THE IDENTITY BECAUSE THE TWO NULLS MEAN DIFFERENT THINGS (#1177). `identityOf` is
 * null for an off-roster name, and that is the same null as "nothing declared". Resolved in one
 * step, `AUTHORING-AGENT: DEV7` reviewed by `DEV7-lang` came back UNDECLARED, which is a false
 * statement about the pull request, and it passed.
 */
export function declaredName(detail) {
  if (detail === null || detail === undefined) return null;
  const texts = [detail.body ?? ""];
  for (const c of detail.commits ?? []) {
    texts.push(c?.messageHeadline ?? "");
    texts.push(c?.messageBody ?? "");
  }
  for (const t of texts) {
    const m = DECLARATION.exec(t);
    if (m) return m.groups.agent;
  }
  return null;
}

/** The declared author's ROSTER IDENTITY, or null for EITHER reason; `declaredName` tells them apart. */
export function declaredIdentity(detail) {
  const name = declaredName(detail);
  return name === null ? null : identityOf(name);
}

/**
 * Reader reports whose agent is the same identity as the author.
 *
 * `null` identities NEVER match. Two off-roster names are two unknowns, not one agent, and
 * reporting them as a match would accuse a reader on the strength of neither name being known.
 */
export function selfReviews(authorIdentity, reports) {
  /*
   * ONE GUARD, NOT TWO. The first draft also returned early on a null author, and mutation found
   * that NEITHER guard was pinned: each masked the other, so removing either alone changed no
   * arm and only removing both broke one. A guard no test can reach is indistinguishable from a
   * guard that is wrong, so the redundant one is gone and `id !== null` below is load-bearing.
   */
  return (reports ?? []).filter((r) => {
    const id = identityOf(r.agent);
    return id !== null && id === authorIdentity;
  });
}

/** Reports naming an agent the roster does not know — uncomparable, and worth announcing. */
export function offRoster(reports) {
  return (reports ?? []).filter((r) => r.agent && identityOf(r.agent) === null);
}

export function classify({ detail, reports }) {
  if (detail === null)
    throw new Refusal("the pull request's body and commits could not be read");
  const declared = declaredName(detail);
  const live = liveReports(reports ?? []);
  if (declared === null)
    return { state: STATE.UNDECLARED, detail: "", offenders: [], author: null };
  const author = identityOf(declared);
  if (author === null)
    return {
      state: STATE.UNKNOWN_AUTHOR,
      author: null,
      declared,
      offenders: [],
      detail:
        `AUTHORING-AGENT declares ${declared}, which is not on the roster, so no reader report ` +
        `can be compared against its author. REPAIR: add ${declared} to the roster if it is a ` +
        `live agent on this board, or correct the declaration`,
    };
  const offenders = selfReviews(author, live);
  if (offenders.length)
    return {
      state: STATE.SELF_REVIEW,
      author,
      offenders,
      detail:
        `declared ${author}, and ${offenders.length} reader report(s) from ${author} cover it — ` +
        `${offenders
          .map((o) => `${o.agent} @ ${String(o.sha).slice(0, 12)}`)
          .join(", ")}. ` +
        `REPAIR: the coverage must come from someone else; withdraw the report by adding a ` +
        `WITHDRAWN line to its own comment, and ask for a reader who did not write it`,
    };
  const unknown = offRoster(live);
  if (unknown.length)
    return {
      state: STATE.UNCOMPARABLE,
      author,
      offenders: [],
      detail: `${unknown.map((u) => u.agent).join(", ")} not on the roster`,
    };
  return { state: STATE.OK, author, offenders: [], detail: "" };
}

const gh = (args) => {
  try {
    return JSON.parse(
      execFileSync("gh", args, { encoding: "utf8", maxBuffer: 1 << 28 })
    );
  } catch {
    return null;
  }
};

/**
 * The run. Its channels are injectable so the selftest can drive the pull-request loop itself
 * (#1215): `ask` stands in for `gh`, and `report` for `reportSubject`, which a process may call once.
 */
export function main({
  ask = gh,
  log = console.log,
  error = console.error,
  report = reportSubject,
} = {}) {
  const list = ask([
    "pr",
    "list",
    "--state",
    "open",
    "--limit",
    "100",
    "--json",
    "number",
  ]);
  if (list === null)
    throw new Refusal(
      "`gh pr list` did not answer, so no pull request was examined"
    );

  const rows = [];
  const unreadable = [];
  for (const { number } of list) {
    const detail = ask([
      "pr",
      "view",
      String(number),
      "--json",
      "body,commits,comments",
    ]);
    /*
     * ONE UNANSWERED `gh pr view` IS A REFUSAL FOR THAT PULL REQUEST, NOT FOR THE RUN (#1215). This
     * threw here, after earlier pull requests' rows were computed and before any was printed, so a
     * transient failure on one hid a real self-review on another. The loop goes on; printThenRank
     * prints both, and a finding decides the exit.
     */
    if (detail === null) {
      unreadable.push({
        number,
        why: `\`gh pr view ${number}\` did not answer`,
      });
      continue;
    }
    const reports = reportsFrom(detail.comments ?? []);
    if (liveReports(reports).length === 0) continue; // not in the subject
    rows.push({ number, ...classify({ detail, reports }) });
  }

  report(rows.length, "pull request(s) carrying a live reader report");

  if (rows.length === 0 && unreadable.length === 0) {
    log(
      "OK: no open pull request carries a live reader report, so NOTHING was examined and this " +
        "check asserts nothing about self-review. The subject floor is on pull requests that " +
        "carry one, not on the open count."
    );
    return 0;
  }

  const bad = rows.filter((r) => FINDINGS.has(r.state));
  const unasked = rows.filter((r) => REFUSALS.has(r.state));
  return printThenRank({
    refusals: [...unreadable, ...unasked],
    findings: bad,
    printRefusals: () => {
      error(
        `REFUSING: ${
          unreadable.length + unasked.length
        } pull request(s) could not be compared:\n`
      );
      for (const u of unreadable) error(`  #${u.number}  ${u.why}\n`);
      for (const r of unasked)
        error(`  #${r.number}  ${r.state}\n    ${r.detail}\n`);
    },
    printFindings: () => {
      error(
        `FAIL: ${bad.length} of ${rows.length} pull request(s) are covered by their own author:\n`
      );
      for (const r of bad)
        error(`  #${r.number}  ${r.state}\n    ${r.detail}\n`);
    },
    printPass: () => {
      log(
        `OK: none of ${rows.length} pull request(s) carrying a reader report is covered by its own author.\n`
      );
      for (const r of rows)
        log(
          `  #${String(r.number).padEnd(5)} author ${String(
            r.author ?? "(undeclared)"
          ).padEnd(10)} ${r.state}${r.detail ? " — " + r.detail : ""}`
        );
    },
  });
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1].endsWith("assert-nobody-reviews-their-own.mjs");
if (invokedDirectly) {
  try {
    process.exit(main());
  } catch (e) {
    if (e instanceof Refusal) {
      console.error(`REFUSING: ${e.message}`);
      process.exit(2);
    }
    refuseUnanticipated(e);
  }
}
