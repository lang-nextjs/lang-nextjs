"use client";

import { usePathname, useSearchParams } from "next/navigation";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@deepagents-nextjs/ui";
import { useConversations } from "../../lib/conversations";

/**
 * The top bar's crumb (#151).
 *
 * WHY THIS IS A COMPONENT AND NOT A PROP. It used to be
 * `<AppShell crumbs={["Lang-Next.js"]}>` — a hardcoded literal in the ROOT
 * layout, identical on every page, and a second copy of the product name the
 * sidebar already shows. Making it dynamic means reading the selected
 * conversation, which is client state, from a shell rendered by a SERVER
 * component.
 *
 * The bridge is this component rather than `"use client"` on the layout:
 * marking the layout would push the entire tree client-side for a breadcrumb.
 * A client leaf inside the server shell keeps the cost to the leaf.
 *
 * It reads `useSearchParams()`, so callers must keep it inside the shell's
 * Suspense boundary — the same constraint AppSidebar already has, and for the
 * same reason: without one, every prerendered page fails `next build`.
 */

/** Fallback when no conversation is selected — never the product name. */
function pageLabel(pathname: string): string {
  if (pathname === "/") return "Runs";
  if (pathname.startsWith("/runs")) return "Run";
  if (pathname.startsWith("/settings")) return "Settings";
  if (pathname.startsWith("/chat")) return "Chat";
  return "Lang-Next.js";
}

export function ShellCrumbs() {
  const pathname = usePathname() ?? "/";
  const params = useSearchParams();
  const { conversations } = useConversations();

  const selectedId = params?.get("c") ?? null;
  // Resolve through the live list rather than caching the title, so a rename
  // reaches the top bar on the same render that updates the sidebar.
  const selected = selectedId
    ? conversations.find((c) => c.id === selectedId)
    : undefined;

  const crumb = selected?.title ?? pageLabel(pathname);

  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbPage data-testid="shell-crumb">{crumb}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}
