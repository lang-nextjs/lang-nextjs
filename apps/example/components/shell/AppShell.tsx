import { SidebarProvider, SidebarInset } from "@deepagents-nextjs/ui";
import { AppSidebar } from "./AppSidebar";
import { SiteHeader } from "./SiteHeader";
import { ShellScroller } from "./ShellScroller";
import { rungNavGroups, HARNESS_GROUP } from "../../lib/shell/nav";

/**
 * The application shell. Replaces DemoNav.
 *
 * DemoNav was a two-entry switcher with both entries hardcoded — "Live Chat"
 * and "Queue · OpenSWE" — which is the flat tab bar #6 exists to remove. It
 * could not express the ladder for a reason that is structural rather than
 * cosmetic: rungs 1-3 share one surface selected by a parameter, rung 4 is a
 * different app on a different origin, and rung 5 has no FRONT DOOR. Three
 * kinds of destination cannot be three tabs.
 *
 * What replaces it is not a longer tab bar. The nav is DERIVED from the rung
 * manifest and GROUPED BY SHAPE, so it enumerates nothing: add a rung to
 * rungs.json and it appears under the heading its shape names, with its href
 * resolved by rungHref() — an in-app route for `param` targets, a cross-origin
 * departure for `origin`, and no link at all for a `none` target.
 *
 * A `none` TARGET IS NOT AN ABSENT RUNG, and this comment said it was until
 * #696 — a user reported rung 5 as "says implemented but I can't click it".
 *
 * #424 made reachability a SECOND AXIS: `state` says whether a rung is here and
 * runnable, `reach` says whether it has a door. Rung 5 is `implemented` and
 * `reach: "vendored"` — present, severable, no way in — and "five forkable and
 * four reachable" is the sentence v2.0 ships. It owns files; see its `owns` in
 * rungs.json, spanning packages/server, packages/react and rungs/5-*.
 *
 * No file count is quoted here on purpose. #669 was filed this week for prose
 * that pinned an exact version and rotted silently; a count rots the same way,
 * and the manifest is the authority regardless.
 *
 * The distinction is load-bearing for whoever reads this next. "Absent from the
 * repo" names a rung to go and write; "vendored" names one already here. A
 * maintainer acting on the old wording would go looking for code that exists,
 * or give rung 5 a target and break the shipping configuration.
 */
export function AppShell({
  crumbs,
  children,
}: {
  crumbs: string[];
  children: React.ReactNode;
}) {
  // Read at render on the server so NEXT_PUBLIC_QUEUE_URL is honoured without
  // baking a build-time literal into the nav.
  const groups = [
    ...rungNavGroups({
      NEXT_PUBLIC_QUEUE_URL: process.env.NEXT_PUBLIC_QUEUE_URL,
    }),
    HARNESS_GROUP,
  ];

  return (
    /*
     * VIEWPORT-LOCKED ON THE WRAPPER, NOT THE INSET. SidebarProvider ships
     * `min-h-svh`, which grows the document instead of capping it, and
     * SidebarInset adds no height of its own — so a child asking for
     * `h-screen` sat BELOW the 56px header inside a container happy to reach
     * 100vh + 56px. Measured before the fix: `/` and `/r/[rung]` overflowed by
     * exactly 56px, which is `h-14` to the pixel.
     *
     * The cap goes on the WRAPPER deliberately. `variant="inset"` gives the
     * inset `m-2`, so capping the inset at `h-svh` would put it 16px over the
     * viewport and reintroduce the same defect one level in. Capping the
     * flex parent lets the inset size itself within the margin.
     */
    <SidebarProvider className="h-svh overflow-hidden">
      <AppSidebar title="Lang-Next.js" groups={groups} />
      <SidebarInset className="overflow-hidden">
        <SiteHeader crumbs={crumbs} />
        {/*
         * FOCUSABLE BECAUSE IT SCROLLS (#451) — AND ONLY THEN (#486).
         *
         * The wrapper above is `h-svh overflow-hidden`, so the DOCUMENT never scrolls and this
         * is the only vertical scroller for every page in the app. It contains no focusable
         * element of its own, so where it overflows a keyboard user could not reach it to
         * scroll it — a mouse user could read a long page and a keyboard user could not. axe
         * calls this scrollable-region-focusable, WCAG 2.1.1.
         *
         * LATENT, NOT NEW. It fires the moment ANY audited page exceeds the viewport, and until
         * now none did; a fifth dashboard tile added one row and made /dashboard the first.
         * Shrinking that page back would have removed the symptom and left every future long
         * page unreachable, so the fix goes on the scroller rather than on the content.
         *
         * The tab stop is now conditional on the region actually overflowing, and carries a
         * name when it exists. See ShellScroller for why measuring beats naming it
         * unconditionally, and for the measurement that prompted it.
         */}
        <ShellScroller>{children}</ShellScroller>
      </SidebarInset>
    </SidebarProvider>
  );
}
