import {
  SidebarTrigger,
  Separator,
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@deepagents-nextjs/ui";

/**
 * dashboard-01's site header, adapted. Pure primitives — no new dependencies.
 *
 * `crumbs` is plain data so the header names no route and no rung; #6's
 * shape-routed shell supplies them from the rung manifest.
 */
export function SiteHeader({ crumbs }: { crumbs: string[] }) {
  return (
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
  );
}
