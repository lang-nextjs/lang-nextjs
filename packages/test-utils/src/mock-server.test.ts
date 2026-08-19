import { describe, it, expect } from "vitest";
import { createMockDeepAgentsServer } from "./mock-server";

/** Read the full body of a Response as a string */
async function readBodyAsText(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  return result;
}

describe("createMockDeepAgentsServer", () => {
  it("returns a Response object", async () => {
    const response = await createMockDeepAgentsServer();
    expect(response).toBeInstanceOf(Response);
  });

  it("returns status 200", async () => {
    const response = await createMockDeepAgentsServer();
    expect(response.status).toBe(200);
  });

  it("response body is a ReadableStream", async () => {
    const response = await createMockDeepAgentsServer();
    expect(response.body).not.toBeNull();
    expect(typeof response.body!.getReader).toBe("function");
  });

  it("response includes x-vercel-ai-ui-message-stream: v1 header", async () => {
    const response = await createMockDeepAgentsServer();
    expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
  });

  it("stream body contains at least one text-delta frame", async () => {
    const response = await createMockDeepAgentsServer({ chunkDelayMs: 0 });
    const body = await readBodyAsText(response);
    expect(body).toContain("text-delta");
  });

  it("stream body ends with a finish frame", async () => {
    const response = await createMockDeepAgentsServer({ chunkDelayMs: 0 });
    const body = await readBodyAsText(response);
    // AI SDK v6 toUIMessageStreamResponse() emits {"type":"finish"} as the envelope
    // finish frame (finishReason is internal to the model stream layer)
    expect(body).toContain('"type":"finish"');
  });

  it("returns a readable stream when chunks: [] is passed (empty custom chunk list)", async () => {
    // Multi-frame streaming edge case: an empty chunks array means the mock model
    // emits nothing before finish. The stream must still be readable (not throw /
    // not hang), and the response headers must still be well-formed.
    // If the implementation iterates chunks unsafely this will throw or stall.
    const response = await createMockDeepAgentsServer({
      chunkDelayMs: 0,
      chunks: [],
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
    // Body must be consumable without error
    const body = await readBodyAsText(response);
    // Even with no content chunks the AI SDK should close the stream cleanly;
    // at minimum the body should be a string (possibly empty, possibly finish-only)
    expect(typeof body).toBe("string");
  });

  it("two sequential calls return independent Response objects", async () => {
    const r1 = await createMockDeepAgentsServer({ chunkDelayMs: 0 });
    const r2 = await createMockDeepAgentsServer({ chunkDelayMs: 0 });
    expect(r1).not.toBe(r2);
    // Both should be readable
    const body1 = await readBodyAsText(r1);
    const body2 = await readBodyAsText(r2);
    expect(body1).toContain("text-delta");
    expect(body2).toContain("text-delta");
  });

  // ---------------------------------------------------------------------------
  // Adversarial edge-case tests (iteration 6)
  // ---------------------------------------------------------------------------

  it("defaults chunkDelayMs to 50 when no opts supplied — finite readable body", async () => {
    // The default chunkDelayMs is 50ms. With 4 chunks × 50ms = ~200ms total.
    // Use a generous ceiling to avoid flakiness — but assert the body is finite.
    const start = Date.now();
    const response = await createMockDeepAgentsServer();
    const body = await readBodyAsText(response);
    const elapsed = Date.now() - start;
    // Must not hang or throw. Body length must be a finite string.
    expect(typeof body).toBe("string");
    expect(elapsed).toBeLessThan(5000); // generous ceiling
    expect(response.status).toBe(200);
  });

  it("chunkDelayMs: -1 (negative value) is treated as 'fast' — does not stall", async () => {
    // DESIGNED TO FAIL if the implementation passes -1 to setTimeout/setInterval
    // (which would behave as 0 in some envs but throw in others). A negative
    // delay must not stall the stream or throw a RangeError.
    const response = await createMockDeepAgentsServer({ chunkDelayMs: -1 });
    const body = await readBodyAsText(response);
    expect(typeof body).toBe("string");
    expect(body).toContain("text-delta");
    expect(response.status).toBe(200);
  });

  // ---------------------------------------------------------------------------
  // Adversarial edge-case tests (iteration 7)
  // ---------------------------------------------------------------------------

  it("100 concurrent createMockDeepAgentsServer() calls return independent, fully-readable responses", async () => {
    // Adversarial: any shared mutable state across invocations (e.g. a
    // module-level stream / generator / singleton) will cause at least one
    // of 100 parallel calls to either hang, throw, return the wrong body, or
    // share a body with a sibling. Asserts independence + readability + parity.
    const N = 100;
    const responses = await Promise.all(
      Array.from({ length: N }, () =>
        createMockDeepAgentsServer({ chunkDelayMs: 0 })
      )
    );
    // All distinct Response objects (no shared identity)
    const distinct = new Set(responses);
    expect(distinct.size).toBe(N);
    // All readable in full, all 200, all carry the right header, all contain text-delta
    const bodies = await Promise.all(responses.map((r) => readBodyAsText(r)));
    for (let i = 0; i < N; i++) {
      expect(responses[i].status).toBe(200);
      expect(responses[i].headers.get("x-vercel-ai-ui-message-stream")).toBe(
        "v1"
      );
      expect(bodies[i]).toContain("text-delta");
      expect(bodies[i]).toContain('"type":"finish"');
    }
  });

  it("oversized frame (delta > 1MB) streams to completion without hanging or OOM-throwing", async () => {
    // Adversarial: pass a single text-delta whose `delta` payload is >1MB.
    // Some stream implementations cap chunk size, buffer indefinitely, or
    // throw a RangeError on huge frames. The mock must let it pass through
    // and the body must contain every byte of the payload.
    const bigPayload = "X".repeat(1024 * 1024 + 7); // 1MB + 7 bytes
    const response = await createMockDeepAgentsServer({
      chunkDelayMs: 0,
      chunks: [
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", delta: bigPayload },
        { type: "text-end", id: "text-1" },
        {
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 5 },
        },
      ],
    });
    const body = await readBodyAsText(response);
    expect(response.status).toBe(200);
    // Body must contain every byte of the oversized payload (not truncated,
    // not buffered away, not lost to a partial read).
    expect(body.length).toBeGreaterThanOrEqual(bigPayload.length);
    expect(body).toContain(bigPayload);
  });

  it("chunk object with a circular self-reference does not corrupt the stream or throw", async () => {
    // Adversarial: JSON.stringify normally throws on circular refs. If the
    // mock accidentally JSON-stringifies chunks synchronously (e.g. via a
    // naive string-coercion path), this will throw a TypeError. We use a
    // well-known chunk type (text-delta) so the AI SDK doesn't reject it for
    // unrelated reasons — we're testing the mock-server's own resilience to
    // weird chunk shapes, not the SDK's chunk-type whitelist.
    type CircularChunk = Record<string, unknown> & { self?: CircularChunk };
    const circular: CircularChunk = {
      type: "text-delta",
      id: "circ",
      delta: "hello",
    };
    circular.self = circular;
    let response: Response;
    try {
      response = await createMockDeepAgentsServer({
        chunkDelayMs: 0,
        chunks: [circular as unknown as Record<string, unknown>],
      });
    } catch (err) {
      // Acceptable ONLY if the implementation rejects circular refs up front
      // with a clear, non-corrupting error (TypeError "Converting circular
      // structure to JSON"). A hang, a swallowed error, or a corrupted stream
      // is NOT acceptable.
      expect((err as Error).message).toMatch(/circular/i);
      return; // rejection up front is fine — the implementation defended itself
    }
    // If we got here, the stream must close cleanly without hanging.
    expect(response.status).toBe(200);
    const body = await readBodyAsText(response);
    expect(typeof body).toBe("string");
  });

  it("many small chunks produce many small reader reads (chunked stream behavior, not one giant blob)", async () => {
    // Adversarial: interpret 'chunked transfer-encoding' as 'the body must
    // arrive in many discrete reads, not collapsed into one ReadableStream
    // pull'. We force 50 small chunks and assert the reader yields >= 10
    // separate `value` events. If the implementation batches / coalesces,
    // this will catch it.
    const chunkCount = 50;
    const chunks = [
      { type: "text-start", id: "text-1" },
      ...Array.from({ length: chunkCount }, (_, i) => ({
        type: "text-delta",
        id: "text-1",
        delta: String(i % 10),
      })),
      { type: "text-end", id: "text-1" },
      {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 5 },
      },
    ];
    const response = await createMockDeepAgentsServer({
      chunkDelayMs: 0,
      chunks,
    });
    const reader = response.body!.getReader();
    let reads = 0;
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      reads++;
      totalBytes += value.byteLength;
    }
    expect(reads).toBeGreaterThanOrEqual(10);
    expect(totalBytes).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // Adversarial edge-case tests (iteration 8 — "likely OK" invariants)
  // ---------------------------------------------------------------------------

  it("createMockDeepAgentsServer({}) — empty opts object applies all defaults without throwing", async () => {
    // Adversarial: an empty opts object is distinct from `undefined`. The
    // implementation reads `opts?.chunkDelayMs ?? 50`, which works for both,
    // but if anyone refactors to `Object.keys(opts).forEach(...)` or
    // destructures `{ chunkDelayMs, chunks } = opts` and forgets to guard
    // against undefined fields, an empty object would either throw or
    // silently drop to a partial-config path. Must produce a valid 200
    // Response with the default greeting body.
    const response = await createMockDeepAgentsServer({});
    expect(response.status).toBe(200);
    expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
    const body = await readBodyAsText(response);
    expect(body).toContain("text-delta");
    expect(body).toContain("I am the mock DeepAgents assistant.");
    expect(body).toContain('"type":"finish"');
  });

  it("chunkDelayMs: 0 emits all chunks back-to-back with no perceptible delay", async () => {
    // Adversarial: chunkDelayMs: 0 is the documented fast-test mode. We
    // assert the wall-clock end-to-end is well under the default-50ms path's
    // latency (which would be >=200ms for 4 chunks). If the implementation
    // accidentally floors to 1 or coerces 0 to the default 50, the 200ms
    // budget will be exceeded and this will catch it.
    const start = Date.now();
    const response = await createMockDeepAgentsServer({ chunkDelayMs: 0 });
    const body = await readBodyAsText(response);
    const elapsed = Date.now() - start;
    expect(response.status).toBe(200);
    expect(typeof body).toBe("string");
    expect(body).toContain("text-delta");
    expect(body).toContain('"type":"finish"');
    // With 5 chunks at 0ms each, total should be far below 200ms even on
    // a slow CI box. Use 500ms as a generous ceiling to avoid flake.
    expect(elapsed).toBeLessThan(500);
  });

  it("chunkDelayMs: NaN does not stall, throw a RangeError, or hang the stream", async () => {
    // Adversarial: NaN is a valid `number` per TS but invalid for setTimeout.
    // If the implementation passes chunkDelayMs through to setTimeout/setInterval
    // without a Number.isFinite guard, the stream may stall forever, throw a
    // "Invalid delay" RangeError, or emit only the first chunk. The contract
    // is: a finite body must arrive, containing the default greeting.
    let response: Response;
    try {
      response = await createMockDeepAgentsServer({ chunkDelayMs: NaN });
    } catch (err) {
      // Acceptable ONLY if the rejection is a clear, explicit "invalid delay"
      // TypeError/RangeError — not a cryptic internal failure. A hang, a
      // swallowed promise, or an opaque rejection is NOT acceptable.
      expect((err as Error).message).toMatch(/delay|invalid|finite/i);
      return;
    }
    // If it didn't throw, it must still produce a fully-readable stream.
    expect(response.status).toBe(200);
    const body = await readBodyAsText(response);
    expect(typeof body).toBe("string");
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain("text-delta");
  });

  it("extra chunks beyond the typical 4-frame payload — arbitrarily large chunk array streams to completion with every frame present", async () => {
    // Adversarial: a real backend can emit arbitrarily many events (think:
    // tool calls, reasoning deltas, multi-message turns). We pass a 200-chunk
    // payload (well beyond the default 4 frames) and verify the stream does
    // NOT truncate, cap at some N, or OOM. Every delta payload must appear
    // in the body, in order. If the implementation silently caps chunks or
    // drops frames after a threshold, this will catch it.
    const N = 200;
    const expectedDeltas = Array.from(
      { length: N },
      (_, i) => `FRAME_${i.toString().padStart(4, "0")}`
    );
    const chunks = [
      { type: "text-start", id: "text-1" },
      ...expectedDeltas.map((d) => ({
        type: "text-delta",
        id: "text-1",
        delta: d,
      })),
      { type: "text-end", id: "text-1" },
      {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 5 },
      },
    ];
    const response = await createMockDeepAgentsServer({
      chunkDelayMs: 0,
      chunks,
    });
    expect(response.status).toBe(200);
    const body = await readBodyAsText(response);
    // Every expected delta payload must appear in the body, in order.
    let cursor = 0;
    for (const d of expectedDeltas) {
      const idx = body.indexOf(d, cursor);
      expect(
        idx,
        `expected delta ${d} after position ${cursor}`
      ).toBeGreaterThanOrEqual(cursor);
      cursor = idx + d.length;
    }
    // And the finish frame must still close the stream.
    expect(body).toContain('"type":"finish"');
  });
});
