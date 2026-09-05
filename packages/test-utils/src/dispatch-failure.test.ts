import { describe, it, expect } from "vitest";
import { dispatchFailureMessage } from "./dispatch-failure";

/**
 * THESE RUN ON EVERY PULL REQUEST, WHICH IS THE POINT AND WAS THE DEFECT.
 *
 * They began in `e2e/shell/matrix-tools-live.spec.ts`, where the only Playwright
 * project matching that file is invoked solely by a push-to-main job gated on a
 * model API key. So they executed after merge and never on a PR — a regression
 * in this function would have landed green, in a change whose own argument was
 * that a proof needing a live dispatch runs only where the failure already costs
 * a day (#744, found in review by DEV1-lang).
 *
 * Nothing here needs a backend, a browser or a key. That was true when they were
 * written; it just was not true of the place they were written in.
 */
describe("dispatchFailureMessage", () => {
  it("the response body survives into the failure message", () => {
    const msg = dispatchFailureMessage(
      "langchain × react",
      '{"detail":"request carries no \'approvalPolicy\'"}'
    );
    expect(msg).toContain("langchain × react");
    // The load-bearing half: a message naming only the cell would pass a test
    // that checked for the cell, and is exactly what this replaces.
    expect(msg).toContain("approvalPolicy");
  });

  it("an empty body says so, rather than trailing off", () => {
    // A rejection that explained nothing is a different fact from one whose
    // explanation was dropped, and the reader must be able to tell.
    expect(dispatchFailureMessage("langgraph × react", "   ")).toContain(
      "(empty body — the rejection explained nothing)"
    );
  });

  it("a huge body is truncated, not passed through whole", () => {
    const msg = dispatchFailureMessage("deepagents × react", "x".repeat(5000));
    expect(msg.length).toBeLessThan(800);
  });
});
