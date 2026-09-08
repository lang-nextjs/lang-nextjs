/**
 * WHAT THE APPROVAL GATE RELEASES MUST BE READABLE BY AI SDK v6 (#256).
 *
 * Every other test of `approval-gating.ts` reads the frames it emits with
 * `JSON.parse`, which accepts anything. The client does not: AI SDK v6 parses
 * standard frames with `strictObject`, so a chunk carrying one extra key is
 * DISCARDED rather than rendered. Between those two readers sits a whole class
 * of change that passes every test and reaches nobody.
 *
 * #311 fixed the gate's REPORTING — a decision arriving after execution now
 * says so, and the buffered frames are released rather than dropped. Its test
 * asserts the release by looking for `tool-output-available` in the transform's
 * output. That assertion could not fail on account of the frames being
 * unreadable, because it never asked a reader. The released
 * `tool-input-start` still carried the upstream's `input`, which the SDK
 * rejects — so "released, not dropped" was true of the transform and false of
 * the wire.
 *
 * THE INSTRUMENT IS THIS REPOSITORY'S OWN CONTRACT, NOT THE SDK'S SCHEMA (#939).
 * It was `uiMessageChunkSchema` from the installed `ai`, which was right while
 * that schema was strict. Under `ai` v7 it is not — the chunk union moved from
 * `strictObject` to `looseObject` — and the two POSITIVE CONTROLS below went
 * red. Measured on `ai@7.0.93`, it now ACCEPTS the exact frame deepagents used
 * to emit. Controls going red on a bump is them working; had they gone green
 * the suite would have kept reporting conformance while checking nothing.
 *
 * The vendor's strictness was never the property under test, only the mechanism
 * that supplied it. `docs/sse-frame-schema.json` carries
 * `additionalProperties: false` on all 21 variants since #945, so this
 * repository already asserts that property about its own wire format, and a
 * dependency cannot take it away. See `frame-contract.ts` for why the verdict
 * comes from the union and the message from the branch.
 *
 * THE CONTROLS AND THE ASSERTIONS SHARE ONE READER, DELIBERATELY. Re-pointing
 * only the controls would leave them demonstrating something about a validator
 * the assertions do not use — a control that runs through a different tool
 * certifies nothing about the tool that produced the verdict.
 *
 * Cross-package by necessity — `packages/server` does not depend on `ai`, and
 * adding a dependency to a shared package to hold a test is the wrong trade.
 * Lives beside accumulator-parity.test.ts, which reaches into siblings for the
 * same reason; both are typechecked by tsconfig.parity.json.
 */
import { describe, it, expect, vi } from "vitest";

import { checkFrame } from "./frame-contract";

import { createApprovalGatingTransform } from "../../server/src/approval-gating";
import { resolveApproval } from "../../server/src/approval-registry";
import type { SseFrame } from "../../server/src/accumulator";

vi.mock("../../server/src/stream-registry", () => ({
  atomicRegisterIfAbsent: vi.fn(),
  markStreamDone: vi.fn(),
  deleteStream: vi.fn(),
  lookupStream: vi.fn(),
}));
vi.mock("../../server/src/reconnect", () => ({
  isStreamReconnectEnabled: vi.fn(() => false),
}));

async function assertAllValid(frames: SseFrame[], label: string) {
  for (const f of frames) {
    if (!f.raw.startsWith("data: ")) continue;
    const chunk = JSON.parse(f.raw.slice(6)) as unknown;
    const verdict = checkFrame(chunk);
    expect(
      verdict.valid,
      `${label}: the wire contract rejects ${f.raw}\n${verdict.message}`
    ).toBe(true);
  }
}

const frame = (o: Record<string, unknown>): SseFrame => ({
  raw: `data: ${JSON.stringify(o)}`,
});

const gateAll = () => ({ require: true, timeoutMs: 40 });

function feed(
  t: ReturnType<typeof createApprovalGatingTransform>,
  frames: SseFrame[]
): SseFrame[] {
  const out: SseFrame[] = [];
  for (const f of frames) {
    const r = t(f);
    if (Array.isArray(r)) out.push(...r);
    else if (r) out.push(r);
  }
  return out;
}

/**
 * The deepagents ordering, which is the one that gates. `tool-input-start`
 * carries `input` — that is what the Python side emits, seen on the wire, and
 * it is the frame the SDK rejects.
 */
const deepagentsOrdering = (): SseFrame[] => [
  frame({
    type: "tool-input-start",
    toolCallId: "tc1",
    toolName: "increment",
    input: { by: 1 },
  }),
  frame({
    type: "tool-input-available",
    toolCallId: "tc1",
    toolName: "increment",
    input: { by: 1 },
  }),
  frame({
    type: "tool-output-available",
    toolCallId: "tc1",
    output: "Counter incremented to 37",
  }),
];

function approvalIdOf(frames: SseFrame[]): string {
  for (const f of frames) {
    const p = JSON.parse(f.raw.slice(6)) as Record<string, unknown>;
    if (p.type === "data-approval-required") {
      return (p.data as Record<string, string>).id;
    }
  }
  throw new Error("no data-approval-required frame was emitted");
}

const lapse = () => new Promise((r) => setTimeout(r, 90));

describe("the validator is real — positive control", () => {
  it("REJECTS a tool-input-start that carries `input`", async () => {
    /*
     * The whole suite below is worthless if this passes. It is the exact frame
     * deepagents emits and the exact frame the release paths used to hand
     * through untouched.
     */
    const verdict = checkFrame({
      type: "tool-input-start",
      toolCallId: "tc1",
      toolName: "increment",
      input: { by: 1 },
    });
    expect(verdict.valid, `the contract ACCEPTED it: ${verdict.message}`).toBe(
      false
    );
    /*
     * AND IT NAMES THE KEY. A rejection alone is satisfied by any reason at all — a typo in
     * `type` would produce one. Under the raw 21-branch `oneOf` the first ajv error names
     * `toolCallId` from an unrelated branch, so asserting the verdict without the attribution
     * is how a control passes while pointing at the wrong field.
     */
    expect(verdict.undeclared).toEqual(["input"]);
  });

  it("ACCEPTS the same frame with `input` stripped", async () => {
    const verdict = checkFrame({
      type: "tool-input-start",
      toolCallId: "tc1",
      toolName: "increment",
    });
    expect(verdict.valid, verdict.message).toBe(true);
    expect(verdict.undeclared).toEqual([]);
  });
});

describe("every frame the approval gate emits validates against AI SDK v6", () => {
  it("approve", async () => {
    const t = createApprovalGatingTransform({ getApprovalConfig: gateAll });
    const gated = feed(t, deepagentsOrdering());
    await assertAllValid(gated, "approve/pre");
    resolveApproval(approvalIdOf(gated), "approve");
    await assertAllValid(await t.drainOnClose(), "approve/drain");
  });

  it("edit — refused because the buffer proves execution", async () => {
    const t = createApprovalGatingTransform({ getApprovalConfig: gateAll });
    const gated = feed(t, deepagentsOrdering());
    resolveApproval(approvalIdOf(gated), "edit", {
      editedInput: { by: 5 },
    });
    const drained = await t.drainOnClose();
    await assertAllValid(drained, "edit/drain");

    // And the record released is the one that actually happened.
    const announced = drained
      .map((f) => JSON.parse(f.raw.slice(6)) as Record<string, unknown>)
      .filter((p) => p.type === "tool-input-available");
    expect(announced).toHaveLength(1);
    expect(announced[0].input).toEqual({ by: 1 });
  });

  it("reject, with execution already proven", async () => {
    const t = createApprovalGatingTransform({ getApprovalConfig: gateAll });
    const gated = feed(t, deepagentsOrdering());
    resolveApproval(approvalIdOf(gated), "reject");
    await assertAllValid(await t.drainOnClose(), "reject/drain");
  });

  it("upstream closed with the approval still pending", async () => {
    const t = createApprovalGatingTransform({
      getApprovalConfig: gateAll,
      drainGraceMs: 0,
    });
    feed(t, deepagentsOrdering());
    await lapse();
    await assertAllValid(await t.drainOnClose(), "close/drain");
  });
});
