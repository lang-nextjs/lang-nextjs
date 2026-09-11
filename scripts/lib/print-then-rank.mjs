/**
 * PRINT EVERYTHING THAT WAS COMPUTED, THEN RANK THE EXIT (#1215; first instance #1208/#1214).
 *
 * THE DEFECT THIS CLOSES. A checker that met a refusal (a file it could not parse, a newcomer
 * it could not measure) exited 2 on the spot. When that exit ran AFTER findings had been
 * computed and BEFORE they were printed, the run said only "could not check", and a real
 * finding from the same run was never shown. DEV1 measured it in three checkers with ordinary
 * triggers and read it in seven more (#1215); check-doc-claims had three such exits
 * (#1208, #1214).
 *
 * WHY ONE HELPER. Ten copies of #1214's change is how #1161 happened: copies of one shared
 * loop drifted apart. This is the ORDER and the RANK, written once. Each checker keeps its own
 * messages, because what it could not read and what it found are specific to it.
 *
 * THE WHOLE CONTRACT:
 *   printThenRank({ refusals, findings, printRefusals, printFindings, printPass }) -> 0 | 1 | 2
 *   - `refusals` and `findings` are arrays; only their lengths are read.
 *   - printRefusals() runs iff there is a refusal, and runs FIRST.
 *   - printFindings() runs iff there is a finding, AFTER the refusals.
 *   - printPass() runs iff there is neither: the only path on which a checker may print PASS.
 *   - It returns 1 if any finding, else 2 if any refusal, else 0 (this repo's vocabulary: 0
 *     pass, 1 violated, 2 could not ask). A finding outranks a refusal. The refusal is still
 *     printed, so a reader of the log loses nothing; one reading only the code sees "violated".
 *   - It DOES NOT EXIT. The caller returns the code or hands it to process.exit / exitCode, so
 *     a checker that ends from a hook keeps doing so.
 *   - It DOES NOT REPORT A SUBJECT. Whether a refused run reports one is each checker's own
 *     rule (#1030), and it stays in the checker.
 *
 * A REFUSAL BESIDE A FINDING IS STILL A REFUSAL, so a refusal message must not promise an exit
 * code ("Exiting 2"): a finding in the same run now decides it.
 */
export function printThenRank({
  refusals,
  findings,
  printRefusals,
  printFindings,
  printPass,
}) {
  if (!Array.isArray(refusals) || !Array.isArray(findings))
    throw new TypeError(
      "printThenRank: `refusals` and `findings` must be arrays"
    );
  for (const [name, fn] of Object.entries({
    printRefusals,
    printFindings,
    printPass,
  }))
    if (typeof fn !== "function")
      throw new TypeError(`printThenRank: \`${name}\` must be a function`);
  if (refusals.length > 0) printRefusals();
  if (findings.length > 0) printFindings();
  if (refusals.length === 0 && findings.length === 0) printPass();
  return findings.length > 0 ? 1 : refusals.length > 0 ? 2 : 0;
}
