/**
 * AN EXCEPTION NOBODY ANTICIPATED IS A CANNOT-COMPUTE, NOT A FINDING (#1175).
 *
 * Every checker with a `Refusal` class ended the same way:
 *
 *     } catch (e) {
 *       if (e instanceof Refusal) { console.error(`REFUSING: ${e.message}`); process.exit(2); }
 *       throw e;        // uncaught -> node exits 1
 *     }
 *
 * The refusal branch is careful and complete for the errors its author foresaw. The re-throw is
 * where an unforeseen one becomes a verdict: node exits 1 on an uncaught throw, and 1 is this
 * repo's code for "I looked and found something". So a checker that never reached its question
 * reported an answer to it. run-checks.mjs recorded that as `fail` with no subject and routed it
 * to #1030's repair ("move reportSubject() above the failing exit"), which cannot apply to a
 * process that never reached any exit.
 *
 * Measured on all sixteen Refusal-bearing checkers, with a preload that makes the first I/O call
 * touching the repo throw a TypeError: seven exited 1. That is the defect present, not argued.
 *
 * EXIT 2 IS THE HONEST CODE, because the checker did not ask. The stack still prints, so nothing
 * a person debugging it needs is lost; what changes is the code, and with it what the runner's
 * record, its annotation, and anyone reading either will say.
 *
 * WHY A SHARED HELPER RATHER THAN SIXTEEN REPAIRS. Sixteen copies of one shape is what produced
 * sixteen copies of the gap, and the next checker would be written by copying one of them. Each
 * checker keeps its own Refusal class and its own refusal message, because those are specific
 * to what it could not read; only the branch nobody wrote a message for is shared.
 *
 * WHAT THIS DOES NOT COVER. It runs where a checker calls it: inside the catch at its exit
 * boundary. A throw at MODULE SCOPE, before `main()` is entered, never reaches that catch and
 * still exits 1. Moving that work inside the boundary is the repair for such a checker; a
 * process-wide `uncaughtException` handler would be the other, and it is not used here because
 * every selftest that imports a checker would inherit it, turning a selftest's own crash into
 * a refusal.
 */

/**
 * The else-branch of a checker's exit boundary: never returns.
 *
 * @param {unknown} err - whatever the checker's try block threw that was not its own Refusal
 * @returns {never}
 */
export function refuseUnanticipated(err) {
  const kind =
    err instanceof Error ? err.constructor.name : `thrown ${typeof err}`;
  const message = err instanceof Error ? err.message : String(err);
  console.error(
    `COULD NOT COMPUTE: an unanticipated ${kind} escaped this checker: ${message}\n` +
      `        Exit 2, not 1: the checker did not reach its question, so this is not a finding\n` +
      `        about its subject (#1175). The stack follows.`
  );
  console.error(err instanceof Error && err.stack ? err.stack : err);
  process.exit(2);
}
