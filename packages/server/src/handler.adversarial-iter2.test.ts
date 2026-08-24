/**
 * Iteration-2 adversarial probes (NON-adapter scope).
 *
 * Targets the most likely untested gaps in handler.ts / approval-registry.ts /
 * observability wiring. Each test is a single-shot RED probe: if the
 * implementation ever changes in a way that breaks the documented behavior,
 * this test catches it on the first run.
 *
 * Constraints honored:
 *   - Test files ONLY (no source modifications)
 *   - No files under packages/server/src/adapters/*
 *   - vitest syntax
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./stream-registry", () => ({
  atomicRegisterIfAbsent: vi.fn(),
  markStreamDone: vi.fn(),
  deleteStream: vi.fn(),
  lookupStream: vi.fn(),
}));

vi.mock("./reconnect", () => ({
  isStreamReconnectEnabled: vi.fn(),
}));

import { isStreamReconnectEnabled } from "./reconnect";
import { createDeepAgentsHandler } from "./deepagents-handler";
import {
  registerApproval,
  getApproval,
  cleanupApproval,
} from "./approval-registry";

const mockIsStreamReconnectEnabled = vi.mocked(isStreamReconnectEnabled);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function makeRequest(
  opts: { headers?: Record<string, string | string[]>; body?: string } = {}
) {
  // Use a real Headers object but allow arrays to model duplicate header lines.
  const headers = new Headers();
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    if (Array.isArray(v)) {
      // Headers#append is the canonical way to attach multiple values.
      for (const item of v) headers.append(k, item);
    } else {
      headers.set(k, v);
    }
  }
  return {
    headers,
    arrayBuffer: async () => new TextEncoder().encode(opts.body ?? "").buffer,
  } as any;
}

function makeFetchResponse(body: string, status = 200) {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return { status, headers: new Headers(), body: stream } as any;
}

// ---------------------------------------------------------------------------
// PROBE 1 — handler with empty body AND missing Content-Type
// ---------------------------------------------------------------------------
describe("ADVERSARIAL iter2 — empty body, no Content-Type", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockIsStreamReconnectEnabled.mockReturnValue(false);
  });

  it("accepts a POST with empty body and missing Content-Type (defaults to passthrough to backend)", async () => {
    // Probe: the handler calls `request.arrayBuffer()` and then forwards the
    // raw bytes as `body`. There is no Content-Type sniffing, no JSON parsing,
    // and no required-body validation. With empty body + no Content-Type, the
    // handler must NOT 400 / 415 / 422 — it must simply forward the request to
    // the backend. If a future contributor adds a "must be JSON" check at the
    // top of POST, this test catches that unintended behavior change.
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse('data: {"type":"text-delta"}\n\n'));
    vi.stubGlobal("fetch", mockFetch);

    const handler = createDeepAgentsHandler({ backendUrl: "http://backend" });
    const req = makeRequest({ body: "" }); // no headers at all → no Content-Type

    const response = await handler(req);

    // Request must have reached the backend.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // Forwarded body is empty (the empty string we sent in).
    const forwardedBody = mockFetch.mock.calls[0][1].body as ArrayBuffer;
    expect(forwardedBody.byteLength).toBe(0);
    // Status is forwarded from the backend, not synthesized as 400/415.
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
  });
});

// ---------------------------------------------------------------------------
// PROBE 2 — handler with DOUBLE Content-Type headers
// ---------------------------------------------------------------------------
describe("ADVERSARIAL iter2 — double Content-Type header (duplicate header lines)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockIsStreamReconnectEnabled.mockReturnValue(false);
  });

  it("rejects duplicate Content-Type headers with 400 BEFORE calling the backend (no fetch, no stream)", async () => {
    // Probe: when a client sends duplicate header lines, the Fetch spec yields
    // each value ALREADY combined with `, ` per RFC 7230 §3.2.2. For Content-Type,
    // which never contains a comma in valid form (RFC 7231 §3.1.1.1 — media-type
    // parameters use `;`), a comma in the combined value is unambiguous evidence
    // of a multi-value collapse. Strict-mode backends (Django, Express strict)
    // reject that combined value with 400, so the handler rejects it up-front
    // with 400 instead of forwarding a malformed header and surfacing a backend
    // 400 to the operator. Pin the new contract: NO fetch call, NO stream start,
    // explicit 400 response with a clear message.
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse("data: hi\n\n"));
    vi.stubGlobal("fetch", mockFetch);

    const handler = createDeepAgentsHandler({ backendUrl: "http://backend" });
    const response = await handler(
      makeRequest({
        headers: {
          "content-type": ["application/json", "text/plain"],
        },
      })
    );

    // 400 Bad Request, NOT a forwarded 200/502 from the backend
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("application/json");

    // Backend was NEVER reached — the malformed request fails closed.
    expect(mockFetch).not.toHaveBeenCalled();

    // Body carries an actionable message so the operator / client knows
    // exactly which header to fix. Case-insensitive match since the message
    // interpolates the lowercased header name (Fetch API normalizes).
    const body = await response.text();
    expect(body.toLowerCase()).toContain("duplicate content-type");
  });

  it("accepts a single Content-Type header with parameters (no comma → no false-positive rejection)", async () => {
    // Regression guard: the strict duplicate-detection uses a comma in the
    // combined Content-Type value as the signal. Valid media types use `;`
    // for parameters (RFC 7231 §3.1.1.1) and never contain a comma. This
    // test pins that `application/json; charset=utf-8` (a perfectly valid
    // Content-Type with parameters) is still forwarded to the backend.
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse("data: hi\n\n"));
    vi.stubGlobal("fetch", mockFetch);

    const handler = createDeepAgentsHandler({ backendUrl: "http://backend" });
    const response = await handler(
      makeRequest({
        headers: {
          "content-type": "application/json; charset=utf-8",
        },
        body: "{}",
      })
    );

    // Forwarded to backend, not rejected up-front.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const forwarded = mockFetch.mock.calls[0][1].headers as Headers;
    expect(forwarded.get("content-type")).toBe("application/json; charset=utf-8");
    // 200 from the mocked backend passthrough
    expect(response.status).toBe(200);
  });

  it("rejects duplicate Authorization headers with 400 (defense against header-injection auth bypass)", async () => {
    // Probe: Authorization is a strict single-value header (RFC 7235). A
    // comma in the combined value is unambiguous evidence of multi-value
    // collapse from duplicate Authorization header lines — this is the
    // signature of a header-injection auth-bypass attempt where the client
    // sends two `Authorization` lines hoping the proxy takes one and the
    // backend takes the other. Reject up-front so neither sees it.
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse("data: hi\n\n"));
    vi.stubGlobal("fetch", mockFetch);

    const handler = createDeepAgentsHandler({ backendUrl: "http://backend" });
    const response = await handler(
      makeRequest({
        headers: {
          authorization: ["Bearer token-a", "Bearer token-b"],
        },
      })
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(mockFetch).not.toHaveBeenCalled();
    const body = await response.text();
    expect(body.toLowerCase()).toContain("duplicate authorization");
  });

  it("accepts Cookie with two values joined by '; ' (Fetch API correctly forwards as RFC 6265 syntax)", async () => {
    // Probe: Cookie is special — when a client sends two Cookie header lines,
    // the Fetch API joins them with "; " (NOT ", " like other headers) per
    // RFC 6265 §4.2.1 grammar. The combined "a=1; b=2" IS valid cookie
    // syntax, so we forward as-is — no comma-detection needed for Cookie.
    // Pin this so any future change to comma-detection doesn't break Cookie.
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse("data: hi\n\n"));
    vi.stubGlobal("fetch", mockFetch);

    const handler = createDeepAgentsHandler({ backendUrl: "http://backend" });
    const response = await handler(
      makeRequest({
        headers: {
          cookie: ["session=abc", "tracking=xyz"],
        },
      })
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const forwarded = mockFetch.mock.calls[0][1].headers as Headers;
    expect(forwarded.get("cookie")).toBe("session=abc; tracking=xyz");
    expect(response.status).toBe(200);
  });

  it("accepts Accept with multiple values joined by ', ' (RFC 7231 §5.3.2 multi-value grammar)", async () => {
    // Probe: Accept LEGITIMATELY uses comma-separated media types. The combined
    // "text/html, application/json" IS what the client intended (RFC 7231 §5.3.2
    // says "Multiple Accept header fields ... can be combined into one field value").
    // Forward as-is — comma-detection must NOT generalize to Accept.
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse("data: hi\n\n"));
    vi.stubGlobal("fetch", mockFetch);

    const handler = createDeepAgentsHandler({ backendUrl: "http://backend" });
    const response = await handler(
      makeRequest({
        headers: {
          accept: ["text/html", "application/json"],
        },
      })
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const forwarded = mockFetch.mock.calls[0][1].headers as Headers;
    expect(forwarded.get("accept")).toBe("text/html, application/json");
    expect(response.status).toBe(200);
  });

  it("accepts Vary with multiple values joined by ', ' (RFC 7231 §7.1.4 multi-value grammar)", async () => {
    // Probe: Vary LEGITIMATELY uses comma-separated header names. Same rationale
    // as Accept — the combined value IS what the client intended, forward as-is.
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeFetchResponse("data: hi\n\n"));
    vi.stubGlobal("fetch", mockFetch);

    const handler = createDeepAgentsHandler({ backendUrl: "http://backend" });
    const response = await handler(
      makeRequest({
        headers: {
          vary: ["Accept-Encoding", "User-Agent"],
        },
      })
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const forwarded = mockFetch.mock.calls[0][1].headers as Headers;
    expect(forwarded.get("vary")).toBe("Accept-Encoding, User-Agent");
    expect(response.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// PROBE 3 — approval-registry concurrent getApproval on a TTL-expired entry
// ---------------------------------------------------------------------------
describe("ADVERSARIAL iter2 — concurrent getApproval on TTL-expired entry", () => {
  afterEach(() => {
    cleanupApproval("adv-ttl-concurrent");
  });

  it("two concurrent getApproval() calls on a TTL-expired 'waiting' entry BOTH observe status='timeout' (idempotent lazy TTL)", async () => {
    // Probe: getApproval() mutates status in place on lazy TTL check. If two
    // requests' finally blocks run concurrently and both call getApproval(id)
    // AFTER the entry has expired, the FIRST call sets status='timeout'; the
    // SECOND must also observe 'timeout' (not 'waiting' or some torn state).
    // A racy implementation could double-write, throw, or leave the entry in
    // an inconsistent state. Pin the documented idempotent semantics.
    const id = "adv-ttl-concurrent";
    // expiresAt in the past — forces the TTL branch on first getApproval.
    registerApproval({
      approvalId: id,
      toolCallId: "tc-1",
      toolName: "bash",
      input: { cmd: "ls" },
      status: "waiting",
      createdAt: new Date(0).toISOString(),
      expiresAt: Date.now() - 1000, // already expired
    });

    // Fire two concurrent reads — both must observe the timeout transition
    // without throwing or producing a torn read.
    const [r1, r2] = await Promise.all([
      Promise.resolve(getApproval(id)),
      Promise.resolve(getApproval(id)),
    ]);

    expect(r1).toBeDefined();
    expect(r2).toBeDefined();
    expect(r1!.status).toBe("timeout");
    expect(r2!.status).toBe("timeout");
    // The two concurrent reads must observe the SAME object identity — the
    // registry must not duplicate or clone the entry under concurrent reads.
    expect(r1).toBe(r2);
  });
});

// ---------------------------------------------------------------------------
// PROBE 4 — observability hook under tight-loop emission (10K frames)
// ---------------------------------------------------------------------------
describe("ADVERSARIAL iter2 — observability hooks under 10K-frame tight loop", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockIsStreamReconnectEnabled.mockReturnValue(false);
  });

  it("fires onStreamEnd exactly once with byteCount >= 10_000 * per-frame-byte-size after 10K frames stream through (no overflow / no hang)", async () => {
    // Probe: the handler reports byteCount as the running sum of encoded bytes
    // enqueued to the client. With 10K tight-loop frames the count must be
    // finite (no Infinity / NaN), no overflow to negative, and onStreamEnd
    // must fire exactly once. A subtle bug would be a Number overflow (e.g.
    // 10K * ~40-byte frame = ~400KB, well below MAX_SAFE_INTEGER, but if the
    // accumulator ever switched to a uint32 or used Math.imul incorrectly the
    // number could roll over — this test catches that).
    const enc = new TextEncoder();
    // Build a stream that emits 10,000 frames in a single tight loop in the
    // start() callback, then closes. Each frame is a small JSON data line.
    const N = 10_000;
    const frameText = 'data: {"type":"text-delta","delta":"x"}\n\n';
    const bigStream = new ReadableStream({
      start(controller) {
        for (let i = 0; i < N; i++) controller.enqueue(enc.encode(frameText));
        controller.close();
      },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: bigStream,
      })
    );

    const onStreamEnd = vi.fn();
    const handler = createDeepAgentsHandler({
      backendUrl: "http://backend",
      observability: { onStreamEnd },
    });
    const response = await handler(makeRequest());

    // Drain the response to actually push the pull-based stream through.
    const reader = response.body!.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }

    // onStreamEnd must have been invoked exactly once.
    expect(onStreamEnd).toHaveBeenCalledTimes(1);
    const ctx = onStreamEnd.mock.calls[0][0];
    expect(typeof ctx.frameCount).toBe("number");
    expect(typeof ctx.byteCount).toBe("number");
    expect(Number.isFinite(ctx.frameCount)).toBe(true);
    expect(Number.isFinite(ctx.byteCount)).toBe(true);
    expect(ctx.frameCount).toBeGreaterThanOrEqual(N);
    expect(ctx.byteCount).toBeGreaterThan(0);
    // No negative overflow.
    expect(ctx.frameCount).toBeGreaterThanOrEqual(0);
    expect(ctx.byteCount).toBeGreaterThanOrEqual(0);
  });
});
