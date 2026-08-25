import { RUNGS } from "@deepagents-nextjs/rungs";
import type { HomeSurface } from "./registry";
import * as registry from "./registry";

/**
 * Public face of the home-surface registry.
 *
 * `import * as` is the point: it names no rung. A named import would be pruned out from
 * under this file the moment its rung was ejected, which is the failure this arrangement
 * exists to remove. Whatever the barrel still exports after eject is what a fork offers —
 * no list here to fall out of step with it.
 */
const surfaces: readonly HomeSurface[] = Object.values(
  registry as Record<string, unknown>
).filter((v): v is HomeSurface => typeof v === "function");

/**
 * The run surface this build actually contains, or null.
 *
 * DERIVED FROM WHAT SURVIVED EJECT, not from the manifest. Those are two different
 * questions and only this one can be answered honestly at render time: the manifest says
 * which rungs a tree DECLARES, the barrel says which surfaces a tree can actually RENDER.
 * They agree on a healthy tree and `homeSurfaceMatchesManifest()` asserts it — but if they
 * ever disagree, rendering must follow the code that exists, not the declaration.
 */
export function runSurface(): HomeSurface | null {
  return surfaces[0] ?? null;
}

/**
 * Whether the manifest declares any run-shaped rung.
 *
 * This is the LADDER question — the one AppSidebar asks when it decides that conversation
 * rungs share /chat and run-shaped rungs get their own route. Kept separate from
 * `runSurface()` on purpose; see below.
 */
export function hasRunShapedRung(): boolean {
  return RUNGS.some((r) => r.shape === "run");
}

/**
 * Do the two sources agree?
 *
 * A tree that declares a run-shaped rung but has no surface to render is a severability
 * bug: something owns the surface that should not, or the barrel lost a line it should have
 * kept. A tree with a surface and no run-shaped rung is the same bug facing the other way.
 *
 * Exported so a test can assert it rather than a comment claiming it. Deliberately NOT
 * consulted by the page: a page that threw here would turn a manifest inconsistency into a
 * white screen on the fork's front door, which is worse than rendering the honest thing and
 * letting CI carry the complaint.
 */
export function homeSurfaceMatchesManifest(): boolean {
  return hasRunShapedRung() === (runSurface() !== null);
}
