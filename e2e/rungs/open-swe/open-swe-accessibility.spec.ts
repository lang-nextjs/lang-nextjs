import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { GATING_TAGS, KEYBOARD_SCROLLER_RULE } from "../../a11y-tags";

/**
 * ACCESSIBILITY AUDIT FOR apps/open-swe — WCAG 2.1 A + AA (#457).
 *
 * WHY THIS FILE EXISTS. `e2e/accessibility.spec.ts` audits apps/example and
 * says so in its own scope note: it runs under `chromium` against the example
 * app, and "apps/open-swe has its own dev server and belongs in its own
 * project". That sentence was accurate and the project it describes was never
 * written, so open-swe — the application this repo is built around — had no
 * accessibility gate of any kind. The absence was not visible as an absence:
 * the a11y tick was green, for a different app.
 *
 * ── WHAT THE ISSUE PREDICTED, AND WHAT IS ACTUALLY TRUE ────────────────────
 *
 * #457 was filed on the premise that open-swe carries apps/example's shell
 * defect: AppShell caps the wrapper at `h-svh overflow-hidden`, so the document
 * never scrolls and the inner `min-h-0 flex-1 overflow-y-auto` div is the only
 * vertical scroller — with no focusable child, unreachable by keyboard.
 *
 * THE SHELLS ARE IDENTICAL. THE DEFECT IS NOT REACHABLE IN THIS APP TODAY, and
 * that difference is measured, not reasoned. At 1280x720 against the dev server,
 * every route of apps/open-swe:
 *
 *   /          shell scroller 648/648   does not scroll
 *   /chat      shell scroller 648/648   does not scroll
 *   /runs      shell scroller 648/648   does not scroll
 *   /settings  shell scroller 1343/648  SCROLLS - and contains 6 focusable
 *                                       form controls, so axe's focusable-content
 *                                       check PASSES it
 *
 * `scrollable-region-focusable` needs BOTH conditions: a region that overflows
 * AND no focusable content inside it. On apps/example's /dashboard the two
 * coincide. On open-swe they do not coincide on any route — the only route that
 * overflows is the one full of form controls.
 *
 * So adding `tabIndex={0}` to open-swe's AppShell would be an unverifiable
 * change: no test could show it mattering, and a focusable div that does not
 * scroll is a useless tab stop on every page in the app. It is deliberately NOT
 * done here. What is done instead is durable: the rule is un-baselineable below,
 * so the day a route DOES overflow without focusable content, this gate fails
 * rather than absorbing it.
 *
 * ── WHAT THE AUDIT FOUND INSTEAD ───────────────────────────────────────────
 *
 * The same defect class is live in open-swe, in a different element. /runs
 * renders the run board as a horizontally scrolling grid:
 *
 *   <div data-testid="run-board" class="... overflow-x-auto ...">
 *
 * Measured empty: 1088/968 horizontally, tabindex=null, focusables=0 —
 * `scrollable-region-focusable`, impact serious. A mouse user can scroll the
 * board to reach columns off-screen and a keyboard user cannot, which is the
 * sentence #457 is about. It is fixed in apps/open-swe/app/runs/page.tsx, and
 * that fix is what makes this project demonstrably able to go red: revert it
 * and the audit below fails on /runs, naming the rule and the node.
 *
 * Note the board only violates when it is EMPTY. Populated, its cards are links
 * and the focusable-content check passes. The audited state is therefore the
 * empty board, which is a real first-run state and the one nothing else covers.
 *
 * ── TAGS ───────────────────────────────────────────────────────────────────
 *
 * Identical to apps/example's, by construction rather than by copy — both
 * import GATING_TAGS from e2e/a11y-tags.ts. See that file for why a second
 * list would be worse than no gate.
 */

/** Desktop, matching the `chromium` project apps/example is audited under. */
const ROUTES = ["/", "/chat", "/runs", "/settings"] as const;

/**
 * A violation that is REAL, ACCEPTED FOR NOW, AND NAMED — not a suppression.
 *
 * The alternative to this list was landing a gate that is red on arrival, which
 * teaches everyone to ignore it. The alternative to THAT was auditing open-swe
 * under weaker tags, which is the outcome #457 explicitly rejects: the weaker
 * gate gets cited as coverage.
 *
 * THREE PROPERTIES KEEP THIS FROM BECOMING A CARPET:
 *
 *   1. It is ENUMERATED. Anything not listed here fails. A new violation of any
 *      rule on any route is red, which is the gate's forward job.
 *   2. It EXPIRES BY ITSELF. Every entry must still match something. When a
 *      violation is fixed, its entry goes stale and this suite FAILS until the
 *      entry is deleted. A baseline that outlives its justification is the
 *      exact defect class where a check records a state of the world that
 *      stopped being true because the code got better, and nobody watches for
 *      it — so here the check watches for it.
 *   3. It CANNOT ABSORB THE RULE THIS PROJECT EXISTS FOR. See UNBASELINEABLE.
 *
 * THE LIST IS EMPTY AS OF #474 and the three entries it held are fixed, not
 * re-accepted. Its machinery stays: an enumeration that happens to be empty is
 * the gate doing its forward job, and the day someone needs an entry the three
 * properties above are what bound it. See the block above KNOWN for what an
 * empty list leaves unexercised and for the one trap in adding an entry.
 */
type KnownViolation = {
  /** Route it occurs on. */
  route: string;
  /** axe rule id. */
  rule: string;
  /** A stable fragment of the offending node's HTML — not the escaped CSS
   *  target, which is positional and churns whenever a sibling moves. */
  htmlFragment: string;
  /** What it is, measured, and what has to happen for it to go. */
  why: string;
};

/*
 * EMPTY, AND THAT IS THE RESTING STATE (#474).
 *
 * It held three entries — two routes' worth of the "2 of 3" rung counter at
 * 3.06:1 and the /runs error alert at 3.64:1. Both are fixed rather than
 * accepted; the entries are deleted because property 2 above requires it, and
 * the suite proved it: with the fixes in and the entries still present, the
 * staleness assertion went red naming all three.
 *
 * THE ACCEPTANCE'S STATED REASON DID NOT SURVIVE MEASUREMENT, which is worth
 * recording where the next person proposing an entry will read it. Both were
 * accepted as "shared-token decisions with blast radius into apps/example and
 * the visual baselines". Neither was: each fragment occurs on exactly ONE node
 * in the entire monorepo, and both fixes are local class changes. No token was
 * touched, so apps/example is untouched too. The blast radius was two
 * screenshots, not a design system.
 *
 * WHAT AN EMPTY LIST COSTS, said plainly rather than left to be discovered.
 * With no entries, the suppression path and the staleness path below are both
 * unexercised in CI: `matchesKnown` is never asked a true question and `stale`
 * folds over nothing. They are not unverified — they were mutation-tested when
 * this file emptied (an unlisted violation reddens the suite; a listed one is
 * suppressed and its entry is not stale) — but that evidence lives in #474's
 * PR, not in a run. Anyone re-adding an entry should re-run both.
 *
 * AND THE MATCH IS BROADER THAN THE INSTANCE, which is the trap to know about
 * before adding one. `htmlFragment` is tested with `String.includes` against
 * the node's HTML, so `text-muted-foreground/60` accepted "any color-contrast
 * violation on this route on a node carrying that utility class" — one node
 * today, and nothing bounds it to one. An entry is a PATTERN. Prefer a fragment
 * that can only ever name the instance, such as a `data-testid`.
 */
const KNOWN: readonly KnownViolation[] = [];

/**
 * RULES THAT MAY NEVER BE BASELINED, ENFORCED RATHER THAN REQUESTED.
 *
 * A comment saying "do not add scrollable-region-focusable to KNOWN" is exactly
 * the kind of instruction that loses to a red build at 2am. This is a check
 * instead: an entry naming one of these rules fails the suite immediately, and
 * a violation of one of these rules never consults KNOWN at all.
 */
const UNBASELINEABLE: readonly string[] = [KEYBOARD_SCROLLER_RULE];

type Finding = {
  route: string;
  rule: string;
  impact: string | null | undefined;
  help: string;
  helpUrl: string;
  target: string;
  html: string;
};

async function auditRoute(page: Page, route: string): Promise<Finding[]> {
  const response = await page.goto(route);
  // THE STATUS ASSERTION IS THE POINT, and it is borrowed deliberately from
  // apps/example's spec, where a deleted route kept passing its a11y test
  // forever because Next renders 404s through the root layout: axe finds a
  // well-formed page and reports nothing wrong with it.
  expect(
    response?.status(),
    `${route} should be a real open-swe route, not a 404 rendered through the root layout`
  ).toBe(200);
  await page.waitForLoadState("networkidle");

  const results = await new AxeBuilder({ page })
    .withTags([...GATING_TAGS])
    .analyze();

  return results.violations.flatMap((v) =>
    v.nodes.map((n) => ({
      route,
      rule: v.id,
      impact: v.impact,
      help: v.help,
      helpUrl: v.helpUrl,
      target: JSON.stringify(n.target),
      html: n.html,
    }))
  );
}

const matchesKnown = (f: Finding, k: KnownViolation): boolean =>
  // An un-baselineable rule matches NOTHING, whatever KNOWN says. This is the
  // structural half of the guard; the assertion in the first test is the other.
  !UNBASELINEABLE.includes(f.rule) &&
  f.route === k.route &&
  f.rule === k.rule &&
  f.html.includes(k.htmlFragment);

test.describe("apps/open-swe — WCAG 2.1 A + AA conformance", () => {
  test("the KNOWN list cannot contain a rule this project exists to catch", () => {
    // Runs first and needs no browser: a KNOWN entry naming an un-baselineable
    // rule is a mistake in the gate itself, and the gate should say so before
    // it reports anything about the app.
    const smuggled = KNOWN.filter((k) => UNBASELINEABLE.includes(k.rule));
    expect(
      smuggled,
      `these KNOWN entries name a rule that may never be baselined (${UNBASELINEABLE.join(
        ", "
      )}). ` +
        `That rule is the reason this project was written; accepting it here would turn this gate into evidence that the defect is absent.`
    ).toEqual([]);
  });

  test("the audited app is open-swe, at a named viewport, on named routes", async ({
    page,
    baseURL,
  }) => {
    // NAME THE SUBJECT, so a run that examined nothing cannot report success.
    //
    // This is not decoration. apps/example and apps/open-swe both serve `/`,
    // so an open-swe project pointed at :3000 does NOT fail — the example app
    // answers and every assertion below runs against the wrong application,
    // reporting open-swe as audited. playwright.config.ts carries the same
    // warning for the same reason; this is the assertion form of it.
    const viewport = page.viewportSize();
    console.log(`[open-swe-a11y] baseURL : ${baseURL}`);
    console.log(
      `[open-swe-a11y] viewport: ${viewport?.width}x${viewport?.height}`
    );
    console.log(`[open-swe-a11y] routes  : ${ROUTES.join(", ")}`);
    console.log(
      `[open-swe-a11y] tags    : ${GATING_TAGS.join(", ")}  (${
        KNOWN.length
      } known violation(s) accepted)`
    );

    const response = await page.goto("/");
    expect(response?.status()).toBe(200);
    await page.waitForLoadState("networkidle");

    // open-swe's shell renders this; apps/example's does not.
    await expect(
      page.locator('[data-testid="conversation-list"]'),
      "no open-swe conversation list on `/` — this is probably the example app answering, which serves `/` too"
    ).toBeAttached();

    expect(
      viewport,
      "no viewport, so no claim about what was audited"
    ).not.toBeNull();
  });

  test(`the tag set still selects ${KEYBOARD_SCROLLER_RULE}`, async ({
    page,
  }) => {
    // WHY THIS IS A TEST AND NOT A COMMENT. Every other assertion in this file
    // is satisfied by "axe reported no violations", and that sentence is also
    // true when the tag set selects a rule set that does not contain the rule
    // #457 is about — because axe was never asked. The gate would be green,
    // permanently, for the one defect it was commissioned to catch.
    //
    // Asked another way: what would have to be true for the audits below to
    // pass while a keyboard-unreachable scroller is sitting on the page? The
    // honest answer is "the rule was not in the selected set", and nothing else
    // here would notice. So it is checked directly, against the axe build that
    // is actually installed rather than against its documentation.
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Asked through the SAME code path the audits use — `.withTags().analyze()`
    // — rather than by reading axe's metadata off the window. axe is injected
    // for the duration of a run and does not outlive it, so a `window.axe`
    // probe reports "not selected" for a rule that is selected, which is a
    // false alarm in the one place a false alarm is most expensive.
    //
    // Every rule axe RAN lands in exactly one of these four buckets, including
    // `inapplicable` when the page has no scrollable region — which is the
    // normal result on `/` and is still proof the rule was selected.
    const results = await new AxeBuilder({ page })
      .withTags([...GATING_TAGS])
      .analyze();
    const executed = [
      ...results.passes,
      ...results.violations,
      ...results.incomplete,
      ...results.inapplicable,
    ].map((r) => r.id);

    expect(
      executed.length,
      "axe reported no rules at all in any bucket, so it did not run — this must not be read as a pass"
    ).toBeGreaterThan(0);
    expect(
      executed,
      `${KEYBOARD_SCROLLER_RULE} is not selected by [${GATING_TAGS.join(
        ", "
      )}] in the installed axe-core. ` +
        `Every audit in this file would pass with the #457 defect on the page.`
    ).toContain(KEYBOARD_SCROLLER_RULE);
  });

  test("the /runs board still scrolls, and is still reachable by keyboard", async ({
    page,
  }) => {
    // THE CONTROL. Everything else in this file reports the ABSENCE of
    // violations, and absence has two causes: the page is clean, or the page
    // never presented the condition. This test proves the second cause is not
    // the one in play — that the board really is a scrollable region, so a
    // clean `scrollable-region-focusable` result is a fact about the fix rather
    // than a fact about the layout.
    //
    // This is the shape that caught a self-consistency bug in #230: a suite of
    // only-negative cases stays green while the thing under test compares
    // nothing. The positive case is what goes red.
    const response = await page.goto("/runs");
    expect(response?.status()).toBe(200);
    await page.waitForLoadState("networkidle");

    const board = page.locator('[data-testid="run-board"]');
    await expect(board).toBeAttached();

    const geometry = await board.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      overflowX: getComputedStyle(el).overflowX,
      tabindex: el.getAttribute("tabindex"),
      focusables: el.querySelectorAll(
        "a[href],button,input,select,textarea,[tabindex]"
      ).length,
    }));
    console.log(`[open-swe-a11y] run board: ${JSON.stringify(geometry)}`);

    expect(
      ["auto", "scroll"],
      `the run board's overflow-x is "${geometry.overflowX}" — it is no longer a scrollable region, so the audit of /runs no longer exercises ${KEYBOARD_SCROLLER_RULE} and this project has stopped covering the defect it was built for`
    ).toContain(geometry.overflowX);

    expect(
      geometry.scrollWidth,
      `the run board no longer overflows (${geometry.scrollWidth} <= ${geometry.clientWidth}), so a clean ${KEYBOARD_SCROLLER_RULE} result on /runs proves nothing. If the board legitimately fits now, this project needs a different route that overflows — it must not simply be deleted.`
    ).toBeGreaterThan(geometry.clientWidth);

    // Reachable: axe accepts EITHER a tabindex on the region or focusable
    // content within it. Both are asserted as one disjunction rather than
    // pinning the current fix, so a future change from one to the other is not
    // spuriously red.
    expect(
      geometry.tabindex !== null || geometry.focusables > 0,
      `the run board scrolls (${geometry.scrollWidth} > ${geometry.clientWidth}) but has neither a tabindex nor focusable content, so no keyboard user can reach the columns that are off-screen`
    ).toBe(true);
  });

  test("every route is WCAG A/AA conformant, and the known-violation list is not stale", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    const findings: Finding[] = [];
    for (const route of ROUTES) {
      const routeFindings = await auditRoute(page, route);
      console.log(
        `[open-swe-a11y] audited ${route}: ${routeFindings.length} violating node(s)`
      );
      findings.push(...routeFindings);
    }

    // A run that audited nothing is not a pass. ROUTES is a literal, so this
    // cannot fail today — which is the point: it fails the day someone filters
    // ROUTES down to nothing and the suite goes green by absence.
    expect(
      ROUTES.length,
      "no routes were audited, so a clean result is a fact about this list and not about the app"
    ).toBeGreaterThan(0);

    const unexpected = findings.filter(
      (f) => !KNOWN.some((k) => matchesKnown(f, k))
    );

    expect(
      unexpected.map((f) => ({
        route: f.route,
        rule: f.rule,
        impact: f.impact,
        help: f.help,
        helpUrl: f.helpUrl,
        target: f.target,
      })),
      `${unexpected.length} unaccepted WCAG A/AA violation(s) across ${ROUTES.length} open-swe route(s)`
    ).toEqual([]);

    // THE BASELINE EXPIRES BY ITSELF. An entry that no longer matches anything
    // describes a violation that has been fixed, and leaving it here would hold
    // open an exception nothing needs — and would silently accept the violation
    // if it ever came back.
    const stale = KNOWN.filter(
      (k) => !findings.some((f) => matchesKnown(f, k))
    );
    expect(
      stale.map((k) => `${k.route} ${k.rule} (${k.htmlFragment})`),
      "these KNOWN violations no longer occur — they have been fixed. Delete them from KNOWN; an exception that outlives its cause will silently re-accept the violation when it returns."
    ).toEqual([]);
  });
});
