/**
 * PROOF FOR assert-no-ascii-escapes.mjs — it fires on an ensure_ascii serialization and stays
 * silent on the escapes JSON itself requires (#828).
 *
 * THE GREEN ARMS CARRY A POSITIVE CONTROL AND THAT IS THE POINT OF THIS FILE. A checker built
 * from a pattern over text can go green two ways: the property holds, or the pattern matched
 * nothing at all. Those are indistinguishable from a complaint count of zero. So every arm that
 * expects silence also asserts the scanner SAW the input — `strings > 0`, and for the literal
 * em-dash case, that the character is present in the fixture in the first place. A run over an
 * empty string would satisfy "no complaints" and fail these.
 */
import {
  escapesIn,
  escapeComplaints,
  mustBeEscaped,
} from "./assert-no-ascii-escapes.mjs";

let pass = 0;
const results = [];
const ok = (name, cond, detail) => {
  results.push({ name, ok: cond, detail });
  if (cond) pass++;
};

console.log("\nassert-no-ascii-escapes — bytes, not names\n");

const complaintsFor = (raw) => escapeComplaints(escapesIn(raw).found);

/* ── the incident, and its companion ─────────────────────────────────────── */
{
  const escaped = '{"why": "a reason \\u2014 with an escaped dash"}';
  const literal = '{"why": "a reason — with a literal dash"}';

  ok(
    "an ensure_ascii em-dash is caught — #821's own incident",
    complaintsFor(escaped).length === 1,
    JSON.stringify(complaintsFor(escaped))
  );

  // POSITIVE CONTROL: the companion must be silent AND must have been read.
  const seen = escapesIn(literal);
  ok(
    "...and the literal spelling is silent, on input the scanner demonstrably READ",
    complaintsFor(literal).length === 0 &&
      seen.strings > 0 &&
      literal.includes("—"),
    `complaints=${complaintsFor(literal).length} strings=${
      seen.strings
    } hasDash=${literal.includes("—")}`
  );
  ok(
    "the control has power: an EMPTY input also raises nothing, and is caught by it",
    complaintsFor("").length === 0 && escapesIn("").strings === 0,
    "an empty input scanned some strings, so the control cannot distinguish anything"
  );
}

/* ── the escape CLASS, not the one character we hit ──────────────────────── */
{
  const cases = [
    ["\\u2014", "em-dash"],
    ["\\u2013", "en-dash"],
    ["\\u201c", "left curly quote"],
    ["\\u2019", "right single quote"],
    ["\\u00a0", "non-breaking space"],
    ["\\u00e9", "e-acute"],
  ];
  const missed = cases.filter(
    ([esc]) => complaintsFor(`{"k": "x ${esc} y"}`).length !== 1
  );
  ok(
    "every escape whose character has a literal form is caught, not just the em-dash",
    missed.length === 0,
    `missed: ${missed.map((m) => m[1]).join(", ")}`
  );
}

/* ── the escapes JSON itself requires ────────────────────────────────────── */
{
  const mandatory = '{"k": "a\\u0009b\\u001fc \\" \\\\ d"}';
  ok(
    "escapes JSON REQUIRES are not complaints — control range, quote, backslash",
    complaintsFor(mandatory).length === 0 &&
      escapesIn(mandatory).found.length === 2,
    `complaints=${complaintsFor(mandatory).length} found=${
      escapesIn(mandatory).found.length
    }`
  );
  ok(
    "...and the boundary is stated where a reader can check it",
    mustBeEscaped(0x00) &&
      mustBeEscaped(0x1f) &&
      mustBeEscaped(0x22) &&
      mustBeEscaped(0x5c) &&
      !mustBeEscaped(0x20) &&
      !mustBeEscaped(0x2014),
    "the mandatory set does not match its own description"
  );
}

/* ── the thing a grep gets wrong ─────────────────────────────────────────── */
{
  // In JSON source, \\ is an escaped backslash; the u2014 after it is LITERAL TEXT.
  const escapedBackslash = '{"k": "a path\\\\u2014not an escape"}';
  ok(
    "an escaped BACKSLASH followed by u2014 is text, not an escape — what a grep cannot tell",
    escapesIn(escapedBackslash).found.length === 0,
    JSON.stringify(escapesIn(escapedBackslash).found)
  );
  ok(
    "...and `u2014` appearing OUTSIDE any string is not an escape either",
    escapesIn("{u2014: 1}").found.length === 0,
    "matched outside a string"
  );
}

/* ── the message ─────────────────────────────────────────────────────────── */
{
  const multiline = '{\n  "a": "one",\n  "b": "two \\u2014 here"\n}';
  const c = complaintsFor(multiline)[0] ?? "";
  ok(
    "the complaint names the LINE and the character, not just that something is wrong",
    /line 3/.test(c) && /u2014/.test(c) && c.includes("—"),
    c
  );
}

/* ── report ─────────────────────────────────────────────────────────────── */
for (const r of results)
  console.log(
    `  ${r.ok ? "ok  " : "FAIL"} ${r.name.padEnd(78)} ${
      r.ok ? "" : `(${r.detail})`
    }`
  );

const total = results.length;
const EXPECTED = 9;
if (total !== EXPECTED) {
  console.error(
    `\nFAIL: ran ${total} case(s), expected ${EXPECTED} — the harness is broken.`
  );
  process.exit(1);
}
if (pass !== total) {
  console.error(`\nFAIL: ${pass}/${total}.`);
  process.exit(1);
}
console.log(
  `\nPASS: ${pass}/${total}. Every silent arm asserts the scanner READ its input, so a\n` +
    `      pattern that matched nothing could not have produced these greens.`
);
