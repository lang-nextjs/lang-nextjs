import { SidebarProvider, SidebarInset } from "@deepagents-nextjs/ui";
import { AppSidebar } from "./AppSidebar";
import { SiteHeader } from "./SiteHeader";
import { rungNavGroups, HARNESS_GROUP } from "../../lib/shell/nav";

/**
 * The application shell. Replaces DemoNav.
 *
 * DemoNav was a two-entry switcher with both entries hardcoded — "Live Chat"
 * and "Queue · OpenSWE" — which is the flat tab bar #6 exists to remove. It
 * could not express the ladder for a reason that is structural rather than
 * cosmetic: rungs 1-3 share one surface selected by a parameter, rung 4 is a
 * different app on a different origin, and rung 5 has no code at all. Three
 * kinds of destination cannot be three tabs.
 *
 * What replaces it is not a longer tab bar. The nav is DERIVED from the rung
 * manifest and GROUPED BY SHAPE, so it enumerates nothing: add a rung to
 * rungs.json and it appears under the heading its shape names, with its href
 * resolved by rungHref() — an in-app route for `param` targets, a cross-origin
 * departure for `origin`, and no link at all for a rung declared in the ladder
 * but absent from the repo.
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
         * FOCUSABLE BECAUSE IT SCROLLS (#451).
         *
         * The wrapper above is `h-svh overflow-hidden`, so the DOCUMENT never scrolls and this
         * div is the only vertical scroller for every page in the app. It contains no focusable
         * element of its own, so a keyboard user could not reach it to scroll it — a mouse user
         * could read a long page and a keyboard user could not. axe calls this
         * scrollable-region-focusable, WCAG 2.1.1.
         *
         * LATENT, NOT NEW. It fires the moment ANY audited page exceeds the viewport, and until
         * now none did; a fifth dashboard tile added one row and made /dashboard the first.
         * Shrinking that page back would have removed the symptom and left every future long
         * page unreachable, so the fix goes on the scroller rather than on the content.
         *
         * `tabindex` only — no `role="region"`. SidebarInset already renders the <main>
         * landmark this sits inside, and a second unnamed landmark is noise to a screen reader.
         */}
        <div tabIndex={0} className="min-h-0 flex-1 overflow-y-auto">
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
