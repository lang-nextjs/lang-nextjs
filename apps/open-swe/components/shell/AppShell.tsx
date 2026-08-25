import { Suspense } from "react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  Separator,
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@deepagents-nextjs/ui";
import { AppSidebar } from "./AppSidebar";

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
export function AppShell({
  crumbs,
  children,
}: {
  crumbs: string[];
  children: React.ReactNode;
}) {
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
          <Breadcrumb>
            <BreadcrumbList>
              {crumbs.map((c, i) => (
                <BreadcrumbItem key={c}>
                  {i > 0 ? <BreadcrumbSeparator /> : null}
                  <BreadcrumbPage>{c}</BreadcrumbPage>
                </BreadcrumbItem>
              ))}
            </BreadcrumbList>
          </Breadcrumb>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
