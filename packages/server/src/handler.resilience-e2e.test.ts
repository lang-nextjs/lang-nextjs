/**
 * OPS-05 Flow 2 E2E — a resilience trip produces the correct fallback.
 *
 * Proves end-to-end that the handler's resilience gate rejects BEFORE any
 * backend fetch:
 *   - over the rate limit  → 429, fetch spy called zero times
 *   - circuit breaker OPEN → 503, fetch spy called zero times
 *
 * The "no fetch" assertion is the core resilience contract: rejections must
 * avoid the upstream round-trip entirely.
 *
 * Self-contained: the file-scope vi.mock blocks, request/response helpers, and
 * the in-memory test stores are copied from handler.resilience.test.ts (do not
 * import from a sibling test).
 */
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
  constructor(private max: number) {}
  async check(key: string) {
    return (this.hits.get(key) ?? 0) < this.max;
  }
  async record(key: string, _windowMs: number) {
    this.hits.set(key, (this.hits.get(key) ?? 0) + 1);
  }
}

class TestCircuitBreakerStore implements CircuitBreakerStore {
  constructor(private fixedState: "closed" | "open" | "half-open") {}
  async getState() {
    return this.fixedState;
  }
  async recordEvent(_key: string, _outcome: "success" | "failure") {}
}

async function drain(res: Response): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
}

describe("OPS-05 Flow 2: resilience trip → correct fallback (E2E)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockIsStreamReconnectEnabled.mockReturnValue(false);
  });

  it("rate limit: first request 200, second (over limit) 429 with no extra fetch", async () => {
    const store = new TestRateLimitStore(1); // limit 1 per key
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(makeFetchResponse({ body: CLEAN_STREAM }));
    vi.stubGlobal("fetch", fetchSpy);

    const handler = createHandler({
      backendUrl: "http://backend",
      resilience: { rateLimitStore: store, rateLimitKey: () => "same-tenant" },
    });

    const first = await handler(makeRequest());
    expect(first.status).toBe(200);
    await drain(first);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Second request is over the limit → 429, and fetch is NOT called again.
    const second = await handler(makeRequest());
    expect(second.status).toBe(429);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // unchanged — no fetch for the rejection
  });

  it("circuit breaker OPEN: single request 503, fetch never called", async () => {
    const store = new TestCircuitBreakerStore("open");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const handler = createHandler({
      backendUrl: "http://backend",
      resilience: { circuitBreakerStore: store },
    });

    const res = await handler(makeRequest());
    expect(res.status).toBe(503);
    // The fallback fired BEFORE any backend fetch — the core resilience contract.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
