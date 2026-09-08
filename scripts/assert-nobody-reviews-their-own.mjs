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

export class Refusal extends Error {}

export const STATE = {
  OK: "no reader report covers its own author",
  SELF_REVIEW: "A READER REPORT COVERS ITS OWN AUTHOR'S PULL REQUEST",
  UNCOMPARABLE: "an agent name is off-roster, so identity cannot be compared",
  UNDECLARED:
    "no AUTHORING-AGENT declaration, so there is nothing to compare against",
};

export const FINDINGS = new Set([STATE.SELF_REVIEW]);

/**
 * The declared author's ROSTER IDENTITY, or null. Reads the body and every commit message, the
 * same union the authorship gate reads, because a declaration may live in either channel.
 */
export function declaredIdentity(detail) {
  if (detail === null || detail === undefined) return null;
  const texts = [detail.body ?? ""];
  for (const c of detail.commits ?? []) {
    texts.push(c?.messageHeadline ?? "");
    texts.push(c?.messageBody ?? "");
  }
  for (const t of texts) {
    const m = DECLARATION.exec(t);
    if (m) return identityOf(m.groups.agent);
  }
  return null;
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
  const author = declaredIdentity(detail);
  const live = liveReports(reports ?? []);
  if (author === null)
    return { state: STATE.UNDECLARED, detail: "", offenders: [], author: null };
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

function main() {
  const list = gh([
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
  for (const { number } of list) {
    const detail = gh([
      "pr",
      "view",
      String(number),
      "--json",
      "body,commits,comments",
    ]);
    if (detail === null)
      throw new Refusal(
        `\`gh pr view ${number}\` did not answer — refusing rather than skipping it`
      );
    const reports = reportsFrom(detail.comments ?? []);
    if (liveReports(reports).length === 0) continue; // not in the subject
    rows.push({ number, ...classify({ detail, reports }) });
  }

  reportSubject(rows.length, "pull request(s) carrying a live reader report");

  if (rows.length === 0) {
    console.log(
      "OK: no open pull request carries a live reader report, so NOTHING was examined and this " +
        "check asserts nothing about self-review. The subject floor is on pull requests that " +
        "carry one, not on the open count."
    );
    return 0;
  }

  const bad = rows.filter((r) => FINDINGS.has(r.state));
  if (bad.length) {
    console.error(
      `FAIL: ${bad.length} of ${rows.length} pull request(s) are covered by their own author:\n`
    );
    for (const r of bad)
      console.error(`  #${r.number}  ${r.state}\n    ${r.detail}\n`);
    return 1;
  }

  console.log(
    `OK: none of ${rows.length} pull request(s) carrying a reader report is covered by its own author.\n`
  );
  for (const r of rows)
    console.log(
      `  #${String(r.number).padEnd(5)} author ${String(
        r.author ?? "(undeclared)"
      ).padEnd(10)} ${r.state}${r.detail ? " — " + r.detail : ""}`
    );
  return 0;
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
    throw e;
  }
}
