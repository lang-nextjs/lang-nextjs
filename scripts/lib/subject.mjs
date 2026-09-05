/**
 * WHAT A CHECK EXAMINED, as a line the runner can read (#741).
 *
 * run-checks.mjs already captures every checker's stdout and was discarding it
 * at the ok line. This prints the one line it now reads, and the count is
 * measured against a floor the check declares in checks.json — so a pass over
 * nothing is refused rather than recorded as a pass.
 *
 * WHY A HELPER RATHER THAN A console.log IN EACH CHECKER. The format is a
 * contract between 34 producers and one consumer. Written out 34 times it is 34
 * chances to drift, and the copy that drifts is the one nothing reads — the
 * runner would simply see no subject and refuse, which is loud, but the fix
 * would then be made 34 different ways. One emitter, one place to change it.
 *
 * NOT A RETURN VALUE, deliberately: the count must reach the runner even when a
 * checker exits down a path that returns nothing, and stdout is the channel the
 * parent already holds.
 */
export function reportSubject(count, label) {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(
      `reportSubject needs a non-negative integer, got ${JSON.stringify(
        count
      )} — ` +
        "a subject that is not a count cannot be compared to a floor, and a check " +
        "that cannot say how much it examined is the thing #741 refuses."
    );
  }
  console.log(`SUBJECT: ${count} ${label}`);
}
