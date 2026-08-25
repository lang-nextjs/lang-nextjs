import type { ComponentType } from "react";

/**
 * THE HOME-SURFACE BARREL — nothing but re-exports of rung-owned surfaces.
 *
 * Same mechanism, and the same reasons, as apps/example/lib/rungs/adapters/registry.ts.
 * Each `export … from "./<rung>"` line points at a module declared under that rung's
 * `owns.ts`. `pnpm eject` deletes the module and then prunes the line, derived from the
 * deletion set rather than from any list kept here (scripts/eject.mjs, "Prune barrel
 * re-exports whose target no longer exists"). So this file shrinks to exactly the rungs a
 * fork retained, and needs no eject machinery of its own.
 *
 * WHY A BARREL RATHER THAN A CONDITIONAL IMPORT
 *   `app/page.tsx` is SHARED after #154; the run surface it used to contain is rung-4-owned.
 *   A shared file cannot statically import a rung-owned one — eject deletes the target and
 *   the fork fails to resolve it. Nor does a dynamic `import()` help: a literal specifier is
 *   still a build-time module reference, so `next build` fails in the fork just the same.
 *   Making the import EDGE itself rung-owned moves the problem to where eject already solves
 *   it, which is the whole point of the pattern.
 *
 * THE ANCHOR BELOW IS LOAD-BEARING — DO NOT DELETE IT
 *   `eject langchain` prunes every re-export in this file. A file with no imports and no
 *   exports is not a module, and `import * as` against it fails with TS2306 — so the fix
 *   would break in precisely the fork it exists for. `HomeSurface` carries no relative
 *   specifier, and the pruner only removes lines matching `export … from "./x"`, so this
 *   stays a module even when it holds no surfaces. Verified by ejecting, not assumed.
 */
export type HomeSurface = ComponentType;

export { RunSurface as openSwe } from "./open-swe";
