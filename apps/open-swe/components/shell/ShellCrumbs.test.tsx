// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { CONVERSATIONS_KEY } from "../../lib/conversations";

/**
 * THE CRUMB THE TOP BAR ACTUALLY RENDERS (#151).
 *
 * Before this, `layout.tsx` passed `crumbs={["Lang-Next.js"]}` — a hardcoded
 * literal in the ROOT layout, identical on every page, and a second copy of the
 * product name the sidebar already shows two inches away.
 *
 * These assert the rendered crumb rather than the helper, because the helper
 * was never the broken part: there was no helper, there was a constant. A test
 * of `pageLabel()` in isolation could not fail on "the top bar ignores your
 * conversation", which is the actual defect.
 *
 * ASSERT THE POSITIVE CLAIM (#140): each case pins the string that SHOULD be
 * there. "does not say Lang-Next.js" would pass against a component that
 * rendered nothing at all.
 */

let pathname = "/chat";
let search = new URLSearchParams();

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useSearchParams: () => search,
}));

import { ShellCrumbs } from "./ShellCrumbs";

function seed(conversations: unknown[]) {
  window.localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(conversations));
}

const CONV = {
  id: "c1",
  title: "Auth work",
  framework: "deepagents",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("ShellCrumbs (#151)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    pathname = "/chat";
    search = new URLSearchParams();
  });

  it("shows the selected conversation's title", async () => {
    seed([CONV]);
    search = new URLSearchParams("c=c1");
    render(<ShellCrumbs />);
    expect((await screen.findByTestId("shell-crumb")).textContent).toBe(
      "Auth work"
    );
  });

  it("reflects a RENAME without a reload — it reads the live list, not a cached title", async () => {
    seed([{ ...CONV, title: "Renamed later" }]);
    search = new URLSearchParams("c=c1");
    render(<ShellCrumbs />);
    expect((await screen.findByTestId("shell-crumb")).textContent).toBe(
      "Renamed later"
    );
  });

  it.each([
    ["/", "Runs"],
    ["/runs/abc", "Run"],
    ["/settings", "Settings"],
    ["/chat", "Chat"],
  ])("with nothing selected, %s shows %j", async (path, expected) => {
    pathname = path;
    render(<ShellCrumbs />);
    expect((await screen.findByTestId("shell-crumb")).textContent).toBe(
      expected
    );
  });

  it("never renders the product name as the crumb — the sidebar already shows it", async () => {
    // Paired with the positive assertions above so this is a genuine extra
    // constraint rather than the whole claim: a component rendering nothing
    // would satisfy this line alone.
    for (const p of ["/", "/chat", "/settings", "/runs/x"]) {
      pathname = p;
      const { unmount } = render(<ShellCrumbs />);
      const el = await screen.findByTestId("shell-crumb");
      expect(el.textContent).toBeTruthy();
      expect(el.textContent).not.toBe("Lang-Next.js");
      unmount();
    }
  });

  it("falls back to the page label when the id in the URL matches nothing", async () => {
    seed([CONV]);
    search = new URLSearchParams("c=does-not-exist");
    render(<ShellCrumbs />);
    expect((await screen.findByTestId("shell-crumb")).textContent).toBe("Chat");
  });
});
