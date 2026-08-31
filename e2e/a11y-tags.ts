/**
 * ONE DEFINITION OF "ACCESSIBLE", SHARED BY EVERY a11y PROJECT.
 *
 * `accessibility.spec.ts` (example app, `chromium`) and
 * `rungs/open-swe/open-swe-accessibility.spec.ts` (open-swe, `open-swe-a11y`)
 * audit two different apps that render THE SAME SHELL. If each spec declared
 * its own tag list, the lists could drift — and the failure would be silent in
 * the worst direction: the app audited under the weaker list keeps passing, and
 * its green tick gets cited as coverage for a rule it never ran.
 *
 * That is not hypothetical here. #457 exists because apps/open-swe carried the
 * same viewport-locked shell as apps/example with no audit at all, and the
 * absence read as health. A weaker tag list is the same defect with a gate in
 * front of it, which is worse: it produces evidence.
 *
 * So the tag set is defined ONCE, here, and imported. Two gates cannot disagree
 * about what they are gating if there is only one list.
 *
 * CALIBRATION (unchanged from accessibility.spec.ts, where it was written):
 * `wcag2a` + `wcag2aa` + the 2.1 additions are the standard browser-renderable
 * conformance levels. `best-practice` is deliberately NOT here — those findings
 * involve judgment calls not appropriate for a hard gate. Note that this is not
 * a soft choice about severity: `scrollable-region-focusable`, the rule #457 is
 * about, is tagged `wcag2a` and IS gated. Measured, not assumed —
 * axe-core 4.11.4 reports its tags as:
 *
 *   cat.keyboard, wcag2a, wcag211, wcag213, TTv5, TT4.a, EN-301-549, ...
 *
 * If a future axe release moves that rule to `best-practice`, this gate goes
 * silent for the exact defect it was built for. `open-swe-accessibility.spec.ts`
 * asserts the rule is reachable under these tags rather than trusting it.
 */
export const GATING_TAGS = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
] as const;

/**
 * The rule #457 is about: a scrollable region no keyboard user can reach.
 *
 * Named here rather than inline because two different files need to agree on
 * it — the audit that must never baseline it, and the reachability check that
 * proves the tag set still selects it.
 */
export const KEYBOARD_SCROLLER_RULE = "scrollable-region-focusable";
