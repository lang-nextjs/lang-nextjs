/**
 * `SseFrame.attribution` MUST NEVER REACH THE WIRE (issue #38b).
 *
 * The whole justification for widening `SseFrame` rests on one clause: the handler serializes
 * only `out.raw`. That is what makes `attribution` an in-process side channel, and it is the
 * only reason AI SDK v6's `strictObject` does not reject it — the same strictness that forces
 * `stripMessageIdTransform` to exist. If a refactor ever serialized the frame OBJECT instead
 * of its `raw`, every consumer's parser would start rejecting frames, and the failure would
 * surface in client code far from the change that caused it.
 *
 * Until now that clause was held by a code comment and one manual verification. Per #36's own
 * reasoning: a comment asserting a property is where a belief is exposed, and a one-time
 * manual check is a check that can never fail again.
 *
 * WHY THIS IS BEHAVIOURAL AND NOT TEXTUAL.
 * Asserting `handler.ts` contains the literal `${out.raw}` would be brittle to any legitimate
 * refactor — renaming `out`, extracting the emit loop, switching to a helper — and would pass
 * for a rewrite that reintroduced the bug through a different expression. So these tests drive
 * the REAL handler and inspect the REAL bytes.
 *
 * WHAT WOULD MAKE THIS PASS WHILE THE PROPERTY IS VIOLATED?
 *   1. The fixture never actually sets `attribution` — then "no attribution in the bytes" is
 *      vacuously true. >>> GUARDED: the transform counts its invocations and the test asserts
 *      the stamped object really carries the field.
 *   2. The stream is empty, so there are no bytes to contain anything.
 *      >>> GUARDED: the byte-exactness assertion requires the expected frames to be present.
 *
 * WHAT WOULD MAKE IT FAIL WHILE THE PROPERTY HOLDS?
 *   3. A sentinel that could legitimately occur in payload content — a false positive on a
 *      frame that merely happens to contain the word "depth" or "scope".
 *      >>> The sentinel is a fixed high-entropy token that cannot arise from any payload.
 *
 * VERIFIED BY MUTATION — every one confirmed to have landed before the run that reports it.
 * A suite observed only passing is not evidence.
 *
 *   M1  handler.ts's two emit sites -> `JSON.stringify(out)`.
 *       => "handler: emitted bytes..." FAILS (sentinel leaks). Proves these tests measure the
 *          REAL handler, not a stand-in.
 *   M2  stream-transform.ts's emit loop -> `JSON.stringify(out)`.
 *       => ONLY "transformSseStream: ..." fails. Proves the two sites are covered
 *          INDEPENDENTLY, so a fix to one cannot mask a regression in the other.
 *   M3  the stamping transform stops setting `attribution`.
 *       => GUARD fails ("expected undefined to be defined"). Proves the vacuous-pass mode is
 *          closed. (Note: the negative control still passed under M3, because that mutation
 *          left the sentinel on the object under another key — which is correct behaviour:
 *          the control asks whether ANY internal field leaked, not specifically this one.)
 *   M4  `findLeakedAttribution` blinded to always return null.
 *       => ALL THREE POSITIVES STAY GREEN and only the NEGATIVE CONTROL fails. This is the
 *          clearest statement of why the control exists: a blinded detector is indis-
 *          tinguishable from a passing suite without it.
 *
 * NOT COVERED, DELIBERATELY: the two SYNTHESISED enqueue sites (handler.ts:912 and :961).
 * They build `buildErrorFrame(...)` from string literals and never touch a frame object, so
 * there is no `attribution` in scope for them to leak — an assertion over them would be
 * theatre, green by construction rather than by the property holding. If a real frame is ever
 * routed through those paths, this property needs extending to cover them.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./stream-registry", () => ({
  atomicRegisterIfAbsent: vi.fn(),
  markStreamDone: vi.fn(),
  deleteStream: vi.fn(),
  lookupStream: vi.fn(),
}));
vi.mock("./reconnect", () => ({
  isStreamReconnectEnabled: vi.fn(() => false),
}));

import { createSseProxyHandler } from "./handler";
import { transformSseStream } from "./stream-transform";
import { neutralAdapter } from "./core-test-adapters";
import type { SseFrame, SseMultiTransform } from "./accumulator";

/**
 * High-entropy and structurally impossible in a payload: no adapter, tool name, file path or
 * model output produces this. A softer sentinel ("depth", "scopeId") could collide with real
 * content and turn this suite into a flake that gets deleted rather than believed.
 */
const SENTINEL = "attr-sentinel-9f3c1e7b5a2d4068-DO-NOT-SERIALIZE";

/** Upstream that is already terminal, so the handler adds no upstream_disconnect frame. */
const UPSTREAM_BODY =
  'data: {"type":"text-delta","id":"t1","delta":"hello"}\n\n' +
  'data: {"type":"finish"}\n\n';

function makeUpstream(body: string) {
  return {
    status: 200,
    headers: new Headers(),
    body: new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(body));
        c.close();
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

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out;
}

/** A transform that stamps attribution out-of-band and records that it did. */
function makeStampingTransform() {
  let stamped = 0;
  const transform: SseMultiTransform = (frame: SseFrame) => {
    stamped += 1;
    return {
      raw: frame.raw, // raw is passed through UNCHANGED — the sentinel lives only off-wire
      attribution: {
        depth: 1,
        path: [SENTINEL],
        scopeId: SENTINEL,
        parentScopeId: SENTINEL,
      },
    };
  };
  return { transform, stampedCount: () => stamped };
}

/**
 * THE ASSERTION UNDER TEST, factored out so the negative control can prove it discriminates.
 * Returns the offending substring, or null when the bytes are clean.
 */
function findLeakedAttribution(bytes: string): string | null {
  return bytes.includes(SENTINEL) ? SENTINEL : null;
}

describe("SseFrame.attribution never reaches the wire", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("GUARD: the stamping transform really does attach attribution", () => {
    // Defeats the vacuous pass. If this fixture silently stopped stamping, every assertion
    // below would hold while proving nothing whatsoever.
    const { transform } = makeStampingTransform();
    const out = transform({ raw: "data: {}" }) as SseFrame;
    expect(out.attribution).toBeDefined();
    expect(out.attribution?.scopeId).toBe(SENTINEL);
    expect(out.raw).not.toContain(SENTINEL); // and it is NOT in raw
  });

  it("handler: emitted bytes carry no attribution, and are EXACTLY the raw frames", async () => {
    const { transform, stampedCount } = makeStampingTransform();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeUpstream(UPSTREAM_BODY))
    );

    const handler = createSseProxyHandler({
      backendUrl: "http://backend",
      adapter: neutralAdapter,
      transforms: [transform as never],
    });
    const response = (await handler(makeRequest())) as unknown as Response;
    const bytes = await drain(response.body!);

    // Guard: the transform actually ran over the stream.
    expect(stampedCount()).toBeGreaterThan(0);

    // THE PROPERTY.
    expect(findLeakedAttribution(bytes)).toBeNull();

    // Stronger than "the sentinel is absent": the output is EXACTLY the raw frames and
    // nothing else. This catches serialisation of any extra field, not just this one, and it
    // survives a refactor that renames or relocates the emit loop.
    expect(bytes).toBe(UPSTREAM_BODY);
  });

  it("transformSseStream: the second serialisation site holds the same property", async () => {
    // handler.ts is not the only place frames become bytes. stream-transform.ts has its own
    // emit loop, and a fix applied to one is not a fix applied to both.
    const { transform, stampedCount } = makeStampingTransform();
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(UPSTREAM_BODY));
        c.close();
      },
    });

    const bytes = await drain(transformSseStream(upstream, [transform]));

    expect(stampedCount()).toBeGreaterThan(0);
    expect(findLeakedAttribution(bytes)).toBeNull();
    expect(bytes).toBe(UPSTREAM_BODY);
  });

  it("NEGATIVE CONTROL: an emitter that serialises the FRAME OBJECT is caught", async () => {
    // A test that has only ever been observed passing is not evidence. This is the broken
    // build, in the same run: an emit loop written the wrong way — `JSON.stringify(out)`
    // instead of `out.raw` — fed through the SAME assertion helper the tests above use.
    //
    // It is a stand-in for handler.ts's loop rather than a mutation of it, and the comment
    // says so plainly: the positive tests drive the real handler, and this proves the
    // detector discriminates. Together they are a discriminating pair — if the sentinel ever
    // stopped being detectable, THIS test goes red while the others stay green.
    const { transform } = makeStampingTransform();
    const encoder = new TextEncoder();
    const brokenBytes = await drain(
      new ReadableStream<Uint8Array>({
        start(c) {
          for (const raw of UPSTREAM_BODY.split("\n\n").filter(Boolean)) {
            const out = transform({ raw }) as SseFrame;
            // THE BUG, written out explicitly.
            c.enqueue(encoder.encode(`${JSON.stringify(out)}\n\n`));
          }
          c.close();
        },
      })
    );

    expect(findLeakedAttribution(brokenBytes)).toBe(SENTINEL);
    expect(brokenBytes).not.toBe(UPSTREAM_BODY);
  });
});
