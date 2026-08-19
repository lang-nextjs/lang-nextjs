import { afterEach, describe, expect, it, vi } from "vitest";
import { createHealthProbe, createReadinessProbe } from "./health";

/**
 * Drift guard for the copy-not-import health probe (PROBE-01..05).
 *
 * `health.ts` is a verbatim copy of packages/server/src/health.ts. The server
 * copy is the source of truth and is fully covered there; this suite asserts
 * THIS package's copy upholds the same behavioral contract, so a silent
 * divergence (a botched manual sync) fails CI here.
 */
const FORBIDDEN_KEYS = [
  "version",
  "backendUrl",
  "backend",
  "env",
  "url",
  "token",
  "secret",
  "stack",
  "error",
  "message",
  "uptime",
  "hostname",
];

function assertNoLeakedKeys(obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    expect(FORBIDDEN_KEYS).not.toContain(key);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createHealthProbe (liveness)", () => {
  it("returns ok:true and status:'ok' with a single always-true check (PROBE-01)", async () => {
    const result = await createHealthProbe([
      { name: "self", check: async () => true },
    ]);

    expect(result.ok).toBe(true);
    expect(result.status).toBe("ok");
    expect(result.checks).toEqual({ self: true });
    expect(typeof result.timestamp).toBe("number");
  });

  it("returns ok:true with no checks supplied (cheap liveness)", async () => {
    const result = await createHealthProbe();

    expect(result.ok).toBe(true);
    expect(result.status).toBe("ok");
    expect(result.checks).toEqual({});
  });

  it("produces a MINIMAL response object with no leaked internals (PROBE-05)", async () => {
    const result = await createHealthProbe([
      { name: "self", check: async () => true },
    ]);

    for (const key of Object.keys(result)) {
      expect(["ok", "status", "checks", "timestamp"]).toContain(key);
    }
    assertNoLeakedKeys(result as unknown as Record<string, unknown>);
  });

  it("bounds a never-resolving check by timeoutMs and records it as false (PROBE-03 timeout)", async () => {
    vi.useFakeTimers();
    try {
      const promise = createHealthProbe([
        {
          name: "hang",
          check: () => new Promise<boolean>(() => {}),
          timeoutMs: 50,
        },
      ]);
      await vi.advanceTimersByTimeAsync(60);
      const result = await promise;

      expect(result.checks.hang).toBe(false);
      expect(result.ok).toBe(false);
      expect(result.status).toBe("error");
    } finally {
      vi.useRealTimers();
    }
  });

  it("records a throwing check as false (ok:false)", async () => {
    const result = await createHealthProbe([
      {
        name: "boom",
        check: async () => {
          throw new Error("nope");
        },
      },
    ]);

    expect(result.checks.boom).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.status).toBe("error");
  });
});

describe("createReadinessProbe", () => {
  it("returns ready:false and status:'draining' when draining (PROBE-02)", async () => {
    const result = await createReadinessProbe({
      draining: true,
      checks: [{ name: "dep", check: async () => true }],
    });

    expect(result.ready).toBe(false);
    expect(result.status).toBe("draining");
  });

  it("honors an isDraining() callback returning true (no module-scope state)", async () => {
    const result = await createReadinessProbe({ isDraining: () => true });

    expect(result.ready).toBe(false);
    expect(result.status).toBe("draining");
  });

  it("supports an async isDraining() callback", async () => {
    const result = await createReadinessProbe({ isDraining: async () => true });

    expect(result.ready).toBe(false);
    expect(result.status).toBe("draining");
  });

  it("is CHEAP by default — no fetch when no checks supplied (PROBE-03)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await createReadinessProbe({});

    expect(fetchSpy).toHaveBeenCalledTimes(0);
    expect(result.ready).toBe(true);
    expect(result.status).toBe("ok");
  });

  it("does not fetch even when not draining and checks omitted", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await createReadinessProbe({ draining: false });

    expect(fetchSpy).toHaveBeenCalledTimes(0);
    expect(result.ready).toBe(true);
    expect(result.status).toBe("ok");
  });

  it("returns ready:false when an opted-in dependency check returns false", async () => {
    const result = await createReadinessProbe({
      checks: [
        { name: "db", check: async () => true },
        { name: "cache", check: async () => false },
      ],
    });

    expect(result.ready).toBe(false);
    expect(result.status).toBe("error");
  });

  it("returns ready:true when all opted-in checks pass and not draining", async () => {
    const result = await createReadinessProbe({
      checks: [
        { name: "db", check: async () => true },
        { name: "cache", check: async () => true },
      ],
    });

    expect(result.ready).toBe(true);
    expect(result.status).toBe("ok");
  });

  it("treats draining as ready:false regardless of passing checks (PROBE-02)", async () => {
    const result = await createReadinessProbe({
      draining: true,
      checks: [{ name: "db", check: async () => true }],
    });

    expect(result.ready).toBe(false);
    expect(result.status).toBe("draining");
  });

  it("bounds a never-resolving check by timeoutMs → ready:false (PROBE-03 timeout)", async () => {
    vi.useFakeTimers();
    try {
      const promise = createReadinessProbe({
        checks: [
          {
            name: "hang",
            check: () => new Promise<boolean>(() => {}),
            timeoutMs: 50,
          },
        ],
      });
      await vi.advanceTimersByTimeAsync(60);
      const result = await promise;

      expect(result.ready).toBe(false);
      expect(result.status).toBe("error");
    } finally {
      vi.useRealTimers();
    }
  });

  it("produces a MINIMAL response object with no leaked internals (PROBE-05)", async () => {
    const result = await createReadinessProbe({
      checks: [{ name: "db", check: async () => true }],
    });

    const keys = Object.keys(result);
    for (const key of keys) {
      expect(["ready", "status", "timestamp"]).toContain(key);
    }
    // readiness must NOT expose per-dependency check detail by default
    expect(keys).not.toContain("checks");
    assertNoLeakedKeys(result as unknown as Record<string, unknown>);
  });

  it("includes a numeric timestamp", async () => {
    const result = await createReadinessProbe({});
    expect(typeof result.timestamp).toBe("number");
  });
});

// Adversarial iter 2 — backend check that simulates a 5xx response
describe("createHealthProbe — adversarial 5xx backend", () => {
  it("a check that performs a real fetch and resolves to false (5xx) reports unhealthy without throwing", async () => {
    // Simulate the realistic health-check pattern: the consumer-supplied
    // check function does a fetch() to the backend and returns true only on
    // 2xx. A 500 response means the check returns false. The probe must:
    //   1. NOT propagate the fetch error / network noise.
    //   2. NOT throw or reject.
    //   3. Report ok:false and status:'error' so a load-balancer / k8s probe
    //      can act on it.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("internal", { status: 500 }))
    );

    const checkBackend = async (): Promise<boolean> => {
      // Not a real request: fetch is mocked in this suite, and 'backend'/'dep'
      // are fake hostnames resolving nowhere. There is no plaintext traffic to
      // intercept — the scheme is irrelevant to what this asserts.
      // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request
      const r = await fetch("http://backend/health");
      return r.ok; // 500 → r.ok === false → returns false
    };

    const result = await createHealthProbe([
      { name: "backend", check: checkBackend },
    ]);

    expect(result.ok).toBe(false);
    expect(result.status).toBe("error");
    expect(result.checks.backend).toBe(false);
    // Timestamp still set — even on failure the contract holds
    expect(typeof result.timestamp).toBe("number");
  });

  it("readiness probe with a 5xx-returning backend dependency reports ready:false / status:error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 }))
    );

    const checkDep = async (): Promise<boolean> => {
      // Not a real request: fetch is mocked in this suite, and 'backend'/'dep'
      // are fake hostnames resolving nowhere. There is no plaintext traffic to
      // intercept — the scheme is irrelevant to what this asserts.
      // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request
      const r = await fetch("http://dep/health");
      return r.ok; // 503 → false
    };

    const result = await createReadinessProbe({
      checks: [{ name: "dep", check: checkDep }],
    });

    expect(result.ready).toBe(false);
    expect(result.status).toBe("error");
    expect(typeof result.timestamp).toBe("number");
    // PROBE-05: must NOT leak per-dependency detail
    expect(Object.keys(result)).not.toContain("checks");
  });
});
