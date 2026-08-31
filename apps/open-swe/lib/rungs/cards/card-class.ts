/**
 * The bubble every card on this surface wears.
 *
 * A LEAF ON PURPOSE — it imports nothing, so nothing can cycle through it (#492).
 *
 * This used to live in `registry.tsx`, which re-exports the rung packs; the packs import the
 * class back from it. That is a cycle, and it was harmless for as long as every pack used
 * `CARD` only INSIDE a renderer body, where evaluation is deferred until the card is drawn.
 *
 * The first module-level use closed it: `const APPROVAL_CARD = \`${CARD} …\`` runs at module
 * initialisation, and in the cycle `registry` is still suspended at its own re-export line, so
 * `CARD` is in the temporal dead zone. Next's production build failed to prerender with
 * "Cannot access 'w' before initialization" — a minified TDZ error that names nothing useful,
 * on a page whose source had not changed.
 *
 * MOVED RATHER THAN DEFERRED. Putting the template back inside the renderer would have worked
 * and would have left the cycle in place, waiting for the next module-level use — a fix that
 * depends on everyone continuing to write pack code in one particular shape. A leaf removes
 * the edge instead, and `cards.test.tsx` asserts no pack imports a runtime value from the
 * registry so the edge cannot come back.
 */
export const CARD =
  "max-w-md rounded-xl border border-border bg-card/60 px-4 py-2 text-sm text-foreground";
