import { describe, it, expect } from "vitest";
import { isConversationRoute } from "./AppSidebar";

/**
 * #154 — THE TRAP IN THE OBVIOUS EDIT.
 *
 * The sidebar marked a conversation rung active with
 * `pathname.startsWith(CONVERSATION_ROUTE)`. That was correct while the
 * constant was "/chat". Moving the chat to the front door turns the same line
 * into `pathname.startsWith("/")`, which is TRUE FOR EVERY PATH — so the board
 * and the settings page would both light up a conversation rung as active.
 *
 * The mechanical find-and-replace is the one that breaks this, and it breaks
 * it in the direction that still renders something plausible: a highlighted
 * row is not a crash, and nobody reads a nav highlight as a bug report.
 */
describe("isConversationRoute", () => {
  it("the front door IS the conversation surface", () => {
    expect(isConversationRoute("/")).toBe(true);
  });

  it("so is its former address, which is still routable", () => {
    expect(isConversationRoute("/chat")).toBe(true);
  });

  it.each(["/runs", "/runs/abc", "/settings"])(
    "%s is NOT — this is what startsWith('/') would have got wrong",
    (path) => {
      expect(isConversationRoute(path)).toBe(false);
    }
  );

  it("is not simply always-false, which would satisfy the cases above", () => {
    // The companion assertion. "These paths are not conversation routes" is
    // fully satisfied by a predicate that never returns true — and that
    // version highlights nothing, ever, which is the opposite failure.
    expect([isConversationRoute("/"), isConversationRoute("/chat")]).toContain(
      true
    );
  });
});
