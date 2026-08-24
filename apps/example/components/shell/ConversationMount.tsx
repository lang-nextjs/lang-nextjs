import type { Rung } from "@deepagents-nextjs/rungs";
import { ConversationSurface } from "../ConversationSurface";

/**
 * The seam between the shape-routed shell and the conversation surface.
 *
 * The route resolves a rung from the URL segment, rejects an unknown id with a
 * real 404, and dispatches by shape — so a `run` rung never reaches here and a
 * `conversation` rung never reaches the run departure. This applies the rung it
 * resolved.
 *
 * WHY THIS IS A SEPARATE COMPONENT rather than two lines inside the route:
 * for a while it could not apply the rung at all. `app/page.tsx` exported a
 * surface that took no props, so `/r/langchain` and `/r/deepagents` resolved,
 * dispatched correctly, and rendered byte-identical pages — the rung was
 * validated and discarded. That is the failure this issue exists to prevent: a
 * nav whose entries all mount one shell satisfies "the nav renders" and
 * violates "the shell routes by shape". Keeping it in one component with one
 * import meant the gap was a single known line rather than a property spread
 * across the route, and closing it changed exactly that line.
 *
 * `initialRung` is validated by ConversationSurface against the adapters the
 * manifest actually declares, and falls back to the default when it does not
 * match — so an ejected fork that no longer has this rung opens on one it does
 * have, rather than on nothing.
 */
export function ConversationMount({ rung }: { rung: Rung }) {
  return <ConversationSurface initialRung={rung.id} />;
}
