import { Suspense } from "react";
import {
  Separator,
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@deepagents-nextjs/ui";
import { AppSidebar } from "./AppSidebar";
import { ShellCrumbs } from "./ShellCrumbs";
import { ShellScroller } from "./ShellScroller";

/**
 * The application shell for the OpenSWE surfaces.
 *
 * VIEWPORT-LOCKED, NOT DOCUMENT-TALL — the same fix applied to apps/example.
 * SidebarProvider sets `min-h-svh`, which grows the document rather than
 * capping it, and SidebarInset adds no height of its own. Every page in this
 * app previously compensated with a viewport unit of its own — `min-h-screen`
 * on two pages and a hardcoded `h-[calc(100vh-53px)]` on the chat page, where
 * 53px was a measurement of the old DemoNav that nothing kept true. The header
 * here is 56px, so that arithmetic was already wrong by 3px.
 *
 * With the shell owning the viewport and the content owning a scrollbar, no
 * descendant needs a viewport unit or a magic offset again.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider className="h-svh overflow-hidden">
      {/*
       * SUSPENSE IS LOAD-BEARING, NOT DECORATION. AppSidebar reads
       * `useSearchParams()` to know which conversation rung is active, and this
       * shell is rendered from the root layout — so without a boundary here
       * every statically prerendered page in the app fails to build, including
       * `/_not-found`, which has no search params at all. `tsc` passes on it;
       * only `next build` catches it.
       */}
      <Suspense fallback={null}>
        <AppSidebar />
      </Suspense>
      <SidebarInset className="overflow-hidden">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 h-4" />
          {/*
            * Inside the Suspense boundary below is not enough — ShellCrumbs
            * reads useSearchParams() too, so it needs its own boundary here or
            * every prerendered page fails `next build` exactly as AppSidebar
            * would. tsc passes either way; only the build catches it.
            */}
          <Suspense fallback={null}>
            <ShellCrumbs />
          </Suspense>
        </header>
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
