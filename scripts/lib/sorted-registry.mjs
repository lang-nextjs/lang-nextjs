/**
 * sorted-registry.mjs — a shared append-target registry is STORED SORTED BY NAME, and this is the
 * one predicate that says so (#1168).
 *
 * WHAT IT REPAIRS, MEASURED RATHER THAN ARGUED. Every registration used to add its entry at the
 * END of `scripts/checks.json`. Appending rewrites the previous last entry's closing `}` into
 * `},`, so any two registrations MODIFY THE SAME LINE and git reports a conflict. Measured at
 * 13e476dc, taking the last 8 real registrations and three-way merging all 28 pairs:
 *
 *     appended at the end   28 / 28 pairs CONFLICT
 *     inserted sorted        0 / 28 pairs conflict
 *
 * A sorted insert ADDS lines between two untouched ones and modifies none, so two registrations
 * land in different hunks. That is why one merge could turn four `checks.json` PRs DIRTY at once.
 *
 * THE RESIDUAL, WHICH IS NOT REMOVED AND MUST NOT BE CLAIMED AWAY. Two names that sort ADJACENT
 * still conflict — measured, `aaa-adjacent-one` against `aaa-adjacent-two`: CONFLICT. Two names
 * that both sort last are that same case. So 0/28 is a measurement of a population, not an
 * invariant: sorting disperses the insertion points, it does not make conflicts impossible.
 *
 * CODE-UNIT ORDER, NOT `localeCompare`. On today's keys the two agree — measured over all 74
 * check names, 18 unregistered checkers and 19 stance paths. They are not the same function
 * though: `localeCompare` weighs case and punctuation by locale, so a key with `_` or a capital
 * would order differently, and its answer depends on the ICU data the running Node was built
 * with. A guard whose verdict can differ between two machines is worse than a stricter one, and
 * `<` is the order every `sort()` in this repo already produces.
 *
 * WHY A PREDICATE OVER NAMES AND NOT A FORMATTER. Rewriting the file on the reader's behalf would
 * make every reader a writer of the registry, and a reader that silently repairs its input cannot
 * report that the input was wrong. This returns a complaint and writes nothing.
 *
 * WHY IT IS SHARED. `scripts/checks.json` and `scripts/git-subject-stances.json` are both
 * append-target registries with the same conflict shape, and their readers are different files.
 * Two copies of this rule would drift, which is the defect #1161 was about.
 */

/**
 * The first place `names` departs from sorted order, as a sentence — or null when it is sorted.
 *
 * @param {string[]} names  the registry's keys, IN FILE ORDER (not a copy that was sorted)
 * @param {{file: string, what: string, key: string}} where
 */
export function unsortedComplaint(names, { file, what, key }) {
  for (let i = 1; i < names.length; i++) {
    if (names[i - 1] <= names[i]) continue;
    return (
      `${file} lists ${what} out of order: "${names[i]}" comes after "${
        names[i - 1]
      }", ` +
      `but sorts before it. This file is stored sorted by \`${key}\` so that two registrations ` +
      `insert at different places and do not conflict (#1168) — appending at the end rewrites ` +
      `the previous entry's closing brace, which is a line every other registration also ` +
      `rewrites. Move the entry into its sorted position; do not re-order anything else.`
    );
  }
  return null;
}

/** The same question as a boolean, for callers that only branch on it. */
export const isSorted = (names) =>
  unsortedComplaint(names, { file: "", what: "", key: "" }) === null;
