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
/**
 * ONE EMISSION PER PROCESS (#789).
 *
 * WHAT THIS IS A PROXY FOR, and the distinction matters more than the guard. The property
 * that makes a recorded subject trustworthy is THE COUNT DOES NOT CHANGE AFTER EMISSION —
 * that is what lets run-checks record a subject from a FAILING run instead of discarding it.
 * Once-only forecloses the way a partial subject would actually arise: a running total
 * emitted from inside a loop, each call reporting more than the last.
 *
 * IT DOES NOT FORECLOSE THE WHOLE PROPERTY. A single emission of a count that is then mutated
 * through an alias — `const n = r.examined; reportSubject(n, …); r.examined++` — passes this
 * guard and violates the property. Nothing asserts against that. Today it holds structurally
 * rather than by assertion: assert-fork-python-imports-resolve freezes its count into an
 * object returned at :175 before emitting, which is the pattern to copy, and no registered
 * checker mutates a counted expression after its own call. Measured, not assumed — and a
 * measurement about today's tree, not a guarantee about tomorrow's.
 *
 * AT THE EMITTER RATHER THAN AS A STATIC SCAN, because a scan cannot see
 * `const emit = reportSubject; emit(a); emit(b)`, a call through a helper, or any dynamic
 * invocation — and every one of those arrives HERE. A scan would be a second implementation
 * of a property this function is already positioned to enforce, and the weaker one.
 */
let emitted = null;

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
  if (emitted !== null) {
    /*
     * TWO CAUSES, AND THE MESSAGE MUST NAME BOTH. "called twice" is a description of the
     * SHAPE, and a reader who has not written a second call would hunt for one that does not
     * exist. Ten registered checkers emit at MODULE SCOPE, so importing two of them into one
     * process reaches this with no double call written anywhere — and that is the likelier
     * cause, because a checker is spawned in its own process by run-checks and a second call
     * inside one would have to be added deliberately.
     */
    throw new Error(
      `reportSubject was called twice in one process — first "${emitted}", now ` +
        `"${count} ${label}". A subject must be a single emission of a completed count; a ` +
        `running total emitted from inside a loop is the shape this forbids.\n` +
        `  LIKELIER CAUSE: two checkers that emit at MODULE SCOPE imported into the same ` +
        `process — ten do, so importing any two reaches this with no second call written ` +
        `anywhere. Spawn them instead, as run-checks does, or import only one.\n` +
        `  OTHER CAUSE: a genuine second call, including through an alias or a helper.`
    );
  }
  emitted = `${count} ${label}`;
  console.log(`SUBJECT: ${count} ${label}`);
}
