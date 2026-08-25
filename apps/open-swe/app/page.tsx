"use client";

import { ConversationLanding } from "../components/ConversationLanding";
import { runSurface } from "../lib/rungs/home";

/**
 * THE FRONT DOOR, DERIVED FROM WHAT THE FORK ACTUALLY CONTAINS.
 *
 * This file is SHARED after #154 — every fork keeps it, down to rung 1. What it renders is
 * not shared, and that is the whole content of this module:
 *
 *   a run surface exists   ->  render it (the kanban and the task composer, as before)
 *   it does not            ->  render the conversation landing
 *
 * WHY IT ASKS THE REGISTRY RATHER THAN THE MANIFEST. `hasRunShapedRung()` is available and
 * is the question AppSidebar asks, but it answers "does this tree DECLARE a run rung",
 * which is not the same as "can this tree RENDER one". Only the second is safe to branch a
 * render on: if they ever disagree, following the declaration means rendering a component
 * that is not there. The registry is derived from what survived eject, so it cannot claim a
 * surface the build lacks. `homeSurfaceMatchesManifest()` asserts the two agree, in a test
 * rather than here — a page that threw on a manifest inconsistency would turn a CI-shaped
 * problem into a white screen on a fork's front door.
 *
 * WHAT THIS FILE MUST NOT DO is import lib/run-board, lib/hooks/useRuns or
 * components/RunListCard. All three are rung-4-owned; this file is shared. `pnpm eject
 * langchain` deletes them, and a static import here — or a dynamic one with a literal
 * specifier, which is still a build-time reference — leaves the fork unable to build. The
 * import edge lives in lib/rungs/home/registry.tsx, where eject prunes it.
 */
export default function HomePage() {
  const RunSurface = runSurface();
  return RunSurface ? <RunSurface /> : <ConversationLanding />;
}
