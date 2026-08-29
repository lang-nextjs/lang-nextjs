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
 * THE INSTRUMENT HERE IS THE SDK'S OWN SCHEMA, `uiMessageChunkSchema`, resolved
 * out of the installed `ai` package. Not a local re-description of it, which
 * would go stale in exactly the direction that hides a defect. `expectRejected`
 * below is the positive control: it demonstrates on every run that this
 * validator DOES reject the pre-fix frame, so a green result here means the
 * frames passed rather than that nothing was checked.
 *
 * Cross-package by necessity — `packages/server` does not depend on `ai`, and
 * adding a dependency to a shared package to hold a test is the wrong trade.
 * Lives beside accumulator-parity.test.ts, which reaches into siblings for the
 * same reason; both are typechecked by tsconfig.parity.json.
 */
import { describe, it, expect, vi } from "vitest";
import { uiMessageChunkSchema } from "ai";

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

/**
 * Resolve the SDK's lazy schema once and expose a plain predicate.
 *
 * `uiMessageChunkSchema` is a `LazySchema` — a thunk returning
 * `{ _type, jsonSchema, validate }`. Calling it is how you get the validator;
 * there is no other supported route from this package, which has no
 * `@ai-sdk/provider-utils` of its own to borrow `safeValidateTypes` from.
 */
type Validator = (v: unknown) => Promise<{ success: boolean; error?: unknown }>;
const validateChunk: Validator = (
  uiMessageChunkSchema as unknown as () => { validate: Validator }
)().validate;

async function assertAllValid(frames: SseFrame[], label: string) {
  for (const f of frames) {
    if (!f.raw.startsWith("data: ")) continue;
    const chunk = JSON.parse(f.raw.slice(6)) as unknown;
    const result = await validateChunk(chunk);
    expect(
      result.success,
      `${label}: AI SDK v6 rejects ${f.raw}\n${String(result.error).slice(
        0,
        600
      )}`
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
    const result = await validateChunk({
      type: "tool-input-start",
      toolCallId: "tc1",
      toolName: "increment",
      input: { by: 1 },
    });
    expect(result.success).toBe(false);
  });

  it("ACCEPTS the same frame with `input` stripped", async () => {
    const result = await validateChunk({
      type: "tool-input-start",
      toolCallId: "tc1",
      toolName: "increment",
    });
    expect(result.success).toBe(true);
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
