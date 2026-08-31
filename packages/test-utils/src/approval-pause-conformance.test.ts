/**
 * WHAT THE ADAPTER EMITS MUST BE WHAT THE CARD'S SCHEMA PARSES (#429).
 *
 * #420 was built by two people across a package boundary: the adapter turns
 * LangChain's `event: approval_pending` into a `data-approval-pause` part
 * (packages/server), and the card parses it with `ApprovalPauseSchema`
 * (packages/react). Each side has its own tests, and each side's tests use its
 * OWN fixture. So until this file existed, the only thing making the two agree
 * was that two people had read each other's code.
 *
 * THE FAILURE IS SILENT, WHICH IS WHY IT NEEDS A GUARD RATHER THAN CARE.
 * `partsToMessages` console.warns and DROPS a `data-*` part that does not match
 * its registered schema. A rename on either side — the wrapper key, the part
 * type, `action_requests` to `actionRequests` — produces no red anywhere. It
 * produces a card that never renders, which is the shape #420 exists to remove,
 * one layer up.
 *
 * This is the same instrument as approval-frame-conformance.test.ts beside it,
 * pointed at a second boundary. Its header states the general case exactly:
 * "between those two readers sits a whole class of change that passes every test
 * and reaches nobody."
 *
 * BOTH REAL IMPLEMENTATIONS, NO COPIED FIXTURE. A fixture copied from either
 * package into the other would assert nothing about the other side — it would be
 * two packages agreeing with themselves while looking like coverage.
 *
 * Cross-package by necessity, like its neighbours: packages/server has no
 * dependency on packages/react and should not grow one to hold a test. Both
 * files are excluded from the package tsconfig's `rootDir` program and
 * typechecked by tsconfig.parity.json instead.
 */
import { describe, it, expect } from "vitest";

import { createLangchainTransform } from "../../server/src/adapters/langchain";
import type { SseFrame } from "../../server/src/accumulator";
import { ApprovalPauseSchema } from "../../react/src/schemas";

/**
 * The frame as the Python backends put it on the wire.
 *
 * `apps/fastapi-backend/ai_backends/langchain.py` emits
 *
 *     event: approval_pending
 *     data: {"interrupt": <upstream interrupt value>}
 *
 * with the interrupt carried verbatim — snake_case keys and upstream's four-way
 * vocabulary, neither of which is ours to rename at this boundary.
 */
function approvalPendingFrame(interrupt: unknown): SseFrame {
  return {
    raw: `event: approval_pending\ndata: ${JSON.stringify({ interrupt })}`,
  };
}

/**
 * The FIRST part the adapter produced, parsed back off the wire.
 *
 * Reads the `data:` lines rather than slicing the raw string — some branches of
 * this adapter emit more than one part in a single frame (a token becomes
 * text-start plus text-delta), and a naive slice turns that into a JSON parse
 * error that reads like a failed assertion about the schema.
 */
function emittedPart(frame: SseFrame | null): Record<string, unknown> {
  expect(frame, "the adapter emitted nothing for this event").not.toBeNull();
  const dataLines = frame!.raw
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice(6));
  expect(dataLines.length, `no data line in: ${frame!.raw}`).toBeGreaterThan(0);
  return JSON.parse(dataLines[0]!) as Record<string, unknown>;
}

/** An interrupt in the shape upstream's HITL middleware actually raises. */
const UPSTREAM_INTERRUPT = {
  action_requests: [
    {
      name: "increment",
      args: { by: 1 },
      description: "Tool execution requires approval",
    },
  ],
  review_configs: [
    {
      action_name: "increment",
      allowed_decisions: ["approve", "edit", "reject", "respond"],
    },
  ],
};

describe("the adapter's pause frame and the card's schema agree (#429)", () => {
  it("a frame the adapter really emits PARSES with the real schema", () => {
    const transform = createLangchainTransform();
    const part = emittedPart(
      transform(approvalPendingFrame(UPSTREAM_INTERRUPT))
    );

    // The part TYPE is half the contract — the card registers a schema against
    // this exact string, and a rename here is as silent as a shape change.
    expect(part.type).toBe("data-approval-pause");

    const parsed = ApprovalPauseSchema.safeParse(part.data);
    expect(
      parsed.success,
      `the card's schema rejected what the adapter emitted: ${
        parsed.success ? "" : JSON.stringify(parsed.error.issues)
      }`
    ).toBe(true);
  });

  it("the payload survives the crossing intact, keys and vocabulary", () => {
    // Not merely "it parses". A schema with every field optional would also
    // parse. These are the values the card renders from: the tool it names, the
    // arguments the decision is made against, and the controls it may offer.
    const transform = createLangchainTransform();
    const part = emittedPart(
      transform(approvalPendingFrame(UPSTREAM_INTERRUPT))
    );
    const parsed = ApprovalPauseSchema.parse(part.data);

    expect(parsed.interrupt.action_requests[0]!.name).toBe("increment");
    expect(parsed.interrupt.action_requests[0]!.args).toEqual({ by: 1 });
    expect(parsed.interrupt.review_configs?.[0]!.allowed_decisions).toEqual([
      "approve",
      "edit",
      "reject",
      "respond",
    ]);
  });

  it("MULTI-ACTION: a pause carrying several calls crosses without collapsing", () => {
    // Measured upstream: one AI message with two gated calls raises ONE
    // interrupt carrying both, with action_requests and review_configs appended
    // in lockstep. The card pairs them BY INDEX, so an adapter that collapsed or
    // reordered either list would mis-associate decisions with calls.
    const transform = createLangchainTransform();
    const part = emittedPart(
      transform(
        approvalPendingFrame({
          action_requests: [
            { name: "increment", args: { by: 1 }, description: null },
            { name: "wipe", args: { path: "/" }, description: null },
          ],
          review_configs: [
            { action_name: "increment", allowed_decisions: ["approve"] },
            { action_name: "wipe", allowed_decisions: ["reject"] },
          ],
        })
      )
    );
    const parsed = ApprovalPauseSchema.parse(part.data);

    expect(parsed.interrupt.action_requests.map((a) => a.name)).toEqual([
      "increment",
      "wipe",
    ]);
    expect(parsed.interrupt.review_configs?.map((c) => c.action_name)).toEqual([
      "increment",
      "wipe",
    ]);
  });
});

describe("the schema REJECTS what is not that shape (#429 positive control)", () => {
  /*
   * THE HALF THAT KEEPS THE GREEN MEANINGFUL, and the reason this file replaces
   * a `JSON.parse` reader rather than adding to one.
   *
   * Every assertion above is satisfied by a schema that accepts anything —
   * which is precisely what the two sides had before: each parsed its own
   * fixture with `JSON.parse`, which accepts any object at all. These cases
   * demonstrate on every run that the validator DOES reject, so a green above
   * means the payload passed rather than that nothing was checked.
   */
  it("a camelCased envelope is rejected — the rename this file exists to catch", () => {
    const drifted = {
      interrupt: {
        actionRequests: [{ name: "increment", args: {} }],
        reviewConfigs: [
          { actionName: "increment", allowedDecisions: ["approve"] },
        ],
      },
    };
    expect(ApprovalPauseSchema.safeParse(drifted).success).toBe(false);
  });

  it("a decision outside upstream's four is rejected", () => {
    // The AI SDK's `{id, approved, reason}` vocabulary, leaking back in.
    const collapsed = {
      interrupt: {
        action_requests: [{ name: "increment", args: {} }],
        review_configs: [
          { action_name: "increment", allowed_decisions: ["approved"] },
        ],
      },
    };
    expect(ApprovalPauseSchema.safeParse(collapsed).success).toBe(false);
  });

  it("a different part from the same adapter does not pass as a pause", () => {
    // Drives the REAL adapter down another branch and shows its output is not
    // accepted here — so the schema is discriminating between this adapter's
    // own frames, not merely rejecting nonsense.
    const transform = createLangchainTransform();
    const token = transform({
      raw: `event: token\ndata: ${JSON.stringify({
        type: "token",
        text: "hi",
      })}`,
    });
    const part = emittedPart(token);
    expect(part.type).not.toBe("data-approval-pause");
    expect(ApprovalPauseSchema.safeParse(part.data).success).toBe(false);
  });
});
