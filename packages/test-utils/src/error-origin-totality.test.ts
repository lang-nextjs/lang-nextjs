/**
 * EVERY data-error FRAME CARRIES AN origin, CHECKED AT THE REAL EMITTERS (#433).
 *
 * `origin` was TOTAL AT THE PRODUCER and PARTIAL AT THE CONSUMER. `_error_origin`
 * in the Python backends returns `provider` or `backend` and has no third
 * branch — but it was set at exactly one emitter, while the proxy had two more
 * that set nothing. A consumer therefore saw THREE states, and any partition on
 * "is it provider?" silently assigned ABSENT to the other side: a proxy-emitted
 * frame counted as a backend transport defect, blaming our own code for a frame
 * the proxy produced about something else.
 *
 * THE GUARD DRIVES THE REAL EMITTERS. `emitted-frame.check.test.ts` in
 * packages/react checks a data-error payload COPY-PASTED from a real run, and
 * that copy had already drifted: the Python emitter gained `origin` and the
 * fixture never noticed, because a copied payload cannot notice a field the
 * producer STARTED sending. It only surfaced when #433 made the field required.
 * So this file calls the emitters and parses what they actually produce.
 *
 * Cross-package by necessity: packages/server has no dependency on
 * packages/react and should not grow one to hold a test. Excluded from the
 * package tsconfig's rootDir program and typechecked by tsconfig.parity.json.
 */
import { describe, it, expect, vi } from "vitest";

import { createApprovalGatingTransform } from "../../server/src/approval-gating";
import { buildErrorFrame } from "../../server/src/handler";
import type { SseFrame } from "../../server/src/accumulator";
import { DataErrorSchema } from "../../react/src/schemas";

vi.mock("../../server/src/stream-registry", () => ({
  atomicRegisterIfAbsent: vi.fn(),
  markStreamDone: vi.fn(),
  deleteStream: vi.fn(),
  lookupStream: vi.fn(),
}));
vi.mock("../../server/src/reconnect", () => ({
  isStreamReconnectEnabled: vi.fn(() => false),
}));

const frame = (o: Record<string, unknown>): SseFrame => ({
  raw: `data: ${JSON.stringify(o)}`,
});

function dataErrors(frames: SseFrame[]): Record<string, unknown>[] {
  return frames
    .map((f) => {
      try {
        return JSON.parse(f.raw.slice(6)) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((p): p is Record<string, unknown> => p?.type === "data-error")
    .map((p) => p.data as Record<string, unknown>);
}

describe("the proxy's own error frames are attributable (#433)", () => {
  it("approval-gating's emitter produces a frame that parses, with origin=proxy", async () => {
    const t = createApprovalGatingTransform({
      getApprovalConfig: () => ({ require: true, timeoutMs: 1 }),
    });
    for (const f of [
      frame({
        type: "tool-input-start",
        toolCallId: "tc1",
        toolName: "increment",
        input: {},
      }),
    ]) {
      t(f);
    }
    const errs = dataErrors(await t.drainOnClose());

    expect(
      errs.length,
      "the gate emitted no data-error to check"
    ).toBeGreaterThan(0);
    for (const e of errs) {
      const parsed = DataErrorSchema.safeParse(e);
      expect(
        parsed.success,
        `the client's schema rejected a frame the gate emits: ${
          parsed.success ? "" : JSON.stringify(parsed.error.issues)
        }`
      ).toBe(true);
      // The proxy is neither the model provider nor the agent backend, and this
      // is the value that stops a consumer having to guess which it resembles.
      expect(e.origin).toBe("proxy");
    }
  });

  it("handler's emitter produces a frame that parses, with origin=proxy", () => {
    const raw = buildErrorFrame("upstream_timeout", "took too long", true, 0);
    const [payload] = dataErrors([{ raw }]);

    expect(
      payload,
      "buildErrorFrame produced no data-error payload"
    ).toBeTruthy();
    expect(DataErrorSchema.safeParse(payload).success).toBe(true);
    expect(payload!.origin).toBe("proxy");
  });
});

describe("the partition is total, and absent is not a value (#433 both directions)", () => {
  /*
   * THE ACCEPT CASES. Without them this is satisfied by a schema that demands
   * `proxy` specifically, which would reject every frame the backends emit — the
   * existing behaviour must classify unchanged, and these are what say so.
   */
  it("a provider frame still parses", () => {
    expect(
      DataErrorSchema.safeParse({
        id: "e",
        seq: 0,
        code: "upstream_404",
        message: "no such model",
        retryable: false,
        origin: "provider",
      }).success
    ).toBe(true);
  });

  it("a backend frame still parses", () => {
    expect(
      DataErrorSchema.safeParse({
        id: "e",
        seq: 0,
        code: "backend_error",
        message: "boom",
        retryable: false,
        origin: "backend",
      }).success
    ).toBe(true);
  });

  it("ABSENT STAYS ABSENT — the schema must never manufacture an origin (#433)", () => {
    /*
     * CONDITION 2, AND IT IS WHERE #433'S REQUIREMENT LIVES NOW.
     *
     * The issue says a consumer must not be able to treat absent as a value. The
     * first version enforced that by REQUIRING origin, and an e2e showed the
     * cost: the frame is rejected, dropped, and the user is told nothing went
     * wrong — an error channel deleting error reports. Attribution is metadata
     * ABOUT an error; the error itself matters more.
     *
     * So the schema permits absent, and what must never happen is INVENTING one.
     * `.default("proxy")` here, or `origin ?? "proxy"` at a consumer, produces a
     * value that is not missing but WRONG — and a wrong attribution survives
     * inspection in a way a missing one does not. This case fails the moment
     * anyone adds either.
     */
    const parsed = DataErrorSchema.parse({
      id: "e",
      seq: 0,
      code: "backend_error",
      message: "boom",
      retryable: false,
    });
    expect(
      "origin" in parsed ? parsed.origin : undefined,
      "an absent origin was given a value — the schema manufactured an attribution"
    ).toBeUndefined();
  });

  it("absent is DISTINGUISHABLE from every real origin", () => {
    /*
     * The presence companion for the case above: "undefined" is only meaningful
     * if a real origin does NOT also read as undefined. Without this, a schema
     * that stripped the field entirely would pass the assertion above while
     * destroying the attribution it exists to carry.
     */
    for (const origin of ["provider", "backend", "proxy"] as const) {
      const parsed = DataErrorSchema.parse({
        id: "e",
        seq: 0,
        code: "backend_error",
        message: "boom",
        retryable: false,
        origin,
      });
      expect(parsed.origin, `${origin} did not survive the parse`).toBe(origin);
    }
  });

  it("a frame with no origin still PARSES, so an error is never deleted for lacking metadata", () => {
    // The half the e2e taught us. Rejecting here means the frame never becomes
    // the error message it was meant to be. `partsToMessages` substitutes an
    // `unreadable` entry rather than dropping silently, but only open-swe
    // renders that — the example app has no branch for it, which is where this
    // showed up as nothing on screen at all (#520). The error is lost either
    // way; the difference is whether anything says so.
    expect(
      DataErrorSchema.safeParse({
        id: "e",
        seq: 0,
        code: "backend_error",
        message: "boom",
        retryable: false,
      }).success
    ).toBe(true);
  });

  it("an origin outside the three is REJECTED", () => {
    expect(
      DataErrorSchema.safeParse({
        id: "e",
        seq: 0,
        code: "backend_error",
        message: "boom",
        retryable: false,
        origin: "gateway",
      }).success
    ).toBe(false);
  });
});
