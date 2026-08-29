import { RUNG_BY_ID } from "@deepagents-nextjs/rungs";

/**
 * WHERE THE QUEUE BOARD LIVES — read from the manifest, not repeated (#154).
 *
 * The board moved from `/` to `/runs`, and the dangerous part was not the move.
 * It was that `/` KEPT WORKING: the run detail page's back arrow said
 * `href="/"` meaning "back to the board", and after the move that silently
 * became "go to the chat" while still rendering a perfectly plausible back
 * arrow. A mutation planting exactly that passed all 904 unit tests.
 *
 * So the literal is gone rather than merely corrected. `rungs.json` already
 * declares this route — it is what apps/example uses to link here across
 * origins — which makes any second spelling of it a copy that can drift.
 */
function boardRoute(): string {
  const t = RUNG_BY_ID["open-swe"].target;
  // The fallback is unreachable for the manifest we ship and is asserted so in
  // lib/routes.test.ts, which compares this against the declared value rather
  // than against a literal. A bare `as` here would assert the very thing that
  // file exists to check.
  return t.kind === "origin" && t.route ? t.route : "/runs";
}

export const BOARD_ROUTE = boardRoute();
