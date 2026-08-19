import { describe, it, expect, beforeEach } from "vitest";
import { parseJsonBody, MAX_BODY_BYTES } from "./body-parser";

describe("parseJsonBody", () => {
  it("returns parsed JSON for valid small body", async () => {
    const request = new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "test task" }),
    });

    const result = await parseJsonBody(request);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ task: "test task" });
    }
  });

  it("returns 415 when Content-Type is missing", async () => {
    const request = new Request("http://localhost/test", {
      method: "POST",
      body: JSON.stringify({ task: "test task" }),
    });

    const result = await parseJsonBody(request);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(415);
      const data = await result.response.json();
      expect(data.error).toBe("Content-Type must be application/json");
    }
  });

  it("returns 415 when Content-Type is text/plain", async () => {
    const request = new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ task: "test task" }),
    });

    const result = await parseJsonBody(request);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(415);
      const data = await result.response.json();
      expect(data.error).toBe("Content-Type must be application/json");
    }
  });

  it("accepts application/json with charset", async () => {
    const request = new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ task: "test task" }),
    });

    const result = await parseJsonBody(request);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ task: "test task" });
    }
  });

  it("returns 413 for oversized body", async () => {
    const largeBody = JSON.stringify({ data: "a".repeat(MAX_BODY_BYTES + 1) });
    const request = new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: largeBody,
    });

    const result = await parseJsonBody(request);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(413);
      const data = await result.response.json();
      expect(data.error).toBe("Request body exceeds 1MB limit");
    }
  });

  it("returns 400 for malformed JSON", async () => {
    const request = new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });

    const result = await parseJsonBody(request);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      const data = await result.response.json();
      expect(data.error).toBe("Invalid JSON body");
    }
  });

  it("ADV: body that is a JSON array (not object) parses successfully — defensive contract for downstream callers", async () => {
    // JSON allows top-level arrays. The parser uses `JSON.parse` which
    // accepts them. Downstream callers (e.g. POST /api/open-swe/runs) read
    // `result.data.task` — accessing a property on an array does NOT throw
    // (returns undefined), but the task validation then fails with 422.
    // This test pins the parser-level contract: a JSON array returns
    // ok:true with data being an actual Array (not silently coerced to an
    // object). Callers MUST guard against non-object data shapes themselves.
    const request = new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(["a", "b", "c"]),
    });

    const result = await parseJsonBody(request);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Must be an actual Array — not coerced to an object/empty record.
      expect(Array.isArray(result.data)).toBe(true);
      expect(result.data).toEqual(["a", "b", "c"]);
      // Type sanity: typeof array === 'object' in JS.
      expect(typeof result.data).toBe("object");
    }
  });

  it("returns empty object for empty body", async () => {
    // Test with actual empty body
    const request = new Request("http://localhost/test", {
      method: "POST",
      body: "",
      headers: { "Content-Type": "application/json" },
    });

    const result = await parseJsonBody(request);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({});
    }
  });

  it("rejects Content-Type 'application/json-patch+json' (startsWith collision)", async () => {
    // The current implementation uses contentType.startsWith('application/json')
    // which incorrectly accepts unrelated MIME types like application/json-patch+json,
    // application/jsonml+xml, application/json-seq, etc. These are NOT regular JSON.
    // A proper check would require either an exact match or a trailing ';' / end-of-string
    // boundary. Without that, callers can smuggle in non-JSON-shaped bodies that
    // happen to share the prefix.
    const request = new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json-patch+json" },
      body: JSON.stringify([{ op: "replace", path: "/a", value: 1 }]),
    });

    const result = await parseJsonBody(request);
    // Adversarial expectation: should reject — but current impl will accept.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(415);
    }
  });

  it("returns data as null when body is the literal JSON 'null' (type guarantee gap)", async () => {
    // The function's return type is `{ ok: true; data: unknown }` so technically
    // `null` is permitted. But downstream callers commonly destructure `data` as
    // a record (e.g. `const { task } = result.data as { task?: string }`) which
    // throws TypeError when data is null. Document the current behaviour so the
    // gap is at least explicit and a callers can guard for it.
    const request = new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "null",
    });

    const result = await parseJsonBody(request);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Current behaviour: returns null (not {} — silent type surprise for callers).
      expect(result.data).toBeNull();
    }
  });

  it("returns {} for whitespace-only body (silent vs. 400 ambiguity)", async () => {
    // The implementation calls text.trim() === '' and returns {} on match.
    // A caller that POSTs '   \n\t  ' instead of a real JSON value (a likely bug
    // on the client side) gets a silent success with empty data — same outcome
    // as the legitimate "no body" path. This masks client bugs; arguably this
    // should be a 400 since the request DID carry bytes that are not valid JSON.
    const request = new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "   \n\t  ",
    });

    const result = await parseJsonBody(request);
    // Adversarial expectation: a non-empty payload of pure whitespace should 400,
    // not be silently coerced to {}. Current impl returns ok with {}.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
    }
  });

  it("handles body with multi-byte UTF-8 split across chunk boundary", async () => {
    // A multi-byte UTF-8 codepoint (e.g. emoji = 4 bytes) can be split across
    // Uint8Array chunks at the reader. The accumulator builds one TextDecoder
    // and only calls decode() ONCE on the joined buffer — so the joined-buffer
    // path should work. BUT if the implementation ever decoded chunks
    // individually (a likely-future "stream-decode" refactor) this would corrupt
    // the codepoint. Pin the current correct behaviour with an emoji whose
    // bytes straddle a chunk boundary.
    const emoji = "\u{1F525}"; // 🔥 — 4 UTF-8 bytes: F0 9F 94 A5
    const json = JSON.stringify({ flame: emoji });
    const utf8 = new TextEncoder().encode(json);
    // Split mid-codepoint of the emoji. Find the byte index of the first emoji byte.
    const flameByteStart = utf8.indexOf(0xf0);
    expect(flameByteStart).toBeGreaterThan(-1);
    // Slice so the first chunk ends in the middle of the emoji's 4 bytes
    const firstChunk = utf8.slice(0, flameByteStart + 2);
    const secondChunk = utf8.slice(flameByteStart + 2);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(firstChunk);
        controller.enqueue(secondChunk);
        controller.close();
      },
    });

    const request = new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: stream,
      // @ts-expect-error - duplex required for streaming bodies in Node
      duplex: "half",
    });

    const result = await parseJsonBody(request);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ flame: emoji });
    }
  });

  it("returns 413 when body exceeds MAX_BODY_BYTES via multi-chunk streaming (boundary check is per-chunk)", async () => {
    // The implementation checks totalBytes > MAX_BODY_BYTES inside the reader
    // loop — so a streamed body that incrementally exceeds the limit must be
    // rejected even if no single chunk is oversized. Adversarial: send many
    // small chunks where the OVERFLOW happens at the very last byte.
    const chunkSize = 64 * 1024; // 64 KB
    const numChunks = Math.ceil((MAX_BODY_BYTES + 1) / chunkSize);
    const chunks: Uint8Array[] = [];
    let totalSent = 0;
    for (let i = 0; i < numChunks; i++) {
      const remaining = MAX_BODY_BYTES + 1 - totalSent;
      const size = Math.min(chunkSize, remaining);
      if (size <= 0) break;
      chunks.push(new Uint8Array(size).fill(0x61)); // 'a' bytes
      totalSent += size;
    }

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    });

    const request = new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: stream,
      // @ts-expect-error - duplex required for streaming bodies in Node
      duplex: "half",
    });

    const result = await parseJsonBody(request);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(413);
    }
  });
});

describe("ADVERSARIAL — circular reference input", () => {
  it("body containing a JSON-stringified circular structure is rejected with 400 (not 500)", async () => {
    // JavaScript objects with circular refs cannot be stringified by
    // JSON.stringify (it throws TypeError). A naive impl that calls
    // JSON.parse on already-text input is safe — but the byte pipeline must
    // not crash on `null` characters, partial UTF-16 surrogates, or empty
    // object literals. The REAL adversarial case here: the body is a
    // syntactically-valid JSON object whose STRINGIFIED form is enormous
    // due to deep self-reference encoded as a string. We assert the parser
    // either returns the object OR rejects with 400 — never 500.
    //
    // We can't actually JSON.stringify a real circular ref, so instead feed
    // a payload that LOOKS like one: nested object with a property whose
    // value is the parent's `__proto__` (a constructor reference). The
    // parser must not throw, must not return something with prototype
    // poisoning, and must not 500.
    type Rec = { name: string; child?: Rec; evil?: unknown };
    const malicious = {
      name: "root",
      child: { name: "child", evil: { name: "grandchild" } } as Rec,
    } as Rec & { __proto__: unknown };
    // Force a __proto__ key (object literal __proto__ is a setter).
    Object.defineProperty(malicious, "__proto__", {
      value: { polluted: true },
      enumerable: true,
      writable: true,
      configurable: true,
    });

    const request = new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(malicious),
    });

    const result = await parseJsonBody(request);
    // Must not 500: either parse succeeded (ok:true) and returned a plain
    // object, OR it failed cleanly with 400. Both are acceptable; an
    // unhandled throw is NOT.
    if (result.ok) {
      expect(typeof result.data).toBe("object");
      expect(result.data).not.toBeNull();
    } else {
      expect(result.response.status).toBe(400);
    }
  });

  it("body containing the literal text 'undefined' is rejected with 400 (not silently nulled)", async () => {
    // JSON.parse('undefined') throws SyntaxError. A naive impl that
    // replaces 'undefined' tokens (like JSON5 shims do) would silently
    // coerce the body to JS undefined, which is the source of the
    // `data === undefined` surprise downstream. Pin the strict behaviour:
    // must 400 with the standard 'Invalid JSON body' message.
    const request = new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "undefined",
    });

    const result = await parseJsonBody(request);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      const data = await result.response.json();
      expect(data.error).toBe("Invalid JSON body");
    }
  });
});

describe("ADVERSARIAL — body is the literal JSON 'null'", () => {
  it("treats body 'null' (4 bytes) as JSON null, NOT as an empty body to coerce to {}", async () => {
    // Body literal "null" has 4 bytes (n,u,l,l) — so it is NOT the empty-body
    // path (body === null), and it IS valid JSON. The current implementation
    // passes it through JSON.parse which returns null. Callers that destructure
    // `result.data` as a record would crash on `null.foo`. This test pins the
    // exact behaviour so the gap is explicit: 4-byte null JSON parses to JS null.
    const request = new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "null",
    });

    const result = await parseJsonBody(request);
    // JSON.parse("null") succeeds — must NOT return 400 (which would mean the
    // implementation confused it for malformed JSON).
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The result must be the JS value null (NOT {} which would indicate the
      // empty-body coercion leaked into the JSON-parsed path).
      expect(result.data).toBeNull();
      // Sanity: null is not an object — distinguishes from {} which is.
      expect(typeof result.data).toBe("object"); // typeof null === "object" in JS
      expect(result.data === null).toBe(true);
    }
  });
});

describe("ADVERSARIAL — 1000-level deeply nested JSON", () => {
  it("parses a 1000-level nested JSON object without RangeError/RangeError-from-TextDecoder", async () => {
    // Adversarial: a malicious or buggy client could send arbitrarily deep
    // JSON (e.g. `{"a":{"a":{"a":...}}}`). Node's JSON.parse throws
    // "Maximum call stack size exceeded" / "stack overflow" on very deep input
    // (engine-dependent, but ~1000+ levels is commonly past the limit).
    //
    // Required contract for parseJsonBody:
    //   - the function MUST NOT hang or 500
    //   - it MUST return either ok:true with parsed data, OR ok:false with a
    //     proper HTTP status (400 / 413). A thrown RangeError or unhandled
    //     rejection is NOT acceptable — it would crash the route handler.
    //
    // We deliberately go DEEPER than V8's default ~1000-depth limit. The
    // exact outcome depends on the Node version, but the parser must surface
    // a clean 4xx instead of an uncaught throw.
    const DEPTH = 1000;
    let body = "null";
    for (let i = 0; i < DEPTH; i++) {
      body = `{"a":${body}}`;
    }
    // Sanity: it's a sizable but not gigantic string.
    expect(body.length).toBeLessThan(20_000);

    const request = new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    const start = Date.now();
    let result: Awaited<ReturnType<typeof parseJsonBody>>;
    let threw = false;
    try {
      result = await parseJsonBody(request);
    } catch {
      threw = true;
      result = undefined as unknown as Awaited<
        ReturnType<typeof parseJsonBody>
      >;
    }
    const elapsed = Date.now() - start;

    // Must finish in bounded time — no infinite recursion or stack overflow hang.
    expect(elapsed).toBeLessThan(5_000);
    // Must NOT throw unhandled — either ok:true or ok:false.
    expect(threw).toBe(false);
    expect(result).toBeDefined();

    if (result.ok) {
      // If parse succeeded, the parsed data must be a deeply-nested object.
      expect(typeof result.data).toBe("object");
      expect(result.data).not.toBeNull();
      // Walk the chain to confirm depth survived — start from data.a and
      // descend DEPTH-1 times. We don't pin exact equality of the leaf
      // because some engines may use plain JSON.parse and accept it; others
      // may use a streaming parser. Either way, the structure is preserved.
      let node: unknown = result.data;
      let depthReached = 0;
      for (let i = 0; i < DEPTH; i++) {
        if (
          node &&
          typeof node === "object" &&
          "a" in (node as Record<string, unknown>)
        ) {
          node = (node as Record<string, unknown>).a;
          depthReached++;
        } else {
          break;
        }
      }
      // Should reach at least depth-1 since the leaf is null.
      expect(depthReached).toBeGreaterThanOrEqual(DEPTH - 1);
    } else {
      // If parse was rejected (e.g. depth-exceeded), it must be a clean 4xx,
      // never a 5xx. The body-parser currently maps JSON.parse errors to 400.
      expect(result.response.status).toBeGreaterThanOrEqual(400);
      expect(result.response.status).toBeLessThan(500);
    }
  });
});
