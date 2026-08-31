// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ShellScroller } from "./ShellScroller";

/**
 * BOTH BRANCHES, BECAUSE A CONDITIONAL WITH ONE TESTED BRANCH IS A COIN FLIP (#486).
 *
 * The scroller is focusable exactly when it overflows. That is two behaviours, and asserting
 * only the one that motivated the change leaves the other free to drift — which is how #451's
 * fix became #486's defect in the first place: the remedy was correct where it was measured
 * and nobody measured where it was not.
 *
 * jsdom does no layout, so `scrollHeight` and `clientHeight` are both 0 and every element
 * "fits". That is the NON-overflowing branch for free, and it means the overflowing branch has
 * to be built deliberately rather than hoped for — a test that never enters it would pass
 * against a component that is never focusable at all.
 */

/** Make the next rendered scroller believe its content is taller than its box. */
function withOverflow(scrollHeight: number, clientHeight: number) {
  const original = {
    scrollHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight"),
    clientHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight"),
  };
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => clientHeight });
  return () => {
    if (original.scrollHeight) Object.defineProperty(HTMLElement.prototype, "scrollHeight", original.scrollHeight);
    if (original.clientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", original.clientHeight);
  };
}

afterEach(cleanup);

describe("ShellScroller", () => {
  it("does NOT overflow: no tab stop, no role, no name — and still renders its content", () => {
    render(<ShellScroller><p>page body</p></ShellScroller>);

    // PRESENCE COMPANION FIRST. "there is no region" passes against a component that rendered
    // nothing at all, so pin what IS there before asserting what is not.
    const body = screen.getByText("page body");
    const scroller = body.parentElement!;

    expect(scroller.className).toContain("overflow-y-auto");
    expect(scroller.getAttribute("tabindex")).toBeNull();
    expect(scroller.getAttribute("role")).toBeNull();
    expect(scroller.getAttribute("aria-label")).toBeNull();
    // The whole complaint in #486, stated as an assertion: nothing here is a focus stop.
    expect(screen.queryAllByRole("region")).toHaveLength(0);
  });

  it("DOES overflow: a tab stop that announces itself", () => {
    const restore = withOverflow(2000, 500);
    try {
      render(<ShellScroller><p>page body</p></ShellScroller>);

      // Found BY ROLE AND NAME, which is what a screen-reader user actually has. Reading the
      // attributes off the div would pass on a region whose name never reaches the a11y tree.
      const region = screen.getByRole("region", { name: "Page content" });
      expect(region.className).toContain("overflow-y-auto");
      expect(region.getAttribute("tabindex")).toBe("0");
      expect(region.contains(screen.getByText("page body"))).toBe(true);
    } finally {
      restore();
    }
  });

  it("the name and the tab stop arrive together, never one without the other", () => {
    /*
     * THE PAIRING IS THE POINT (#486). A focus stop with no name is the defect being fixed; a
     * name on something unreachable is decoration. Asserting them in one place stops a future
     * change from keeping one and dropping the other, which both branches above would still
     * pass individually.
     */
    for (const [scrollH, clientH, focusable] of [[2000, 500, true], [500, 500, false]] as const) {
      const restore = withOverflow(scrollH, clientH);
      try {
        render(<ShellScroller><p>body</p></ShellScroller>);
        const el = screen.getByText("body").parentElement!;
        const hasStop = el.getAttribute("tabindex") === "0";
        const hasName = el.getAttribute("aria-label") !== null && el.getAttribute("role") === "region";
        expect(hasStop).toBe(focusable);
        expect(hasName).toBe(hasStop);
      } finally {
        restore();
        cleanup();
      }
    }
  });
});
