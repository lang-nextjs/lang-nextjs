import type { Rung } from "@deepagents-nextjs/rungs";
import ChatSurface from "../../app/page";

/**
 * THE SEAM between the shape-routed shell and the conversation surface.
 *
 * WHAT WORKS TODAY: the route resolves the rung from the URL segment, rejects
 * an unknown id with a real 404, and dispatches by shape — so a `run` rung
 * never mounts this component and a `conversation` rung never mounts a run
 * departure. That dispatch is complete.
 *
 * WHERE IT STOPS, stated plainly rather than left for someone to discover:
 * `app/page.tsx` currently exports `ChatPage()` with NO props, so the rung is
 * resolved and validated but NOT yet APPLIED to the surface. `/r/langchain` and
 * `/r/langgraph` render the same default-configured surface today.
 *
 * That is exactly the failure this issue exists to prevent — a nav whose
 * entries all mount one shell passes "the nav renders" and violates "the shell
 * routes by shape" — so it is deliberately isolated HERE, in one component with
 * one import, rather than spread through the route.
 *
 * CLOSING IT IS A TWO-LINE CHANGE, and the contract is already agreed with the
 * owner of page.tsx (DEV9, #6 severability half):
 *
 *     import { ConversationSurface } from "./ConversationSurface";
 *     return <ConversationSurface initialRung={rung.id} />;
 *
 * `ConversationSurface({ initialRung?: string })` falls back to the default on
 * an unknown or absent id — and its default is the highest-ordinal selectable
 * rung the manifest declares, not a hardcoded "deepagents", so an ejected
 * rung-1 fork opens on a rung that actually exists there.
 */
export function ConversationMount({ rung }: { rung: Rung }) {
  // rung is intentionally referenced so this does not silently drift into an
  // unused-parameter component that looks wired and is not.
  void rung;
  return <ChatSurface />;
}
