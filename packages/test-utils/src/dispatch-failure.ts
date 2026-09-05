/**
 * WHAT A REJECTED DISPATCH SAYS, GIVEN THE BODY IT WAS REJECTED WITH (#744).
 *
 * The live tool matrix asserted `res.status()` alone, so a rejected dispatch
 * reached the log as `Expected: 200 / Received: 400` and nothing else. The
 * response's own explanation — which the backend supplies, naming the field it
 * wanted — was read by the assertion and discarded. The failure was legible as
 * WHAT and never as WHY, on every run.
 *
 * Measured cost: main took 48 dispatch failures per run from 02 Sep, every one
 * carrying its own diagnosis in a body nobody printed. The streak was
 * investigated twice without anyone learning the cause (#742, #745).
 *
 * ── WHY IT LIVES HERE AND NOT IN THE SPEC THAT USES IT ──────────────────────
 *
 * It was written inside `e2e/shell/matrix-tools-live.spec.ts`, and its three
 * cases went there with it. That file is matched by exactly one Playwright
 * project, `matrix-tools-live`, whose only CI invocations are inside
 * "E2E — open-swe live transport (push to main only)" — a job gated on a model
 * API key and on `github.ref == refs/heads/main`. So the cases ran AFTER merge
 * and never on a pull request, and a regression here would have landed green.
 *
 * That inverted the argument the change was made on: a proof that needs a live
 * dispatch to observe would only run where the failure already costs a day. Put
 * in this package it runs under `pnpm test` on every PR, which is what the
 * argument required all along. Found in review by DEV1-lang.
 *
 * `cell` is an opaque label rather than framework-and-topology, because nothing
 * here needs to know what a cell is — and a helper that took the matrix's
 * vocabulary would be usable only by the matrix.
 */
export function dispatchFailureMessage(cell: string, body: string): string {
  const why = body.trim().slice(0, 600);
  return (
    `${cell} should dispatch — the response said: ` +
    (why || "(empty body — the rejection explained nothing)")
  );
}
