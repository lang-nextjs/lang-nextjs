import { afterEach, describe, expect, it, vi } from "vitest";
import { createHealthProbe, createReadinessProbe } from "./health";
import type { ProbeCheck } from "./health";
// Vite `?raw` returns the file contents as a string at test time — no Node `fs`,
// so the edge package keeps its zero-`@types/node` guarantee even in tests.
// @ts-expect-error -- the `?raw` suffix has no ambient type declaration
import healthSource from "./health.ts?raw";

/**
 * Drift guard for the copy-not-import health probe (PROBE-01..05).
 *
 * `health.ts` is a verbatim copy of packages/server/src/health.ts. The server
 * copy is the source of truth and is fully covered there; this suite asserts
 * THIS package's copy upholds the same behavioral contract, so a silent
 * divergence (a botched manual sync) fails CI here.
 *
 * The edge package additionally asserts the copy is edge-runtime safe — it must
 * use only Web-standard APIs and never import a Node.js built-in, since the same
 * source ships to Cloudflare Workers / Deno where `node:*` is unavailable.
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

  // ADVERSARIAL (iter 2): Backend 5xx must report unhealthy. A real consumer
  // wires createHealthProbe to a probe check that calls fetch and resolves
  // false when the backend returns 5xx. The probe must propagate that as
  // ok:false (liveness) AND readiness must flip ready:false. Otherwise a
  // broken backend would still appear healthy and a load balancer would
  // happily keep routing traffic to a dead pod.
  it("reports unhealthy when backend 5xx is observed via a probe check", async () => {
    // Simulate a backend that returns 503 — the consumer's probe resolves
    // to false in that case, mirroring real usage.
    const backendProbe: ProbeCheck = {
      name: "backend",
      check: async () => {
        // In real code: const res = await fetch(backendUrl); return res.ok
        // Here we hardcode the 5xx outcome to test the propagation.
        const simulatedStatus = 503;
        return simulatedStatus < 500;
      },
    };

    const liveness = await createHealthProbe([backendProbe]);
    expect(liveness.checks.backend).toBe(false);
    expect(liveness.ok).toBe(false);
    expect(liveness.status).toBe("error");

    const readiness = await createReadinessProbe({ checks: [backendProbe] });
    expect(readiness.ready).toBe(false);
    expect(readiness.status).toBe("error");
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

// ADVERSARIAL (iter 3): 100 concurrent health probes. The probe API must be
// stateless — no module-scope accumulator, no shared draining flag that mutates
// across calls. A buggy impl with hidden shared state would let one concurrent
// call's `isDraining()` flip the result of another. We fire 100 parallel probes
// with a real async isDraining() and assert every result is consistent.
it("100 concurrent createReadinessProbe calls produce independent, consistent results", async () => {
  let drainingFlag = false;
  const config = {
    isDraining: async () => drainingFlag,
    checks: [
      // A check that resolves on a microtask — exercises the async path under load.
      { name: "dep", check: async () => true },
    ],
  };

  const N = 100;
  const results = await Promise.all(
    Array.from({ length: N }, () => createReadinessProbe(config))
  );
  expect(results).toHaveLength(N);
  // No result may leak a non-allowed key (PROBE-05).
  for (const r of results) {
    expect(Object.keys(r).sort()).toEqual(["ready", "status", "timestamp"]);
    expect(r.status).toBe("ok");
    expect(r.ready).toBe(true);
  }

  // Now flip draining mid-stream — every probe issued AFTER must return draining.
  drainingFlag = true;
  const drainingResults = await Promise.all(
    Array.from({ length: N }, () => createReadinessProbe(config))
  );
  for (const r of drainingResults) {
    expect(r.status).toBe("draining");
    expect(r.ready).toBe(false);
  }
});

describe("edge-runtime safety (no Node.js built-ins)", () => {
  it("health.ts imports no Node.js built-in module", () => {
    const src = healthSource as string;

    // No `node:` specifier and no bare import of a common Node built-in —
    // the source must run on Cloudflare Workers / Deno unmodified.
    expect(src).not.toMatch(/from\s+["']node:/);
    expect(src).not.toMatch(/require\(\s*["']node:/);
    expect(src).not.toMatch(
      /from\s+["'](?:fs|path|crypto|os|http|https|stream|buffer|net|child_process|worker_threads)["']/
    );
  });
});
