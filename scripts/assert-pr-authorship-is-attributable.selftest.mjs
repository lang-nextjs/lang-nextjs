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
 * DERIVED, BECAUSE A FIXTURE MUST NOT PIN THE THING THAT IS MEANT TO DISAPPEAR.
 *
 * Retiring #1011's entry broke three arms that named it. The entry's whole PURPOSE is to be
 * retired, so those arms depended on the feature never being used as intended — correct,
 * specific and passing at every moment before the single event they were built to support.
 *
 * The remaining entry is next to go, and one arm below degrades WORSE than breaking: an
 * "expected nothing stale" assertion over an EMPTY roster passes while asserting nothing at
 * all. Loud breakage is recoverable; a silent pass is what this file exists to prevent.
 */
/*
 * A FUNCTION OF A ROSTER, NOT OF THE ROSTER — so the empty case can be DRIVEN.
 *
 * The guard below fires only when KNOWN_UNDECLARED empties, which nothing currently produces.
 * Left as a read of the real roster it would be untested by construction: a check whose
 * triggering condition is the feature succeeding, which is the very shape this file spent two
 * commits removing from its fixtures. Moving the mortality problem outward is not closing it.
 *
 * Taking the roster as an ARGUMENT costs nothing and makes the predicate falsifiable today —
 * two arms below drive it empty and populated, so the guard's logic is proven even though the
 * state that fires it does not exist yet.
 */
const fixtureFrom = (known) => {
  const [number, entry] = Object.entries(known ?? {})[0] ?? [];
  return {
    n: Number(number ?? -1),
    head: entry?.head ?? "",
    usable: number !== undefined && typeof entry?.head === "string",
  };
};
const PINNED = fixtureFrom(KNOWN_UNDECLARED);
const ALL_EXEMPT_OPEN = new Set(Object.keys(KNOWN_UNDECLARED).map(Number));

/*
 * FALLBACKS SO AN EMPTY ROSTER FAILS RATHER THAN CRASHES, measured rather than assumed: with the
 * roster emptied, `PINNED_HEAD` threw a TypeError at import time and the harness printed
 * NOTHING — so the guard arm below, whose entire job is to name that situation, never reached a
 * reader. A guard that cannot report is not a guard.
 *
 * With these, the same mutation leaves every dependent arm RED and the guard's sentence among the
 * failures, which is the difference between a stack trace and a diagnosis.
 */
const PINNED_HEAD = PINNED.head;
const PINNED_N = PINNED.n;

ok(
  "THE GUARD'S OWN PREDICATE IS DRIVEN, not merely read off the live roster — an empty roster " +
    "yields no usable fixture, which is the state the guard exists to announce and which " +
    "production cannot currently produce",
  fixtureFrom({}).usable === false && fixtureFrom(undefined).usable === false
);

ok(
  "PAIRED CONTROL: a populated roster DOES yield one, so the arm above is not satisfied by a " +
    "predicate that calls everything unusable",
  (() => {
    const f = fixtureFrom({ 4242: { head: "abcdef123456" } });
    return f.usable === true && f.n === 4242 && f.head === "abcdef123456";
  })()
);

ok(
  "KNOWN_UNDECLARED IS EMPTY, AND THAT IS THE EXEMPTION PROGRAMME SUCCEEDING, NOT A REGRESSION. " +
    "THE REPAIR: delete this arm and the exemption arms that depend on it — the grandfathered/" +
    "lapsed pair, the two staleExemptions arms, and the three stdout arms. They have no subject " +
    "once no exemption exists, and nothing they assert is lost, because there is nothing left to " +
    "exempt. Keep the grace-period and closedAgeMinutes arms; those are about the mechanism and " +
    "stand on their own. AND DO NOT SIMPLY DELETE WHAT IS RED: the paired control `with the " +
    "same exemptions still OPEN nothing stale is printed` will PASS on an empty roster, because " +
    "its fixture degenerates to the declared-only case and it then asserts that nothing stale " +
    "is printed when nothing can be stale. It goes GREEN while asserting nothing, which this " +
    "file treats as worse than breaking — delete it too",
  PINNED.usable
);

ok(
  "a grandfathered pull request AT ITS RECORDED HEAD passes",
  classify({
    isBot: false,
    head: PINNED_HEAD,
    number: PINNED_N,
    declarations: decl(["no line"]),
  }).state === STATE.GRANDFATHERED
);

ok(
  "THE SAME pull request PUSHED lapses into a finding - the exemption is pinned to a sha, " +
    "so it expires by the event that makes the repair possible",
  (() => {
    const r = classify({
      isBot: false,
      head: "deadbeef1234",
      number: PINNED_N,
      declarations: decl(["no line"]),
    });
    return r.state === STATE.LAPSED && /pushed since/.test(r.detail);
  })()
);

ok(
  "a grandfathered head matches on PREFIX, so a 12-char record and a 40-char head agree",
  sameCommit("c6ccb180ca27f00dbaadf00dbaadf00dbaadf00d", "c6ccb180ca27") &&
    !sameCommit("c6ccb180ca27", "c6ccb180ca28")
);

ok(
  "every KNOWN_UNDECLARED entry carries a REASON, not just a sha",
  Object.values(KNOWN_UNDECLARED).every(
    (e) =>
      typeof e.reason === "string" &&
      e.reason.length > 40 &&
      /^[0-9a-f]{7,40}$/.test(e.head)
  )
);

ok(
  "KNOWN_UNDECLARED is frozen, so widening it is an edit a reviewer sees",
  Object.isFrozen(KNOWN_UNDECLARED) &&
    Object.values(KNOWN_UNDECLARED).every((e) => Object.isFrozen(e))
);

/* ---- the exemption list cannot rot quietly --------------------------------------------- */

ok(
  "an exemption whose pull request is still open is NOT stale",
  ALL_EXEMPT_OPEN.size > 0 &&
    staleExemptions(new Set([...ALL_EXEMPT_OPEN, 4242])).length === 0
);

ok(
  "an exemption whose pull request is no longer open IS named, so the list has a repair " +
    "rather than a slow drift",
  (() => {
    const stillOpen = new Set(
      [...ALL_EXEMPT_OPEN].filter((n) => n !== PINNED_N)
    );
    const s = staleExemptions(stillOpen);
    return s.length === 1 && s[0] === PINNED_N;
  })()
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

/* ---- what the PROCESS prints, not what a function returns -------------------------------- */
/*
 * DEV2 CLOSED THE GAP THE ARMS ABOVE LEAVE OPEN, and the gap is worth stating because it is the
 * same defect as the one they were written to fix, moved one level:
 *
 *     the wiring arm     the SOURCE interpolates ${staleNote}       pinned
 *     the content arms   renderStaleNote() returns the right text   pinned
 *     the CALL SITE      const staleNote = renderStaleNote(...)     PINNED BY NEITHER
 *
 * Replacing the call site with `"\n"` leaves `renderStaleNote` untouched and both halves green
 * while the process prints nothing. The claim is about what a READER IS TOLD, so the subject has
 * to be stdout.
 *
 * These run the real checker as a process with a stubbed `gh` on PATH — both call sites reach it
 * through `spawnSync("gh", ...)`, so nothing in the checker needs a testing seam. A function
 * nobody calls cannot satisfy them, and neither can a correct function called nowhere.
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
/*
 * DERIVED FROM THE LIST, NOT COPIED FROM IT. These arms hardcoded #1011 and broke the moment its
 * entry was retired — which is the entry's whole purpose, so the arms were pinned to something
 * designed to disappear. Reading the roster means they now survive the next retirement, and they
 * assert the BEHAVIOUR (an exemption is named, and its repair is printed) rather than a number.
 */
const EXEMPT_NUMBERS = Object.keys(KNOWN_UNDECLARED).map(Number);
const AN_EXEMPT = EXEMPT_NUMBERS[0];

/*
 * AND IF THE LIST EMPTIES, SAY SO RATHER THAN SEARCHING FOR `#undefined`. The three arms below
 * are about what the note DOES with an exemption; with none they cannot compute, and a check
 * that cannot compute must announce that rather than fail obscurely or quietly pass.
 */
/* The exemptions still OPEN at the heads they are pinned to, so they are grandfathered. */
const EXEMPTIONS_STILL_OPEN = [
  ...DECLARED_ONLY,
  ...Object.entries(KNOWN_UNDECLARED).map(([number, e]) => ({
    number: Number(number),
    headRefOid: e.head,
    author: { is_bot: false },
  })),
];
const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString();

ok(
  "the stale note REACHES STDOUT — the checker run as a process, with its exemptions closed " +
    "inside the grace, actually tells a reader which entry to delete",
  (() => {
    const { code, out } = runCheckerWithStubbedGh(DECLARED_ONLY, minutesAgo(5));
    return (
      code === 0 &&
      out.includes(`#${AN_EXEMPT}`) &&
      out.includes("does not fail yet") &&
      out.includes("Delete the entry")
    );
  })()
);

ok(
  "PAIRED CONTROL: with the same exemptions still OPEN nothing stale is printed, so the arm " +
    "above is not satisfied by a checker that prints the note unconditionally",
  (() => {
    const { code, out } = runCheckerWithStubbedGh(
      EXEMPTIONS_STILL_OPEN,
      minutesAgo(5)
    );
    return code === 0 && !out.includes("Delete the entry");
  })()
);

ok(
  "past the grace the process EXITS 1 and says FAILS, so the failing path is printed too and " +
    "not only returned",
  (() => {
    const { code, out } = runCheckerWithStubbedGh(
      DECLARED_ONLY,
      minutesAgo(STALE_GRACE_MINUTES + 60)
    );
    return code === 1 && out.includes(`#${AN_EXEMPT}`) && out.includes("FAILS");
  })()
);

const pass = results.filter((r) => r.ok).length;
for (const r of results)
  process.stdout.write(`  ${r.ok ? "ok  " : "FAIL"}  ${r.name}\n`);
const EXPECTED = 61;
const code = pass === results.length ? 0 : 1;
process.stdout.write(`\n  ${pass}/${results.length} passed\n`);
if (code === 0 && results.length !== EXPECTED) {
  process.stderr.write(
    `\nFAIL: ran ${results.length}, expected ${EXPECTED} — a case was added or lost.\n`
  );
  process.exit(1);
}
process.exit(code);
