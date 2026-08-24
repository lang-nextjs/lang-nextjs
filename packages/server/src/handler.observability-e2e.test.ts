/**
 * OPS-05 Flow 1 E2E — an observability event reaches a consumer sink.
 *
 * Proves end-to-end that when the handler hits an error path (upstream fetch
 * rejects), the `observability.onError` hook fires into an in-memory consumer
 * sink with the documented {@link OnErrorContext} shape — and that the context
 * carries no forbidden fields (no headers / authorization / cookie / raw body),
 * upholding the OBS-03 security contract end-to-end.
 *
 * Self-contained: the file-scope vi.mock blocks and request/response helpers are
 * copied from handler.resilience.test.ts (do not import from a sibling test).
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
import type { OnErrorContext } from "./observability";

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

describe("OPS-05 Flow 1: observability event reaches a sink (E2E)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockIsStreamReconnectEnabled.mockReturnValue(false);
  });

  it("onError fires into the consumer sink with the OnErrorContext shape on a fetch error path", async () => {
    // In-memory consumer sink — the thing a real APM/log exporter would push to.
    const sink: OnErrorContext[] = [];
    const onError = (ctx: OnErrorContext): void => {
      sink.push(ctx);
    };

    // Drive an error path: the upstream fetch rejects (backend down).
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("backend down"))
    );

    const handler = createHandler({
      backendUrl: "http://backend",
      observability: { onError },
    });

    const res = await handler(makeRequest());
    expect(res.status).toBe(502);

    // The event reached the sink end-to-end with the documented shape.
    expect(sink.length).toBeGreaterThanOrEqual(1);
    expect(sink[0].type).toBe("fetch");
    expect(sink[0].error).toBeInstanceOf(Error);
    expect(sink[0].error.message).toBe("backend down");
    expect(typeof sink[0].durationMs).toBe("number");
    expect(typeof sink[0].sessionId).toBe("string");
    expect(sink[0].sessionId.length).toBeGreaterThan(0);
    expect(typeof sink[0].timestamp).toBe("number");
  });

  it("the sink event carries NO forbidden fields (OBS-03 safety end-to-end)", async () => {
    const sink: OnErrorContext[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("backend down"))
    );

    const handler = createHandler({
      backendUrl: "http://backend",
      observability: {
        onError: (ctx) => {
          sink.push(ctx);
        },
      },
    });

    await handler(
      makeRequest({
        headers: { authorization: "Bearer secret", cookie: "sid=abc" },
        body: '{"secret":"do-not-leak"}',
      })
    );

    expect(sink).toHaveLength(1);
    const keys = Object.keys(sink[0]);
    expect(keys).not.toContain("headers");
    expect(keys).not.toContain("authorization");
    expect(keys).not.toContain("cookie");
    expect(keys).not.toContain("body");
    expect(keys).not.toContain("request");
    // Only the documented safe scalar fields are present.
    expect(keys.sort()).toEqual(
      ["durationMs", "error", "sessionId", "timestamp", "type"].sort()
    );
  });
});
