// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import {
  CONVERSATIONS_KEY,
  __subscriberCountForTests,
  useConversations,
  type Conversation,
} from "./conversations";

/**
 * TWO `useConversations()` IN ONE TAB MUST AGREE.
 *
 * The `storage` event DOES NOT FIRE IN THE TAB THAT WROTE — that is the DOM
 * spec, not a quirk. So the hook's cross-tab sync covered every case except the
 * one the app actually has: `AppSidebar` and `ShellCrumbs` both call this hook,
 * in the same document, and neither learned about the other's writes.
 *
 * The visible symptom was #129 part 3 — the top bar never showed a
 * conversation's title, and a rename reached the sidebar and not the crumb —
 * under a ShellCrumbs comment asserting the opposite.
 *
 * This is the cheap, deterministic form of the e2e that caught it.
 */

const CONV: Conversation = {
  id: "c1",
  title: "First name",
  framework: "langchain",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

/** Two independent consumers, exactly as the shell mounts them. */
function Writer() {
  const { upsert } = useConversations();
  return (
    <button data-testid="write" onClick={() => upsert(CONV)}>
      write
    </button>
  );
}

function Reader() {
  const { conversations } = useConversations();
  return (
    <span data-testid="reader">
      {conversations.map((c) => c.title).join(",") || "(empty)"}
    </span>
  );
}

function Renamer({ to }: { to: string }) {
  const { rename } = useConversations();
  return (
    <button data-testid={`rename-${to}`} onClick={() => rename("c1", to)}>
      rename
    </button>
  );
}

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("same-tab fanout", () => {
  it("a write in one consumer reaches another mounted beside it", () => {
    render(
      <>
        <Writer />
        <Reader />
      </>
    );
    expect(screen.getByTestId("reader").textContent).toBe("(empty)");

    act(() => {
      screen.getByTestId("write").click();
    });

    // Before the fix this stayed "(empty)" forever: the Reader had read once at
    // mount, and `storage` never fires for a write made in the same document.
    expect(screen.getByTestId("reader").textContent).toBe("First name");
  });

  it("a RENAME reaches the other consumer too, not just the first write", () => {
    // The second write is the one that matters. A consumer that happened to
    // re-read for some unrelated reason could pass the test above by luck; a
    // rename with everything already mounted cannot.
    render(
      <>
        <Writer />
        <Renamer to="Second name" />
        <Reader />
      </>
    );
    act(() => screen.getByTestId("write").click());
    expect(screen.getByTestId("reader").textContent).toBe("First name");

    act(() => screen.getByTestId("rename-Second name").click());
    expect(screen.getByTestId("reader").textContent).toBe("Second name");
  });

  it("the store is still what was written — the fanout does not replace persistence", () => {
    render(
      <>
        <Writer />
        <Reader />
      </>
    );
    act(() => screen.getByTestId("write").click());
    const raw = window.localStorage.getItem(CONVERSATIONS_KEY);
    expect(raw, "nothing was persisted").toBeTruthy();
    expect(raw!).toContain("First name");
  });

  it("unmounting REMOVES the subscriber — the set returns to where it started", () => {
    /*
     * MEASURED, because it is otherwise unobservable. React 19 no longer warns
     * on setState-after-unmount, so a subscriber left behind leaks silently and
     * grows with every mount. The first version of this test asserted
     * `expect(true).toBe(true)` and survived a mutation that removed the
     * cleanup entirely — a check naming a property it could not fail on.
     */
    const before = __subscriberCountForTests();
    const a = render(<Reader />);
    const b = render(<Writer />);
    expect(__subscriberCountForTests()).toBe(before + 2);
    a.unmount();
    b.unmount();
    expect(__subscriberCountForTests()).toBe(before);
  });
});
