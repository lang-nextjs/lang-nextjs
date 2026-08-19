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

  // -------------------------------------------------------------------------
  // ADVERSARIAL — readiness probe isDraining() callback exception propagates
  // uncaught (no try/catch around the await), surfacing as an unhandled
  // rejection instead of a clean ready:false / status:'error' response.
  // -------------------------------------------------------------------------

  it("readiness probe catches isDraining() exceptions and returns status:'error' rather than rejecting the promise", async () => {
    // In createReadinessProbe the line
    //   const draining = config.draining === true ||
    //     (config.isDraining ? (await config.isDraining()) === true : false);
    // has no try/catch around `await config.isDraining()`. A throwing
    // isDraining (e.g. config store read error) propagates and the probe
    // rejects — SvelteKit's request handler then 500s instead of returning
    // a clean {ready:false, status:'error'} body. Pin the contract: the
    // probe must NEVER reject; a thrown isDraining must degrade gracefully.
    const result = await createReadinessProbe({
      isDraining: () => {
        throw new Error("config-store-down");
      },
    });

    expect(result.ready).toBe(false);
    expect(result.status).toBe("error");
    expect(typeof result.timestamp).toBe("number");
  });

  it("createReadinessProbe handles 100 parallel invocations with no shared state — each resolves independently with its own result", async () => {
    // Adversarial: if the probe ever relies on module-scope mutable state
    // (e.g. a shared cache of recent results, a counter, or a singleton
    // timestamp source), 100 parallel invocations race over that state and
    // some probes will see partial/incorrect output. The contract is that
    // createReadinessProbe is fully stateless — each invocation must produce
    // a self-contained, correct result regardless of how many other probes
    // are running concurrently.
    //
    // Additionally: if isDraining is captured by reference into a shared
    // closure that gets mutated by a concurrent probe, the "draining" flag
    // leaks across invocations. Pin: each probe sees its own isDraining value.
    const N = 100;
    // Mix three drain states across the N probes, each running concurrently.
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => {
        const draining = i % 3 === 0;
        return createReadinessProbe({
          isDraining: () => draining,
        });
      })
    );

    expect(results).toHaveLength(N);

    // Every probe must produce a well-formed result shape.
    for (const r of results) {
      expect(typeof r.ready).toBe("boolean");
      expect(typeof r.timestamp).toBe("number");
      expect(["ok", "draining", "error"]).toContain(r.status);
    }

    // Each probe must see its OWN drain state — no cross-contamination.
    // Probe 0 should be draining, probe 1 should be ok, probe 2 ok,
    // probe 3 draining, ...
    for (let i = 0; i < N; i++) {
      const expectedDraining = i % 3 === 0;
      if (expectedDraining) {
        expect(results[i].ready).toBe(false);
        expect(results[i].status).toBe("draining");
      } else {
        expect(results[i].ready).toBe(true);
        expect(results[i].status).toBe("ok");
      }
    }

    // Timestamps must be monotonically non-decreasing in dispatch order
    // (or at minimum all numeric — proves no NaN from a shared source).
    for (const r of results) {
      expect(Number.isFinite(r.timestamp)).toBe(true);
      expect(r.timestamp).toBeGreaterThan(0);
    }
  });

  // -------------------------------------------------------------------------
  // ADVERSARIAL — iter 7 likely-OK probe: with NO probes configured, the
  // readiness probe must return ready:true by default. This is the
  // cheap-by-default contract (PROBE-03): a deployment with zero configured
  // dependency checks must be considered ready so Kubernetes / load
  // balancers route traffic to it. If a future change accidentally makes
  // "no checks = not ready", the entire fleet would refuse to take traffic
  // until every consumer opts in — pin this behavior.
  // -------------------------------------------------------------------------

  it("health probes with no probes configured return healthy/ready by default — empty-config default-ok contract", async () => {
    // Liveness: no checks supplied must produce ok:true (no failure to record).
    const live = await createHealthProbe();
    expect(live.ok).toBe(true);
    expect(live.status).toBe("ok");
    expect(live.checks).toEqual({});
    // No leaked fields beyond the documented shape.
    expect(Object.keys(live).sort()).toEqual(
      ["checks", "ok", "status", "timestamp"].sort()
    );

    // Readiness: no checks supplied AND not draining must produce ready:true.
    // Call with explicit empty config object to pin the "default-ok" path.
    const ready = await createReadinessProbe({});
    expect(ready.ready).toBe(true);
    expect(ready.status).toBe("ok");
    // No leaked fields beyond the documented shape — PROBE-05 invariant.
    expect(Object.keys(ready).sort()).toEqual(
      ["ready", "status", "timestamp"].sort()
    );

    // Pin the cheap-by-default contract: when no checks are configured,
    // the readiness probe must NOT call fetch (no backend round-trip).
    // A botched implementation that always probes the network would slow
    // down every readiness poll even when no deps are configured.
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const readyAgain = await createReadinessProbe({});
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(readyAgain.ready).toBe(true);
    expect(readyAgain.status).toBe("ok");
  });
});
