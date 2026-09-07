#!/usr/bin/env node
/**
 * PROOF for assert-font-stack-resolves.mjs (#914).
 *
 * DRIVEN WITH INJECTED DATA, NOT THE MACHINE'S FONTS. The checker's answer depends on what is
 * installed where it runs — on a developer Mac the pinned stack genuinely does not resolve — so a
 * proof that ran `fc-list` would pass or fail for reasons that have nothing to do with the code.
 * Every case below feeds the pure functions.
 *
 * THE LOAD-BEARING CASE IS THE REFUSAL ON AN UNCLASSIFIABLE TOKEN. Skipping one would check FEWER
 * families and report the same PASS — the shape #923's floorNote got wrong, where a floor was
 * argued to catch a change that would in fact only shrink the claim set rather than empty it. A
 * checker that narrows its own subject silently is worse than one that refuses.
 *
 * Usage: node scripts/assert-font-stack-resolves.selftest.mjs
 */
import {
  parseFontStack,
  familiesFrom,
  coveringFamily,
  UI_CODEPOINTS,
  STACK_SOURCE,
} from "./assert-font-stack-resolves.mjs";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0,
  fail = 0;
const ok = (label, cond, got) => {
  if (cond) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label} — got ${JSON.stringify(got)}`);
  }
};
const refuses = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

/* ── parsing the stack ─────────────────────────────────────────────────────── */

/*
 * THE VALUE SPANS LINES AND THAT IS THE POINT. A `[^;}]*` read returns a truncated list ending in
 * a comma, which looks complete — four separate readings were lost to exactly that during #908,
 * one of which dropped a family and changed a conclusion.
 */
const MULTILINE = `@theme {
  --font-sans:
    "Liberation Sans", Arial, "Helvetica Neue", Helvetica, "DejaVu Sans",
    sans-serif;
}`;

ok(
  "a value spanning lines is read WHOLE, so the last family is not lost",
  (() => {
    const p = parseFontStack(MULTILINE);
    return (
      p.families.length === 5 &&
      p.families[0] === "Liberation Sans" &&
      p.families[4] === "DejaVu Sans"
    );
  })(),
  parseFontStack(MULTILINE).families
);

ok(
  "...and the generic keyword is EXCLUDED BY NAME rather than dropped",
  (() => {
    const p = parseFontStack(MULTILINE);
    return p.generics.length === 1 && p.generics[0] === "sans-serif";
  })(),
  parseFontStack(MULTILINE).generics
);

ok(
  "an unquoted bare family is a family, not a generic",
  parseFontStack(`--font-sans: Arial, sans-serif;`).families.join() === "Arial",
  parseFontStack(`--font-sans: Arial, sans-serif;`)
);

/*
 * THE REFUSALS. Each is a case where a lesser checker would carry on over a smaller subject.
 */
ok(
  "a token that is neither a family nor a generic REFUSES — it does not skip",
  refuses(() =>
    parseFontStack(`--font-sans: "Liberation Sans", var(--x), sans-serif;`)
  ),
  "did not refuse"
);

ok(
  "...and the refusal says WHY skipping would be wrong",
  (() => {
    try {
      parseFontStack(`--font-sans: "A", var(--x);`);
      return false;
    } catch (e) {
      return /FEWER families/.test(e.message);
    }
  })(),
  "message did not name the shrinking subject"
);

ok(
  "a stack of ONLY generics refuses — nothing's presence could be asserted",
  refuses(() => parseFontStack(`--font-sans: sans-serif;`)),
  "did not refuse"
);

ok(
  "no --font-sans at all refuses rather than passing over an empty stack",
  refuses(() => parseFontStack(`:root { --color: red; }`)),
  "did not refuse"
);

/* ── fc-list output ────────────────────────────────────────────────────────── */

ok(
  "families are split on commas and trimmed, so a multi-name line yields each",
  (() => {
    const s = familiesFrom(
      "Liberation Sans,Liberation Sans Narrow\nDejaVu Sans\n"
    );
    return s.has("Liberation Sans") && s.has("DejaVu Sans") && s.size === 3;
  })(),
  [...familiesFrom("Liberation Sans,Liberation Sans Narrow\nDejaVu Sans\n")]
);

ok(
  "COMPANION: an empty fc-list output yields no families rather than throwing",
  familiesFrom("").size === 0,
  [...familiesFrom("")]
);

/* ── per-codepoint attribution ─────────────────────────────────────────────── */

/*
 * CSS FALLBACK RESOLVES PER CHARACTER, so the family that draws a glyph is the FIRST present one
 * that covers it — not the first in the list. Measured on ubuntu: Liberation Sans covers U+25D0
 * and NOT U+2713, so ✓ is drawn by DejaVu Sans, fifth in the chain. A checker that stopped at the
 * first family would report the wrong face for that glyph.
 */
ok(
  "the covering family is the first PRESENT one that has the glyph, not the first declared",
  coveringFamily(
    ["Liberation Sans", "Arial", "DejaVu Sans"],
    new Map([
      ["Liberation Sans", false],
      ["Arial", false],
      ["DejaVu Sans", true],
    ])
  ) === "DejaVu Sans",
  "wrong family attributed"
);

ok(
  "...and a glyph no family covers attributes to nothing rather than to the first",
  coveringFamily(
    ["Liberation Sans", "Arial"],
    new Map([
      ["Liberation Sans", false],
      ["Arial", false],
    ])
  ) === null,
  "attributed a family that does not cover it"
);

/* ── the real tree ─────────────────────────────────────────────────────────── */

/*
 * DOMAIN ASSERTIONS. Every case above runs on fixtures and would pass over a repo with no pinned
 * stack and no status cards. These two say the subject exists.
 */
ok(
  "the REAL stylesheet declares a stack this checker has something to check",
  (() => {
    const p = parseFontStack(readFileSync(join(ROOT, STACK_SOURCE), "utf8"));
    return p.families.length >= 2;
  })(),
  parseFontStack(readFileSync(join(ROOT, STACK_SOURCE), "utf8")).families
);

/*
 * THE CODEPOINT LIST IS HARDCODED, so it can drift from the UI while reporting the same PASS —
 * checking characters nothing renders. This asserts the cards still emit each one.
 */
ok(
  "every hardcoded UI codepoint is still emitted by the status cards",
  (() => {
    const src = ["PlanCard", "TestingCard"]
      .map((f) =>
        readFileSync(join(ROOT, "packages/react/src", `${f}.tsx`), "utf8")
      )
      .join("\n");
    return UI_CODEPOINTS.every(({ ch }) => src.includes(`"${ch}"`));
  })(),
  UI_CODEPOINTS.filter(({ ch }) => {
    const src = ["PlanCard", "TestingCard"]
      .map((f) =>
        readFileSync(join(ROOT, "packages/react/src", `${f}.tsx`), "utf8")
      )
      .join("\n");
    return !src.includes(`"${ch}"`);
  }).map((c) => c.ch)
);

const EXPECTED = 13;
/* THE COUNT GUARD RUNS AT EXIT (#836), so a case appended below it is still counted. */
process.on("exit", (code) => {
  const ran = pass + fail;
  if (code === 0 && ran !== EXPECTED) {
    console.log(
      `\nFAIL: ran ${ran} assertions, expected ${EXPECTED} — a case was added or lost.`
    );
    process.exitCode = 1;
  }
});
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
