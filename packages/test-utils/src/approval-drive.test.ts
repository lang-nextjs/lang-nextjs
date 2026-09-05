import { describe, it, expect } from "vitest";
import {
  APPROVAL_PAUSE_PART,
  APPROVE,
  approvalPolicy,
  driveApprovals,
  isApprovalPause,
} from "./approval-drive";

/**
 * These drive the ROUND TRIP with no backend, which is the point rather than a
 * convenience. The suite this helper was written for runs only on pushes to main
 * with a model key, so a proof that needed a live gated run would only ever
 * execute where the failure already costs a day — which is exactly how a 400 at
 * dispatch survived from 02 Sep with nobody able to read it (#742, #745).
 *
 * The dispatch is a stub returning scripted bodies, so what is asserted is the
 * POLICY — how many times it dispatches, what it sends on each, and what it does
 * when the run will not finish — and not the backend's behaviour, which belongs
 * to the backend's own tests.
 */

const PAUSE = `data: {"type":"${APPROVAL_PAUSE_PART}","data":{"action_requests":[{"name":"increment"}]}}\n`;
const DONE = `data: {"type":"tool-output-available","toolName":"increment"}\ndata: {"type":"finish"}\n`;

/** A dispatch that replays `script` and records every body it was given. */
function scripted(script: string[]) {
  const sent: Record<string, unknown>[] = [];
  let i = 0;
  const dispatch = async (body: Record<string, unknown>) => {
    sent.push(body);
    return script[Math.min(i++, script.length - 1)];
  };
  return { dispatch, sent };
}

describe("isApprovalPause", () => {
  it("is true for a paused stream", () => {
    expect(isApprovalPause(PAUSE)).toBe(true);
  });

  // THE COMPANION. Without it, a matcher that returned true unconditionally
  // would satisfy the case above — and would make driveApprovals loop until it
  // threw on every run, gated or not.
  it("is false for a stream that completed", () => {
    expect(isApprovalPause(DONE)).toBe(false);
  });

  it("is false for a stream carrying a DIFFERENT data- part", () => {
    expect(
      isApprovalPause(`data: {"type":"data-approval-required","data":{}}\n`)
    ).toBe(false);
  });
});

describe("driveApprovals", () => {
  it("an ungated run dispatches ONCE and sends no decisions", async () => {
    const { dispatch, sent } = scripted([DONE]);
    const r = await driveApprovals(dispatch, { messages: [] });
    expect(r.rounds).toBe(1);
    expect(r.approvals).toBe(0);
    // An ordinary turn must not carry the field at all: an empty decisions list
    // is refused by the backend, and "no decision" is spelled by omission.
    expect(sent[0]).not.toHaveProperty("approvalDecisions");
  });

  it("THE ROUND TRIP: a paused run is approved and resumed", async () => {
    const { dispatch, sent } = scripted([PAUSE, DONE]);
    const r = await driveApprovals(dispatch, {
      messages: [],
      topology: "react",
    });

    expect(r.rounds).toBe(2);
    expect(r.approvals).toBe(1);
    // The first dispatch is an ordinary turn; only the SECOND carries a decision.
    expect(sent[0]).not.toHaveProperty("approvalDecisions");
    expect(sent[1].approvalDecisions).toEqual([{ type: "approve" }]);
    // And it carries the original body forward — a resume that dropped the turn
    // would be a different request that happened to be approved.
    expect(sent[1].topology).toBe("react");
    // The caller gets both bodies: the pause is evidence too, and a helper that
    // returned only the last one would make "it paused" unassertable.
    expect(r.bodies).toHaveLength(2);
    expect(isApprovalPause(r.bodies[0])).toBe(true);
  });

  it("REFUSES rather than returning a still-paused run", async () => {
    const { dispatch } = scripted([PAUSE]);
    await expect(
      driveApprovals(dispatch, { messages: [] }, { maxRounds: 2 })
    ).rejects.toThrow(/still awaiting approval after 2/);
  });

  it("the refusal explains what returning would have cost", async () => {
    // The message must say WHY, not just that a cap was hit: a caller who reads
    // "gave up" reasonably raises the cap, and a caller who reads this looks at
    // whether the approval was honoured.
    const { dispatch } = scripted([PAUSE]);
    await expect(
      driveApprovals(dispatch, {}, { maxRounds: 1 })
    ).rejects.toThrow(/the tool did not run/);
  });

  it("a maxRounds that could never dispatch is refused", async () => {
    const { dispatch } = scripted([DONE]);
    await expect(
      driveApprovals(dispatch, {}, { maxRounds: 0 })
    ).rejects.toThrow(/at least 1/);
  });

  it("drives more than one pause", async () => {
    const { dispatch, sent } = scripted([PAUSE, PAUSE, DONE]);
    const r = await driveApprovals(dispatch, {}, { maxRounds: 4 });
    expect(r.rounds).toBe(3);
    expect(r.approvals).toBe(2);
    expect(sent[2].approvalDecisions).toEqual([{ type: "approve" }]);
  });
});

describe("approvalPolicy", () => {
  it("carries the READ-ONLY allowlist under the key the backend reads", () => {
    expect(approvalPolicy(["get_counter"])).toEqual({
      readOnlyTools: ["get_counter"],
    });
  });

  it("an explicit empty allowlist is preserved, not dropped", () => {
    // `{"readOnlyTools": []}` is a statement — nothing is read-only — and is not
    // the same as an absent policy, which the backend refuses.
    expect(approvalPolicy([])).toEqual({ readOnlyTools: [] });
  });

  it("copies its input, so a caller's array cannot mutate a sent policy", () => {
    const tools = ["get_counter"];
    const policy = approvalPolicy(tools);
    tools.push("increment");
    expect(policy.readOnlyTools).toEqual(["get_counter"]);
  });
});

describe("APPROVE", () => {
  it("is the decision shape the backend accepts, and is frozen", () => {
    expect(APPROVE).toEqual({ type: "approve" });
    expect(Object.isFrozen(APPROVE)).toBe(true);
  });
});
