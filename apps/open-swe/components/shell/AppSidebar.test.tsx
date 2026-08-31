// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
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

/**
 * WHICH TREE IS THIS, AND HOW WE KNOW IT WITHOUT ASKING THE MANIFEST TWICE.
 *
 * THIS FILE RUNS IN EVERY FORK. apps/open-swe's SHELL is shared — rung 4 owns
 * `app/runs/**`, `app/api/open-swe/**` and a list of named lib files, but NOT
 * `components/shell/**` — so ejecting to rung 1, 2 or 3 removes this app's run
 * surfaces and leaves this test running against a ladder with NO run rungs at
 * all. In such a tree every assertion below is legitimately vacuous, and a
 * floor demanding otherwise asserts something FALSE about a correct fork.
 *
 * That is what turned four eject cells red: not a component defect and not an
 * expectation hardcoded to the full ladder — the expectations were already
 * derived from the manifest and `toEqual` passed in every cell — but the
 * anti-vacuity floors, which could not tell a legitimately-low fork from a
 * broken fixture. Both present as zero.
 *
 * So they are told apart by an INDEPENDENT WITNESS. Deciding purely from the
 * manifest would put one source on both sides: a stale generated.ts reporting
 * zero rungs would SKIP rather than fail, which is the failure
 * chat-settings.spec.ts already records surviving in a branch. eject deletes
 * files, so the filesystem is evidence the manifest cannot fake, and the two
 * must AGREE.
 */
/**
 * The workspace root, FOUND rather than assumed.
 *
 * This was `new URL("../../../../" + rel, import.meta.url)`, which resolves
 * correctly against the real file path and NOT under vitest — measured, both
 * witnesses reported ABSENT on a full ladder where both directories exist.
 *
 * That bug matters more than the fix, because of the SHAPE it had.
 * `existsSync` on a WRONG path and `existsSync` on a CORRECT path to a deleted
 * file both return false. So a path error reads as "eject removed this rung",
 * which is precisely the conflation this witness exists to prevent — one level
 * down, inside the mechanism doing the preventing.
 *
 * So the root is located by walking up for pnpm-workspace.yaml, and NOT FINDING
 * IT THROWS. A witness that cannot say where it looked is not evidence.
 */
function workspaceRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `could not locate pnpm-workspace.yaml above ${process.cwd()} — the filesystem witness cannot resolve, and every "ABSENT" below would be a fact about this lookup rather than about the tree.`
  );
}

const ROOT = workspaceRoot();
const repoPath = (rel: string) => join(ROOT, rel);

/** Rung 4's run surface. Deleted by eject at rungs 1-3, present at 4 and 5. */
const RUN_SURFACE_ON_DISK = existsSync(repoPath("apps/open-swe/app/runs"));
/** Rung 5's tree. Deleted by eject at rungs 1-4, present only on the full ladder. */
const RUNG5_ON_DISK = existsSync(repoPath("rungs/5-software-developer-agent"));

/** Run rungs whose front door is this app. Empty below rung 4. */
const LOCAL_ORIGIN_RUNGS = RUN_RUNGS.filter(
  (r) => r.target.kind === "origin" && r.target.app === "open-swe"
);
/** Rungs declared with no target at all. Empty below rung 5. */
const NO_TARGET_RUNGS = RUNGS.filter((r) => r.target.kind === "none");

describe("the tree this test is running in", () => {
  /*
   * RUNS FIRST AND UNCONDITIONALLY. Every skip below is justified by one of
   * these two facts, so if the facts themselves are wrong the skips are
   * unearned and this must say so before anything else reports green.
   */
  it("has a manifest at all", () => {
    // A fork always retains at least the rung it was ejected to. Zero means the
    // manifest failed to load or generated.ts is stale — which would otherwise
    // present exactly like a low fork and skip the whole file.
    expect(
      RUNGS.length,
      "the manifest declares ZERO rungs. That is not a fork, it is a broken or stale @deepagents-nextjs/rungs build, and every skip below would be unearned."
    ).toBeGreaterThan(0);
  });

  it("the manifest and the filesystem agree about rung 4's run surface", () => {
    expect(
      LOCAL_ORIGIN_RUNGS.length > 0,
      `the manifest declares ${
        LOCAL_ORIGIN_RUNGS.length
      } run rung(s) targeting this app, but apps/open-swe/app/runs is ${
        RUN_SURFACE_ON_DISK ? "PRESENT" : "ABSENT"
      } on disk. One of the two is stale; they are severed together or not at all.`
    ).toBe(RUN_SURFACE_ON_DISK);
  });

  it("the manifest and the filesystem agree about rung 5", () => {
    expect(
      NO_TARGET_RUNGS.length > 0,
      `the manifest declares ${
        NO_TARGET_RUNGS.length
      } rung(s) with no target, but rungs/5-software-developer-agent is ${
        RUNG5_ON_DISK ? "PRESENT" : "ABSENT"
      } on disk. One of the two is stale.`
    ).toBe(RUNG5_ON_DISK);
  });
});

describe("which rungs the nav lists, and which it deliberately does not", () => {
  it("lists every non-conversation rung, in ordinal order, from the manifest", async () => {
    await renderSidebar();
    const ids = RUN_RUNGS.map((r) => r.id);
    const rendered = [...document.querySelectorAll("li span")]
      .map((s) => s.textContent ?? "")
      .filter((t) => (ids as readonly string[]).includes(t));
    // `toEqual` is the assertion, and it holds in every fork — including one
    // where both sides are empty, which is the correct rendering of a ladder
    // with no run rungs. The floor that used to sit here demanded MORE THAN ONE
    // run rung, which is false at rung 4 (one) and at rungs 1-3 (none). The
    // non-vacuity it was protecting is now asserted once, against the
    // filesystem, in "the tree this test is running in" above.
    expect(rendered).toEqual(ids);
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
  // SKIPPED, WITH A REASON, IN A FORK BELOW RUNG 4 — where no rung targets this
  // app, so there is nothing for this to witness. Conditional on the filesystem
  // agreement established above, not on the manifest alone.
  it.skipIf(LOCAL_ORIGIN_RUNGS.length === 0)(
    "keeps a run rung whose origin IS this app on a local link",
    async () => {
      await renderSidebar();
      const local = LOCAL_ORIGIN_RUNGS;
      // Measured, not assumed: the ladder currently declares NO off-origin rung,
      // so the external branch of hrefFor has no rung to exercise it. Asserting
      // "renders external links correctly" would have been a claim about a case
      // this manifest cannot produce — green, and describing nothing.
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
    }
  );

  /*
   * #471 asked that each href resolve to what `rungHref` returns. Measured, the
   * two resolvers answer different questions and agree only here, where both say
   * there is nowhere to go: `rungHref` reports the LADDER's target, `hrefFor`
   * reports where THIS app sends you. Asserting agreement in general would have
   * pinned a relationship that does not hold.
   */
  // Below rung 5 there is no targetless rung, so this has nothing to compare.
  it.skipIf(NO_TARGET_RUNGS.length === 0)(
    "agrees with rungHref where both say there is nowhere to go",
    async () => {
      await renderSidebar();
      const none = NO_TARGET_RUNGS;
      for (const rung of none) {
        expect(rungHref(rung)).toBeNull();
        expect(within(itemFor(rung.id)).queryByRole("link")).toBeNull();
      }
    }
  );
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
  const noTarget = NO_TARGET_RUNGS;

  /*
   * THE CONTROL MOVED RATHER THAN VANISHED.
   *
   * It used to be `expect(noTarget.length).toBeGreaterThan(0)` here, and it was
   * doing real work: both tests below LOOP over noTarget, so with an empty list
   * they iterate zero times and pass having checked nothing. That is exactly
   * what a control is for.
   *
   * But it was unconditional, and below rung 5 the list is legitimately empty —
   * so it failed four eject cells for being right about a tree where being
   * right is not a defect. The same protection now lives in "the tree this test
   * is running in", where emptiness is cross-checked against the filesystem: an
   * empty list with rungs/5-software-developer-agent still on disk fails, an
   * empty list in a tree where eject removed it skips with a reason.
   */
  it.skipIf(noTarget.length === 0)(
    "does not claim a state the manifest does not declare",
    async () => {
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
    }
  );

  it.skipIf(noTarget.length === 0)(
    "still offers no link, because there is genuinely nowhere to go",
    async () => {
      await renderSidebar();
      for (const rung of noTarget) {
        expect(within(itemFor(rung.id)).queryByRole("link")).toBeNull();
      }
    }
  );
});
