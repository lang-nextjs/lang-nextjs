import type { BackendTopology } from "../lib/backend-topology";

/**
 * SAY WHETHER THIS VIEW IS SHOWING THE WHOLE AGENT (#423).
 *
 * The run view streams ONE thread. Against the bundled local backend that is the
 * whole agent and this component renders nothing. Against a real multi-graph
 * Open SWE each graph dispatches the next onto a sibling thread and this view
 * is showing one of three — so it says so.
 *
 * WHY AN HONEST PARTIAL RATHER THAN A MERGED VIEW. Ruled on #423: a merged view
 * built today would merge one thread and call it merged, which asserts a
 * completeness it never computed — worse than the partial, because a reader
 * cannot tell it apart from the real thing. And #23 ruled that THE DIVERGENCE IS
 * THE PEDAGOGY: that one graph dispatched another on its own thread is the
 * most interesting fact about this architecture, and hiding it behind uniform
 * chrome would misteach. Following the siblings is a follow-on affordance, never
 * the default.
 *
 * WHY SINGLE-RUN RENDERS NOTHING AT ALL. #423's acceptance names it directly: a
 * run that genuinely is single-thread must be UNCHANGED — no new banner, no new
 * latency. Without that half, the criterion is satisfied by labelling every run
 * incomplete, which teaches nothing and annoys everyone. It is the presence
 * companion for the multi-graph assertion: "renders nothing" only means
 * something beside a case that renders something.
 */
export function RunTopologyNotice({
  topology,
}: {
  topology: BackendTopology | undefined;
}) {
  /*
   * NOT YET PROBED is not the same as single-run, and neither is FAILED TO
   * PROBE. Rendering nothing while the answer is outstanding is correct — it is
   * the same silence as the single-run case and lasts as long as the request.
   * Rendering nothing when the probe FAILED is not: that is the view implying
   * completeness it never established, which is the defect this issue is about.
   */
  if (!topology) return null;

  if (!topology.known) {
    return (
      <p
        data-testid="run-topology"
        data-topology="unknown"
        className="text-sm text-muted-foreground"
      >
        Could not determine whether this backend runs more than one graph (
        {topology.reason}). This view follows a single thread, so it may be
        showing part of the agent.
      </p>
    );
  }

  if (!topology.multiGraph) return null;

  return (
    <div
      data-testid="run-topology"
      data-topology="multi-graph"
      role="note"
      className="rounded-md border border-border bg-card p-3 text-sm"
    >
      <p className="font-medium text-foreground">
        Showing 1 of {topology.graphs.length} graphs
      </p>
      <p className="mt-1 text-muted-foreground">
        This backend registers {topology.graphs.join(", ")}. They run on
        separate threads, and this view follows one of them — the others are not
        shown.
      </p>
    </div>
  );
}
