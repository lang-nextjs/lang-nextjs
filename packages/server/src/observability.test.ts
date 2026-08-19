import { describe, it, expect } from "vitest";
import type {
  ObservabilityHooks,
  OnRequestContext,
  OnFetchStartContext,
  OnFetchEndContext,
  OnStreamStartContext,
  OnTransformBeginContext,
  OnTransformEndContext,
  OnErrorContext,
  OnStreamEndContext,
} from "./observability";

// Field names that would constitute a secret/raw-data leak through callbacks.
// OBS-03: none of these may appear as a context field on ANY hook.
const FORBIDDEN_FIELDS = [
  "headers",
  "authorization",
  "token",
  "cookie",
  "body",
  "request",
  "response",
  "raw",
];

function assertNoForbiddenFields(ctx: Record<string, unknown>) {
  const keys = Object.keys(ctx);
  for (const forbidden of FORBIDDEN_FIELDS) {
    expect(keys).not.toContain(forbidden);
  }
}

describe("ObservabilityHooks interface (OBS-01)", () => {
  it("supports all lifecycle hooks as a typed object literal", () => {
    const calls: string[] = [];
    const hooks: ObservabilityHooks = {
      onRequest: () => {
        calls.push("onRequest");
      },
      onFetchStart: () => {
        calls.push("onFetchStart");
      },
      onFetchEnd: () => {
        calls.push("onFetchEnd");
      },
      onStreamStart: () => {
        calls.push("onStreamStart");
      },
      onTransformBegin: () => {
        calls.push("onTransformBegin");
      },
      onTransformEnd: () => {
        calls.push("onTransformEnd");
      },
      onError: () => {
        calls.push("onError");
      },
      onStreamEnd: () => {
        calls.push("onStreamEnd");
      },
    };

    // Exercise each hook at runtime to prove they are callable functions.
    hooks.onRequest?.({
      sessionId: "s",
      backendUrl: "http://b",
      timestamp: 1,
    });
    hooks.onFetchStart?.({ backendUrl: "http://b", timestamp: 1 });
    hooks.onFetchEnd?.({
      backendUrl: "http://b",
      status: 200,
      bytesReceived: 0,
      durationMs: 0,
      timestamp: 1,
    });
    hooks.onStreamStart?.({
      backendUrl: "http://b",
      status: 200,
      timestamp: 1,
    });
    hooks.onTransformBegin?.({ frameIndex: 0, frameBytes: 0, timestamp: 1 });
    hooks.onTransformEnd?.({
      frameIndex: 0,
      dropped: false,
      outputCount: 1,
      durationMs: 0,
      timestamp: 1,
    });
    hooks.onError?.({
      type: "stream",
      error: new Error("x"),
      durationMs: 0,
      sessionId: "s",
      timestamp: 1,
    });
    hooks.onStreamEnd?.({
      success: true,
      frameCount: 1,
      byteCount: 1,
      durationMs: 0,
      timestamp: 1,
    });

    expect(calls).toEqual([
      "onRequest",
      "onFetchStart",
      "onFetchEnd",
      "onStreamStart",
      "onTransformBegin",
      "onTransformEnd",
      "onError",
      "onStreamEnd",
    ]);
  });
});

describe("ObservabilityHooks — invalid/edge-case context values (NEW, iter 8)", () => {
  // The handler hands context objects to user-supplied callbacks. A buggy
  // callback that stringifies the context (e.g., for logging) will crash on
  // circular refs, return NaN for invalid timings, etc. The interface MUST
  // remain type-safe: every documented field is either string|number|boolean|Error.
  // These tests pin that the contract holds even when callers pass weird values.

  it("OnErrorContext accepts an Error whose .cause is a CIRCULAR reference (no type/signature crash)", () => {
    // Adversarial: a handler may wrap an upstream error whose `.cause` chain
    // includes a self-reference (common when an object is rethrown across
    // async boundaries). The OnErrorContext type allows `error: Error` —
    // the .cause field is a runtime detail of the Error instance, not part
    // of the type. The handler must NOT recurse into the cause to serialize
    // it before handing the context to the callback. We just verify the
    // contract: any Error-shaped value is accepted.
    const circular: any = new Error("primary");
    circular.cause = circular;
    const ctx: OnErrorContext = {
      type: "stream",
      error: circular,
      durationMs: 0,
      sessionId: "s",
      timestamp: 1,
    };
    expect(ctx.error).toBe(circular);
    expect((ctx.error as any).cause).toBe(circular);
    // The callback receives the context as-is — it is the CALLER's job to
    // safely serialize, not the handler's. We simulate a callback that
    // checks the error name and stops there (no recursion).
    let seen: Error | undefined;
    const cb = (c: OnErrorContext) => {
      seen = c.error;
    };
    cb(ctx);
    expect(seen).toBe(circular);
  });

  it("OnFetchEndContext accepts NaN durationMs and NaN bytesReceived without throwing (graceful degradation, not Infinity/string)", () => {
    // Adversarial: when a backend fetch fails very early (no body, no
    // timing) a buggy counter may produce NaN. The interface permits
    // number | undefined fields — NaN is a number. A consumer metric
    // aggregator MUST be able to see a NaN and either drop or sanitize
    // the metric; the type system should not fight that. We pin: NaN is
    // accepted, identity-preserved, and not silently coerced to a string
    // by any framework-level coercion.
    const ctx: OnFetchEndContext = {
      backendUrl: "http://b",
      status: 200,
      bytesReceived: Number.NaN,
      durationMs: Number.NaN,
      timestamp: Number.NaN,
    };
    expect(Number.isNaN(ctx.bytesReceived)).toBe(true);
    expect(Number.isNaN(ctx.durationMs)).toBe(true);
    expect(Number.isNaN(ctx.timestamp)).toBe(true);
    // Identity preserved across assignment — no auto-coercion.
    const ctx2: OnFetchEndContext = { ...ctx };
    expect(Number.isNaN(ctx2.bytesReceived)).toBe(true);
    expect(Number.isNaN(ctx2.durationMs)).toBe(true);
  });
});

describe("ObservabilityHooks secret-safety contract (OBS-03)", () => {
  it("no context type carries a header/token/body/raw field", () => {
    const onRequest: OnRequestContext = {
      sessionId: "s",
      backendUrl: "http://b",
      timestamp: 1,
    };
    const onFetchStart: OnFetchStartContext = {
      backendUrl: "http://b",
      timeoutMs: 1000,
      timestamp: 1,
    };
    const onFetchEnd: OnFetchEndContext = {
      backendUrl: "http://b",
      status: 200,
      bytesReceived: 10,
      durationMs: 5,
      timestamp: 1,
    };
    const onStreamStart: OnStreamStartContext = {
      backendUrl: "http://b",
      status: 200,
      timestamp: 1,
    };
    const onTransformBegin: OnTransformBeginContext = {
      frameIndex: 0,
      frameBytes: 12,
      timestamp: 1,
    };
    const onTransformEnd: OnTransformEndContext = {
      frameIndex: 0,
      dropped: false,
      outputCount: 1,
      durationMs: 1,
      timestamp: 1,
    };
    const onError: OnErrorContext = {
      type: "fetch",
      error: new Error("boom"),
      durationMs: 1,
      sessionId: "s",
      timestamp: 1,
    };
    const onStreamEnd: OnStreamEndContext = {
      success: true,
      frameCount: 3,
      byteCount: 100,
      durationMs: 9,
      timestamp: 1,
    };

    for (const ctx of [
      onRequest,
      onFetchStart,
      onFetchEnd,
      onStreamStart,
      onTransformBegin,
      onTransformEnd,
      onError,
      onStreamEnd,
    ]) {
      assertNoForbiddenFields(ctx as unknown as Record<string, unknown>);
    }
  });
});
