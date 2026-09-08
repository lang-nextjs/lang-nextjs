#!/usr/bin/env node
/**
 * PROOF FOR assert-pr-authorship-is-attributable.mjs (#1052).
 *
 * The arm that matters most is the `Co-Authored-By:` one. `AUTHORED-BY` — the obvious name
 * for this line — is a SUBSTRING of a trailer this repository mandates on every commit, and
 * a case-insensitive search for it returned three false positives on the day this was
 * written, one of them mine. The pattern must reject that trailer and accept a real
 * declaration, and an arm asserting only the first half would pass against a pattern that
 * matches nothing at all.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  DECLARATION,
  DECLARATION_LOOSE,
  KNOWN_UNDECLARED,
  STATE,
  REFUSALS,
  FINDINGS,
  classify,
  declarationTexts,
  declarationsIn,
  passLine,
  sameCommit,
  staleExemptions,
  closedAgeMinutes,
  ageExemptions,
  renderStaleNote,
  STALE_GRACE_MINUTES,
  CHANNEL,
  describeDeclarations,
  canonicalAgent,
  ROSTER,
  identityOf,
} from "./assert-pr-authorship-is-attributable.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const results = [];
const ok = (name, cond) => results.push({ ok: !!cond, name });

const decl = (texts) =>
  declarationsIn(texts.map((t) => ({ channel: CHANNEL.COMMIT, text: t })));
const declBody = (texts) =>
  declarationsIn(texts.map((t) => ({ channel: CHANNEL.BODY, text: t })));
const TRAILER = "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>";

/* ---- the naming decision, which is the whole reason this token is not AUTHORED-BY ------ */

ok(
  "the MANDATED Co-Authored-By trailer is NOT read as a declaration - strict form",
  DECLARATION.test(TRAILER) === false
);

ok(
  "...nor by the LOOSE form, which is what catches near-misses and could have caught this",
  DECLARATION_LOOSE.test(TRAILER) === false
);

ok(
  "PAIRED CONTROL: the same pattern DOES accept a real declaration, so the two arms above " +
    "are not a pattern that matches nothing",
  (() => {
    const m = DECLARATION.exec("AUTHORING-AGENT: DEV2");
    return m !== null && m.groups.agent === "DEV2";
  })()
);

ok(
  "a commit body carrying BOTH the trailer and a declaration yields the declaration only",
  (() => {
    const r = decl([`some message\n\nAUTHORING-AGENT: DEV1\n${TRAILER}`]);
    return (
      r.found.length === 1 &&
      r.found[0].agent === "DEV1" &&
      r.nearMisses.length === 0
    );
  })()
);

/* ---- token discipline, matching READER-REPORT ------------------------------------------ */

ok(
  "symmetric ** is accepted",
  DECLARATION.exec("**AUTHORING-AGENT: DEV3**")?.groups.agent === "DEV3"
);

ok(
  "UNBALANCED ** is refused by the strict form and caught by the loose one, so it is a " +
    "FINDING rather than an absence",
  DECLARATION.test("**AUTHORING-AGENT: DEV3") === false &&
    DECLARATION_LOOSE.test("**AUTHORING-AGENT: DEV3") === true
);

ok(
  "an INDENTED declaration is refused strictly and caught loosely",
  DECLARATION.test("   AUTHORING-AGENT: DEV3") === false &&
    DECLARATION_LOOSE.test("   AUTHORING-AGENT: DEV3") === true
);

/* ---- absent input is not empty input --------------------------------------------------- */

ok(
  "declarationTexts(null) is null - the API not answering must stay distinguishable from " +
    "it answering with nothing",
  declarationTexts(null) === null && declarationsIn(null) === null
);

ok(
  "a pull request with a body and no commits yields an ARRAY, not null",
  (() => {
    const t = declarationTexts({ body: "hello", commits: [] });
    return (
      Array.isArray(t) &&
      t.length === 1 &&
      t[0].channel === CHANNEL.BODY &&
      t[0].text === "hello"
    );
  })()
);

/* ---- the states, driven ---------------------------------------------------------------- */

ok(
  "a bot-opened pull request is attributable WITHOUT a declaration - the API names it",
  classify({ isBot: true, head: "aaa", number: 1, declarations: null })
    .state === STATE.BOT
);

ok(
  "a declaration in the body clears it, and the state names the agent",
  (() => {
    const r = classify({
      isBot: false,
      head: "aaa",
      number: 1,
      declarations: decl(["AUTHORING-AGENT: DEV2"]),
    });
    return r.state === STATE.DECLARED && /^DEV2 \(via /.test(r.detail);
  })()
);

ok(
  "a declaration in a COMMIT clears it - the channel #1028 needed, where the opener is not " +
    "the author",
  classify({
    isBot: false,
    head: "aaa",
    number: 1,
    declarations: decl([
      "a body with no line",
      "feat: x",
      "AUTHORING-AGENT: DEV1",
    ]),
  }).state === STATE.DECLARED
);

ok(
  "no declaration and not grandfathered is the FINDING",
  classify({
    isBot: false,
    head: "aaa",
    number: 99999,
    declarations: decl(["nothing here"]),
  }).state === STATE.UNDECLARED
);

ok(
  "a near-miss is UNPARSED, not UNDECLARED - a malformed line is louder than a missing one",
  (() => {
    const r = classify({
      isBot: false,
      head: "aaa",
      number: 99999,
      declarations: decl(["  AUTHORING-AGENT: DEV2"]),
    });
    return r.state === STATE.UNPARSED && /whole\s+line/.test(r.detail);
  })()
);

ok(
  "an unfetchable pull request is a REFUSAL, not a finding",
  classify({ isBot: false, head: "aaa", number: 1, declarations: null })
    .state === STATE.UNFETCHED
);

/* ---- the transition, and the property that makes it self-draining ---------------------- */

/*
 * THE TRANSITION COMPLETED. `KNOWN_UNDECLARED` IS EMPTY.
 *
 * Every pull request open on this board is now attributable by declaration or by the forge,
 * which is the state the list existed to reach. #1011's entry went when it closed. #1028's went
 * when its author was established and wrote the line into the pull request BODY — the body
 * deliberately, because the exemption was pinned to a sha and any push would have lapsed it.
 *
 * THE GUARD THAT ANNOUNCED THIS IS GONE, WITH ITS OWN TWO ARMS AND `fixtureFrom`, `PINNED`,
 * `PINNED_HEAD`, `PINNED_N` and `ALL_EXEMPT_OPEN`. It was built to fire exactly once, on the
 * emptying, and to name the repair. It fired; this is the repair; a guard whose condition is
 * permanently discharged is furniture. Its fixtures derived FROM the live roster, which is the
 * coupling everything below now drops.
 *
 * ITS REPAIR LIST TOLD ME TO DELETE MORE THAN WAS NECESSARY, AND FOLLOWING IT WOULD HAVE
 * REGRESSED DEV2's FIX. It named "the grandfathered/lapsed pair" and "the two staleExemptions
 * arms" as having no subject once no exemption exists. They do. `classify` and
 * `staleExemptions` BOTH ALREADY TAKE THE ROSTER AS A PARAMETER — `known = KNOWN_UNDECLARED` is
 * a DEFAULT, not a dependency, and those arms merely used it. Passing `SYNTHETIC` keeps the
 * exemption MECHANISM proven while the LIST is empty, which matters because the mechanism is
 * still wired into production and the list can repopulate on any day.
 *
 * THE GENERAL FORM, WHICH IS WORTH MORE THAN THIS INSTANCE. When live data an arm was built on
 * empties, the arm has two possible relationships to it, and they need OPPOSITE repairs:
 *
 *     the arm is ABOUT the data          it is dead        delete it
 *     the arm is about a MECHANISM
 *     that merely READ the data          it needs a fixture, not a funeral
 *
 * A repair list written before the emptying cannot tell those apart, because at the time it was
 * written both looked like "depends on the roster". Re-derive the relationship at the moment of
 * the deletion rather than trusting the note left for you — including this one.
 */
const SYNTHETIC = Object.freeze({
  4242: Object.freeze({
    head: "abcdef1234567890abcdef1234567890abcdef12",
    reason:
      "A FIXTURE, NOT AN EXEMPTION. #4242 does not exist. This roster is passed EXPLICITLY to " +
      "the arms below so the exemption machinery stays proven while the real list is empty",
  }),
});
const SYN_N = 4242;
const SYN_HEAD = SYNTHETIC[SYN_N].head;

/* The two shape predicates, as functions of a roster, so a PAIRED CONTROL can drive them. */
const entriesWellFormed = (known) =>
  Object.values(known).every(
    (e) =>
      typeof e.reason === "string" &&
      e.reason.length > 40 &&
      /^[0-9a-f]{7,40}$/.test(e.head)
  );
const entriesFrozen = (known) =>
  Object.values(known).every((e) => Object.isFrozen(e));

ok(
  "THE REAL ROSTER IS EMPTY — the exemption programme having succeeded, asserted rather than " +
    "left in a comment, so that repopulating it is a decision taken against a failing test",
  Object.keys(KNOWN_UNDECLARED).length === 0
);

ok(
  "a grandfathered pull request AT ITS RECORDED HEAD passes",
  classify({
    isBot: false,
    head: SYN_HEAD,
    number: SYN_N,
    declarations: decl(["no line"]),
    known: SYNTHETIC,
  }).state === STATE.GRANDFATHERED
);

ok(
  "THE SAME pull request PUSHED lapses into a finding - the exemption is pinned to a sha, " +
    "so it expires by the event that makes the repair possible",
  (() => {
    const r = classify({
      isBot: false,
      head: "deadbeef1234",
      number: SYN_N,
      declarations: decl(["no line"]),
      known: SYNTHETIC,
    });
    return r.state === STATE.LAPSED && /pushed since/.test(r.detail);
  })()
);

ok(
  "PAIRED CONTROL: against the REAL empty roster that same pull request is an ordinary " +
    "FINDING, so the two arms above are satisfied by the exemption applying and not by " +
    "`classify` being lenient about an undeclared pull request",
  classify({
    isBot: false,
    head: SYN_HEAD,
    number: SYN_N,
    declarations: decl(["no line"]),
    known: KNOWN_UNDECLARED,
  }).state === STATE.UNDECLARED
);

ok(
  "a grandfathered head matches on PREFIX, so a 12-char record and a 40-char head agree",
  sameCommit("c6ccb180ca27f00dbaadf00dbaadf00dbaadf00d", "c6ccb180ca27") &&
    !sameCommit("c6ccb180ca27", "c6ccb180ca28")
);

ok(
  "every KNOWN_UNDECLARED entry carries a REASON, not just a sha",
  entriesWellFormed(KNOWN_UNDECLARED)
);

ok(
  "PAIRED CONTROL, BECAUSE THE ARM ABOVE IS NOW VACUOUS ON ITS OWN. `[].every()` is true, so " +
    "over an empty roster it passes while asserting nothing — the exact shape this file treats " +
    "as worse than breaking. Driven, the predicate is shown to REJECT a bare sha, a reason too " +
    "short to be a reason, and a head that is not hex, and to ACCEPT a well-formed entry",
  !entriesWellFormed({ 1: { head: "abcdef1" } }) &&
    !entriesWellFormed({ 1: { head: "abcdef1", reason: "too short" } }) &&
    !entriesWellFormed({ 1: { head: "zzzz", reason: "x".repeat(41) } }) &&
    entriesWellFormed(SYNTHETIC)
);

ok(
  "KNOWN_UNDECLARED is frozen, so widening it is an edit a reviewer sees",
  Object.isFrozen(KNOWN_UNDECLARED) && entriesFrozen(KNOWN_UNDECLARED)
);

ok(
  "PAIRED CONTROL for the same reason: the per-entry half of the arm above is vacuous over an " +
    "empty roster, and the container half is not — driven, an unfrozen entry is rejected",
  !entriesFrozen({ 1: { head: "abcdef1" } }) && entriesFrozen(SYNTHETIC)
);

/* ---- the exemption list cannot rot quietly --------------------------------------------- */

ok(
  "an exemption whose pull request is still open is NOT stale",
  staleExemptions(new Set([SYN_N, 4243]), SYNTHETIC).length === 0
);

ok(
  "an exemption whose pull request is no longer open IS named, so the list has a repair " +
    "rather than a slow drift",
  (() => {
    const s = staleExemptions(new Set([4243]), SYNTHETIC);
    return s.length === 1 && s[0] === SYN_N;
  })()
);

ok(
  "PAIRED CONTROL: an EMPTY roster yields nothing stale however the open set is shaped, which " +
    "is the degenerate reading the two arms above would otherwise have collapsed into",
  staleExemptions(new Set([]), KNOWN_UNDECLARED).length === 0 &&
    staleExemptions(new Set([1, 2, 3]), KNOWN_UNDECLARED).length === 0
);

ok(
  "REGRESSION: #989 is absent. The first draft grandfathered it and it MERGED before this " +
    "file was finished — a list written from a measurement taken minutes earlier was already " +
    "wrong, which is why staleness is checked every run rather than remembered",
  !Object.prototype.hasOwnProperty.call(KNOWN_UNDECLARED, "989")
);

/* ---- the channel is recorded, because the header argues from it (DEV2, reading #1055) --- */

ok(
  "a COMMIT declaration says so, so a trailer written by the author is distinguishable",
  /\(via commit\)/.test(
    classify({
      isBot: false,
      head: "aaa",
      number: 1,
      declarations: decl(["AUTHORING-AGENT: DEV1"]),
    }).detail
  )
);

ok(
  "a BODY declaration says so - #1028 is the case where the opener is not the author, and a " +
    "body line typed by a guessing opener must not read identically to the author's trailer",
  /\(via pull request body\)/.test(
    classify({
      isBot: false,
      head: "aaa",
      number: 1,
      declarations: declBody(["AUTHORING-AGENT: DEV1"]),
    }).detail
  )
);

ok(
  "both channels carrying it are reported as both, not collapsed to one",
  (() => {
    const d = declarationsIn([
      { channel: CHANNEL.BODY, text: "AUTHORING-AGENT: DEV1" },
      { channel: CHANNEL.COMMIT, text: "AUTHORING-AGENT: DEV1" },
    ]);
    const s = describeDeclarations(d.found);
    return (
      /commit/.test(s) && /pull request body/.test(s) && d.found.length === 2
    );
  })()
);

ok(
  "the same agent on the same channel twice is reported once - two commits both carrying the " +
    "trailer is one declaration, not two",
  (() => {
    const d = declarationsIn([
      { channel: CHANNEL.COMMIT, text: "AUTHORING-AGENT: DEV1" },
      { channel: CHANNEL.COMMIT, text: "AUTHORING-AGENT: DEV1" },
    ]);
    return (
      d.found.length === 1 &&
      describeDeclarations(d.found) === "DEV1 (via commit)"
    );
  })()
);

/* ---- the captured name must be comparable (DEV3 + TEAMLEAD, reading #1055) ------------- */

ok(
  "a TRAILING-only ** is refused - it was absorbed by the greedy \\S+ and captured as part " +
    "of the agent, producing a name no consumer can compare",
  DECLARATION.test("AUTHORING-AGENT: DEV3**") === false &&
    DECLARATION_LOOSE.test("AUTHORING-AGENT: DEV3**") === true
);

ok(
  "a LEADING ** on the agent itself is refused too",
  DECLARATION.test("AUTHORING-AGENT: **DEV3") === false
);

ok(
  "the SYMMETRIC wrapped form still parses, and the agent excludes the closing pair",
  DECLARATION.exec("**AUTHORING-AGENT: DEV3**")?.groups.agent === "DEV3"
);

ok(
  "canonicalAgent normalises CASE, which is mechanical...",
  canonicalAgent("dev3") === canonicalAgent("DEV3")
);

ok(
  "...and does NOT invent a roster mapping: DEV3 and DEV3-lang stay distinct, because " +
    "resolving a rename is #1058's job and this file has no instrument for it",
  canonicalAgent("DEV3") !== canonicalAgent("DEV3-lang")
);

ok(
  "REGRESSION: the checker source contains NO raw NUL byte. One shipped here, and it made " +
    "`grep -I` skip the file silently - in the one file whose purpose is to be found and read",
  (() => {
    const src = readFileSync(
      join(HERE, "assert-pr-authorship-is-attributable.mjs"),
      "latin1"
    );
    return !src.includes("\u0000");
  })()
);

/* ---- vacuity ---------------------------------------------------------------------------- */

ok(
  "a board with NO agent-authored pull request says it asserts nothing, rather than " +
    "reporting a green that reads as coverage",
  /asserts nothing/.test(passLine(0, 8, 0))
);

ok(
  "a non-empty agent set reports both counts",
  (() => {
    const s = passLine(3, 11, 0);
    return (
      /3 agent-authored/.test(s) &&
      /11 open/.test(s) &&
      !/asserts nothing/.test(s)
    );
  })()
);

ok(
  "grandfathered pull requests are named in the pass line rather than hidden by it",
  /grandfathered/.test(passLine(3, 11, 2))
);

/* ---- the vocabulary is total and disjoint ---------------------------------------------- */

ok(
  "REFUSALS and FINDINGS are disjoint",
  [...REFUSALS].every((s) => !FINDINGS.has(s))
);

ok(
  "every declared STATE is classified - no state falls through as an accidental pass",
  (() => {
    const passing = new Set([STATE.BOT, STATE.DECLARED, STATE.GRANDFATHERED]);
    return Object.values(STATE).every(
      (s) => FINDINGS.has(s) || REFUSALS.has(s) || passing.has(s)
    );
  })()
);

/* ---- CONTROL: the real script, on the real board ---------------------------------------- */

ok(
  "CONTROL: the checker RUNS against this repository and answers in its own vocabulary",
  (() => {
    const r = spawnSync(
      process.execPath,
      [join(HERE, "assert-pr-authorship-is-attributable.mjs")],
      { encoding: "utf8" }
    );
    if (![0, 1, 2].includes(r.status)) return false;
    // Exit 2 is legitimate here (no `gh` credential in some environments) and is the one
    // outcome that examines nothing, so it must not be read as agreement.
    if (r.status === 2) return /COULD NOT CHECK/.test(r.stderr);
    return /open pull request/.test(r.stdout + r.stderr);
  })()
);

/* ---- the agent is a POSITIVE class; two negative ones failed first (DEV3, #1055) -------- */

ok(
  "every markdown-decorated form DEV3 produced is refused by the strict pattern AND caught by " +
    "the loose one, so each is a FINDING rather than a silent mis-parse",
  ["_DEV3_", "`DEV3`", "DEV3.", "[DEV3](x)", "DEV3**", "**DEV3"].every((n) => {
    const line = `AUTHORING-AGENT: ${n}`;
    return (
      DECLARATION.test(line) === false && DECLARATION_LOOSE.test(line) === true
    );
  })
);

ok(
  "PAIRED CONTROL: the forms that SHOULD parse still do, so the class did not simply reject " +
    "everything",
  DECLARATION.exec("AUTHORING-AGENT: DEV3")?.groups.agent === "DEV3" &&
    DECLARATION.exec("AUTHORING-AGENT: DEV3-lang")?.groups.agent ===
      "DEV3-lang" &&
    DECLARATION.exec("**AUTHORING-AGENT: TEAMLEAD**")?.groups.agent ===
      "TEAMLEAD"
);

ok(
  "a captured name contains ONLY letters, digits and hyphens — the property a consumer needs, " +
    "stated as an invariant rather than as a list of rejected punctuation",
  ["DEV3", "DEV3-lang", "ARCHITECT", "PRODUCT"].every((n) => {
    const m = DECLARATION.exec(`AUTHORING-AGENT: ${n}`);
    return m !== null && /^[A-Za-z][A-Za-z0-9-]*$/.test(m.groups.agent);
  })
);

/* ---- retiring an exemption (#1052 follow-up) ------------------------------------------- */
/*
 * THE DEADLOCK THESE ARMS EXIST FOR. Before the grace, every route from "entry present, pull
 * request open" to "entry gone, pull request closed" passed through a failing state, and the
 * failure is global: `pnpm checks` runs inside a REQUIRED context, so closing an exempted pull
 * request reddened every open pull request on the board until the deletion merged.
 *
 * The arm that could be faked is the first. "Nothing within the grace fails" is satisfied by a
 * function that never fails anything, so the expiry arm below it is not a second case — it is
 * the control that makes the first one mean something.
 */
const T0 = Date.parse("2026-09-08T12:00:00Z");
const at = (minsAgo) => new Date(T0 - minsAgo * 60000).toISOString();

ok(
  "an age is minutes since closedAt",
  closedAgeMinutes(at(90), T0) === 90 && closedAgeMinutes(at(0), T0) === 0
);

ok(
  "a FUTURE-dated closedAt is null rather than negative — a negative age would silently satisfy " +
    "'younger than the grace' and dismiss the finding on a broken clock",
  closedAgeMinutes(new Date(T0 + 60000).toISOString(), T0) === null
);

ok(
  "an unusable closedAt is null, and null is not zero",
  closedAgeMinutes("not a date", T0) === null &&
    closedAgeMinutes(null, T0) === null &&
    closedAgeMinutes(undefined, T0) === null &&
    closedAgeMinutes(12345, T0) === null
);

ok(
  "an entry closed INSIDE the grace does not fail — this is the deadlock fix: the deletion can " +
    "be landed without reddening a board that cannot fix the list",
  (() => {
    const a = ageExemptions([1011], { 1011: { closedAt: at(5) } }, T0);
    return (
      a.within.length === 1 &&
      a.within[0].number === 1011 &&
      a.expired.length === 0 &&
      a.absent.length === 0
    );
  })()
);

ok(
  "THE CONTROL for the arm above: an entry closed PAST the grace still fails, so the grace is a " +
    "deadline rather than a dismissal",
  (() => {
    const a = ageExemptions(
      [1011],
      { 1011: { closedAt: at(STALE_GRACE_MINUTES + 1) } },
      T0
    );
    return a.expired.length === 1 && a.within.length === 0;
  })()
);

ok(
  "the boundary belongs to the failing side: exactly the grace has elapsed, so it fails",
  ageExemptions([7], { 7: { closedAt: at(STALE_GRACE_MINUTES) } }, T0).expired
    .length === 1
);

ok(
  "a number that is NO pull request fails at once — no grace can apply to something that was " +
    "never opened, which is what stops the grace swallowing a typo'd entry",
  (() => {
    const a = ageExemptions([99999], { 99999: { absent: true } }, T0);
    return (
      a.absent.length === 1 && a.within.length === 0 && a.unaged.length === 0
    );
  })()
);

ok(
  "a query that DID NOT ANSWER is not the same as a pull request that is not there: it fails " +
    "nothing, and it lands in a different bucket from `absent`",
  (() => {
    const a = ageExemptions(
      [42],
      { 42: { why: "the API did not answer" } },
      T0
    );
    return (
      a.unaged.length === 1 && a.absent.length === 0 && a.expired.length === 0
    );
  })()
);

ok(
  "the grace exceeds the slowest open-to-merge yet measured on this board (272 minutes, from " +
    "the 25 most recently merged pull requests sampled 2026-09-08), so the merge step alone " +
    "cannot exhaust it",
  STALE_GRACE_MINUTES > 272
);

ok(
  "the stale note is WIRED ONTO THE PASS PATH, read from the checker's own bytes — a grace that " +
    "silenced the note would convert visible debt into invisible debt, which is worse than the " +
    "red it replaces",
  readFileSync(
    join(HERE, "assert-pr-authorship-is-attributable.mjs"),
    "utf8"
  ).includes("${staleNote}${grandNote}")
);

/*
 * WIRING AND CONTENT ARE DIFFERENT CLAIMS. The arm above reads the checker's own bytes and
 * proves the note is REFERENCED on the exit-0 path. DEV1 showed that is not enough: replacing
 * the note's body with `"\n"` leaves the reference intact and the suite green, while the thing
 * a human reads says nothing. These assert what it SAYS.
 */
ok(
  "the stale note names the pull request, its age and the grace — a note that went blank cannot " +
    "pass as wired",
  (() => {
    const note = renderStaleNote(
      ageExemptions([1011], { 1011: { closedAt: at(5) } }, T0),
      STALE_GRACE_MINUTES
    );
    return (
      note.includes("#1011") &&
      note.includes("does not fail yet") &&
      note.includes("closed 5 minute(s) ago") &&
      note.includes(String(STALE_GRACE_MINUTES)) &&
      note.includes("Delete the entry")
    );
  })()
);

ok(
  "a failing entry reads as FAILING in the text, so the two outcomes are distinguishable to a " +
    "human and not only in the exit code",
  (() => {
    const note = renderStaleNote(
      ageExemptions([7], { 7: { absent: true } }, T0)
    );
    return (
      note.includes("#7") &&
      note.includes("FAILS") &&
      note.includes("no such pull request")
    );
  })()
);

ok(
  "nothing stale renders the empty string, so callers can interpolate it unconditionally",
  renderStaleNote(ageExemptions([], {}, T0)) === ""
);

/*
 * THE HARNESS THE ARMS BELOW STILL NEED, restored after my own edit took it by accident.
 * Deleting the three process arms meant deleting a SPAN, and the span contained these two
 * declarations sitting between the comment that opened it and the arms that closed it.
 * `minutesAgo` went with them and stays gone — nothing left can age an exemption — but these
 * two are still used, and losing them was not a decision.
 *
 * Recorded rather than quietly fixed, because the failure mode is general: a deletion specified
 * by its ENDPOINTS takes whatever lies between them, and what lies between is not necessarily
 * what the endpoints are named after. Node named it immediately, which is the only reason this
 * paragraph is about a near miss rather than a defect.
 */
function runCheckerWithStubbedGh(openPrs, closedAt) {
  const dir = mkdtempSync(join(tmpdir(), "authorship-gate-"));
  const stub = join(dir, "gh");
  writeFileSync(
    stub,
    `#!/usr/bin/env node
const a = process.argv.slice(2);
const openPrs = ${JSON.stringify(JSON.stringify(openPrs))};
const closedAt = ${JSON.stringify(closedAt)};
if (a[0] === "pr" && a[1] === "list") { process.stdout.write(openPrs); process.exit(0); }
// A REAL AGENT NAME, NOT "STUB" (DEV2, #1090). The roster is being closed, and a
// checker that accepts test-only names loses the ability to reject a wrong one --
// which is the entire point of closing it. It also makes the stub more faithful:
// the thing it stands in for always names a real agent.
if (a[0] === "pr" && a[1] === "view") {
  process.stdout.write(JSON.stringify({ body: "AUTHORING-AGENT: ARCHITECT", commits: [] }));
  process.exit(0);
}
if (a[0] === "api") { process.stdout.write(JSON.stringify({ closed_at: closedAt })); process.exit(0); }
process.stderr.write("stub gh: unexpected invocation: " + a.join(" ") + "\\n");
process.exit(9);
`
  );
  chmodSync(stub, 0o755);
  const r = spawnSync(
    process.execPath,
    [join(HERE, "assert-pr-authorship-is-attributable.mjs")],
    {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    }
  );
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/* One declared pull request, so nothing else fails and the note is the only thing under test. */
const DECLARED_ONLY = [
  { number: 9001, headRefOid: "aaaaaaaaaaaa", author: { is_bot: false } },
];

/* ---- what the PROCESS prints, not what a function returns -------------------------------- */
/*
 * DEV2's FINDING, KEPT BECAUSE IT IS WHY THE BLOCK BELOW IS SHAPED AS IT IS. They showed that
 * the wiring arm and the content arms TOGETHER still leave the call site unpinned, and closed it
 * with three arms that ran the checker as a process against a stale exemption.
 *
 * Those arms are gone. Not because the finding stopped being true — it is still exactly true —
 * but because emptying `KNOWN_UNDECLARED` removed the only input that could reach them. The
 * comment below says what that cost and what stands in their place.
 */
/*
 * WHAT EMPTYING THE ROSTER COST, STATED PLAINLY RATHER THAN ABSORBED.
 *
 * Three arms here ran the real checker as a process with a stubbed `gh` and asserted that the
 * stale note REACHES STDOUT. They are gone, because none of them can compute: a stale exemption
 * requires an exemption, and there are none. That is not a tidy-up. DEV2 added them to close a
 * gap they had measured, and the gap comes back:
 *
 *     the wiring arm     the SOURCE interpolates ${staleNote}       still pinned, below
 *     the content arms   renderStaleNote() returns the right text   still pinned, above
 *     the CALL SITE      const staleNote = renderStaleNote(...)     was pinned ONLY by those three
 *
 * Replacing the call site with `""` leaves `renderStaleNote` untouched and both surviving halves
 * green while the process prints nothing to a reader. THAT IS A LIVE HOLE, not a hypothetical —
 * it is the precise mutation DEV2 demonstrated.
 *
 * I DID NOT ADD A TESTING SEAM, AND THE REASON IS NOT COST. A seam that lets a caller inject
 * exemptions into THIS checker is a seam that lets a caller exempt any pull request from
 * authorship attribution. The one place that must not become injectable is the list of things
 * the gate agrees not to look at. A hole in the tests is recoverable; a hole in the gate is the
 * thing the gate exists to prevent.
 *
 * SO THE CALL SITE IS PINNED BY BYTES INSTEAD, AND THAT IS A DOWNGRADE. A source-shape assertion
 * cannot tell a live call from a dead one and breaks on an innocent rename. It closes the exact
 * mutation named above and nothing more. It is what is available while the roster is empty, and
 * it should be replaced by the process arms the moment an exemption exists again — which is why
 * the deleted arms are described here in enough detail to rebuild them rather than merely
 * mourned.
 */
/*
 * A PREDICATE OVER A SOURCE, NOT OVER THE SOURCE — the same move the exemption arms above make,
 * for the same reason. My first draft built the control by mutating the real file's bytes, so
 * when the call site was actually missing the control could not construct its fixture and failed
 * beside the arm it was supposed to be independent of. A control whose fixture comes from the
 * thing under test is not a control.
 */
const callSiteIsWired = (src) =>
  src.includes("const staleNote = renderStaleNote(") &&
  src.includes("${staleNote}${grandNote}");

ok(
  "THE CALL SITE IS WIRED: the checker ASSIGNS renderStaleNote's result to the identifier it " +
    "interpolates. Bytes, not behaviour — see above for why, and for what this does not catch",
  callSiteIsWired(
    readFileSync(join(HERE, "assert-pr-authorship-is-attributable.mjs"), "utf8")
  )
);

ok(
  "PAIRED CONTROL over LITERAL sources, so it computes whatever the real file says: the " +
    "predicate accepts a wired source, and rejects both halves of the failure — the call site " +
    "replaced by an empty string, and the note assigned but never interpolated",
  callSiteIsWired(
    "const staleNote = renderStaleNote(a);\n`${staleNote}${grandNote}`"
  ) &&
    !callSiteIsWired('const staleNote = "";\n`${staleNote}${grandNote}`') &&
    !callSiteIsWired(
      "const staleNote = renderStaleNote(a);\n`only the grand note`"
    )
);

/*
 * THE PROCESS PATH ITSELF IS STILL DRIVEN, so `runCheckerWithStubbedGh` does not rot unused
 * while the roster is empty. This asserts far less than the three arms it stands beside — it
 * reaches stdout but never reaches the note — and it is here so that the spawn, the stub and the
 * exit code stay exercised and the arms above can be restored without first repairing the
 * harness they depend on.
 */
ok(
  "the checker RUN AS A PROCESS over a declared-only board exits 0 and says so on stdout",
  (() => {
    const { code, out } = runCheckerWithStubbedGh(DECLARED_ONLY, null);
    return code === 0 && /attributable to whoever wrote them/.test(out);
  })()
);

/* ---- the roster, which is what makes a declared name comparable (#1058) ----------------- */

ok("identityOf resolves the unsuffixed form", identityOf("DEV3") === "DEV3");

ok(
  "identityOf resolves the -lang form to THE SAME identity — the DEV3 / DEV3-lang collision",
  identityOf("DEV3-lang") === identityOf("DEV3")
);

ok(
  "identityOf is case-insensitive, since canonicalAgent upper-cases",
  identityOf("dev3-LANG") === "DEV3"
);

ok(
  "identityOf returns null for a plausible non-agent rather than inventing an identity",
  identityOf("Claude") === null &&
    identityOf("jobordu") === null &&
    identityOf("DEV9") === null
);

ok(
  "EVERY roster alias is upper-case — a lower-case one could never match and would be dead",
  Object.values(ROSTER).every((aliases) =>
    aliases.every((a) => a === a.toUpperCase())
  )
);

ok(
  "every identity is an alias of itself, so the canonical name always resolves",
  Object.entries(ROSTER).every(([identity, aliases]) =>
    aliases.includes(identity)
  )
);

ok(
  "MEASURED ON origin/main: every declaration form that actually occurs resolves to an " +
    "identity — the roster is closed, but not closed tighter than reality",
  ["ARCHITECT", "DEV3", "DEV2"].every(
    (observed) => identityOf(observed) !== null
  )
);

ok(
  "two channels naming the same agent in DIFFERENT forms are ONE agent, not two",
  (() => {
    const d = declarationsIn([
      { channel: CHANNEL.COMMIT, text: "AUTHORING-AGENT: DEV3" },
      { channel: CHANNEL.BODY, text: "AUTHORING-AGENT: DEV3-lang" },
    ]);
    return (
      d.found.length === 2 && new Set(d.found.map((f) => f.agent)).size === 1
    );
  })()
);

ok(
  "and describeDeclarations reports that as one agent via both channels",
  (() => {
    const d = declarationsIn([
      { channel: CHANNEL.COMMIT, text: "AUTHORING-AGENT: DEV3" },
      { channel: CHANNEL.BODY, text: "AUTHORING-AGENT: DEV3-lang" },
    ]);
    const line = describeDeclarations(d.found);
    return (
      line.startsWith("DEV3") &&
      line.includes("commit and pull request body") &&
      !line.includes(",")
    );
  })()
);

ok(
  "a form that differs from the identity is still SHOWN, so a rename stays visible",
  describeDeclarations([
    { agent: "DEV3", asWritten: "DEV3-lang", channel: CHANNEL.BODY },
  ]).includes("[written DEV3-lang]")
);

ok(
  "and no bracket is added when the written form IS the identity",
  !describeDeclarations([
    { agent: "DEV3", asWritten: "DEV3", channel: CHANNEL.BODY },
  ]).includes("[written")
);

ok(
  "an unknown name lands in the unknown list, NOT in found — it must not read as an attribution",
  (() => {
    const d = declarationsIn([
      { channel: CHANNEL.BODY, text: "AUTHORING-AGENT: Claude" },
    ]);
    return (
      d.found.length === 0 &&
      d.unknown.length === 1 &&
      d.unknown[0] === "Claude"
    );
  })()
);

ok(
  "classify reports UNKNOWN_AGENT and names the roster in the repair",
  (() => {
    const r = classify({
      isBot: false,
      head: "abc",
      number: 1,
      declarations: declarationsIn([
        { channel: CHANNEL.BODY, text: "AUTHORING-AGENT: Claude" },
      ]),
    });
    return (
      r.state === STATE.UNKNOWN_AGENT &&
      r.detail.includes("ARCHITECT") &&
      r.detail.includes("add the agent")
    );
  })()
);

ok(
  "UNKNOWN_AGENT is a FINDING and not a REFUSAL — the name is computed, not unreadable",
  FINDINGS.has(STATE.UNKNOWN_AGENT) && !REFUSALS.has(STATE.UNKNOWN_AGENT)
);

ok(
  "A VALID DECLARATION DOES NOT MASK AN UNKNOWN ONE ALONGSIDE IT",
  (() => {
    const r = classify({
      isBot: false,
      head: "abc",
      number: 1,
      declarations: declarationsIn([
        { channel: CHANNEL.COMMIT, text: "AUTHORING-AGENT: DEV2" },
        { channel: CHANNEL.BODY, text: "AUTHORING-AGENT: Claude" },
      ]),
    });
    return r.state === STATE.UNKNOWN_AGENT;
  })()
);

ok(
  "THE ROSTER IS UNIFORM — every identity carries exactly its own name and the -LANG form. " +
    "The first draft gave the suffix to four agents and withheld it from ARCHITECT and PRODUCT, " +
    "which is a FALSE UNKNOWN_AGENT waiting for the day either uses the form 5 files already " +
    "use for them. A per-agent judgement call is the thing this arm forecloses",
  Object.entries(ROSTER).every(
    ([identity, aliases]) =>
      aliases.length === 2 &&
      aliases[0] === identity &&
      aliases[1] === `${identity}-LANG`
  )
);

ok(
  "the SAME unknown name on two channels is reported ONCE — found dedups through `seen` and " +
    "unknown did not, which is this file's own subject one `continue` from where it was fixed",
  (() => {
    const d = declarationsIn([
      { channel: CHANNEL.COMMIT, text: "AUTHORING-AGENT: FOO" },
      { channel: CHANNEL.BODY, text: "AUTHORING-AGENT: FOO" },
    ]);
    return d.unknown.length === 1 && d.unknown[0] === "FOO";
  })()
);

ok(
  "and two SPELLINGS of one unknown name are one mistake, not two — deduped on the canonical " +
    "form, exactly as a declared name is",
  (() => {
    const d = declarationsIn([
      { channel: CHANNEL.COMMIT, text: "AUTHORING-AGENT: FOO" },
      { channel: CHANNEL.BODY, text: "AUTHORING-AGENT: foo" },
    ]);
    return d.unknown.length === 1;
  })()
);

const pass = results.filter((r) => r.ok).length;
for (const r of results)
  process.stdout.write(`  ${r.ok ? "ok  " : "FAIL"}  ${r.name}\n`);
const EXPECTED = 81; // 58 at the base + 18 from #1090's roster work + 3 from #1093
// + 2 net from #1100: SIX retired with the exemption list (the empty-roster guard, its two
// fixtureFrom arms, and the three process arms that needed a stale exemption to compute),
// EIGHT added (the roster-is-empty assertion, and paired controls for classify, the two
// shape predicates, staleExemptions, and the call site now pinned by bytes).
const code = pass === results.length ? 0 : 1;
process.stdout.write(`\n  ${pass}/${results.length} passed\n`);
if (code === 0 && results.length !== EXPECTED) {
  process.stderr.write(
    `\nFAIL: ran ${results.length}, expected ${EXPECTED} — a case was added or lost.\n`
  );
  process.exit(1);
}
process.exit(code);
