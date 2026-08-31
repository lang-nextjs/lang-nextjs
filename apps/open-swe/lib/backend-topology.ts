/**
 * WHETHER THE CONNECTED BACKEND RUNS ONE GRAPH OR SEVERAL (#423).
 *
 * Open SWE's agent is three graphs on three threads: each dispatches the next as
 * a NEW run on a NEW thread and passes its own thread id down as
 * `parentThreadId` — upstream links them precisely because they are separate.
 * This app's stream route is single-thread by construction, so pointed at a real
 * multi-graph Open SWE it shows one third of the agent.
 *
 * THE DEFECT IS NOT THAT THE VIEW IS PARTIAL. The bundled local backend is
 * single-run by design, and against it the single-thread view is complete and
 * correct. The defect is that THE DASHBOARD CANNOT TELL WHICH CASE IT IS IN and
 * renders identically in both. Complete and one-third look the same.
 *
 * WHY THIS IS A RUNTIME PROBE AND NOT A MANIFEST FIELD. Ruled on #423 extending
 * #23: `shape` is a static per-rung property and multi-graph-ness is a dynamic
 * per-connection fact — the SAME rung, with the SAME manifest, answers
 * differently depending on which backend it is pointed at. No value of `shape`
 * fixes that; the field is the wrong kind of thing whatever you set it to. This
 * is the same class of fact as "which model provider is configured", which this
 * repo already reports from a probe rather than declaring in `rungs.json`.
 *
 * THREE STATES, NOT TWO, AND THAT IS THE WHOLE POINT.
 *
 * "I could not ask" is not "it is single-run". Collapsing them would put the
 * view back exactly where this issue found it — implying completeness it has not
 * established — and it would do so on the failure path, where nobody looks. This
 * repo shipped that bug three weeks ago in a different file: a classifier that
 * partitioned a THREE-state field two ways reported an unreadable frame as a
 * defect it had never measured (#426). A two-way answer to a three-way question
 * silently absorbs the third state into whichever side is the default.
 */

/** Distinct graph ids the backend registers, or why we could not find out. */
export type BackendTopology =
  | { known: true; graphs: string[]; multiGraph: boolean }
  | { known: false; reason: string };

/**
 * Pure, so the interesting cases are reachable without a backend.
 *
 * `multiGraph` is `graphs.length > 1` and NOT `>= 3`. Hardcoding three would
 * make this a check on Open SWE's current decomposition rather than on the
 * property that matters — that more than one graph exists and this view follows
 * one of them. Upstream is free to add a fourth.
 */
export function classifyTopology(graphIds: readonly string[]): BackendTopology {
  const graphs = [...new Set(graphIds)].sort();
  /*
   * A backend that registers NOTHING has not told us it is single-run; it has
   * told us nothing. Reporting `multiGraph: false` here would be the two-state
   * collapse this module exists to avoid, arrived at from the other direction.
   */
  if (graphs.length === 0) {
    return { known: false, reason: "the backend registered no graphs" };
  }
  return { known: true, graphs, multiGraph: graphs.length > 1 };
}
