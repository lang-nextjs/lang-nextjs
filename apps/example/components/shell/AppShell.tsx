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
    ...rungNavGroups({ NEXT_PUBLIC_QUEUE_URL: process.env.NEXT_PUBLIC_QUEUE_URL }),
    HARNESS_GROUP,
  ];

  return (
    <SidebarProvider>
      <AppSidebar title="Lang-Next.js" groups={groups} />
      <SidebarInset>
        <SiteHeader crumbs={crumbs} />
        {children}
      </SidebarInset>
    </SidebarProvider>
  );
}
