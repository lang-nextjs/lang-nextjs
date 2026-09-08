#!/usr/bin/env node
/**
 * EVERY OPEN PULL REQUEST CAN BE ATTRIBUTED TO WHOEVER WROTE IT (#1052).
 *
 * WHY THE FORGE CANNOT ANSWER THIS. Every agent on this board authenticates as the same
 * GitHub account, so `author.login` is `jobordu` for all of them. The dispatcher's rule
 * "never assign someone their own pull request" has therefore been UNENFORCEABLE the whole
 * time it has been in force: there is no field to read. It held on 2026-09-08 only because
 * DEV3 volunteered that they had written `frame-contract.ts` and declined the #989 read.
 * A rule that holds when someone happens to speak is not a control.
 *
 * WHAT THIS IS AND IS NOT. It is not an identity check and cannot become one. The
 * declaration is SELF-DECLARED and unverifiable, exactly like `READER-REPORT`, and that is
 * acceptable HERE for a reason worth stating rather than assuming:
 *
 *     THE THREAT MODEL IS OMISSION, NOT DECEPTION.
 *
 * An agent reading its own pull request is uninformed, not adversarial — nobody asked, and
 * a number does not look like one's own work. A self-declared line closes that completely
 * and closes nothing against an agent that lies. Waiting for a verifiable channel means
 * waiting forever, because with one shared login there is not one, and the failure actually
 * met is the one the unverifiable version fixes.
 *
 * WHY THE LINE IS `AUTHORING-AGENT:` AND NOT THE OBVIOUS `AUTHORED-BY:`. Because this
 * repository mandates `Co-Authored-By:` on every commit, and `AUTHORED-BY` is a SUBSTRING of
 * it. Column-anchored patterns do not collide — measured, both the strict and loose forms
 * reject the trailer — but a case-insensitive substring search does, and that is how a
 * person greps. The name was chosen after a search for `AUTHORED-BY` on the three
 * agent-authored pull requests open at the time returned 2, 3 and 1 hits, ALL of them the
 * mandated trailer and none of them a declaration. A token whose first measurement was a
 * false positive against a string the repo puts in every commit is the wrong token.
 *
 * WHERE THE DECLARATION MAY LIVE, AND WHY BOTH. A commit trailer is the better channel: it
 * is written by the author, at authoring time, and it survives SOMEONE ELSE OPENING THE
 * PULL REQUEST. That last case is not hypothetical — #1028 is a branch pushed by one agent
 * and opened as a draft by TEAMLEAD purely to make it visible, and TEAMLEAD could not
 * attribute it. A body-only rule would have been filled in by the opener, who did not know.
 * The pull request BODY is also accepted, because a branch whose commits predate this gate
 * cannot be amended without a force-push, and a repairable channel beats an unusable one.
 * The union of the two is read.
 *
 * BOTS ARE NOT AN EXEMPTION, AND THE DIFFERENCE MATTERS. Eight of the eleven pull requests
 * open when this landed were Dependabot's. They carry no declaration and never will. The
 * wrong repair is an exception list, which shrinks the domain by an unwritten rule and has
 * the same known repair for every entry. The right one is to notice that the API's answer
 * is INFORMATIVE for a bot and VACUOUS for us: `author.is_bot` is true and `app/dependabot`
 * names a real distinct author. So the rule is derived from whether the channel carries
 * information, not from a list of names, and the domain stays whole — every open pull
 * request is attributable, by declaration where the forge is silent and by the forge where
 * it is not.
 *
 * THE LIMIT OF THAT, STATED BECAUSE IT IS REAL: a pull request OPENED BY A BOT whose branch
 * carries agent commits would pass here without a declaration. That combination does not
 * occur today — Dependabot's branches are Dependabot's — and the inverse, an agent opening
 * a branch someone else wrote, is the case this file is built around. If a bot ever opens
 * human work, this check is the wrong instrument and says so here rather than failing
 * quietly.
 *
 * THE TRANSITION SELF-DRAINS, WITH NO DATE IN IT. The pull requests that were agent-authored
 * and undeclared when this landed would otherwise be red-lit for a rule that did not exist
 * when they were pushed, so `KNOWN_UNDECLARED` grandfathers exactly those, and
 * each entry is PINNED TO THE HEAD SHA IT WAS GRANDFATHERED AT. Push to one and the
 * exemption lapses — because the author is demonstrably active on it and can add the line.
 * That is deliberately not a cutoff date: a date is a constraint in prose that expires
 * unnoticed, whereas a sha stops applying by the same event that makes the repair possible.
 * An entry that lapses is a FINDING and says so, rather than silently widening.
 *
 * EXIT VOCABULARY, applied as everywhere else: 0 pass, 1 the property is violated, 2 the
 * question could not be asked. A refusal OUTRANKS a finding — if some pull request's body
 * and commits could not be read, "N are undeclared" is not a true statement about the set.
 */
import { spawnSync } from "node:child_process";
import { invokedAsProgram } from "./lib/is-main.mjs";
import { reportSubject } from "./lib/subject.mjs";

/**
 * Bare, anchored at column one, optionally wrapped in a SYMMETRIC `**`. `\k<bold>` is what
 * buys the symmetry: when the group does not participate the backreference is the empty
 * string, so `**AUTHORING-AGENT: X` with no closing pair is refused rather than accepted.
 * Named groups rather than indices, so adding a wrapper later cannot silently renumber the
 * agent capture.
 *
 * THE AGENT IS A POSITIVE CLASS, AND TWO NEGATIVE ONES FAILED BEFORE IT. `\k<bold>` bought
 * symmetry only against a LEADING-only `**`; a TRAILING-only one was absorbed by the greedy
 * `\S+`, so `AUTHORING-AGENT: DEV3**` captured `"DEV3**"`. Excluding `*` fixed that instance
 * and nothing else — DEV3 then produced four more, every one of them parsing into a name no
 * consumer can compare:
 *
 *     AUTHORING-AGENT: _DEV3_        ->  "_DEV3_"        markdown italics
 *     AUTHORING-AGENT: `DEV3`        ->  "`DEV3`"        markdown code
 *     AUTHORING-AGENT: DEV3.         ->  "DEV3."         a sentence
 *     AUTHORING-AGENT: [DEV3](x)     ->  "[DEV3](x)"     a link
 *
 * THE LESSON IS THE SHAPE, NOT THE CHARACTERS. An exclusion list enumerates hazards, and the
 * hazards are every punctuation mark a person or a renderer might put beside a word — an open
 * set, so the list is never finished and each repair looks complete until the next instance.
 * A positive class enumerates what an agent name may CONTAIN, which is small, closed, and
 * stable: a letter, then letters, digits and hyphens. `DEV3-lang` still parses; all six known
 * bad forms are refused by the strict pattern and caught by the loose one as FINDINGS, which
 * is louder than a silent mis-parse.
 */
export const DECLARATION =
  /^(?<bold>\*\*)?AUTHORING-AGENT:\s*(?<agent>[A-Za-z][A-Za-z0-9-]*)\s*\k<bold>\s*$/mu;

/**
 * The form a consumer compares. Case is mechanical and is normalised here; ROSTER IDENTITY IS
 * NOT, and deliberately so — `DEV3` and `DEV3-lang` are the same agent under a rename this
 * file has no way to know about, and guessing at it would be a mapping with no instrument
 * behind it. #1058 owns that, and owns it with the roster in hand. What this guarantees to a
 * consumer is narrower and checkable: no whitespace, no asterisks, upper-cased.
 */
export const canonicalAgent = (agent) => String(agent ?? "").toUpperCase();

/**
 * THE CLOSED ROSTER, WHICH IS WHAT MAKES A DECLARED NAME COMPARABLE (#1058).
 *
 * `canonicalAgent` above normalises case and nothing else, and said so: it left roster
 * identity to this issue, "with the roster in hand". Here it is, and the measurement that
 * shaped it — because the obvious roster is wrong in a way only counting reveals.
 *
 * MEASURED on origin/main, 549 commits and 120 pull requests:
 *
 *     declarations in 549 commits     ARCHITECT 14, DEV3 2
 *     declarations in 120 PR bodies  ARCHITECT 7, DEV3 5, DEV2 3
 *     (reported separately, NOT summed: a merged PR is in both populations)
 *     the same agents named in prose  ARCHITECT 83, PRODUCT 27, DEV3-lang 12,
 *                                     DEV2-lang 7, TEAMLEAD-lang 4, DEV1-lang 4
 *
 * NOT ONE DECLARATION HAS EVER CARRIED THE `-lang` SUFFIX, and almost every prose mention
 * does. So the two forms are both live, for the same agents, in different channels — which
 * is precisely the `DEV3` / `DEV3-lang` collision the note above could not resolve without
 * measuring. A roster of only the suffixed names would refuse every declaration on main; a
 * roster of only the unsuffixed ones would refuse the first person to paste their prose name.
 *
 * SO THE ROSTER IS DECLARED RATHER THAN DERIVED, and the aliases are the finding. Deriving it
 * from observation alone would close the set at three — `DEV1`, `TEAMLEAD` and `PRODUCT` have
 * never declared — and refuse their first declaration as unknown. An observed set is a floor,
 * never a roster.
 */
export const ROSTER = Object.freeze({
  ARCHITECT: Object.freeze(["ARCHITECT"]),
  PRODUCT: Object.freeze(["PRODUCT"]),
  TEAMLEAD: Object.freeze(["TEAMLEAD", "TEAMLEAD-LANG"]),
  DEV1: Object.freeze(["DEV1", "DEV1-LANG"]),
  DEV2: Object.freeze(["DEV2", "DEV2-LANG"]),
  DEV3: Object.freeze(["DEV3", "DEV3-LANG"]),
});

/**
 * The identity a declared name denotes, or `null` when the roster does not know it.
 *
 * A null is a FINDING rather than a refusal: an unrecognised name is a fact about that pull
 * request, fully computed, not an input this check could not read. Refusals in this file mean
 * "the API did not answer". Adding an agent is a one-line edit here, and the finding names it.
 */
export function identityOf(name) {
  const wanted = canonicalAgent(name);
  for (const [identity, aliases] of Object.entries(ROSTER))
    if (aliases.includes(wanted)) return identity;
  return null;
}

/** Anything that MEANT to be a declaration. A near-miss must be loud, never absent. */
export const DECLARATION_LOOSE = /^([ \t>*_#`-]*AUTHORING-AGENT:.*)$/mu;

/**
 * WHICH CHANNEL CARRIED A DECLARATION. A commit trailer is written by the AUTHOR at authoring
 * time; a body line is written by whoever OPENED the pull request, and #1028 is the case where
 * those are different agents. Both satisfy this check — the threat model is omission — but a
 * reader deciding whether to trust an attribution wants to know which one it was.
 */
export const CHANNEL = Object.freeze({
  COMMIT: "commit",
  BODY: "pull request body",
});

export const STATE = {
  BOT: "attributable — opened by a bot the API names",
  DECLARED: "declared",
  GRANDFATHERED: "undeclared, grandfathered at the sha it was open at",
  UNDECLARED: "NO AUTHORING-AGENT DECLARATION",
  LAPSED: "NO DECLARATION, AND ITS GRANDFATHERING LAPSED WHEN IT WAS PUSHED",
  UNPARSED: "A DECLARATION IS PRESENT THAT THE PATTERN DOES NOT MATCH",
  UNKNOWN_AGENT: "IT DECLARES A NAME THAT IS NOT ON THE ROSTER",
  UNFETCHED: "ITS BODY AND COMMITS COULD NOT BE FETCHED - COULD NOT CHECK",
};

export const REFUSALS = new Set([STATE.UNFETCHED]);
export const FINDINGS = new Set([
  STATE.UNDECLARED,
  STATE.LAPSED,
  STATE.UNPARSED,
  STATE.UNKNOWN_AGENT,
]);

/**
 * The agent-authored pull requests that were open and undeclared when this landed, each pinned
 * to the head it was grandfathered at. A reason per entry, never a bare number: a list of
 * numbers with one shared implicit reason is the shape that outlives the situation that
 * justified it.
 *
 * NO COUNT IS WRITTEN IN THIS SENTENCE, and that is deliberate rather than vague. It said
 * "three" until #989 merged and the list became two — a number in prose describing a set that
 * changes is a claim with no instrument behind it, which is the same defect `staleExemptions`
 * exists to catch in the data. The entries below are the count.
 */
export const KNOWN_UNDECLARED = Object.freeze({
  1011: Object.freeze({
    head: "c4c93f1a7341",
    reason:
      "a DIAGNOSTIC-ONLY probe branch marked DO NOT MERGE, opened before this gate existed",
  }),
  1028: Object.freeze({
    head: "c6ccb180ca27",
    reason:
      "THE CASE THAT MOTIVATED #1052. Pushed by an agent that raised no pull request; " +
      "TEAMLEAD opened it as a draft to make it visible and could not attribute it. It is " +
      "grandfathered because nobody currently knows the author to write the line — which is " +
      "the finding, not an oversight in this list",
  }),
});

/** Prefix-tolerant, because a recorded sha may be abbreviated and a head is not. */
export function sameCommit(a, b) {
  return Boolean(a && b && (a.startsWith(b) || b.startsWith(a)));
}

/**
 * AN EXEMPTION FOR A PULL REQUEST THAT IS NO LONGER OPEN IS A DEAD PREMISE, AND IT MUST NOT
 * BE ABLE TO ROT QUIETLY. This is not hypothetical caution: the first draft of this file
 * grandfathered #989, and #989 merged BEFORE the file was finished. A list written from a
 * measurement taken minutes earlier was already wrong, which is precisely why the list
 * cannot be trusted to be pruned by whoever remembers.
 *
 * A stale entry is a FINDING with a one-line repair — delete it — rather than a refusal,
 * because the board answered fine and the list is simply making a claim about a pull
 * request that is not there.
 */
export function staleExemptions(openNumbers, known = KNOWN_UNDECLARED) {
  return Object.keys(known)
    .map(Number)
    .filter((n) => !openNumbers.has(n));
}

/**
 * HOW LONG AN EXEMPTION MAY NAME A CLOSED PULL REQUEST BEFORE IT BECOMES A FINDING.
 *
 * WITHOUT THIS, THE LIST HAD NO GREEN RETIREMENT PATH — every route from "entry present, pull
 * request open" to "entry gone, pull request closed" passes through a failing state:
 *
 *     entry present, pull request OPEN      PASS   grandfathered, where an entry starts
 *     entry deleted, pull request OPEN      FAIL   the pull request becomes an undeclared finding
 *     entry present, pull request CLOSED    FAIL   stale — and this is the state a close lands in
 *     entry deleted, pull request CLOSED    PASS   the destination
 *
 * `pnpm checks` runs inside the job named "Build, Test, Validate", which is a REQUIRED context,
 * so the two middle rows are not a local inconvenience: they red every open pull request on the
 * board, none of which can fix the list, and the deletion is the only thing that could be green.
 * Ten were open when this was written.
 *
 * WHY THIS FINDING MAY BE DISMISSED WHEN THE OTHERS MAY NOT. An exemption matches by pull request
 * NUMBER. Once that number is closed nothing open can be excused by it, so a stale entry cannot
 * cause a false pass — it is untidiness with a deadline rather than a hole. That asymmetry is the
 * whole justification: a grace period would be indefensible on an undeclared pull request, where
 * the finding withheld is the finding that matters.
 *
 * THE DURATION IS A JUDGEMENT AND THE MEASURED PART IS STATED BESIDE IT, because a threshold that
 * DISMISSES a finding must not be able to pass as derived. Across the 25 most recently merged pull
 * requests (sampled 2026-09-08) open-to-merge ran median 69 minutes, p90 119, max 272. That bounds
 * only the last step. The step that sets this number is somebody NOTICING the entry went stale,
 * which nothing here measures and which spans nights and weekends. Seven days is chosen so the
 * slowest merge yet observed is under 2% of it: the margin is deliberately dominated by the term
 * that was never measured. Re-derive it rather than trusting it.
 */
export const STALE_GRACE_MINUTES = 7 * 24 * 60;

/**
 * Minutes since `closedAt`, or `null` when the reading is unusable. Null is not zero and not
 * "old" — it means the age could not be computed, and every caller treats it as a reason to
 * WITHHOLD a finding rather than to raise one.
 *
 * A future-dated timestamp returns null for the reason the branch-raising gate does the same: a
 * clock that disagrees with the API yields a negative age, and a negative age silently satisfies
 * any "younger than the grace" test — dismissing a finding on the strength of a broken instrument.
 */
export function closedAgeMinutes(closedAt, now = Date.now()) {
  if (typeof closedAt !== "string") return null;
  const t = Date.parse(closedAt);
  if (Number.isNaN(t)) return null;
  const minutes = Math.floor((now - t) / 60000);
  return minutes < 0 ? null : minutes;
}

/**
 * Sorts stale exemptions into what may be asserted about each. Takes the resolved API answers as
 * data so the decision is testable without a network: the seam is here rather than at the fetch.
 *
 * FOUR OUTCOMES, AND THE SPLIT THAT MATTERS IS ABSENT VERSUS UNAGED. A pull request that does not
 * exist is an ANSWER — no grace can apply to a number that was never a pull request, so it fails
 * at once, which is what stops the grace from swallowing a typo'd entry. A query that did not
 * answer is a REFUSAL and fails nothing. Collapsing those two would convert "I could not ask"
 * into "it is not there", which is the error this file's exit-2 path exists to prevent.
 */
export const EXEMPTION = Object.freeze({
  EXPIRED: "expired",
  WITHIN: "within",
  ABSENT: "absent",
  UNAGED: "unaged",
});

/**
 * The note a human actually reads. SEPARATE FROM `main` SO ITS CONTENT CAN BE ASSERTED, which is
 * the gap DEV1 found in the first version of this change: the proof read the checker's own bytes
 * for `${staleNote}${grandNote}` and so pinned that the note is REFERENCED on the pass path.
 * Replacing the whole note with `"\n"` left that reference intact and the suite green — an arm
 * about turning visible debt into invisible debt, surviving the note going blank.
 *
 * The pattern is worth naming because it is not specific to this file: THE ASSERTION WAS PINNED
 * AND THE THING THAT DELIVERS IT TO A READER WAS NOT. A wiring check and a content check are
 * different claims, and only the second one notices an empty message.
 *
 * Returns "" for an empty list so callers can interpolate it unconditionally.
 */
export function renderStaleNote(aged, grace = STALE_GRACE_MINUTES) {
  const rows = [
    ...aged.expired.map(
      (e) =>
        `        #${e.number}  FAILS — closed ${e.age} minute(s) ago, past the grace`
    ),
    ...aged.absent.map(
      (e) => `        #${e.number}  FAILS — there is no such pull request`
    ),
    ...aged.within.map(
      (e) =>
        `        #${e.number}  does not fail yet — closed ${e.age} minute(s) ago, so the ` +
        `deletion can be landed without reddening the board`
    ),
    ...aged.unaged.map(
      (e) =>
        `        #${e.number}  does not fail on age — ${e.why}, so it cannot be aged`
    ),
  ];
  if (rows.length === 0) return "";
  return (
    `\n      ${rows.length} exemption(s) in KNOWN_UNDECLARED name a pull request that is no ` +
    `longer open, so the list asserts a premise that has expired. Delete the entry — the ` +
    `grace is ${grace} minutes and it is a deadline, not a dismissal:\n` +
    rows.join("\n") +
    `\n`
  );
}

export function ageExemptions(
  stale,
  resolved,
  now = Date.now(),
  grace = STALE_GRACE_MINUTES
) {
  const out = { expired: [], within: [], absent: [], unaged: [] };
  for (const n of stale) {
    const r = resolved?.[n];
    if (r?.absent === true) {
      out.absent.push({ number: n });
      continue;
    }
    const age = closedAgeMinutes(r?.closedAt, now);
    if (age === null)
      out.unaged.push({ number: n, why: r?.why ?? "no closedAt was read" });
    else if (age >= grace) out.expired.push({ number: n, age });
    else out.within.push({ number: n, age });
  }
  return out;
}

/**
 * The union of the pull request body and every commit message. `null` means the API did not
 * answer, which must stay distinguishable from "answered, and there was nothing" — an empty
 * mapping is not an absent input.
 */
export function declarationTexts(detail) {
  if (detail === null || detail === undefined) return null;
  const out = [];
  if (typeof detail.body === "string")
    out.push({ channel: CHANNEL.BODY, text: detail.body });
  for (const c of detail.commits ?? []) {
    if (typeof c?.messageHeadline === "string")
      out.push({ channel: CHANNEL.COMMIT, text: c.messageHeadline });
    if (typeof c?.messageBody === "string")
      out.push({ channel: CHANNEL.COMMIT, text: c.messageBody });
  }
  return out;
}

export function declarationsIn(texts) {
  if (texts === null) return null;
  const found = [];
  const nearMisses = [];
  const unknown = [];
  const seen = new Set();
  for (const { channel, text } of texts) {
    const m = DECLARATION.exec(text ?? "");
    if (m) {
      const identity = identityOf(m.groups.agent);
      if (identity === null) {
        unknown.push(m.groups.agent);
        continue;
      }
      const key = `${identity} ${channel}`;
      if (!seen.has(key)) {
        seen.add(key);
        found.push({ agent: identity, asWritten: m.groups.agent, channel });
      }
      continue;
    }
    const loose = DECLARATION_LOOSE.exec(text ?? "");
    if (loose) nearMisses.push(loose[1].trim());
  }
  return { found, nearMisses, unknown };
}

/**
 * `AGENT (via commit)` / `AGENT (via pull request body)`, and both when both carry it.
 *
 * THE CHANNEL IS RECORDED BECAUSE THE HEADER ARGUES FROM IT. This file's own case for
 * accepting two channels is that a COMMIT TRAILER is written by the author at authoring time
 * while a BODY line is written by whoever opened the pull request — which is #1028 exactly,
 * where those are different agents. An implementation that returned a bare DECLARED would
 * flatten that distinction at the moment it starts to matter: a push-and-raise convention
 * makes body declarations common, and a body line typed by an opener who guessed is worth
 * less than a trailer written by the author, while satisfying an identical check. Found by
 * DEV2 reading #1055.
 *
 * It is not a FINDING for a declaration to arrive by body — the threat model is omission —
 * so this changes what the row SAYS, not whether it passes.
 */
export function describeDeclarations(found) {
  const byAgent = new Map();
  for (const { agent, asWritten, channel } of found ?? []) {
    if (!byAgent.has(agent))
      byAgent.set(agent, { channels: new Set(), written: new Set() });
    byAgent.get(agent).channels.add(channel);
    byAgent.get(agent).written.add(asWritten ?? agent);
  }
  return [...byAgent]
    .map(([agent, { channels, written }]) => {
      // Grouping is by ROSTER IDENTITY, so `DEV3` in a trailer and `DEV3-lang` in the
      // body are one agent rather than two. The forms are still shown when they differ,
      // because collapsing them silently is how a rename stops being visible.
      const forms = [...written]
        .filter((w) => canonicalAgent(w) !== agent)
        .sort();
      const as = forms.length ? ` [written ${forms.join(", ")}]` : "";
      return `${agent}${as} (via ${[...channels].sort().join(" and ")})`;
    })
    .join(", ");
}

export function classify({
  isBot,
  head,
  number,
  declarations,
  known = KNOWN_UNDECLARED,
}) {
  if (isBot) return { state: STATE.BOT, detail: "" };
  if (declarations === null)
    return {
      state: STATE.UNFETCHED,
      detail:
        "`gh pr view --json body,commits` did not answer, so neither its body nor its " +
        "commits were read — a declaration may be sitting on it",
    };
  // Checked BEFORE the DECLARED branch on purpose: a pull request carrying one good
  // declaration and one naming a non-agent is exactly the case a consumer would join
  // wrongly, and letting the good one mask the other is how it stays invisible.
  if ((declarations.unknown ?? []).length > 0)
    return {
      state: STATE.UNKNOWN_AGENT,
      detail:
        `${declarations.unknown
          .map((u) => JSON.stringify(u))
          .join(", ")} — not on the ` +
        `roster (${Object.keys(ROSTER).join(
          ", "
        )}). Either fix the name, or add the agent ` +
        `to ROSTER in this file if it is a real one`,
    };
  if (declarations.found.length > 0)
    return {
      state: STATE.DECLARED,
      detail: describeDeclarations(declarations.found),
    };
  if (declarations.nearMisses.length > 0)
    return {
      state: STATE.UNPARSED,
      detail:
        `${JSON.stringify(
          declarations.nearMisses[0]
        )} — the declaration must be the whole ` +
        `line, bare or wrapped in a symmetric **`,
    };
  const entry = known[number];
  if (entry) {
    if (sameCommit(head, entry.head))
      return { state: STATE.GRANDFATHERED, detail: entry.reason };
    return {
      state: STATE.LAPSED,
      detail:
        `grandfathered at ${entry.head}, now at ${String(head).slice(
          0,
          12
        )}. It has been ` +
        `pushed since, so whoever is working on it can add the line`,
    };
  }
  return { state: STATE.UNDECLARED, detail: "" };
}

/**
 * A pass over a set containing no agent-authored pull request asserts NOTHING about
 * declarations, and must say so rather than reporting a green that reads as coverage. The
 * subject floor is on OPEN pull requests, which this repository never has zero of; the
 * agent-authored count is legitimately zero on a board that is all Dependabot.
 */
export function passLine(agentCount, openCount, grandfathered) {
  const tail = grandfathered
    ? ` ${grandfathered} of them carry no declaration and are grandfathered at the sha they were open at.`
    : "";
  if (agentCount === 0)
    return (
      `none of the ${openCount} open pull request(s) is agent-authored — every one is opened ` +
      `by a bot the API names — so NOTHING was examined for a declaration and this check ` +
      `asserts nothing about them`
    );
  return (
    `${agentCount} agent-authored pull request(s) of ${openCount} open are attributable to ` +
    `whoever wrote them.${tail}`
  );
}

function gh(args) {
  const r = spawnSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

/**
 * Resolves one exemption number to what the API says about it, keeping "no such pull request"
 * distinguishable from "the query failed". `gh()` above cannot do this: it collapses every
 * non-zero exit into `null`, and here the difference decides whether a finding is raised.
 */
function resolveExemption(number) {
  const r = spawnSync("gh", ["api", `repos/{owner}/{repo}/pulls/${number}`], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status === 0) {
    try {
      const d = JSON.parse(r.stdout);
      return {
        closedAt: typeof d.closed_at === "string" ? d.closed_at : null,
        why: "the pull request carries no closed_at",
      };
    } catch {
      return { why: "the API answered with something that is not JSON" };
    }
  }
  return /HTTP 404/.test(String(r.stderr ?? ""))
    ? { absent: true }
    : { why: "the API did not answer" };
}

function main() {
  const open = gh([
    "pr",
    "list",
    "--state",
    "open",
    "--limit",
    "100",
    "--json",
    "number,headRefOid,author",
  ]);
  if (open === null) {
    process.stderr.write(
      "\nCOULD NOT CHECK: `gh pr list` did not answer, so no pull request was examined.\n" +
        "      Exit 2, not 0 — this check read nothing, which is a different answer from\n" +
        "      every open pull request being attributable.\n\n"
    );
    process.exit(2);
  }
  reportSubject(open.length, "open pull request(s)");

  const rows = [];
  for (const p of open) {
    const isBot = p.author?.is_bot === true;
    const detail = isBot
      ? null
      : gh(["pr", "view", String(p.number), "--json", "body,commits"]);
    const declarations = isBot
      ? null
      : declarationsIn(declarationTexts(detail));
    rows.push({
      number: p.number,
      ...classify({
        isBot,
        head: p.headRefOid,
        number: p.number,
        declarations,
      }),
    });
  }

  const agent = rows.filter((r) => r.state !== STATE.BOT);
  const bad = rows.filter((r) => FINDINGS.has(r.state));
  const refused = rows.filter((r) => REFUSALS.has(r.state));
  const grandfathered = rows.filter((r) => r.state === STATE.GRANDFATHERED);
  const stale = staleExemptions(new Set(open.map((p) => p.number)));
  const resolved = Object.fromEntries(
    stale.map((n) => [n, resolveExemption(n)])
  );
  const aged = ageExemptions(stale, resolved);
  const listFindings = aged.expired.length + aged.absent.length;

  const staleNote = renderStaleNote(aged, STALE_GRACE_MINUTES);

  const grandNote = grandfathered.length
    ? `\n      ${grandfathered.length} grandfathered, which does not fail — each lapses the ` +
      `moment it is pushed:\n` +
      grandfathered.map((r) => `        #${r.number}  ${r.detail}`).join("\n") +
      `\n`
    : "";

  if (refused.length) {
    process.stderr.write(
      `\nCOULD NOT CHECK: ${refused.length} of ${agent.length} agent-authored pull request(s) ` +
        `could not be examined at all:\n` +
        refused.map((r) => `  #${r.number}  ${r.detail}`).join("\n") +
        (bad.length
          ? `\n\n      and ${bad.length} carrying no usable declaration:\n` +
            bad
              .map(
                (r) =>
                  `  #${r.number}  ${r.state}${
                    r.detail ? ` — ${r.detail}` : ""
                  }`
              )
              .join("\n")
          : "") +
        grandNote +
        `\n      Exit 2, not 1 — part of the set was never looked at, so neither ` +
        `"attributable"\n      nor a count of failures is a true statement about it.\n\n`
    );
    process.exit(2);
  }

  if (bad.length === 0 && listFindings === 0) {
    process.stdout.write(
      `\nOK: ${passLine(
        agent.length,
        open.length,
        grandfathered.length
      )}\n${staleNote}${grandNote}\n`
    );
    process.exit(0);
  }

  process.stderr.write(
    `\nFAIL: ${bad.length} of ${agent.length} agent-authored pull request(s) cannot be ` +
      `attributed to whoever wrote them:\n` +
      (bad.length
        ? bad
            .map(
              (r) =>
                `  #${r.number}  ${r.state}${r.detail ? ` — ${r.detail}` : ""}`
            )
            .join("\n")
        : `  (none — the ${listFindings} failure(s) below are the exemption list, not a ` +
          `pull request)`) +
      staleNote +
      grandNote +
      `\n      The author clears one by putting  AUTHORING-AGENT: <agent>  on its own line in\n` +
      `      a commit message or the pull request body. It is self-declared and unverifiable\n` +
      `      by design: the failure this closes is nobody being asked, not somebody lying.\n\n`
  );
  process.exit(1);
}

if (invokedAsProgram(import.meta.url)) main();
