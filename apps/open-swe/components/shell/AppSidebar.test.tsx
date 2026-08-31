// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { RUNGS, rungHref } from "@deepagents-nextjs/rungs";
import { SidebarProvider } from "@deepagents-nextjs/ui";

/**
 * THE PRIMARY NAVIGATION, RENDERED (#471).
 *
 * Until this file, the app shell's main nav had NO render test at all. Every
 * behavioural claim about it — which rungs appear, in what order, with what
 * href, described how — was held by source-level assertions and by whoever read
 * the diff. `nav.ts`'s `noteFor` shipped a user-visible wrong answer under
 * exactly that arrangement (#424): a rung with 248 files described as "not
 * present in this repo", found by someone editing an adjacent field rather than
 * by a test.
 *
 * It also gives `hrefFor` a runtime witness without exporting it. #425 replaced
 * the sidebar's `shape` comparisons with total dispatch, and the compile error
 * is the real guard there — but "the code cannot mis-bucket" and "the screen
 * shows the right thing" are different claims, and only one of them was checked.
 *
 * ASSERTED AGAINST THE MANIFEST, NOT AGAINST LITERALS. A hardcoded list of rung
 * ids would keep passing while describing a ladder this repo no longer has,
 * which is the failure mode the manifest exists to remove.
 */

let pathname = "/chat";
let search = new URLSearchParams();

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useSearchParams: () => search,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

beforeEach(() => {
  pathname = "/chat";
  search = new URLSearchParams();
  window.localStorage.clear();
  // SidebarProvider reads a media query on mount; jsdom has no implementation.
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (q: string) => ({
      matches: false,
      media: q,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
});

async function renderSidebar() {
  const { AppSidebar } = await import("./AppSidebar");
  return render(
    <SidebarProvider>
      <AppSidebar />
    </SidebarProvider>
  );
}

/** The nav item for a rung, found by its visible id rather than by position. */
function itemFor(id: string): HTMLElement {
  const label = screen.getAllByText(id).find((el) => el.tagName === "SPAN");
  expect(label, `no nav item rendered for rung "${id}"`).toBeDefined();
  const item = label!.closest("li");
  expect(item, `nav item for "${id}" is not inside a list item`).not.toBeNull();
  return item as HTMLElement;
}

const RUN_RUNGS = [...RUNGS]
  .filter((r) => r.shape !== "conversation")
  .sort((a, b) => a.ordinal - b.ordinal);

describe("which rungs the nav lists, and which it deliberately does not", () => {
  it("lists every non-conversation rung, in ordinal order, from the manifest", async () => {
    await renderSidebar();
    const ids = RUN_RUNGS.map((r) => r.id);
    const rendered = [...document.querySelectorAll("li span")]
      .map((s) => s.textContent ?? "")
      .filter((t) => (ids as readonly string[]).includes(t));
    expect(rendered).toEqual(ids);
    expect(ids.length).toBeGreaterThan(1);
  });

  /*
   * CONVERSATION RUNGS ARE ABSENT FROM THIS LIST ON PURPOSE, and pinning it is
   * the point: this app SERVES them, so they are reached through the chat
   * framework selector rather than by navigating to a rung. Asserting their
   * absence without the companion below would pass against a sidebar that had
   * stopped rendering rungs altogether.
   */
  it("omits conversation rungs from the rung groups — they are served, not navigated to", async () => {
    await renderSidebar();
    const conversation = RUNGS.filter((r) => r.shape === "conversation");
    expect(conversation.length).toBeGreaterThan(0);
    for (const rung of conversation) {
      const labels = screen
        .queryAllByText(rung.id)
        .filter((el) => el.closest("li") !== null);
      expect(labels, `"${rung.id}" appeared as a rung nav item`).toEqual([]);
    }
  });
});

describe("hrefFor, witnessed through what is rendered", () => {
  it("keeps a run rung whose origin IS this app on a local link", async () => {
    await renderSidebar();
    const local = RUN_RUNGS.filter(
      (r) => r.target.kind === "origin" && r.target.app === "open-swe"
    );
    // Measured, not assumed: the ladder currently declares NO off-origin rung,
    // so the external branch of hrefFor has no rung to exercise it. Asserting
    // "renders external links correctly" would have been a claim about a case
    // this manifest cannot produce — green, and describing nothing.
    expect(local.length).toBeGreaterThan(0);
    for (const rung of local) {
      // Narrowed rather than asserted: `route` exists only on the origin and
      // param variants, and the filter above has already established which one
      // this is. A cast here would compile past a manifest that changed shape.
      const target = rung.target;
      expect(target.kind).toBe("origin");
      if (target.kind !== "origin") continue;
      const link = within(itemFor(rung.id)).getByRole("link");
      expect(link.getAttribute("href")).toBe(target.route ?? "/");
      expect(link.getAttribute("target")).toBeNull();
    }
  });

  /*
   * #471 asked that each href resolve to what `rungHref` returns. Measured, the
   * two resolvers answer different questions and agree only here, where both say
   * there is nowhere to go: `rungHref` reports the LADDER's target, `hrefFor`
   * reports where THIS app sends you. Asserting agreement in general would have
   * pinned a relationship that does not hold.
   */
  it("agrees with rungHref where both say there is nowhere to go", async () => {
    await renderSidebar();
    const none = RUN_RUNGS.filter((r) => r.target.kind === "none");
    expect(none.length).toBeGreaterThan(0);
    for (const rung of none) {
      expect(rungHref(rung)).toBeNull();
      expect(within(itemFor(rung.id)).queryByRole("link")).toBeNull();
    }
  });
});

describe("a rung with no front door is not described as absent", () => {
  /*
   * THE CLAIM #471 NAMED, AND IT FAILS AGAINST THE SIDEBAR AS SHIPPED.
   *
   * `software-developer-agent` has `state: "implemented"` and owns 248 files. It
   * has no TARGET — there is nowhere in this app to send you — and rendering it
   * without a link is right. What is wrong is the description: the badge is the
   * hardcoded string "planned", so the nav tells a reader that a rung with 248
   * files in the tree is not built yet.
   *
   * Same defect as #424's `noteFor`, in a different file, found the same way it
   * was: by someone looking at the rendering rather than at the source. Having
   * no front door and not existing are different facts, and the nav conflated
   * them.
   */
  const noTarget = RUNGS.filter((r) => r.target.kind === "none");

  it("(control) there is such a rung, or the rest of this block is vacuous", () => {
    expect(noTarget.length).toBeGreaterThan(0);
  });

  it("does not claim a state the manifest does not declare", async () => {
    await renderSidebar();
    for (const rung of noTarget) {
      const text = itemFor(rung.id).textContent ?? "";
      expect(
        text,
        `the nav describes "${rung.id}" with a state the manifest does not ` +
          `declare: the manifest says state="${rung.state}". Having no target ` +
          `means no entry point in this app, not that the rung is unbuilt.`
      ).toContain(rung.state);
    }
  });

  it("still offers no link, because there is genuinely nowhere to go", async () => {
    await renderSidebar();
    for (const rung of noTarget) {
      expect(within(itemFor(rung.id)).queryByRole("link")).toBeNull();
    }
  });
});
