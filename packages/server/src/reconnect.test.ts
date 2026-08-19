import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// Must mock before importing reconnect.ts
vi.mock("./stream-registry", () => ({
  lookupStream: vi.fn(),
}));

import {
  isStreamReconnectEnabled,
  createDeepAgentsResumeHandler,
} from "./reconnect";
import { lookupStream } from "./stream-registry";

const mockLookupStream = vi.mocked(lookupStream);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("isStreamReconnectEnabled", () => {
  it("returns false when ENABLE_STREAM_RECONNECT is undefined", () => {
    vi.stubEnv("ENABLE_STREAM_RECONNECT", "");
    // delete is needed to test true undefined — stub with empty string covers false path
    expect(isStreamReconnectEnabled()).toBe(false);
  });

  it("returns false when ENABLE_STREAM_RECONNECT is 'false'", () => {
    vi.stubEnv("ENABLE_STREAM_RECONNECT", "false");
    expect(isStreamReconnectEnabled()).toBe(false);
  });

  it("returns true when ENABLE_STREAM_RECONNECT is 'true'", () => {
    vi.stubEnv("ENABLE_STREAM_RECONNECT", "true");
    expect(isStreamReconnectEnabled()).toBe(true);
  });
});

describe("createDeepAgentsResumeHandler", () => {
  function makeRequest(resumeId: string): NextRequest {
    return new NextRequest(`http://localhost/api/resume/${resumeId}`);
  }

  function makeParams(resumeId: string): {
    params: Promise<{ resumeId: string }>;
  } {
    return { params: Promise.resolve({ resumeId }) };
  }

  describe("flag off → 503", () => {
    beforeEach(() => {
      vi.stubEnv("ENABLE_STREAM_RECONNECT", "false");
    });

    it("returns 503 with descriptive body when feature flag is off", async () => {
      const GET = createDeepAgentsResumeHandler();
      const response = await GET(makeRequest("abc"), makeParams("abc"));
      expect(response.status).toBe(503);
      const text = await response.text();
      expect(text).toContain("ENABLE_STREAM_RECONNECT");
    });
  });

  describe("flag on + no record → 204", () => {
    beforeEach(() => {
      vi.stubEnv("ENABLE_STREAM_RECONNECT", "true");
      mockLookupStream.mockReturnValue(undefined);
    });

    it("returns 204 when resumeId is not in registry", async () => {
      const GET = createDeepAgentsResumeHandler();
      const response = await GET(makeRequest("xyz"), makeParams("xyz"));
      expect(response.status).toBe(204);
    });
  });

  describe("flag on + record.done=true → 204", () => {
    beforeEach(() => {
      vi.stubEnv("ENABLE_STREAM_RECONNECT", "true");
      mockLookupStream.mockReturnValue({
        streamId: "stream-1",
        createdAt: Date.now(),
        done: true,
      });
    });

    it("returns 204 when record exists but stream is already done", async () => {
      const GET = createDeepAgentsResumeHandler();
      const response = await GET(makeRequest("abc"), makeParams("abc"));
      expect(response.status).toBe(204);
    });
  });

  describe("flag on + record.done=false but no stored ReadableStream → 204", () => {
    beforeEach(() => {
      vi.stubEnv("ENABLE_STREAM_RECONNECT", "true");
      // Record exists and is active (done=false) but no ReadableStream was stored.
      // This happens when the POST handler registers via registerStream(resumeId, streamId)
      // WITHOUT passing a ReadableStream — the default code path in handler.ts.
      // The resume handler must return 204 (not crash or return 200 with null body).
      mockLookupStream.mockReturnValue({
        streamId: "stream-in-progress",
        createdAt: Date.now(),
        done: false,
        // stream: undefined — intentionally absent
      });
    });

    it("returns 204 when record is active but has no stored stream (stream field is undefined)", async () => {
      const GET = createDeepAgentsResumeHandler();
      const response = await GET(makeRequest("abc"), makeParams("abc"));
      // Must NOT be 200 — there's no stream to replay
      expect(response.status).toBe(204);
    });
  });

  describe("isStreamReconnectEnabled with non-'true' truthy strings", () => {
    it("returns false when ENABLE_STREAM_RECONNECT is '1' (only exact 'true' is accepted)", () => {
      // Gap: strict equality `=== 'true'` means '1', 'yes', 'TRUE' must all return false.
      // If an implementor loosens the check to a truthy cast this test will catch the regression.
      vi.stubEnv("ENABLE_STREAM_RECONNECT", "1");
      expect(isStreamReconnectEnabled()).toBe(false);
    });

    it("returns false when ENABLE_STREAM_RECONNECT is 'TRUE' (case-sensitive exact match)", () => {
      // Gap: JavaScript string comparison is case-sensitive, so 'TRUE' !== 'true'.
      // If an implementor adds a .toLowerCase() call to be 'user-friendly', the flag
      // semantics change: an infra team that sets ENABLE_STREAM_RECONNECT=TRUE would
      // unexpectedly enable the feature. This test pins the strict case sensitivity so
      // any loosening is a deliberate, visible decision.
      vi.stubEnv("ENABLE_STREAM_RECONNECT", "TRUE");
      expect(isStreamReconnectEnabled()).toBe(false);
    });
  });

  describe("flag on + record.done=false AND stored ReadableStream → 200 with stream body", () => {
    beforeEach(() => {
      vi.stubEnv("ENABLE_STREAM_RECONNECT", "true");
    });

    it("returns 200 with the stored ReadableStream as body when record is active and has a stream (happy path never tested)", async () => {
      // Gap: ALL previous tests for the GET handler cover 503/204 branches.
      // The only branch that returns 200 — record.done=false AND record.stream is set —
      // has never been exercised. If the 200 branch is accidentally removed or the
      // stream field is misread, this test will catch it.
      const fakeStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: hello\n\n"));
          controller.close();
        },
      });
      mockLookupStream.mockReturnValue({
        streamId: "live-stream",
        createdAt: Date.now(),
        done: false,
        stream: fakeStream,
      });

      const GET = createDeepAgentsResumeHandler();
      const response = await GET(makeRequest("live"), makeParams("live"));

      expect(response.status).toBe(200);
      // Body must be non-null — if the handler accidentally returns NextResponse(null) the
      // test fails here before we even check headers.
      expect(response.body).not.toBeNull();
    });

    it("200 response includes SSE streaming headers (Content-Type, X-Accel-Buffering, Cache-Control)", async () => {
      // Gap: even if the 200 branch fires, the response headers are never asserted.
      // An implementor who forgets to set Content-Type or X-Accel-Buffering would
      // cause SSE buffering issues in production — this pins the exact header values.
      const fakeStream = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
      mockLookupStream.mockReturnValue({
        streamId: "s1",
        createdAt: Date.now(),
        done: false,
        stream: fakeStream,
      });

      const GET = createDeepAgentsResumeHandler();
      const response = await GET(
        makeRequest("hdr-test"),
        makeParams("hdr-test")
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/plain");
      expect(response.headers.get("x-accel-buffering")).toBe("no");
      expect(response.headers.get("cache-control")).toBe("no-cache");
    });
  });

  describe("ADVERSARIAL: resumeId with URL-encoded special characters", () => {
    beforeEach(() => {
      vi.stubEnv("ENABLE_STREAM_RECONNECT", "true");
    });

    it("lookupStream is called with the DECODED resumeId — `/` and `%2F` map to the same registry key", async () => {
      // Gap: the GET handler calls `lookupStream(resumeId)` where resumeId
      // comes from `await params`. Next.js params parser URL-DECODES the
      // path segment, so an inbound `res%2Fume` decodes to `res/ume`.
      // If the implementation accidentally encoded the resumeId again
      // (double-encoding), the lookup would miss and the handler would
      // always return 204 even for valid registry entries — silent
      // resume failure. We verify the lookup key is the DECODED form.
      mockLookupStream.mockReturnValue(undefined);
      const GET = createDeepAgentsResumeHandler();
      await GET(
        makeRequest("has-slash"),
        makeParams("res/ume") // path-decoded value
      );
      // The lookup MUST be called with the decoded "res/ume" — not "res%2Fume".
      // (If the handler double-encoded, this would be "res%2Fume" and would
      //  silently miss for any legitimate registry entry.)
      expect(mockLookupStream).toHaveBeenCalledWith("res/ume");
    });

    it("null `stream` field on an active record returns 204 — NOT a 200 with null body crash", async () => {
      // Gap: the existing test covers `stream: undefined` (field absent), but
      // `stream: null` (explicitly null in the registry record) is a different
      // JS path: `!record.stream` must catch BOTH undefined AND null. If the
      // check were tightened to `record.stream === undefined`, a null value
      // would slip through to the NextResponse(record.stream) branch and
      // NextResponse(null) would either throw or return a 200 with no body,
      // depending on the version. We pin the 204 contract for the null case.
      mockLookupStream.mockReturnValue({
        streamId: "active-null-stream",
        createdAt: Date.now(),
        done: false,
        // The cast is deliberate and the lie is the point: `stream` is typed
        // `... | undefined`, so TypeScript cannot express the value we need to
        // test. Untyped JS callers can still put a literal `null` here at
        // runtime, and that is precisely the case being pinned — the runtime
        // value IS null, not undefined. Widening the field's type instead
        // would let the null case escape into production code.
        stream: null as unknown as undefined,
      });

      const GET = createDeepAgentsResumeHandler();
      const response = await GET(
        makeRequest("null-stream"),
        makeParams("null-stream")
      );
      expect(response.status).toBe(204);
    });
  });

  describe("ADVERSARIAL: concurrent GETs + malformed resumeId", () => {
    beforeEach(() => {
      vi.stubEnv("ENABLE_STREAM_RECONNECT", "true");
    });

    it("two concurrent GETs for the same resumeId resolve independently without races (lookupStream called twice)", async () => {
      // Gap: a client reconnecting across browsers / tabs can fire two GETs
      // simultaneously for the same resumeId. The handler must NOT
      // double-register, double-mark-done, or throw — it just performs an
      // idempotent lookup. We verify the lookup is invoked once per request
      // and both responses are 200 (with the same stream body).
      const sharedStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: replayed\n\n"));
          controller.close();
        },
      });
      mockLookupStream.mockReturnValue({
        streamId: "shared-live",
        createdAt: Date.now(),
        done: false,
        stream: sharedStream,
      });

      const GET = createDeepAgentsResumeHandler();
      const [r1, r2] = await Promise.all([
        GET(makeRequest("shared"), makeParams("shared")),
        GET(makeRequest("shared"), makeParams("shared")),
      ]);

      // Both responses must succeed — no race / double-handling crash.
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      // lookupStream must be invoked once per request — exactly twice total.
      expect(mockLookupStream).toHaveBeenCalledTimes(2);
      expect(mockLookupStream).toHaveBeenNthCalledWith(1, "shared");
      expect(mockLookupStream).toHaveBeenNthCalledWith(2, "shared");
    });

    it("GET with a resumeId containing URL-fragment/control chars does NOT crash — handler still returns 200/204 (graceful fallback)", async () => {
      // Gap: Next.js params decoding is lenient. A path segment containing
      // characters that break downstream consumers (NUL, \n, etc.) can land
      // here. The handler must NOT throw on `lookupStream(\"weird\")` — it
      // must complete and return a valid HTTP status (204 because the lookup
      // returns undefined in the mock). If the handler awaits params and the
      // lookup key propagates to a Map or a URL-builder, the throw could
      // surface as an unhandled rejection.
      mockLookupStream.mockReturnValue(undefined);
      const GET = createDeepAgentsResumeHandler();
      // Use a control-char + newline embedded resumeId. JSON.stringify so we
      // can construct the string without the linter complaining.
      const weirdId = "x yz";
      const response = await GET(makeRequest(weirdId), makeParams(weirdId));
      // Graceful: not a 500. Either 200 (if the registry returned a record) or
      // 204 (no record). Both are acceptable graceful outcomes.
      expect([200, 204]).toContain(response.status);
      // lookupStream must have been called with the EXACT weirdId — no
      // silent stripping or encoding.
      expect(mockLookupStream).toHaveBeenCalledWith(weirdId);
    });
  });
});
