/**
 * "WAS I INVOKED AS THE PROGRAM, OR IMPORTED AS A LIBRARY?" — asked so that it cannot be
 * answered by accident (#631).
 *
 * Every checker in scripts/ ends with a guard deciding whether to run `main()`. Thirty-six of
 * them decided it by comparing a RESOLVED path to an UNRESOLVED one:
 *
 *     fileURLToPath(import.meta.url) === process.argv[1]        // 30 of them
 *     import.meta.url === `file://${process.argv[1]}`           //  6 of them
 *
 * `import.meta.url` is always fully resolved — node resolves symlinks when it loads a module.
 * `process.argv[1]` is the string the caller typed. Invoke through a symlinked path and the two
 * differ, the guard answers "library", `main()` never runs, and the process EXITS 0 HAVING
 * PRINTED NOTHING. A checker that prints nothing and exits 0 is indistinguishable from a
 * checker that passed, in CI logs and in every summary line that matters.
 *
 * Measured: classify.mjs through a symlinked repo root emits ZERO bytes at exit 0; invoked
 * directly it emits 692. On macOS every temp directory is under /var/folders, which is itself a
 * symlink to /private/var/folders — so this fires in precisely the fixtures our own selftests
 * build, which is how it stayed invisible while looking like it was under test.
 *
 * THE SECOND SHAPE IS BROKEN TWICE. `file://${path}` is string concatenation, not URL
 * construction: a path containing a space yields `file:///a b/x.mjs` where `import.meta.url`
 * holds `file:///a%20b/x.mjs`. Measured with no symlink anywhere — under a directory named
 * "with space", the first shape answers true and the second answers FALSE. Those six scripts
 * are silently inert for anyone whose checkout sits under a path with a space in it.
 *
 * WHY A SHARED HELPER RATHER THAN THIRTY-SIX REPAIRS. The comparison is one line and subtly
 * wrong in two different ways already; three scripts had independently arrived at the correct
 * form, which is the same evidence read the other way. Thirty-six hand-fixed copies is a
 * population that can drift again, and it would drift silently, because the failure is silence.
 * scripts/lib/ already holds fixture-premise.mjs on the same reasoning.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * @param {string} importMetaUrl - the caller's own `import.meta.url`
 * @returns {boolean} true when this module IS the entry point node was given
 *
 * Named for the question rather than for the idiom: 26 of the call sites already bind a local
 * `isMain`, and an import of that name would collide with the declaration it is initialising.
 *
 * Exits 2 rather than guessing when the question cannot be answered — see below.
 */
export function invokedAsProgram(importMetaUrl) {
  /*
   * No argv[1] at all: `node -e`, `node --eval`, the REPL, or a loader hook. Nothing was
   * invoked BY PATH, so this module is definitively not it. That is a real answer, not an
   * unknown one, and it must stay silent — returning false here is correct rather than
   * conservative.
   */
  if (!process.argv[1]) return false;

  const self = fileURLToPath(importMetaUrl);

  let selfReal;
  let invokedReal;
  try {
    selfReal = realpathSync(self);
    invokedReal = realpathSync(process.argv[1]);
  } catch (err) {
    /*
     * REFUSING IS THE WHOLE POINT, AND THIS IS THE DECISION WORTH ARGUING.
     *
     * A path that will not resolve — deleted, a broken symlink, a directory we cannot traverse
     * — means we cannot compute whether we are the program. The tempting answer is `false`,
     * because that is what the old code effectively did and it never crashed. But `false` here
     * ASSERTS "I am a library" on no evidence, and the consequence of being wrong is the exact
     * defect this file exists to remove: a checker that runs nothing, prints nothing, and exits
     * 0 while a gate reports it green.
     *
     * "Could not compute" is a third answer and this repo already spells it 2. It is loud, and
     * it should be: the only way to reach it is that argv[1] names something unreadable, and a
     * legitimate import cannot — the importer's own entry file is a file node is currently
     * running, so it resolves by construction. The blast radius of refusing is a situation that
     * is already broken; the blast radius of guessing is a silent pass.
     */
    console.error(
      `REFUSING TO GUESS: cannot resolve the invocation path, so this script cannot tell\n` +
        `whether it was RUN or IMPORTED (${err.message}).\n\n` +
        `  own path : ${self}\n` +
        `  argv[1]  : ${process.argv[1]}\n\n` +
        `Answering "imported" would make this process do nothing and exit 0, which reads as a\n` +
        `passing check. Exiting 2: not run, which is not the same as nothing wrong.`
    );
    process.exit(2);
  }

  return selfReal === invokedReal;
}
