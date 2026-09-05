#!/usr/bin/env node
/**
 * assert-ladder-is-cumulative.mjs — the retain set at rung N is exactly rungs 1..N (#788).
 *
 * THE GUARANTEE THAT WAS STATED NOWHERE. `assert-every-rung-is-witnessed.mjs:9` says it in as
 * many words: "A rung nothing removes has never been shown severable. Today that holds only
 * because the ladder is cumulative, WHICH IS A REAL GUARANTEE STATED NOWHERE." It now has two
 * dependents and neither would go red if it stopped holding:
 *
 *   WITNESSING      every non-base rung must be absent from some retain set, or a cell that
 *                   removes it does not exist and its severability was never shown.
 *   #755's AUDIT    eject-to-langchain is treated as the MAXIMAL strip, so a subject static
 *                   under it is static under every weaker target. That is only true while the
 *                   retain sets nest.
 *
 * WHAT IS ASSERTED, AND WHY IT IS THE CONSEQUENCE RATHER THAN THE CAUSE. `requires` happens to
 * form a chain today — each rung requires exactly its predecessor — and `eject.mjs:372` builds
 * its retain set as the transitive closure of that relation, downward. Asserting "requires is a
 * chain" would check the CAUSE, and would stay green if the closure changed under it. What both
 * dependents actually rely on is the CONSEQUENCE:
 *
 *     closure(requires, N)  ==  { rungs with ordinal <= ordinal(N) }
 *
 * so that is what this checks, for every rung. A future manifest where rung 4 requires
 * `langchain` directly would still be a legal graph and would break this, which is the point:
 * retain(4) would be {1,4}, rungs 2 and 3 would be removed by a cell that claims to retain a
 * superset of them, and both mechanisms above would carry on green.
 *
 * ORDINALS ARE CHECKED FIRST, because "ordinal <= N" is meaningless if they are not 1..N. A
 * manifest whose ordinals are duplicated, gapped or out of array order is a REFUSAL, not a
 * failure: the question this asks cannot be posed against it.
 *
 * WHAT THE eject.mjs GAP IS, AND WHAT IT IS NOT — narrowed by DEV3-lang, who is the dependent
 * and so is the one entitled to say. This asserts a property of the MANIFEST, and eject reads
 * the SAME manifest and computes the SAME closure (:373). So if the manifest's closure is
 * {ordinal <= N}, eject's retain set is {ordinal <= N}: the disclaimer is about the ALGORITHM,
 * not about the data, and a reader who takes it as wider than that will build something to
 * close a gap that is already narrow.
 *
 * What is genuinely left is smaller and is worth naming: TWO IMPLEMENTATIONS OF ONE RULE WITH
 * NOTHING ASSERTING THEY AGREE. A manifest change cannot break it — this catches those. A
 * change to eject's ALGORITHM can, and asserting that needs eject to expose its retain set.
 *
 * NOT CHECKED, named so a green is not read as more than it is:
 *   - that the `owns` sets are disjoint between rungs. A file owned by two rungs survives an
 *     eject that should have removed it, which is a real defect and a different one.
 *
 * Exit 0 property holds · 1 violated · 2 could not ask.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { invokedAsProgram } from "./lib/is-main.mjs";
import { reportSubject } from "./lib/subject.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Rungs reachable downward from `id` through `requires` — eject.mjs:372's rule. */
export function retainSet(rungs, id) {
  const byId = new Map(rungs.map((r) => [r.id, r]));
  const seen = new Set();
  (function visit(cur) {
    if (seen.has(cur)) return;
    seen.add(cur);
    (byId.get(cur)?.requires ?? []).forEach(visit);
  })(id);
  return seen;
}

/**
 * null if every `requires` names a rung that exists, else which one does not.
 *
 * WHY THIS IS A REFUSAL AND NOT A FAILURE (found by DEV3-lang). `retainSet` reaches an unknown
 * id through `?.` and contributes nothing for it, so a manifest saying `requires: ["langchian"]`
 * produces retain(3) = {3} — which is not {ordinal <= 3}, so the cumulativity check FAILS, and
 * fails with a true sentence about the wrong cause: it reports a ladder that is not cumulative
 * when the defect is a misspelled id. eject.mjs:377 has no `?.` and throws a bare TypeError on
 * the same manifest. Both notice; neither says what is wrong.
 *
 * The `?.` is doing real work — it converts a crash into a wrong-shaped answer — so the repair
 * is not to remove it but to ask this question FIRST, which is the same could-not-ask versus
 * violated split the ordinal check already makes, one field over.
 */
export function danglingComplaint(rungs) {
  const ids = new Set(rungs.map((r) => r.id));
  for (const r of rungs)
    for (const need of r.requires ?? [])
      if (!ids.has(need))
        return (
          `rung "${r.id}" requires "${need}", which is not a rung in this manifest. ` +
          `A dangling reference makes every retain set below it wrong, and "the ladder is ` +
          `not cumulative" would be a true sentence about the wrong cause.`
        );
  return null;
}

/** null if the ordinals can carry the question, else why they cannot. */
export function ordinalComplaint(rungs) {
  if (rungs.length === 0) return "the manifest declares no rungs";
  const ords = rungs.map((r) => r.ordinal);
  if (ords.some((o) => !Number.isInteger(o)))
    return `every rung needs an integer ordinal; got ${JSON.stringify(ords)}`;
  const want = rungs.map((_, i) => i + 1);
  if (ords.join(",") !== want.join(","))
    return (
      `ordinals must be 1..${rungs.length} in array order, and are ` +
      `${ords.join(",")}. "the rungs below N" has no meaning otherwise.`
    );
  return null;
}

/** One entry per rung whose retain set is not its ordinal prefix. */
export function violations(rungs) {
  const out = [];
  for (const r of rungs) {
    const got = retainSet(rungs, r.id);
    const want = new Set(
      rungs.filter((x) => x.ordinal <= r.ordinal).map((x) => x.id)
    );
    const missing = [...want].filter((id) => !got.has(id));
    const extra = [...got].filter((id) => !want.has(id));
    if (missing.length || extra.length)
      out.push({ id: r.id, ordinal: r.ordinal, missing, extra });
  }
  return out;
}

function main() {
  let rungs;
  try {
    rungs = JSON.parse(readFileSync(join(ROOT, "rungs.json"), "utf8")).rungs;
  } catch (e) {
    console.error(
      `COULD NOT COMPUTE: rungs.json is unreadable — ${e.message}\n` +
        `      This asks a question about the manifest; with no manifest there is nothing\n` +
        `      to ask it of, which is not the same as the property holding.`
    );
    process.exit(2);
  }
  const why = ordinalComplaint(rungs ?? []);
  if (why) {
    console.error(`COULD NOT COMPUTE: ${why}`);
    process.exit(2);
  }

  const dangling = danglingComplaint(rungs);
  if (dangling) {
    console.error(`COULD NOT COMPUTE: ${dangling}`);
    process.exit(2);
  }

  const bad = violations(rungs);
  if (bad.length) {
    console.error(
      `THE LADDER IS NOT CUMULATIVE, so eject's retain set is not "everything below".\n`
    );
    for (const b of bad) {
      console.error(`  · ${b.id} (ordinal ${b.ordinal})`);
      if (b.missing.length)
        console.error(
          `      retains NEITHER of: ${b.missing.join(
            ", "
          )} — a rung below it that`
        );
      if (b.extra.length)
        console.error(`      retains ABOVE itself: ${b.extra.join(", ")}`);
    }
    console.error(
      `\n  Two mechanisms assume this and neither would have failed:\n` +
        `  assert-every-rung-is-witnessed (a rung nothing removes is never shown severable)\n` +
        `  and #755's audit (eject-to-rung-1 treated as the maximal strip).\n`
    );
    process.exit(1);
  }

  reportSubject(rungs.length, "rung(s) whose retain set was recomputed");
  console.log(
    `PASS: every rung's retain set is exactly the rungs at or below its ordinal, so\n` +
      `      "eject <N> keeps 1..N" is a fact rather than a coincidence of today's manifest.`
  );
}

if (invokedAsProgram(import.meta.url)) main();
