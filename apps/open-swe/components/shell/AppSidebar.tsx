"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import {
  ListChecks,
  MessageSquare,
  MessageSquarePlus,
  Pencil,
  Settings2,
  Trash2,
} from "lucide-react";
import { RUNGS } from "@deepagents-nextjs/rungs";
import {
  defaultNewChatFramework,
  newConversationId,
  useConversations,
} from "../../lib/conversations";
import {
  Badge,
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuAction,
  SidebarMenuItem,
  SidebarRail,
} from "@deepagents-nextjs/ui";

/**
 * dashboard-01's app sidebar, DERIVED FROM THE RUNG MANIFEST.
 *
 * REPLACES DemoNav, which was a sticky tab bar painting itself from the stock
 * Tailwind palette — a raw hex canvas, a fixed neutral border, and a neutral
 * text ramp — none of which the theme can reach. Nine of this app's 237
 * palette findings lived in that one file.
 *
 * The old class names are described here rather than quoted, deliberately:
 * a line-oriented palette scan cannot tell a quotation from an invocation,
 * so a comment naming them would be a finding in the file that removed them.
 *
 * IT ALSO REPLACES A HARDCODED PAIR. The first version of this file listed two
 * entries — Live Chat and Queue — which is a second list beside rungs.json and
 * silently omitted the two rungs it did not know about. The ladder has five
 * steps; a nav that enumerates them will always be one merge behind.
 *
 * HREFS ARE COMPUTED FROM THIS APP'S VANTAGE, NOT example's. apps/example has
 * a `rungHref()` that resolves open-swe as a cross-origin departure — correct
 * there and exactly inverted here, where open-swe is local and the
 * conversation rungs are the remote ones. Sharing that helper would have
 * imported the wrong perspective, which is why this derives its own.
 */
/**
 * THE CHAT IS THE FRONT DOOR (#154).
 *
 * It used to be `/chat` while `/` served the queue board. The board is a
 * rung-4 feature, so the shared shell's entry point was a surface only rungs 4
 * and 5 possess — a shared shell whose front door belongs to one rung is not
 * shared. What every rung on the ladder has is the chat.
 */
const CONVERSATION_ROUTE = "/";

/** The address the chat used to live at, still routable. See app/chat/page.tsx. */
const CONVERSATION_ROUTE_LEGACY = "/chat";

/**
 * Is this pathname the conversation surface?
 *
 * A FUNCTION, AND NOT `pathname.startsWith(CONVERSATION_ROUTE)`, WHICH IS WHAT
 * THE OLD CODE DID. That test was correct while the constant was "/chat" and
 * becomes catastrophic the moment it is "/": every path starts with "/", so
 * `/runs` and `/settings` would both mark a conversation rung active. The
 * mechanical find-and-replace is the one that breaks this, and it breaks it in
 * the direction that still renders something plausible.
 */
export function isConversationRoute(pathname: string): boolean {
  return (
    pathname === CONVERSATION_ROUTE || pathname === CONVERSATION_ROUTE_LEGACY
  );
}

/** Where this app sends a rung, from where this app is standing. */
function hrefFor(rung: (typeof RUNGS)[number]): {
  href: string | null;
  external: boolean;
} {
  // Rung 5 is declared in the ladder with no target at all. A dead link would
  // be worse than an honest "unavailable", so it gets no href.
  if (rung.target.kind === "none") return { href: null, external: false };

  // This app serves every conversation rung itself, on one route selected by a
  // query param — the same "one surface, parameterised" shape the manifest
  // describes, hosted here rather than on the example origin.
  if (rung.shape === "conversation")
    return {
      href: `${CONVERSATION_ROUTE}?framework=${encodeURIComponent(rung.id)}`,
      external: false,
    };

  // A run-shaped rung whose origin IS this app resolves to a local route.
  if (rung.target.kind === "origin" && rung.target.app === "open-swe")
    return { href: rung.target.route ?? "/", external: false };

  // Any other origin is a genuine departure.
  if (rung.target.kind === "origin") {
    const base =
      (rung.target.originEnv
        ? process.env[rung.target.originEnv as keyof typeof process.env]
        : undefined) ??
      rung.target.originFallback ??
      "";
    return { href: `${base}${rung.target.route ?? "/"}`, external: true };
  }

  return { href: null, external: false };
}

const GROUP_LABEL: Record<string, string> = {
  conversation: "Conversation",
  run: "Runs",
};

export function AppSidebar() {
  const pathname = usePathname() ?? "/";
  const params = useSearchParams();
  const router = useRouter();
  const activeFramework = params?.get("framework") ?? null;
  const activeConversation = params?.get("c") ?? null;
  const { conversations, upsert, remove, rename } = useConversations();

  /**
   * Inline rename state (#151). `renamingId` is the row being edited; `draft`
   * is the uncommitted text. Escape cancels, Enter and blur commit.
   *
   * A rejected rename (empty/whitespace) keeps the editor OPEN rather than
   * silently reverting: a rename that vanishes looks identical to one that
   * saved, and the user has no way to tell which happened.
   */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  function startRename(id: string, current: string) {
    setRenamingId(id);
    setDraft(current);
  }

  function commitRename(id: string) {
    if (rename(id, draft).ok) setRenamingId(null);
    // else: keep editing — the title was blank and nothing was stored.
  }

  /**
   * New chat starts on DeepAgents — the most capable rung, which is a
   * different question from the ladder order the Conversation group uses.
   * The framework is then changeable from the toolbar under the composer;
   * this only picks where you land.
   */
  function newChat() {
    const id = newConversationId();
    const framework = defaultNewChatFramework();
    upsert({
      id,
      title: "New chat",
      framework,
      updatedAt: new Date().toISOString(),
    });
    router.push(
      `/chat?framework=${encodeURIComponent(framework)}&c=${encodeURIComponent(id)}`
    );
  }

  /*
   * CONVERSATION RUNGS ARE NOT NAV ENTRIES.
   *
   * They were, and it was wrong once New Chat and history existed: langchain /
   * langgraph / deepagents are a PROPERTY of a conversation, chosen from the
   * toolbar under the composer, not three places you can go. Listing them as
   * destinations put the same three names in the sidebar as in the Framework
   * row and made "which one am I on" ambiguous.
   *
   * Run-shaped rungs stay — those genuinely are separate surfaces with their
   * own routes. The grouping is still derived from `shape`, so a new shape in
   * the manifest appears without editing this file.
   */
  const groups = new Map<string, (typeof RUNGS)[number][]>();
  for (const rung of [...RUNGS]
    .filter((r) => r.shape !== "conversation")
    .sort((a, b) => a.ordinal - b.ordinal)) {
    const list = groups.get(rung.shape);
    if (list) list.push(rung);
    else groups.set(rung.shape, [rung]);
  }

  return (
    <Sidebar variant="inset" collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              {/* The front door, which is now the chat rather than the board. */}
              <Link href="/">
                <span className="bg-primary text-primary-foreground grid size-8 shrink-0 place-items-center rounded-lg text-sm font-bold">
                  ◇
                </span>
                <span className="font-semibold">Lang-Next.js</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {/* Primary action, above the ladder — it is what you do, not where you go. */}
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  onClick={newChat}
                  data-testid="new-chat"
                  tooltip="New chat"
                  className="bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground"
                >
                  <MessageSquarePlus />
                  <span>New Chat</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/*
         * HISTORY, AND HONEST ABOUT ITS LIMIT. Selecting a conversation
         * restores its SETTINGS — session id and framework — not its messages.
         * `useDeepAgentsChat` has no `initialMessages` and nothing in the chain
         * persists a transcript, so the message list starts empty. See #122.
         */}
        <SidebarGroup>
          <SidebarGroupLabel>Conversations</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu data-testid="conversation-list">
              {conversations.length === 0 ? (
                <p className="text-muted-foreground px-2 py-1 text-xs group-data-[collapsible=icon]:hidden">
                  No conversations yet
                </p>
              ) : (
                conversations.map((c) => (
                  <SidebarMenuItem key={c.id}>
                    {renamingId === c.id ? (
                      <div className="flex items-center gap-2 px-2 py-1.5">
                        <MessageSquare className="size-4 shrink-0" />
                        <input
                          autoFocus
                          value={draft}
                          data-testid={`rename-input-${c.id}`}
                          aria-label={`Rename ${c.title}`}
                          onChange={(e) => setDraft(e.target.value)}
                          onBlur={() => commitRename(c.id)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              commitRename(c.id);
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              setRenamingId(null);
                            }
                          }}
                          className="bg-background text-foreground min-w-0 flex-1 rounded border px-1 text-sm outline-none"
                        />
                      </div>
                    ) : (
                      <>
                        <SidebarMenuButton
                          asChild
                          isActive={activeConversation === c.id}
                          tooltip={`${c.title} — ${c.framework}`}
                        >
                          <Link
                            href={`/?framework=${encodeURIComponent(c.framework)}&c=${encodeURIComponent(c.id)}`}
                            onDoubleClick={(e) => {
                              e.preventDefault();
                              startRename(c.id, c.title);
                            }}
                          >
                            <MessageSquare />
                            <span className="truncate">{c.title}</span>
                          </Link>
                        </SidebarMenuButton>
                        <SidebarMenuAction
                          onClick={() => startRename(c.id, c.title)}
                          aria-label={`Rename ${c.title}`}
                          title="Rename conversation"
                          data-testid={`rename-${c.id}`}
                          className="right-8"
                          showOnHover
                        >
                          <Pencil />
                        </SidebarMenuAction>
                        <SidebarMenuAction
                          onClick={() => remove(c.id)}
                          aria-label={`Delete ${c.title}`}
                          title="Delete conversation"
                          showOnHover
                        >
                          <Trash2 />
                        </SidebarMenuAction>
                      </>
                    )}
                  </SidebarMenuItem>
                ))
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {[...groups.entries()].map(([shape, rungs]) => (
          <SidebarGroup key={shape}>
            <SidebarGroupLabel>{GROUP_LABEL[shape] ?? shape}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {rungs.map((rung) => {
                  const { href, external } = hrefFor(rung);
                  const Icon =
                    rung.shape === "conversation" ? MessageSquare : ListChecks;

                  const active =
                    href !== null &&
                    !external &&
                    (rung.shape === "conversation"
                      ? isConversationRoute(pathname) &&
                        activeFramework === rung.id
                      : pathname === href);

                  return (
                    <SidebarMenuItem key={rung.id}>
                      {href === null ? (
                        // Declared, unavailable, and honest about it.
                        <SidebarMenuButton
                          disabled
                          tooltip={`${rung.id} — declared in the ladder, no target in this repo`}
                          className="opacity-50"
                        >
                          <Icon />
                          <span>{rung.id}</span>
                          <Badge
                            variant="outline"
                            className="ml-auto text-[10px]"
                          >
                            planned
                          </Badge>
                        </SidebarMenuButton>
                      ) : (
                        <SidebarMenuButton
                          asChild
                          isActive={active}
                          tooltip={rung.id}
                        >
                          <Link
                            href={href}
                            {...(external
                              ? { target: "_blank", rel: "noreferrer" }
                              : {})}
                          >
                            <Icon />
                            <span>{rung.id}</span>
                            {external && (
                              <span className="text-muted-foreground ml-auto text-[10px]">
                                ↗
                              </span>
                            )}
                          </Link>
                        </SidebarMenuButton>
                      )}
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}

        {/*
         * NOT A RUNG, AND IN ITS OWN GROUP FOR THAT REASON. apps/example keeps
         * its harnesses separate on the same principle: folding a non-rung
         * route in beside the ladder would imply the ladder has six steps. This
         * route is also absent from `owns` in the manifest by design — it is
         * app chrome, not a step.
         */}
        <SidebarGroup>
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={pathname === "/settings"}
                  tooltip="Workspace settings"
                >
                  <Link href="/settings">
                    <Settings2 />
                    <span>Settings</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarRail />
    </Sidebar>
  );
}
