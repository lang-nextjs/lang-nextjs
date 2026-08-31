import type { Rung, RungShape } from "@deepagents-nextjs/rungs";

/**
 * THE SHAPE CONTRACT — what a rung's interaction shape actually commits to.
 *
 * #23 ruled that shape is a declared rung property and the shell routes by it.
 * `rungs.json` declares it; this file says what each value MEANS, and the
 * registry dispatches on it.
 *
 * The two shapes are not two skins over one surface. They differ in
 * information architecture:
 *
 *                  conversation                  run
 *   surfaces       one                           list -> detail
 *   identity       ephemeral thread              durable runId + threadId
 *   reconnection   resume a stream you own       JOIN a run started elsewhere
 *   lifetime       ends with the page            outlives the page, server-side
 *   streams        exactly one                   a parent PLUS N children,
 *                                                discovered at runtime
 *
 * That last row is the one that gets built wrong, so it is modelled explicitly
 * below rather than left to each handler.
 */

/** A child stream is not a lesser stream — the role only records how it was found. */
export type StreamRole = "root" | "child";

export interface StreamRef {
  readonly threadId: string;
  readonly runId: string;
  readonly role: StreamRole;
  /** Display label, e.g. the graph that owns it. */
  readonly label?: string;
}

/**
 * Identity of a stream. A run is addressed by BOTH ids: real Open SWE
 * dispatches each child as a new run on a NEW thread, so threadId alone
 * collides across children and runId alone collides across reconnects.
 */
export function streamKey(ref: StreamRef): string {
  return `${ref.threadId}:${ref.runId}`;
}

/**
 * How a `run`-shaped rung is carried.
 *
 * DELIBERATELY NOT "one stream per run". Real Open SWE registers three graphs
 * that do NOT share a run — each dispatches a new run on a new thread to the
 * next. Upstream's own UI opens three concurrent
 * subscriptions, discovering children by watching the parent's state for
 * `plannerSession: { threadId, runId }` to appear, then joining each as it
 * materialises. See apps/open-swe/docs/LOCAL-AGENT.md, "Topology: this backend
 * is single-run", which records the one-stream assumption as a known limitation
 * of rung 4 rather than a property of runs.
 *
 * So the unit is a SET that grows, not a stream. A handler supplies the root
 * and a discovery rule; the shell owns joining, and therefore owns the
 * guarantee that a child is joined exactly once.
 */
export interface RunTopology {
  readonly root: StreamRef;
  /**
   * Given the latest parent state, name every child that now exists.
   *
   * Called on EVERY parent-state update, so it must be pure and idempotent:
   * returning the same child on every call is normal and expected. There is no
   * upper bound on how many children it may name, and it may name none —
   * children need not exist when the run starts.
   */
  discoverChildren(parentState: unknown): readonly StreamRef[];
}

/**
 * Join newly-discovered children into the live set — exactly once each.
 *
 * THE DOUBLE-JOIN GUARD LIVES HERE, not in each handler, so every `run` rung
 * inherits it. Rung 5 forks open-swe and gets this for free; a second run rung
 * cannot reintroduce the bug by forgetting it.
 *
 * Returns the SAME array reference when nothing changed, so a caller can use it
 * as a React dependency without re-subscribing on every parent-state tick.
 */
export function joinDiscovered(
  live: readonly StreamRef[],
  discovered: readonly StreamRef[]
): readonly StreamRef[] {
  const seen = new Set(live.map(streamKey));
  const additions: StreamRef[] = [];
  for (const ref of discovered) {
    const key = streamKey(ref);
    // Two guards, not one: `seen` rejects a child already live, and adding to
    // `seen` as we go rejects a duplicate WITHIN a single discovery result.
    if (seen.has(key)) continue;
    seen.add(key);
    additions.push(ref);
  }
  return additions.length === 0 ? live : [...live, ...additions];
}

/** The live subscription set for one run. */
export interface RunSession {
  readonly topology: RunTopology;
  readonly streams: readonly StreamRef[];
}

/** Open a session. The root is live immediately; children arrive later. */
export function openRunSession(topology: RunTopology): RunSession {
  return { topology, streams: [topology.root] };
}

/** Fold a parent-state update into the session, joining anything newly named. */
export function advanceRunSession(
  session: RunSession,
  parentState: unknown
): RunSession {
  const next = joinDiscovered(
    session.streams,
    session.topology.discoverChildren(parentState)
  );
  return next === session.streams ? session : { ...session, streams: next };
}

/**
 * What the shell renders for a rung, chosen by shape.
 *
 * An app registers handlers only for the shapes it HOSTS. apps/example hosts
 * `conversation`; rung 4's run surface is a separate app on another origin, so
 * here `run` resolves to a departure. That is not a stub — routing a run rung
 * to a cross-origin handoff instead of an embedded run list IS the correct
 * behaviour for this app. #29 deliberately deleted the embedded Open SWE rung;
 * re-embedding it to make the branch look symmetrical would undo that merge.
 */
export type ShapeRender = (rung: Rung) => React.ReactNode;

export interface ShapeHandler {
  readonly shape: RungShape;
  /** Human-readable name for the nav group this shape forms. */
  readonly groupLabel: string;
  readonly render: ShapeRender;
}
