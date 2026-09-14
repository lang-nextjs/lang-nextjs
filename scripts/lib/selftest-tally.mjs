/**
 * selftest-tally.mjs — an arm registered after the tally can never be counted (#1292).
 *
 * THE DEFECT, AND WHY THE GUARD THAT EXISTED COULD NOT SEE IT. #1173 gave selftests a declared
 * count: a file says how many arms it runs, and the suite refuses if the number moves. That guard
 * compares `results.length`. An arm appended BELOW the tally still pushes into `results`, so
 * `results.length` increments exactly as it would if the arm were placed correctly, and the two
 * states are indistinguishable to it:
 *
 *     an arm above the tally     counted, printed, and part of the verdict
 *     an arm below the tally     counted in `results`, and never part of the verdict
 *
 * The guard is checking a QUANTITY where the defect is a POSITION, and the quantity is incremented
 * by the very code whose reachability is in question.
 *
 * WHAT IT LOOKS LIKE WHEN IT HAPPENS, measured by planting one arm below the tally in
 * `assert-pr-authorship-is-attributable.selftest.mjs`:
 *
 *     exit 1, banner "85/86 passed", the planted arm PRINTED as `ok`, and NO arm printed as FAIL
 *
 * A red suite in which every arm says `ok`, and the declared-count message stays silent because in
 * that file it is gated on `code === 0`. Nothing in the output names the cause.
 *
 * WHY AN EXIT HANDLER, WHICH IS THE WHOLE MECHANISM. The guard has to be somewhere the defect
 * cannot get below it. Any statement at the top level can be outrun by appending one more line --
 * including a guard against appending one more line. `process.on("exit")` runs after ALL top-level
 * code, so an arm registered anywhere, by any route, is already in the array by the time this
 * compares. That is what turns "the tally is the last statement that reads `results`" from a
 * convention somebody must uphold into a property the file cannot violate.
 *
 * AND THE MECHANISM WAS MEASURED, BECAUSE THE OBVIOUS ONE IS INERT. The first draft threw from
 * inside the handler. Node SWALLOWS it -- driven on v22.22.2, `process.on("exit", () => { throw
 * ... })` after `process.exit(0)` exits 0, so the guard would have announced nothing while looking
 * like it worked. Assigning `process.exitCode` does take effect, and does so even when the file
 * ended with an explicit `process.exit(0)`, which is how all seven adopting files end:
 *
 *     handler throws                    -> status 0    the guard is inert
 *     handler sets process.exitCode = 1 -> status 1    the guard is heard
 *
 * WHAT IT DOES NOT CLAIM. It does not check that the count is right, that arms are printed, or
 * that an arm asserts anything -- #1173's declared count and `assert-selftest-arms-are-visible`
 * own those. It answers one question: did every arm this file registered reach the tally.
 */

/**
 * Record how many arms the tally is about to count, and fail at exit if more arrive.
 *
 * Call it IMMEDIATELY BEFORE the statement that computes the verdict, passing the same array.
 *
 * @param {Array<{name?: string}>} results the arm array this file's tally reads
 * @param {(s: string) => void} write      where the complaint goes (stderr by default)
 * @returns {number} the count the tally is entitled to claim
 */
export function armsMustReachTheTally(results, write = null) {
  const out = write ?? ((s) => process.stderr.write(s));
  const counted = results.length;
  process.on("exit", () => {
    const late = results.slice(counted);
    if (late.length === 0) return;
    const named = late
      .map((r, i) => `        ${i + 1}. ${r?.name ?? "(an arm with no name)"}`)
      .join("\n");
    out(
      `\nFAIL: ${late.length} arm(s) registered AFTER the tally, so they ran and were ` +
        `NOT counted (#1292).\n` +
        `      The tally saw ${counted}; the file finished with ${results.length}.\n` +
        `      Move them ABOVE the statement that computes the verdict:\n${named}\n`
    );
    process.exitCode = 1;
  });
  return counted;
}
