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
import { readFileSync } from "node:fs";
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

ok(
  "a grandfathered pull request AT ITS RECORDED HEAD passes",
  classify({
    isBot: false,
    head: "c6ccb180ca27",
    number: 1028,
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
      number: 1028,
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
  staleExemptions(new Set([1011, 1028, 4242])).length === 0
);

ok(
  "an exemption whose pull request is no longer open IS named, so the list has a repair " +
    "rather than a slow drift",
  (() => {
    const s = staleExemptions(new Set([1011]));
    return s.length === 1 && s[0] === 1028;
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

const pass = results.filter((r) => r.ok).length;
for (const r of results)
  process.stdout.write(`  ${r.ok ? "ok  " : "FAIL"}  ${r.name}\n`);
const EXPECTED = 39;
const code = pass === results.length ? 0 : 1;
process.stdout.write(`\n  ${pass}/${results.length} passed\n`);
if (code === 0 && results.length !== EXPECTED) {
  process.stderr.write(
    `\nFAIL: ran ${results.length}, expected ${EXPECTED} — a case was added or lost.\n`
  );
  process.exit(1);
}
process.exit(code);
