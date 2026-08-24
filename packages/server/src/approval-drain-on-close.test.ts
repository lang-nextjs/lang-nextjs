/**
 * DRAIN-ON-CLOSE — the approval gate must not silently discard buffered frames when
 * upstream ends while a human is still deciding.
 *
 * THE DEFECT (issue #25b). `createApprovalGatingTransform` drains buffered frames only from
 * inside the transform, and the transform runs only per input frame. When upstream closes,
 * handler.ts's `done` branch flushes the accumulator — zero frames for a well-formed stream —
 * and closes the controller. Everything still buffered is discarded: no frames, no error, the
 * stream just ends. The approval POST still returns 200 and the registry still reads
 * "success", so the client is told the action succeeded while its continuation is dropped.
 *
 * Reproduced deterministically on chromium by varying only human decision latency; the cliff
 * sits exactly at the mock backend's 4s close. WebKit was a trigger, not the cause.
 *
 * WHAT THESE TESTS ASSERT, AND WHY NOT THE OBVIOUS THING.
 * The tempting assertion is "the internal buffers are empty at close". That is a proxy and it
 * fails the standard question — what would have to be true for it to pass while the property
 * is violated? At least five answers:
 *
 *   1. The fixture never fills a buffer (require:false, wrong frame shape, no gating) — then
 *      "closed with a non-empty buffer" never occurs and the assertion is vacuously true.
 *      This is the same shape as a mutation that never applies.
 *   2. The buffers are read AFTER the drain emptied them, so they measure post-state rather
 *      than whether anything was emitted.
 *   3. The buffers are closure-private internals. Their emptiness says nothing about what the
 *      CLIENT received — which is the actual property.
 *   4. "Some frames were emitted" is satisfied by an unrelated frame (a terminal frame, an
 *      error frame) while the buffered payload is still lost.
 *   5. Resolving the approval BEFORE upstream close exercises the normal in-band drain and
 *      never touches the close path at all.
 *
 * So every test here asserts on BYTES THE CLIENT ACTUALLY RECEIVED, resolves the approval
 * strictly AFTER upstream has ended, and carries an explicit guard proving the buffer was
 * non-empty at close time (defeating #1 and #5).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./stream-registry", () => ({
  atomicRegisterIfAbsent: vi.fn(),
  markStreamDone: vi.fn(),
  deleteStream: vi.fn(),
  lookupStream: vi.fn(),
}));
vi.mock("./reconnect", () => ({ isStreamReconnectEnabled: vi.fn(() => false) }));

/**
 * CHECK-4b harness — the broken build, available in this same run.
 *
 * A test that has only ever been seen to pass is not evidence. When `simulatePreFixBuild` is
 * on, `drainOnClose()` returns nothing, which is exactly the pre-fix behaviour: the handler
 * asks the gate to settle, the gate says "nothing", and the stream closes on top of a
 * non-empty buffer. Everything else — fixture, handler, registry, assertions — is identical.
 *
 * This makes the positive and negative tests a DISCRIMINATING PAIR over one fixture:
 *   · if the fix regressed, the positive test fails;
 *   · if the fixture stopped gating (the vacuous-pass mode), the tool frame would flow
 *     straight through and the NEGATIVE control would fail instead.
 * Neither can pass for the wrong reason without the other going red.
 */
const ctl = vi.hoisted(() => ({ simulatePreFixBuild: false }));

vi.mock("./approval-gating", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./approval-gating")>();
  return {
    ...actual,
    createApprovalGatingTransform: (cfg: Parameters<
      typeof actual.createApprovalGatingTransform
    >[0]) => {
      const real = actual.createApprovalGatingTransform(cfg);
      const wrapped = ((f: Parameters<typeof real>[0]) => real(f)) as ReturnType<
        typeof actual.createApprovalGatingTransform
      >;
      wrapped.hasPending = () => real.hasPending();
      wrapped.drainOnClose = async () =>
        ctl.simulatePreFixBuild ? [] : real.drainOnClose();
      return wrapped;
    },
  };
});

import { createSseProxyHandler } from "./handler";
import type { SseProxyHandlerOptions } from "./handler";
import { coreDefaultAdapter } from "./core-test-adapters";
import { resolveApproval } from "./approval-registry";

/**
 * Core transport handler for tests. Issue #17b.
 *
 * This file tests the TRANSPORT, so it must survive `eject langchain` — a fork containing the
 * lowest rung and nothing above it. It previously used `createDeepAgentsHandler`, the RUNG-3
 * wrapper, which left the core with zero working tests in any ejected fork.
 *
 * `coreDefaultAdapter` is behaviour-identical to `deepagentsAdapter` (both are
 * `defaultTransforms`, which is core), so this migration changes no assertion. The spread is
 * last so a test that passes its own `adapter` still overrides the default.
 */
const createHandler = (options: SseProxyHandlerOptions) =>
  createSseProxyHandler({ adapter: coreDefaultAdapter, ...options });


const TOOL_INPUT_START =
  'data: {"type":"tool-input-start","toolCallId":"tc-1","toolName":"bash_execute","input":{"command":"echo hi"}}\n\n';

/**
 * A WELL-FORMED upstream: the gated tool frame followed by a terminal `finish`.
 *
 * The terminal frame matters and an earlier draft of this file got it wrong. handler.ts sets
 * `sawTerminalFrame` from the RAW input frame before transforms, so a `finish` arriving while
 * an approval is pending still marks the stream as cleanly finished — which SUPPRESSES the
 * `upstream_disconnect` error on the done path. Without the terminal frame the handler emits
 * that unrelated error and a loose assertion ("some data-error appeared") passes for entirely
 * the wrong reason. With it, the loss is exactly what production sees: complete silence.
 *
 * The `finish` frame is itself buffered globally, so under the defect the client is never
 * even told the stream completed.
 */
const WELL_FORMED_UPSTREAM =
  TOOL_INPUT_START + 'data: {"type":"finish"}\n\n';

/** Upstream that emits `body` and then CLOSES immediately — the whole point of the repro. */
function upstreamThatClosesImmediately(body: string) {
  return {
    status: 200,
    headers: new Headers(),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
  } as never;
}

function makeRequest() {
  return {
    headers: new Headers(),
    arrayBuffer: async () => new TextEncoder().encode("{}").buffer,
  } as never;
}

/**
 * Read the response, and the instant a `data-approval-required` frame arrives, resolve that
 * approval with `decision`. Upstream has already closed by then — the fake enqueues one chunk
 * and closes in the same tick — so the resolve necessarily happens AFTER upstream end, which
 * is the condition under test.
 */
async function readResolvingApprovalAfterUpstreamClose(
  response: Response,
  decision: "approve" | "reject" = "approve"
): Promise<{ body: string; sawApprovalFrame: boolean; approvalId: string | null }> {
  const reader = response.body!.getReader();
  const dec = new TextDecoder();
  let body = "";
  let approvalId: string | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    body += dec.decode(value, { stream: true });

    if (approvalId === null) {
      const line = body
        .split("\n")
        .find((l) => l.includes('"type":"data-approval-required"'));
      if (line) {
        approvalId = JSON.parse(line.slice(6)).data.id as string;
        // Upstream is finished; the human decides now. Under the defect the stream is
        // already closing and this resolution reaches a client that will never be told.
        resolveApproval(approvalId, decision);
      }
    }
  }
  return { body, sawApprovalFrame: approvalId !== null, approvalId };
}

describe("approval gating — drain on upstream close (issue #25b)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    ctl.simulatePreFixBuild = false;
  });

  it("GUARD: the scenario really does gate a frame and leave it buffered at close", async () => {
    // Defeats failure mode 1. If gating silently stopped happening, every assertion below
    // would pass while proving nothing — so pin that the gate fired and that the gated frame
    // is NOT in the output at the moment the approval is still unresolved.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(upstreamThatClosesImmediately(WELL_FORMED_UPSTREAM))
    );
    const handler = createHandler({
      backendUrl: "http://backend",
      approvalGating: { getApprovalConfig: () => ({ require: true }) },
    });
    const response = (await handler(makeRequest())) as unknown as Response;
    const reader = response.body!.getReader();
    const dec = new TextDecoder();
    const { value } = await reader.read();
    const first = dec.decode(value!, { stream: true });

    expect(first).toContain('"type":"data-approval-required"');
    // The gated frame is withheld — i.e. it IS buffered right now.
    expect(first).not.toContain('"type":"tool-input-start"');
    await reader.cancel();
  });

  it("the buffered tool frame reaches the client when approval resolves AFTER upstream close", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(upstreamThatClosesImmediately(WELL_FORMED_UPSTREAM))
    );
    const handler = createHandler({
      backendUrl: "http://backend",
      approvalGating: { getApprovalConfig: () => ({ require: true }) },
    });
    const response = (await handler(makeRequest())) as unknown as Response;

    const { body, sawApprovalFrame } =
      await readResolvingApprovalAfterUpstreamClose(response);

    // Guard: the approval frame must have been seen, else the resolve never happened and the
    // assertion below would be testing nothing.
    expect(sawApprovalFrame).toBe(true);
    // THE PROPERTY: the continuation the human approved actually reached the client.
    expect(body).toContain('"toolCallId":"tc-1"');
    expect(body).toContain("tool-input");
  });

  it("a rejected approval still closes with an in-band error, never silence", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(upstreamThatClosesImmediately(WELL_FORMED_UPSTREAM))
    );
    const handler = createHandler({
      backendUrl: "http://backend",
      approvalGating: { getApprovalConfig: () => ({ require: true }) },
    });
    const response = (await handler(makeRequest())) as unknown as Response;

    const { body, sawApprovalFrame } =
      await readResolvingApprovalAfterUpstreamClose(response, "reject");

    expect(sawApprovalFrame).toBe(true);
    // Reject drops the tool frames by design, but the client must be TOLD.
    expect(body).toContain("approval_rejected");
  });

  it("an approval that is never resolved closes with an error rather than silence", async () => {
    // The unresolvable case: nobody decides. Holding forever is not an option, so the stream
    // must end — but it must end LOUDLY. Silence here is the original defect.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(upstreamThatClosesImmediately(WELL_FORMED_UPSTREAM))
    );
    const handler = createHandler({
      backendUrl: "http://backend",
      approvalGating: {
        // 50ms so the test does not wait on the 5-minute production default.
        getApprovalConfig: () => ({ require: true, timeoutMs: 50 }),
      },
    });
    const response = (await handler(makeRequest())) as unknown as Response;
    const reader = response.body!.getReader();
    const dec = new TextDecoder();
    let body = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      body += dec.decode(value, { stream: true });
    }
    expect(body).toContain('"type":"data-approval-required"');
    // Must be an APPROVAL-specific signal. `data-error` alone is too loose: handler.ts emits
    // `upstream_disconnect` whenever no terminal frame was seen, which would satisfy a generic
    // check while the approval loss stayed silent. This upstream sends `finish`, so that error
    // cannot fire here — and the assertion names the codes that actually mean something.
    expect(body).toMatch(/approval_timeout|approval_pending_at_close/);
    expect(body).not.toContain("upstream_disconnect");
  });
});

describe("CHECK-4b — the assertion is observed to FAIL against a broken build", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    ctl.simulatePreFixBuild = true;
  });
  afterEach(() => {
    ctl.simulatePreFixBuild = false;
  });

  it("NEGATIVE CONTROL: with drain-on-close disabled, the approved frame IS lost, silently", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(upstreamThatClosesImmediately(WELL_FORMED_UPSTREAM))
    );
    const handler = createHandler({
      backendUrl: "http://backend",
      approvalGating: { getApprovalConfig: () => ({ require: true }) },
    });
    const response = (await handler(makeRequest())) as unknown as Response;

    const { body, sawApprovalFrame } =
      await readResolvingApprovalAfterUpstreamClose(response);

    // The gate still fired and the human still approved — same fixture, same flow.
    expect(sawApprovalFrame).toBe(true);

    // ...and the continuation is gone. This is the defect, reproduced on demand. If this
    // assertion ever starts failing, the fixture stopped exercising the gated path and the
    // positive tests above became vacuous — that is what this control is here to detect.
    expect(body).not.toContain('"toolCallId":"tc-1"');
    // Silently: no terminal frame reached the client either, and no error explained it.
    expect(body).not.toContain('"type":"finish"');
    expect(body).not.toContain("data-error");
  });
});
