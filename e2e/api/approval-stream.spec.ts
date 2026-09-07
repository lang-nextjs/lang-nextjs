/**
 * THE APPROVAL-ANSWERING STREAM READER, EXERCISED WHERE IT CAN BE (#887).
 *
 * `e2e/approval-stream.ts` exists for `live-transport.spec.ts`, which runs ONLY on pushes to
 * main (`e2e.yml:544` gates it on `github.ref == 'refs/heads/main'`). Nothing about that helper
 * can be verified on a pull request through its real caller, so a bug in the frame parsing or
 * the decision POST would first be observed on main, in a job whose log is the whole evidence.
 *
 * THIS SPEC EXISTS TO MOVE THAT LINE. The mocked HITL surface gates deterministically —
 * `app/api/hitl-demo/route.ts` mounts `getApprovalConfig: () => ({ require: true })`, so every
 * tool the mock backend tries to run raises an approval, on every run, with no model involved.
 * Driving the helper through it tests the PROTOCOL half locally: that a `data-approval-required`
 * frame is recognised while the stream is open, that the id is read from `data.id`, that the
 * decision route accepts the POST, and that the stream then drains without the close-time sweep
 * firing.
 *
 * WHAT IT DELIBERATELY DOES NOT COVER, and the live PR body says so too: whether a REAL model
 * chooses to call a tool on a given run. If it does not, the helper's approval branch never
 * executes there. That residual cannot be retired from a pull request by any means, and a green
 * live run does not establish it — it may simply be a run where no tool was called.
 */
import { test, expect } from "@playwright/test";
import {
  streamAnsweringApprovals,
  describeApprovals,
} from "../approval-stream";
import { inBandErrorFrame } from "../error-frame";

test.describe("approval-answering stream reader (mocked HITL surface)", () => {
  test("answers the approval the gate raises, and the stream drains clean", async ({
    baseURL,
  }) => {
    const result = await streamAnsweringApprovals({
      url: `${baseURL}/api/hitl-demo`,
      approvalUrl: (id) => `${baseURL}/api/approval/${id}`,
      payload: {
        messages: [{ role: "user", content: "run the demo" }],
      },
      timeoutMs: 60_000,
    });

    expect(
      result.status,
      `POST /api/hitl-demo returned ${
        result.status
      }. Body:\n${result.body.slice(0, 800)}`
    ).toBe(200);

    /*
     * THE DOMAIN ASSERTION, AND IT IS THE ONE THAT KEEPS THIS HONEST. Every assertion below
     * passes over a stream that raised no approval at all — which is precisely the state the
     * live spec is in on a run where the model called no tool. Without this, a green here
     * would be indistinguishable from the helper never having run.
     */
    expect(
      result.approvals.length,
      `the mocked surface gates every tool, so at least one approval must have been raised. ` +
        `Frames seen:\n${result.body.slice(0, 800)}`
    ).toBeGreaterThan(0);

    expect(
      result.approvals.every((a) => a.decisionStatus === 200),
      `every decision must be accepted — ${describeApprovals(result)}`
    ).toBe(true);

    /*
     * The point of the whole exercise: with the approval answered inside the drain grace, the
     * close-time sweep at approval-gating.ts:940 has nothing stranded, so it emits neither
     * `tool_executed_without_approval` nor `approval_pending_at_close`.
     */
    const err = inBandErrorFrame(result.body);
    expect(
      err,
      `an answered approval must leave no in-band error frame. Got: ${JSON.stringify(
        err
      )}\n` + `Approvals: ${describeApprovals(result)}`
    ).toBeNull();

    expect(result.timedOut, "the exchange must not hit its deadline").toBe(
      false
    );
  });

  /*
   * THE COMPANION, WATCHING THE HELPER FAIL TO FIND WHAT IS NOT THERE. Without it, the parse
   * above is only ever seen succeeding, and a parser that returned an approval for every line
   * would pass every assertion in the first test.
   */
  test("raises no approval for a stream that gates nothing", async ({
    baseURL,
  }) => {
    const result = await streamAnsweringApprovals({
      url: `${baseURL}/api/hitl-demo/backend`,
      approvalUrl: (id) => `${baseURL}/api/approval/${id}`,
      payload: { messages: [{ role: "user", content: "run the demo" }] },
      timeoutMs: 30_000,
    });

    /*
     * The BACKEND route is the un-gated half — the mock the proxy wraps. It emits the same
     * tool frames with no approval transform in front of them, so a correct reader finds zero
     * approvals in a body that is otherwise the same shape.
     */
    expect(
      result.approvals.length,
      `the ungated mock raises no approvals, so the reader must find none. ` +
        `Found: ${describeApprovals(result)}`
    ).toBe(0);
    expect(
      result.body.length,
      "the ungated mock still streams"
    ).toBeGreaterThan(0);
  });
});
