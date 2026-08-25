import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock calls must be at file scope for Vitest hoisting.
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
import { createSseProxyHandler } from "./handler";
import type { SseProxyHandlerOptions } from "./handler";
import { coreDefaultAdapter } from "./core-test-adapters";
import type { RateLimitStore, CircuitBreakerStore } from "./resilience";

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

const mockIsStreamReconnectEnabled = vi.mocked(isStreamReconnectEnabled);

function makeRequest(
  opts: { headers?: Record<string, string>; body?: string } = {}
) {
  const headers = new Headers(opts.headers ?? {});
  return {
    headers,
    arrayBuffer: async () => new TextEncoder().encode(opts.body ?? "").buffer,
  } as any;
}

function makeFetchResponse(opts: { status?: number; body?: string } = {}) {
  const encoded = opts.body ? [new TextEncoder().encode(opts.body)] : [];
  const stream = new ReadableStream({
    start(controller) {
      for (const c of encoded) controller.enqueue(c);
      controller.close();
    },
  });
  return {
    status: opts.status ?? 200,
    headers: new Headers(),
    body: stream,
  } as any;
}

/** A clean SSE stream that ends with a terminal finish frame. */
const CLEAN_STREAM = 'data: {"type":"finish"}\n\n';

// In-memory test stores (instance-scoped, never module scope).
class TestRateLimitStore implements RateLimitStore {
  private hits = new Map<string, number>();
  public recordCalls = 0;
  constructor(private max: number) {}
  async check(key: string) {
    return (this.hits.get(key) ?? 0) < this.max;
  }
  async record(key: string, _windowMs: number) {
    this.recordCalls++;
    this.hits.set(key, (this.hits.get(key) ?? 0) + 1);
  }
}

class TestBreakerStore implements CircuitBreakerStore {
  public events: Array<{ key: string; outcome: string }> = [];
  constructor(private fixedState: "closed" | "open" | "half-open") {}
  async getState() {
    return this.fixedState;
  }
  async recordEvent(key: string, outcome: "success" | "failure") {
    this.events.push({ key, outcome });
  }
}

async function drain(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

describe("handler resilience integration", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockIsStreamReconnectEnabled.mockReturnValue(false);
  });

  describe("rate limit (RESIL-02)", () => {
    it("over limit → 429 before any fetch, fires onError type rate-limit", async () => {
      const store = new TestRateLimitStore(0); // always over
      const mockFetch = vi.fn();
      vi.stubGlobal("fetch", mockFetch);
      const onError = vi.fn();

      const handler = createHandler({
        backendUrl: "http://backend",
        observability: { onError },
        resilience: { rateLimitStore: store },
      });

      const res = await handler(makeRequest());
      expect(res.status).toBe(429);
      expect(mockFetch).toHaveBeenCalledTimes(0);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0][0].type).toBe("rate-limit");
    });

    it("under limit → proceeds and records once", async () => {
      const store = new TestRateLimitStore(5);
      const mockFetch = vi
        .fn()
        .mockResolvedValue(makeFetchResponse({ body: CLEAN_STREAM }));
      vi.stubGlobal("fetch", mockFetch);

      const handler = createHandler({
        backendUrl: "http://backend",
        resilience: { rateLimitStore: store },
      });

      const res = await handler(makeRequest());
      expect(res.status).toBe(200);
      await drain(res);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(store.recordCalls).toBe(1);
    });

    it("uses rateLimitKey to derive the key", async () => {
      const seenKeys: string[] = [];
      const store: RateLimitStore = {
        async check(key) {
          seenKeys.push(key);
          return false;
        },
        async record() {},
      };
      vi.stubGlobal("fetch", vi.fn());
      const handler = createHandler({
        backendUrl: "http://backend",
        resilience: { rateLimitStore: store, rateLimitKey: () => "tenant-42" },
      });
      const res = await handler(makeRequest());
      expect(res.status).toBe(429);
      expect(seenKeys).toEqual(["tenant-42"]);
    });
  });

  describe("circuit breaker (RESIL-03)", () => {
    it("breaker open → 503 before fetch, fires onError type circuit-breaker", async () => {
      const store = new TestBreakerStore("open");
      const mockFetch = vi.fn();
      vi.stubGlobal("fetch", mockFetch);
      const onError = vi.fn();

      const handler = createHandler({
        backendUrl: "http://backend",
        observability: { onError },
        resilience: { circuitBreakerStore: store },
      });

      const res = await handler(makeRequest());
      expect(res.status).toBe(503);
      expect(mockFetch).toHaveBeenCalledTimes(0);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0][0].type).toBe("circuit-breaker");
    });

    it("breaker closed → proceeds and records success on clean finish", async () => {
      const store = new TestBreakerStore("closed");
      const mockFetch = vi
        .fn()
        .mockResolvedValue(makeFetchResponse({ body: CLEAN_STREAM }));
      vi.stubGlobal("fetch", mockFetch);

      const handler = createHandler({
        backendUrl: "http://backend",
        resilience: { circuitBreakerStore: store },
      });

      const res = await handler(makeRequest());
      expect(res.status).toBe(200);
      await drain(res);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(store.events).toEqual([
        { key: expect.any(String), outcome: "success" },
      ]);
    });

    it("breaker closed → records failure on fetch error", async () => {
      const store = new TestBreakerStore("closed");
      const mockFetch = vi.fn().mockRejectedValue(new Error("conn refused"));
      vi.stubGlobal("fetch", mockFetch);

      const handler = createHandler({
        backendUrl: "http://backend",
        resilience: { circuitBreakerStore: store },
      });

      const res = await handler(makeRequest());
      expect(res.status).toBe(502);
      expect(store.events).toEqual([
        { key: expect.any(String), outcome: "failure" },
      ]);
    });
  });

  describe("concurrent isolation (RESIL-05)", () => {
    it("N concurrent requests with distinct keys are independently accounted", async () => {
      // Limit of 1 per key. Each request uses its own key, so all pass.
      const store = new TestRateLimitStore(1);
      // Fresh response (and thus a fresh, unlocked ReadableStream) per call —
      // a single shared response object would lock its stream on the 2nd read.
      const mockFetch = vi
        .fn()
        .mockImplementation(async () =>
          makeFetchResponse({ body: CLEAN_STREAM })
        );
      vi.stubGlobal("fetch", mockFetch);

      let n = 0;
      const handler = createHandler({
        backendUrl: "http://backend",
        resilience: {
          rateLimitStore: store,
          rateLimitKey: () => `user-${n++}`,
        },
      });

      const results = await Promise.all([
        handler(makeRequest()),
        handler(makeRequest()),
        handler(makeRequest()),
      ]);
      for (const r of results) {
        expect(r.status).toBe(200);
        await drain(r);
      }
      // each distinct key recorded exactly once → no cross-key bleed
      expect(store.recordCalls).toBe(3);
    });

    it("second request on the SAME key is limited while first is not", async () => {
      const store = new TestRateLimitStore(1);
      const mockFetch = vi
        .fn()
        .mockResolvedValue(makeFetchResponse({ body: CLEAN_STREAM }));
      vi.stubGlobal("fetch", mockFetch);

      const handler = createHandler({
        backendUrl: "http://backend",
        resilience: { rateLimitStore: store, rateLimitKey: () => "same" },
      });

      const first = await handler(makeRequest());
      await drain(first);
      const second = await handler(makeRequest());

      expect(first.status).toBe(200);
      expect(second.status).toBe(429);
    });
  });

  describe("retry config (RESIL-06)", () => {
    it("connection-level fetch failures are retried per config", async () => {
      const mockFetch = vi
        .fn()
        .mockRejectedValueOnce(new Error("fail-1"))
        .mockRejectedValueOnce(new Error("fail-2"))
        .mockResolvedValue(makeFetchResponse({ body: CLEAN_STREAM }));
      vi.stubGlobal("fetch", mockFetch);

      const handler = createHandler({
        backendUrl: "http://backend",
        retry: { maxRetries: 2, initialDelayMs: 1 },
      });

      const res = await handler(makeRequest());
      expect(res.status).toBe(200);
      await drain(res);
      expect(mockFetch).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
    });

    it("mid-stream reader errors are NEVER retried (single fetch)", async () => {
      // Body stream that errors after the first chunk → mid-stream failure.
      const failingStream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode('data: {"type":"x"}\n\n')
          );
          controller.error(new Error("mid-stream boom"));
        },
      });
      const mockFetch = vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers(),
        body: failingStream,
      });
      vi.stubGlobal("fetch", mockFetch);

      const handler = createHandler({
        backendUrl: "http://backend",
        retry: { maxRetries: 2, initialDelayMs: 1 },
      });

      const res = await handler(makeRequest());
      const out = await drain(res);
      // fetch called exactly once — mid-stream failures do not trigger retry
      expect(mockFetch).toHaveBeenCalledTimes(1);
      // surfaced as an in-band error frame, not a retried connection
      expect(out).toContain("data-error");
    });
  });

  describe("config completeness", () => {
    it("accepts timeoutMs without error (consumed in Plan 04)", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(makeFetchResponse({ body: CLEAN_STREAM }));
      vi.stubGlobal("fetch", mockFetch);
      const handler = createHandler({
        backendUrl: "http://backend",
        resilience: { timeoutMs: 5000 },
      });
      const res = await handler(makeRequest());
      expect(res.status).toBe(200);
      await drain(res);
    });
  });
});
