import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { RUNGS, RUNG_BY_ID } from "@deepagents-nextjs/rungs";

/**
 * THE MANIFEST'S ROUTE AND THE FILESYSTEM MUST AGREE (#154).
 *
 * `rungs.json` declares where each rung lives, and `rungHref()` in
 * packages/rungs builds `${origin}${target.route}` from it. That is not a note
 * for humans — it is what apps/example uses to link ACROSS ORIGINS to this
 * app's queue board.
 *
 * So moving the board from `/` to `/runs` without editing the manifest would
 * have left example's "Open SWE" nav item pointing at this app's front door,
 * which after #154 serves the CHAT. Every link would resolve, every page would
 * render, and the destination would silently be the wrong surface — a
 * consequence invisible from inside apps/open-swe, where nothing reads that
 * field for a local route except the sidebar.
 *
 * Nothing checked this. The two facts were coupled by nobody noticing.
 */

const APP_DIR = join(__dirname, "..", "app");

/** Does Next serve this pathname from this app's `app/` directory? */
function hasRoute(route: string): boolean {
  const segments = route.split("/").filter(Boolean);
  return existsSync(join(APP_DIR, ...segments, "page.tsx"));
}

describe("#154 — a rung served BY THIS APP declares a route this app has", () => {
  // Derived from the manifest rather than naming open-swe, so a fork that adds
  // a run-shaped rung here is covered without editing this file — and a fork
  // that ejects open-swe stops asserting anything about it rather than failing.
  // flatMap rather than filter: inside the ternary TypeScript narrows
  // `target` to the origin variant, so `route` is reachable without a cast.
  // A filter would need `as`, and a cast here would be asserting exactly the
  // thing this file exists to check.
  const localRoutes = RUNGS.flatMap((r) =>
    r.target.kind === "origin" && r.target.app === "open-swe"
      ? ([[r.id, r.target.route ?? "/"]] as const)
      : ([] as const)
  );

  /*
   * THE NON-VACUITY GUARD IS ITSELF A WHOLE-LADDER FACT (#154).
   *
   * "there is at least one" is true of the manifest we ship and FALSE of a fork that ejected
   * every run-shaped rung — where `it.each([])` registering nothing is the correct outcome,
   * not a botched edit. The comment above already promised this file "stops asserting anything
   * about it rather than failing"; the guard was the one line that did not.
   *
   * Conditional rather than deleted: on a full ladder it still catches the botched edit it was
   * written for, and the condition is visible in the source beside it.
   */
  it.skipIf(localRoutes.length === 0)(
    "there is at least one, so the cases below are not vacuous",
    () => {
      expect(localRoutes.length).toBeGreaterThan(0);
    }
  );

  it.each(localRoutes)(
    "%s declares %s, and this app serves it",
    (_id, route) => {
      expect(hasRoute(route)).toBe(true);
    }
  );

  it.each(localRoutes)(
    "%s points at its own surface, not at the front door",
    (_id, route) => {
      /*
       * The specific regression. `/` still exists and still renders — it is the chat now — so
       * "the route resolves" is not enough to catch this: the assertion has to say which
       * surface a run-shaped rung means.
       *
       * DERIVED, not `RUNG_BY_ID["open-swe"]`. Naming the rung made this the one case in the
       * file that contradicted the comment at the top: in a fork below rung 4 the generated
       * `RUNG_BY_ID` has no such key, so it did not merely fail — IT DID NOT COMPILE. A fork is
       * where this file is least able to be edited and most likely to be trusted.
       */
      expect(route).not.toBe("/");
    }
  );

  it("hasRoute can return false, so the assertions above can fail", () => {
    // The anti-vacuity guard. Every case above is `expect(hasRoute(x)).toBe(true)`,
    // which a helper hardcoded to `true` satisfies completely.
    expect(hasRoute("/a-route-this-app-does-not-serve")).toBe(false);
  });

  it("the chat is reachable at the front door AND at its former address", () => {
    // #154 moved the chat to `/` and kept `/chat` routable for links already
    // written into browsers' localStorage. Both are asserted so that deleting
    // the alias later is a deliberate change with a failing test, not a
    // silent 404 for anyone holding an old link.
    expect(hasRoute("/")).toBe(true);
    expect(hasRoute("/chat")).toBe(true);
  });
});
