// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RunTopologyNotice } from "./RunTopologyNotice";
import { classifyTopology } from "../lib/backend-topology";

/**
 * THE CRITERION #423 SET, AND WHY IT IS SHAPED THIS WAY.
 *
 *   "The dashboard must render DIFFERENTLY against a single-run backend and a
 *    multi-graph one, and a test must drive BOTH."
 *
 * One configuration proves nothing here. A single-run fixture passes IDENTICALLY
 * whether detection exists or not — which is exactly how this ended up as prose
 * in LOCAL-AGENT.md instead of coverage. So the assertion that matters is not
 * "the multi-graph case renders a notice"; it is that THE TWO RENDERS DIFFER.
 * A test that only ever sees one configuration is a criterion passing by
 * symmetry: it cannot distinguish a working detector from an absent one.
 *
 * WHAT DRIVES THE TWO CASES. Not hand-written topology objects — those would
 * restate the conclusion. Each case starts from what `POST /assistants/search`
 * returns for that backend and goes through the real `classifyTopology`, so the
 * fixtures are backend RESPONSES and the classification is the code's.
 *
 * HONEST LIMITATION, recorded here because #423 asked for it explicitly: these
 * are two backend RESPONSES, not two live backends. Only the single-run backend
 * ships in this repo. The multi-graph response uses the three graph ids upstream
 * declares in `rungs/5-software-developer-agent/langgraph.json` — real, in-tree,
 * and quoted in #423 — but rung 4 must not READ that file or an ejected rung-4
 * fork would break, so the ids are literals here and nothing asserts they stay
 * in step with rung 5. If upstream renames a graph this fixture goes stale
 * silently. That is a narrower gap than the one it closes, and it is a gap.
 */

/** What a backend's /assistants/search returns, reduced to what we read. */
const SINGLE_RUN = [{ graph_id: "agent" }];
const OPEN_SWE = [
  { graph_id: "manager" },
  { graph_id: "planner" },
  { graph_id: "programmer" },
];

const renderFor = (assistants: Array<{ graph_id?: string }>) => {
  const ids = assistants
    .map((a) => a.graph_id)
    .filter((id): id is string => typeof id === "string");
  const { container } = render(
    <RunTopologyNotice topology={classifyTopology(ids)} />
  );
  return container;
};

describe("RunTopologyNotice — the dashboard knows which backend it is on", () => {
  it("renders NOTHING against a single-run backend — the shipped case is unchanged", () => {
    const container = renderFor(SINGLE_RUN);
    expect(container.textContent).toBe("");
    expect(screen.queryByTestId("run-topology")).toBeNull();
  });

  it("says which fraction it is showing against a multi-graph backend", () => {
    renderFor(OPEN_SWE);
    const note = screen.getByTestId("run-topology");
    expect(note.getAttribute("data-topology")).toBe("multi-graph");
    expect(note.textContent).toContain("1 of 3");
    for (const g of ["manager", "planner", "programmer"]) {
      expect(note.textContent).toContain(g);
    }
  });

  /*
   * THE ONE THAT MAKES THE OTHER TWO MEAN SOMETHING. Both assertions above pass
   * against a component that ignores its argument entirely — the first trivially,
   * the second if it always renders the notice. Only the DIFFERENCE between them
   * is evidence that the input was read.
   */
  it("renders DIFFERENTLY for the two backends — the discriminator", () => {
    const single = renderFor(SINGLE_RUN).innerHTML;
    const multi = renderFor(OPEN_SWE).innerHTML;
    expect(single).not.toBe(multi);
    // ...and not merely different: one is empty and the other is not, so this
    // cannot be satisfied by two different-but-equally-uninformative renders.
    expect(single).toBe("");
    expect(multi.length).toBeGreaterThan(0);
  });

  it("treats MORE THAN ONE as the trigger, not exactly three", () => {
    // Hardcoding 3 would test Open SWE's current decomposition rather than the
    // property. Upstream may add a fourth graph, or a different backend may run
    // two — both are the multi-graph case.
    renderFor([{ graph_id: "manager" }, { graph_id: "planner" }]);
    expect(screen.getByTestId("run-topology").textContent).toContain("1 of 2");
  });

  it("does not mistake several assistants on ONE graph for several graphs", () => {
    // /assistants/search returns ASSISTANTS, and a backend may register more
    // than one against the same graph. Counting rows rather than distinct
    // graph_ids would report the shipped single-run backend as multi-graph and
    // put a "showing 1 of 3" warning on a view that is complete.
    const container = renderFor([
      { graph_id: "agent" },
      { graph_id: "agent" },
      { graph_id: "agent" },
    ]);
    expect(container.textContent).toBe("");
  });

  describe("the third state: a probe that could not answer", () => {
    /*
     * "I could not ask" is not "it is single-run". Rendering nothing here would
     * put the view back where #423 found it — implying completeness it has not
     * established — and would do it on the failure path, where nobody looks.
     */
    it("is visibly distinct from BOTH known states", () => {
      const unknown = render(
        <RunTopologyNotice
          topology={{ known: false, reason: "backend unreachable" }}
        />
      ).container.innerHTML;
      expect(unknown).not.toBe(renderFor(SINGLE_RUN).innerHTML);
      expect(unknown).not.toBe(renderFor(OPEN_SWE).innerHTML);
      expect(unknown).toContain("Could not determine");
    });

    it("is reached when the backend registers no graphs at all", () => {
      const container = renderFor([]);
      expect(container.textContent).toContain("Could not determine");
    });
  });

  it("renders nothing while the probe is still outstanding", () => {
    // Undefined is "not answered yet", which is correctly silent — it lasts as
    // long as the request. Distinct from a probe that answered "I don't know".
    const { container } = render(<RunTopologyNotice topology={undefined} />);
    expect(container.textContent).toBe("");
  });
});
