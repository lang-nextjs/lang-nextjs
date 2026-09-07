#!/usr/bin/env node
/**
 * EVERY GLYPH THE UI EMITS IS DRAWN BY A FAMILY THE STACK NAMES (#914).
 *
 * #912 pinned `--font-sans` so rendering stopped depending on whichever default tailwindcss
 * shipped. It did not assert the pin still governs what is drawn. If the chain reaches past its
 * last entry, rendering comes from a font nothing pinned and the visual baselines move — the
 * identical symptom to the bug #912 fixed, which took a full investigation to attribute.
 *
 * WHAT THIS DOES NOT ASSERT, AND THE FIRST LIVE RUN IS WHY. An earlier version failed unless
 * EVERY declared family resolved. It went red on ubuntu for `Arial, Helvetica Neue, Helvetica`,
 * which is a fallback chain WORKING AS DESIGNED — those exist on macOS and Windows and are
 * preferred there, and their absence on Linux is precisely what makes the chain reach Liberation
 * Sans. "Every family resolves" is stronger than the property that matters and FALSE BY
 * CONSTRUCTION for any chain worth writing; absence is now reported, never failed.
 *
 * The refutation was in the local run before CI saw it — on macOS this reports Liberation Sans
 * and DejaVu Sans missing — and it was recorded as a fact about the machine rather than as
 * evidence against the assertion.
 *
 * CHECKING ONLY THE FIRST FAMILY WOULD STILL GO GREEN ON THE MACHINE THAT PRODUCED THE BUG, which
 * is why the gate is per codepoint. Measured on ubuntu:24.04 with exactly the font packages
 * `playwright install --with-deps` installs:
 *
 *     Liberation Sans   U+25D0 ◐   COVERED
 *     Liberation Sans   U+2713 ✓   NOT COVERED  -> drawn by DejaVu Sans, FIFTH in the chain
 *
 * CSS font fallback resolves PER CODEPOINT, not once per element. The later entries are
 * load-bearing rather than decorative, and the committed baselines are mixed-font by construction.
 * An instrument that only asked "is the first family present" would answer yes on a tree whose
 * checkmarks had silently moved to another face.
 *
 * ── WHAT THIS DOES NOT COVER, AND IT IS HALF THE STORY ────────────────────────────────────────
 *
 * THIS IS ABOUT THE FONT ASSUMPTION BEING UNPINNED. IT IS NOT ABOUT THE SURFACE BEING WATCHED.
 * A green here says every glyph the cards emit is drawn by a family the CSS names. It says NOTHING about whether a rendering change would be SEEN: the visual job
 * compares four card baselines, so a layout change on a page nobody screenshots is invisible to
 * it whatever this checker reports. #908 and #912 needed BOTH to be wrong at once — an unpinned
 * font AND an unwatched surface — and this closes exactly one of them.
 *
 * Nor does it check that a family renders a glyph WELL. Liberation Sans covers U+25D0 and draws
 * it differently from DejaVu Sans; both are legitimate, and which one reads better as a progress
 * indicator is a design question no `fc-list` query can answer.
 *
 * ── REFUSAL, AND WHY IT REACHES INSIDE THE PARSE ──────────────────────────────────────────────
 *
 * A floor catches "verified nothing" and not "verified fewer" — #923's own floorNote overstated
 * its guard on exactly this, arguing a wording change would drop the claim set to zero when a
 * PARTIAL change drops it from 8 to 7 and sails past a floor of 1.
 *
 * So a token this parser cannot classify is a REFUSAL, never a skip. Skipping one would shrink
 * the subject silently and report PASS over the remainder, which is the same defect one level in.
 * CSS generic keywords are the one thing excluded, and they are excluded BY NAME in the output so
 * the count a reader sees is the count that was checked.
 *
 * Usage: node scripts/assert-font-stack-resolves.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { reportSubject } from "./lib/subject.mjs";
import { invokedAsProgram } from "./lib/is-main.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const STACK_SOURCE = "packages/ui/src/styles/globals.css";

/**
 * CSS generic families. These are not looked up — no font is named "sans-serif" — but they are
 * NAMED in the output rather than dropped, because a silently smaller subject is the failure this
 * file's header is about.
 */
export const CSS_GENERICS = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong",
]);

/**
 * The glyphs the status cards emit, with where they come from. Hardcoded rather than derived,
 * and the proof asserts the sources still emit them — a codepoint list that drifts from the UI
 * would check the wrong characters while reporting the same PASS.
 *
 *   ◐ U+25D0  in-progress   packages/react/src/PlanCard.tsx, TestingCard.tsx
 *   ✓ U+2713  done          same
 *   ○ U+25CB  pending       same
 */
export const UI_CODEPOINTS = [
  { cp: 0x25d0, ch: "◐", role: "in-progress" },
  { cp: 0x2713, ch: "✓", role: "done" },
  { cp: 0x25cb, ch: "○", role: "pending" },
];

class Refusal extends Error {}

/**
 * The declared stack, read WHOLE.
 *
 * DOTALL to the terminator, not a character class to the line end: the value spans lines, and
 * `--font-sans:[^;}]*` returns a truncated list that LOOKS complete — it ends in a comma and
 * nothing else says it was cut. That truncation cost four separate readings during #908,
 * including one that dropped 'Noto Sans' and changed a conclusion.
 */
export function parseFontStack(css) {
  const m = /--font-sans:\s*([^;]*);/s.exec(css);
  if (!m)
    throw new Refusal(
      `no \`--font-sans\` declaration in ${STACK_SOURCE}. The stack this checker exists to ` +
        `verify is not there, so there is nothing to check rather than nothing wrong.`
    );
  const raw = m[1].replace(/\s+/g, " ").trim();
  if (raw === "")
    throw new Refusal(`\`--font-sans\` in ${STACK_SOURCE} is empty.`);

  const families = [];
  const generics = [];
  for (const piece of raw.split(",")) {
    const t = piece.trim();
    if (t === "") continue;
    const quoted = /^"([^"]+)"$/.exec(t) ?? /^'([^']+)'$/.exec(t);
    if (quoted) {
      families.push(quoted[1]);
      continue;
    }
    if (CSS_GENERICS.has(t)) {
      generics.push(t);
      continue;
    }
    // An unquoted bare family name: letters, digits, hyphens, single spaces.
    if (/^[A-Za-z][A-Za-z0-9-]*(?: [A-Za-z0-9-]+)*$/.test(t)) {
      families.push(t);
      continue;
    }
    throw new Refusal(
      `cannot classify \`${t}\` in the --font-sans stack as a family or a CSS generic. ` +
        `Skipping it would check FEWER families while reporting the same PASS, so this refuses ` +
        `rather than narrowing its own subject.`
    );
  }
  if (families.length === 0)
    throw new Refusal(
      `the --font-sans stack names ${generics.length} generic keyword(s) and no concrete ` +
        `family, so there is nothing whose presence could be asserted.`
    );
  return { families, generics, raw };
}

/** Family names fontconfig reports, exactly as written. */
export function familiesFrom(fcListStdout) {
  const out = new Set();
  for (const line of String(fcListStdout).split("\n"))
    for (const fam of line.split(","))
      if (fam.trim() !== "") out.add(fam.trim());
  return out;
}

/**
 * Which family in the stack draws a codepoint — the FIRST present one that covers it, which is
 * how a browser resolves per character.
 */
export function coveringFamily(stack, coverage) {
  for (const fam of stack) if (coverage.get(fam)) return fam;
  return null;
}

function run(args) {
  const r = spawnSync("fc-list", args, { encoding: "utf8" });
  if (r.error)
    throw new Refusal(
      `could not run \`fc-list\`: ${r.error.message}. Without fontconfig this cannot ask which ` +
        `families exist, which is the absence of an answer rather than a finding about them.`
    );
  if (r.status !== 0)
    throw new Refusal(
      `\`fc-list ${args.join(" ")}\` exited ${r.status}: ${(r.stderr || "")
        .trim()
        .slice(0, 200)}`
    );
  return r.stdout ?? "";
}

function main() {
  let parsed, present, coverage;
  try {
    const path = join(ROOT, STACK_SOURCE);
    if (!existsSync(path))
      throw new Refusal(
        `${STACK_SOURCE} does not exist, so no stack could be read.`
      );
    parsed = parseFontStack(readFileSync(path, "utf8"));
    present = familiesFrom(run([":", "family"]));
    coverage = new Map();
    for (const fam of parsed.families)
      for (const { cp } of UI_CODEPOINTS) {
        const hit = run([
          `:charset=${cp.toString(16)}:family=${fam}`,
          "family",
        ]);
        coverage.set(`${fam}\u0000${cp}`, hit.trim() !== "");
      }
  } catch (e) {
    if (e instanceof Refusal) {
      console.error(
        `COULD NOT CHECK: ${e.message}\n\n` +
          `      Exiting 2: the question could not be asked. A font check that cannot tell\n` +
          `      "every family is present" from "I could not look" is green in both cases.`
      );
      process.exit(2);
    }
    throw e;
  }

  const missing = parsed.families.filter((f) => !present.has(f));
  const uncovered = UI_CODEPOINTS.filter(
    ({ cp }) =>
      !parsed.families.some(
        (f) => present.has(f) && coverage.get(`${f}\u0000${cp}`)
      )
  );

  /*
   * THE SUBJECT IS THE CODEPOINTS, BECAUSE THAT IS WHAT IS ASSERTED. It named the families
   * while the gate was "every family resolves"; the gate is now per glyph, and a subject that
   * counts something other than what the check can fail on describes the wrong domain.
   */
  reportSubject(
    UI_CODEPOINTS.length,
    `UI glyph(s) checked against the ${parsed.families.length} famil(ies) ${STACK_SOURCE}'s --font-sans names`
  );

  /*
   * ABSENT FAMILIES ARE REPORTED, NEVER FAILED — and the first live run is what established
   * that. It went red on `Arial, Helvetica Neue, Helvetica` missing from ubuntu, which is A
   * FALLBACK CHAIN WORKING EXACTLY AS DESIGNED: those three exist on macOS and Windows and are
   * preferred there, and their absence on Linux is what makes the chain fall through to
   * Liberation Sans, which is what #912 pinned it to do.
   *
   * So "every declared family resolves" is STRONGER THAN THE PROPERTY THAT MATTERS, and false by
   * construction for any chain worth writing. The evidence was in my own local run before CI
   * ever saw it — on macOS the stack reports Liberation Sans and DejaVu Sans missing — and I
   * recorded that as a fact about the machine rather than as a refutation of the assertion.
   */
  if (missing.length > 0)
    console.log(
      `NOTE: ${missing.length} of ${parsed.families.length} declared famil(ies) are absent here` +
        ` — ${missing.join(", ")}.\n` +
        `      That is what a fallback chain is FOR: each entry covers a platform where it is\n` +
        `      preferred, and absence is how the chain reaches the next one.`
    );

  if (uncovered.length > 0) {
    for (const { ch, cp, role } of uncovered)
      console.error(
        `FAIL: ${ch} (U+${cp
          .toString(16)
          .toUpperCase()}, the ${role} marker) is covered by NO ` +
          `present family in the stack, so it renders from a font the stack does not name.`
      );
    process.exit(1);
  }

  console.log(
    `PASS: every UI glyph is drawn by a family the stack names.\n` +
      `      stack   : ${parsed.raw}\n` +
      `      excluded: ${
        parsed.generics.length === 0
          ? "(no generic keywords)"
          : `${parsed.generics.length} CSS generic(s) — ${parsed.generics.join(
              ", "
            )}`
      }\n` +
      UI_CODEPOINTS.map(({ ch, cp, role }) => {
        const fam = coveringFamily(
          parsed.families.filter((f) => present.has(f)),
          new Map(
            parsed.families.map((f) => [f, coverage.get(`${f}\u0000${cp}`)])
          )
        );
        return `      ${ch} U+${cp
          .toString(16)
          .toUpperCase()} (${role}) drawn by: ${fam}`;
      }).join("\n") +
      `\n\n      NOT COVERED: whether a rendering change would be SEEN. The visual job compares\n` +
      `      four card baselines, so a change on a page nobody screenshots is invisible to it\n` +
      `      whatever this reports.`
  );
}

if (invokedAsProgram(import.meta.url)) main();
