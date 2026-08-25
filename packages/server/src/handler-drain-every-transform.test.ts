/**
 * THE DRAIN APPLIES TO EVERY BUFFERING TRANSFORM, NOT ONLY THE ONE THE HANDLER BUILT.
 *
 * handler.ts has held frames open for a pending approval since #39, but it drained exactly one
 * transform: the gate it constructs itself from `options.approvalGating`. A gate supplied
 * through `options.transforms` was never drained.
 *
 * That distinction was invisible and load-bearing. open-swe supplies its gate through
 * `transforms` BECAUSE ORDERING REQUIRES IT — the gate must run after the enrichment transform,
 * and `approvalGating` is spliced in ahead of `options.transforms`. So the caller was silently
 * choosing between correct ordering and the #25b guarantee. Under the defect the approved
 * continuation never reached the client, the approval POST still returned 200, the registry
 * still read "success", and the `finish` frame was swallowed too, so the client was not even
 * told the stream had ended. Nothing failed anywhere.
 *
 * WHAT WOULD LET THESE PASS WHILE THE PROPERTY IS STILL BROKEN, and what stops it:
 *   · a fixture that never gates -> every test would pass trivially, so each one first asserts
 *     the approval frame appeared AND that the gated frame was withheld before the decision;
 *   · draining only the FIRST drainable found -> "two independent transforms both release"
 *     fails, because the second one's frames never arrive;
 *   · re-running the whole pipeline over drained frames -> "a transform BEFORE the gate does
 *     not see them again" fails, catching the double-transform that a naive fix introduces.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSseProxyHandler } from "./handler";
import type { SseFrame, SseMultiTransform, SseTransform } from "./accumulator";
import { coreDefaultAdapter } from "./core-test-adapters";
import { createApprovalGatingTransform } from "./approval-gating";
import { resolveApproval } from "./approval-registry";

const TOOL_INPUT_START =
  'data: {"type":"tool-input-start","toolCallId":"tc-1","toolName":"bash_execute","input":{"command":"echo hi"}}\n\n';

/**
 * The terminal `finish` matters. handler.ts sets `sawTerminalFrame` from the RAW input frame
 * before transforms, so a `finish` arriving while an approval is pending still marks the stream
 * cleanly finished — which SUPPRESSES the `upstream_disconnect` error on the done path. Without
 * it the handler emits that unrelated error and a loose assertion passes for the wrong reason.
 */
const UPSTREAM = TOOL_INPUT_START + 'data: {"type":"finish"}\n\n';

beforeEach(() => {
  vi.stubGlobal("fetch", async () => ({
    status: 200,
    headers: new Headers(),
    body: new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(UPSTREAM));
        c.close();
      },
    }),
  }));
});

const makeRequest = () =>
  ({
    headers: new Headers(),
    arrayBuffer: async () => new TextEncoder().encode("{}").buffer,
  } as never);

const gate = () =>
  createApprovalGatingTransform({
    getApprovalConfig: () => ({ require: true }),
  }) as unknown as SseTransform;

/**
 * Read to completion, resolving the approval the instant its frame appears. The fake upstream
 * enqueues one chunk and closes in the same tick, so the resolve necessarily lands AFTER
 * upstream end — which is the condition under test.
 */
async function readResolving(response: Response): Promise<{
  body: string;
  sawApprovalFrame: boolean;
  gatedFrameWithheldBeforeDecision: boolean;
}> {
  const reader = response.body!.getReader();
  const dec = new TextDecoder();
  let body = "";
  let approvalId: string | null = null;
  let gatedFrameWithheldBeforeDecision = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    body += dec.decode(value, { stream: true });

    if (approvalId === null) {
      const line = body
        .split("\n")
        .find((l) => l.includes('"type":"data-approval-required"'));
      if (line) {
        // Vacuity guard: at the moment the gate fires, the gated frame must NOT yet have been
        // emitted. If it had, the transform is not gating and every assertion below is empty.
        gatedFrameWithheldBeforeDecision = !body.includes(
          '"toolCallId":"tc-1"'
        );
        approvalId = JSON.parse(line.slice(6)).data.id as string;
        resolveApproval(approvalId, "approve");
      }
    }
  }
  return {
    body,
    sawApprovalFrame: approvalId !== null,
    gatedFrameWithheldBeforeDecision,
  };
}

function expectGatedThenReleased(r: {
  body: string;
  sawApprovalFrame: boolean;
  gatedFrameWithheldBeforeDecision: boolean;
}) {
  expect(r.sawApprovalFrame, "the gate must have fired").toBe(true);
  expect(
    r.gatedFrameWithheldBeforeDecision,
    "the gated frame must have been withheld before the decision, else nothing was gated"
  ).toBe(true);
  expect(r.body, "the approved continuation must reach the client").toContain(
    '"toolCallId":"tc-1"'
  );
}

/** A transform that records what it sees and passes everything through unchanged. */
function spyTransform(seen: string[]): SseMultiTransform {
  return ((frame: SseFrame) => {
    seen.push(frame.raw);
    return frame;
  }) as SseMultiTransform;
}

describe("handler drain-on-close — every buffering transform, not just the built-in gate", () => {
  it("releases the continuation for a gate supplied via options.transforms", async () => {
    // THE REGRESSION THIS FILE EXISTS FOR. Before the fix this failed: the client received the
    // data-approval-required frame and nothing else, ever.
    const handler = createSseProxyHandler({
      adapter: coreDefaultAdapter,
      backendUrl: "http://backend",
      transforms: [gate()],
    });
    expectGatedThenReleased(
      await readResolving((await handler(makeRequest())) as unknown as Response)
    );
  });

  it("still releases it for a gate supplied via options.approvalGating", async () => {
    // The path that already worked. Kept so the generalisation cannot fix one route by
    // breaking the other — the two are a pair, and a change that trades them is not a fix.
    const handler = createSseProxyHandler({
      adapter: coreDefaultAdapter,
      backendUrl: "http://backend",
      approvalGating: { getApprovalConfig: () => ({ require: true }) },
    });
    expectGatedThenReleased(
      await readResolving((await handler(makeRequest())) as unknown as Response)
    );
  });

  it("EVERY pending transform drains, not just the first one found", async () => {
    // Kills find-then-drain. Two independent gates, each holding its own frame; a loop that
    // stopped at the first match would strand the second, and the body would be short exactly
    // one tool frame while every other assertion still passed.
    const released: SseFrame[] = [
      { raw: 'data: {"type":"data-second-drainable"}' } as SseFrame,
    ];
    const second = ((f: SseFrame) => f) as SseMultiTransform & {
      hasPending: () => boolean;
      drainOnClose: () => Promise<SseFrame[]>;
    };
    second.hasPending = () => true;
    second.drainOnClose = async () => released;

    const handler = createSseProxyHandler({
      adapter: coreDefaultAdapter,
      backendUrl: "http://backend",
      transforms: [gate(), second as unknown as SseTransform],
    });
    const r = await readResolving(
      (await handler(makeRequest())) as unknown as Response
    );

    expectGatedThenReleased(r);
    expect(
      r.body,
      "the second drainable's frames must be released too"
    ).toContain('"type":"data-second-drainable"');
  });

  it("feeds drained frames to transforms AFTER the drainer, and not to ones before it", async () => {
    // The ordering property, and the reason `downstream` is a parameter. Frames released by a
    // transform have already been through it and everything ahead of it; re-running the whole
    // pipeline would transform them twice and feed them back into the gate that just let them
    // go. `before` is the control: if it sees the released frame, the slice is wrong.
    const before: string[] = [];
    const after: string[] = [];
    const handler = createSseProxyHandler({
      adapter: coreDefaultAdapter,
      backendUrl: "http://backend",
      transforms: [
        spyTransform(before) as unknown as SseTransform,
        gate(),
        spyTransform(after) as unknown as SseTransform,
      ],
    });
    const r = await readResolving(
      (await handler(makeRequest())) as unknown as Response
    );
    expectGatedThenReleased(r);

    const releasedSeenAfter = after.filter((raw) =>
      raw.includes('"toolCallId":"tc-1"')
    ).length;
    const releasedSeenBefore = before.filter((raw) =>
      raw.includes('"toolCallId":"tc-1"')
    ).length;

    expect(
      releasedSeenAfter,
      "a transform after the gate must process the released frame"
    ).toBeGreaterThan(0);
    // The frame passes `before` ONCE on its way in. If the drain re-ran the full pipeline it
    // would pass a second time, which is the double-transform this asserts against.
    expect(
      releasedSeenBefore,
      "a transform before the gate must not see the released frame a second time"
    ).toBe(1);
  });

  it("a transform whose drain throws does not crash the stream or strand later transforms", async () => {
    // Draining must never turn a recoverable truncation into a dead stream, and one bad
    // drainer must not take the ones after it down with it.
    const thrower = ((f: SseFrame) => f) as SseMultiTransform & {
      hasPending: () => boolean;
      drainOnClose: () => Promise<SseFrame[]>;
    };
    thrower.hasPending = () => true;
    thrower.drainOnClose = async () => {
      throw new Error("drain exploded");
    };

    const handler = createSseProxyHandler({
      adapter: coreDefaultAdapter,
      backendUrl: "http://backend",
      transforms: [thrower as unknown as SseTransform, gate()],
    });
    const r = await readResolving(
      (await handler(makeRequest())) as unknown as Response
    );

    // The gate sits AFTER the thrower, so this also proves the loop continued past the failure.
    expectGatedThenReleased(r);
  });

  it("does not call drainOnClose when nothing is pending", async () => {
    // Guards against draining unconditionally, which would do needless work on every stream
    // and — worse — mask a hasPending() that had stopped reporting correctly.
    const drain = vi.fn(async () => []);
    const idle = ((f: SseFrame) => f) as SseMultiTransform & {
      hasPending: () => boolean;
      drainOnClose: () => Promise<SseFrame[]>;
    };
    idle.hasPending = () => false;
    idle.drainOnClose = drain;

    const handler = createSseProxyHandler({
      adapter: coreDefaultAdapter,
      backendUrl: "http://backend",
      transforms: [idle as unknown as SseTransform],
    });
    const res = (await handler(makeRequest())) as unknown as Response;
    await new Response(res.body).text();

    expect(drain).not.toHaveBeenCalled();
  });

  it("a plain transform with neither method is left alone", async () => {
    // The common case: the pipeline is mostly ordinary functions. The structural check must
    // not throw on an object that simply does not implement the optional members.
    const seen: string[] = [];
    const handler = createSseProxyHandler({
      adapter: coreDefaultAdapter,
      backendUrl: "http://backend",
      transforms: [spyTransform(seen) as unknown as SseTransform],
    });
    const res = (await handler(makeRequest())) as unknown as Response;
    const body = await new Response(res.body).text();

    expect(seen.length).toBeGreaterThan(0);
    expect(body).toContain('"toolCallId":"tc-1"');
  });
});
