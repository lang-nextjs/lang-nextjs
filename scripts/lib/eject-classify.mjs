/**
 * WHAT AN EJECT DOES TO A CHECKER'S SUBJECT — #741's RED 3, as a classification (#755).
 *
 * #741 makes a passing checker declare how much it examined, and refuses a pass
 * under a declared floor. That catches a checker examining NOTHING. It cannot
 * catch a checker that PRINTS `SUBJECT: 41` having examined none, because the
 * parent holds a number the child produced and a number is not evidence of the
 * work behind it. From the ruling: the parent cannot check arithmetic, but it
 * can check that the arithmetic RESPONDS.
 *
 * So: eject a rung and see whether the subject moves.
 *
 * FOUR OUTCOMES, NOT TWO, AND THE FOURTH WAS MEASURED RATHER THAN DESIGNED.
 * DEV1-lang found the third; the fourth came out of a control run that was only
 * meant to validate the third:
 *
 *   moved       the subject changed. The count responds to the tree — the
 *               property RED 3 asks for.
 *   static-under-eject-langchain
 *               the subject did not change. Either the domain genuinely does not
 *               vary by rung, or the number is printed rather than computed. The
 *               census cannot tell those apart, so a `static` carries a NOTE.
 *   absent      the checker REFUSED in the ejected tree (exit 2). It could not
 *               ask its question, which is not a statement about its subject.
 *   broken      the checker FAILED in the ejected tree (exit 1) while passing on
 *               the full tree. Ejection broke it. It emits no usable subject, and
 *               calling that `absent` would say "could not ask" about a tree that
 *               answered loudly and wrongly.
 *
 * MEASURED AT 383f7dbf, both readings pinned to ONE sha: 8 broken, 8 absent.
 * `broken` is a real population, not an artefact bucket — which is why it exists.
 *
 * AND `no-baseline` IS THE REFUSAL, NOT A FIFTH CLASSIFICATION. If the FULL tree
 * cannot produce a subject for a checker, there is nothing for the ejected
 * reading to be compared against, and recording an outcome would be inventing
 * one. `readme-quickstart` failed on BOTH trees in that run — an unbuilt tree,
 * not an eject finding — and only the full-tree control could say so.
 *
 * NO AGGREGATE IS COMPUTED, DELIBERATELY. An aggregate inherits its noisiest
 * component's variance: DEV1-lang's power analysis found a 12-step sum had a
 * minimum detectable shift of 128% while its component of interest had 4.5%. The
 * per-checker classification IS the finding. A summary line here — "N of 47
 * moved" — would be dominated by whichever checker has the widest natural range
 * and would hide a real change in a small-subject one. Do not add one.
 */

/**
 * THE VERDICT NAMES ITS TARGET, and that is not pedantry.
 *
 * `eject.mjs:3` deletes every rung ABOVE its argument, so the argument is a
 * RETAIN point: `langchain` retains rung 1 alone and strips 424 of 435 files —
 * the MAXIMAL strip. `eject software-developer-agent` retains everything and
 * deletes nothing.
 *
 * So `static` here is the STRONGEST available claim of invariance, not the
 * weakest — but a reader cannot tell which target produced it from the word
 * `static` alone, and on a ladder that ever stops being cumulative the
 * distinction becomes load-bearing. Naming it now is cheap; renaming a
 * classification already written into a census is not.
 *
 * The weaker targets need no separate run: they retain strict SUPERSETS of what
 * `langchain` retains, so static under this target implies static under all of
 * them.
 */
export const STATIC = "static-under-eject-langchain";

/** A checker's subject count in one reading, or null when it produced none. */
function countOf(entry) {
  const n = entry?.subject?.count;
  return Number.isInteger(n) ? n : null;
}

/**
 * Classify ONE checker from its full-tree and ejected-tree entries.
 *
 * Returns `{ verdict, full, ejected, why }`. `verdict` is one of the four above
 * or `no-baseline`; `why` is the sentence a reader gets and is part of the
 * contract — a classification whose reason is not stated is a bucket name.
 */
export function classifyOne(fullEntry, ejectedEntry) {
  const f = countOf(fullEntry);
  const e = countOf(ejectedEntry);

  // THE BASELINE COMES FIRST. Every other branch compares against `f`, so a
  // missing baseline is not a property of the eject and must not be reported as
  // one — that is the readme-quickstart case, and it fails on both trees.
  if (fullEntry === undefined)
    return {
      verdict: "no-baseline",
      full: null,
      ejected: e,
      why: "not present in the full-tree reading",
    };
  if (fullEntry.exit === 1)
    return {
      verdict: "no-baseline",
      full: f,
      ejected: e,
      why: "FAILS on the full tree too — not an eject finding",
    };
  if (f === null)
    return {
      verdict: "no-baseline",
      full: null,
      ejected: e,
      why: "the full tree produced no subject to compare against",
    };

  if (ejectedEntry === undefined)
    return {
      verdict: "absent",
      full: f,
      ejected: null,
      why: "not present in the ejected reading",
    };
  if (ejectedEntry.exit === 2)
    return {
      verdict: "absent",
      full: f,
      ejected: null,
      why: "REFUSED in the ejected tree — could not ask, which says nothing about its subject",
    };
  if (ejectedEntry.exit === 1)
    return {
      verdict: "broken",
      full: f,
      ejected: null,
      why: "FAILS in the ejected tree while passing on the full one — ejection broke it",
    };
  if (e === null)
    return {
      verdict: "absent",
      full: f,
      ejected: null,
      why: "passed in the ejected tree without reporting a subject",
    };

  if (e === f)
    return {
      verdict: STATIC,
      full: f,
      ejected: e,
      why: `subject unchanged at ${f} — either the domain does not vary by rung, or the number is printed rather than computed`,
    };
  return {
    verdict: "moved",
    full: f,
    ejected: e,
    why: `subject moved ${f} -> ${e}`,
  };
}
