import Link from "next/link";
import type { ComponentType } from "react";
import {
  Badge,
  Sidebar, SidebarContent, SidebarFooter, SidebarHeader,
  SidebarGroup, SidebarGroupLabel, SidebarGroupContent,
  SidebarMenu, SidebarMenuItem, SidebarMenuButton, SidebarRail,
} from "@deepagents-nextjs/ui";

export type NavItem = {
  title: string;
  /** null renders a non-interactive entry — for something declared but absent. */
  href: string | null;
  icon?: ComponentType<{ className?: string }>;
  external?: boolean;
  note?: string;
};

export type NavGroup = { label: string; items: NavItem[] };

/**
 * dashboard-01's app sidebar, adapted. Pure primitives — no new dependencies.
 *
 * DELIBERATELY GENERIC OVER GROUPS. It renders whatever groups it is handed and
 * names no rung, so it stays `shared` under the boundary rule. #6 supplies the
 * groups from the rung manifest, keyed by interaction shape — this component
 * never learns what a shape is.
 *
 * `href: null` is a first-class case, not an oversight: a rung can be declared
 * in the ladder and absent from the repo, and the manifest's rungHref() returns
 * null for exactly that. Rendering it as a dead link would be worse than
 * rendering it as unavailable, so this refuses to make it clickable.
 */
export function AppSidebar({ title, groups }: { title: string; groups: NavGroup[] }) {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link href="/">
                <span className="bg-primary text-primary-foreground grid size-8 shrink-0 place-items-center rounded-lg text-sm font-bold">
                  ◇
                </span>
                <span className="font-semibold">{title}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {groups.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const body = (
                    <>
                      {Icon ? <Icon className="size-4 shrink-0" /> : null}
                      {/* Rung ids run long (software-developer-agent); truncate
                          rather than wrap, or the row grows and collides with
                          the trailing badge. title= keeps the full name
                          reachable when it is clipped. */}
                      <span className="truncate" title={item.title}>
                        {item.title}
                      </span>
                    </>
                  );
                  return (
                    <SidebarMenuItem key={item.title}>
                      {item.href === null ? (
                        // Not a link. An unavailable rung must not look clickable.
                        //
                        // NOT dimmed, on purpose. `opacity-60` here measures
                        // 3.30:1 against the light sidebar — a contrast failure
                        // in the very theme that documents a 4.5:1 floor, and
                        // opacity-70 still fails at 4.26:1. Beyond that, dimming
                        // encodes state as contrast alone (WCAG 1.4.1). The
                        // badge carries the meaning in text at full contrast.
                        <SidebarMenuButton
                          aria-disabled="true"
                          tooltip={item.note ?? "Declared in the ladder, not in this repo"}
                          className="cursor-default"
                        >
                          {body}
                          <Badge variant="outline" className="ml-auto shrink-0 text-[10px]">
                            planned
                          </Badge>
                        </SidebarMenuButton>
                      ) : (
                        <SidebarMenuButton asChild tooltip={item.note ?? item.title}>
                          {item.external ? (
                            <a href={item.href} rel="noreferrer">{body}</a>
                          ) : (
                            <Link href={item.href}>{body}</Link>
                          )}
                        </SidebarMenuButton>
                      )}
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter>
        <span className="text-muted-foreground px-2 text-[11px]">
          Fork it, pick a rung, eject the rest.
        </span>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
