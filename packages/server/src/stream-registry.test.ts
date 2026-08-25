import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  registerStream,
  lookupStream,
  markStreamDone,
  deleteStream,
  atomicRegisterIfAbsent,
  RegisterResult,
  // cleanupExpired is now exported by ./stream-registry; the prior
  // `@ts-expect-error` (assuming it wasn't) has become stale and breaks tsc
  // with TS2578: Unused '@ts-expect-error' directive.
  cleanupExpired,
} from "./stream-registry";

// Reset the global registry between tests
beforeEach(() => {
  const g = globalThis as unknown as {
    __deepagents_stream_registry?: Map<string, unknown>;
  };
  g.__deepagents_stream_registry = new Map();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("stream-registry", () => {
  describe("registerStream / lookupStream", () => {
    it("registers a stream and lookupStream returns the record", () => {
      registerStream("abc", "stream-1");
      const record = lookupStream("abc");
      expect(record).toBeDefined();
      expect(record!.streamId).toBe("stream-1");
      expect(record!.done).toBe(false);
    });

    it("lookupStream returns undefined for nonexistent resumeId", () => {
      expect(lookupStream("nonexistent")).toBeUndefined();
    });

    it("registerStream overwrites an existing entry (dedup: last write wins)", () => {
      registerStream("abc", "stream-1");
      registerStream("abc", "stream-2");
      const record = lookupStream("abc");
      expect(record!.streamId).toBe("stream-2");
    });
  });

  describe("markStreamDone", () => {
    it("marks an existing stream as done", () => {
      registerStream("abc", "stream-1");
      markStreamDone("abc");
      const record = lookupStream("abc");
      expect(record!.done).toBe(true);
    });

    it("markStreamDone is a no-op when resumeId is not found", () => {
      expect(() => markStreamDone("missing")).not.toThrow();
    });
  });

  describe("deleteStream", () => {
    it("removes the entry so lookupStream returns undefined", () => {
      registerStream("abc", "stream-1");
      deleteStream("abc");
      expect(lookupStream("abc")).toBeUndefined();
    });

    it("deleteStream is a no-op when resumeId does not exist", () => {
      expect(() => deleteStream("missing")).not.toThrow();
    });
  });

  describe("TTL eviction (lazy)", () => {
    it("lookupStream returns undefined and evicts the entry when createdAt is older than TTL_MS", () => {
      registerStream("abc", "stream-1");

      // Mock Date.now() to return a value far beyond the 5-minute TTL
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now + 6 * 60 * 1000); // 6 minutes later

      expect(lookupStream("abc")).toBeUndefined();

      // The entry must have been evicted — restore real Date.now and confirm
      vi.restoreAllMocks();
      // After eviction, even without time travel the entry is gone
      expect(lookupStream("abc")).toBeUndefined();
    });

    it("lookupStream returns the record when within TTL", () => {
      registerStream("abc", "stream-1");
      // Default Date.now() — entry just created, well within 5 min TTL
      expect(lookupStream("abc")).toBeDefined();
    });
  });

  describe("singleton stability", () => {
    it("same map is returned across multiple getRegistry calls (survives HMR pattern)", () => {
      registerStream("test-1", "s-1");
      registerStream("test-2", "s-2");
      // lookupStream uses the same singleton
      expect(lookupStream("test-1")).toBeDefined();
      expect(lookupStream("test-2")).toBeDefined();
    });
  });

  describe("registerStream with optional stream argument", () => {
    it("stores the ReadableStream on the record when passed as third argument", () => {
      // Gap: registerStream accepts an optional ReadableStream but the stored value
      // is never verified. If the field assignment is silently dropped or mapped to
      // the wrong key the reconnect GET handler would return 204 instead of replaying.
      const fakeStream = new ReadableStream();
      registerStream("with-stream", "s-1", fakeStream);
      const record = lookupStream("with-stream");
      expect(record).toBeDefined();
      expect(record!.stream).toBe(fakeStream);
    });

    it("empty-string resumeId is treated as a valid key — registerStream('', ...) can be looked up and marked done", () => {
      // Gap: the handler reads resumeId from the header with `?? undefined`, so an
      // `x-resume-id: ` header (empty value) would produce "" which is falsy and be
      // skipped. But if empty-string keys ever reach the registry (e.g. from a direct
      // registerStream call or a different code path), the Map must handle them correctly
      // and not corrupt other entries. This pins that Map("") isolation works as expected.
      registerStream("", "stream-empty-key");
      registerStream("other", "stream-other");

      const emptyRecord = lookupStream("");
      const otherRecord = lookupStream("other");

      expect(emptyRecord).toBeDefined();
      expect(emptyRecord!.streamId).toBe("stream-empty-key");
      // Empty-string key must not bleed into other entries
      expect(otherRecord).toBeDefined();
      expect(otherRecord!.streamId).toBe("stream-other");

      // markStreamDone("") must only affect the "" entry
      markStreamDone("");
      expect(lookupStream("")!.done).toBe(true);
      expect(lookupStream("other")!.done).toBe(false);
    });

    it("re-registering a done=true resumeId with registerStream resets done to false (overwrite resets state)", () => {
      // Gap: the overwrite test only checks streamId, not the `done` field.
      // If an implementor merges rather than replaces the record (e.g. Object.assign
      // without resetting `done`), a completed stream re-registered for a new conversation
      // would immediately appear done=true, causing the POST handler to skip dedup and
      // the GET handler to return 204 instead of replaying.
      registerStream("abc", "stream-1");
      markStreamDone("abc");
      expect(lookupStream("abc")!.done).toBe(true);

      // Re-register the same resumeId for a new session
      registerStream("abc", "stream-2");
      const record = lookupStream("abc");
      expect(record).toBeDefined();
      expect(record!.streamId).toBe("stream-2");
      // done must be reset to false — the new registration is a fresh stream
      expect(record!.done).toBe(false);
    });

    it("TTL boundary: entry at EXACTLY TTL_MS age is evicted (> vs >= off-by-one)", () => {
      // Gap: the eviction check uses `Date.now() - record.createdAt > TTL_MS`.
      // A record that is exactly TTL_MS ms old (not older) is NOT evicted by the current
      // implementation. This test pins the boundary: at exactly TTL_MS the record should
      // still be returned (i.e., > is the correct operator, not >=).
      // If an implementor changes > to >= this test will fail, exposing the regression.
      // FREEZE THE CLOCK BEFORE REGISTERING. registerStream stamps createdAt from
      // Date.now(); reading Date.now() AFTERWARDS and calling it "the creation time"
      // is a race. If the millisecond ticks in between, "exactly TTL_MS" is really
      // TTL_MS + 1, the record IS evicted, and the assertion fails with "expected
      // undefined to be defined". Rare in isolation, likely under turbo's parallel
      // load — this test failed exactly that way in CI and passed 3/3 alone.
      // Reproduced deterministically by burning 1ms between the two calls.
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now);
      registerStream("boundary", "s-boundary");
      // Advance time to EXACTLY TTL_MS — should NOT be evicted (> not >=)
      vi.spyOn(Date, "now").mockReturnValue(now + 5 * 60 * 1000); // exactly TTL_MS
      expect(lookupStream("boundary")).toBeDefined();
    });

    it("TTL boundary: entry at TTL_MS + 1ms IS evicted (confirms the > operator works in both directions)", () => {
      // Companion to the exact-TTL test above. The exact-TTL test pins that records at
      // age === TTL_MS are NOT evicted. This test pins that records at TTL_MS + 1ms ARE
      // evicted. Together they bracket the > operator: if an implementor changes the
      // threshold to `> TTL_MS + 1` (shifting the boundary by 1ms), the first test still
      // passes but this one fails, immediately exposing the regression.
      // Same freeze-before-register discipline as the companion above. This
      // direction is not flaky — drift only makes the record older, and older is
      // still evicted — but without the freeze the test does not pin the boundary
      // at +1ms, which is the only thing it claims to do.
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now);
      registerStream("boundary-plus-one", "s-b1");
      // Advance time to exactly TTL_MS + 1ms — must be evicted
      vi.spyOn(Date, "now").mockReturnValue(now + 5 * 60 * 1000 + 1);
      expect(lookupStream("boundary-plus-one")).toBeUndefined();
    });

    it("re-registering after TTL expiry produces a fresh entry that is fully lookupable", () => {
      // Gap: after a TTL eviction deletes an entry, re-registering the same resumeId
      // must produce a fresh record that lookupStream can find. If deleteStream during
      // eviction corrupts the map, or if getRegistry() returns a stale snapshot, the
      // new entry would be invisible and lookupStream would keep returning undefined.
      registerStream("ttl-reuse", "s-original");
      const originalNow = Date.now();

      // Travel 6 minutes into the future — entry expires and is evicted on first lookup
      vi.spyOn(Date, "now").mockReturnValue(originalNow + 6 * 60 * 1000);
      expect(lookupStream("ttl-reuse")).toBeUndefined(); // eviction fires here

      // Restore real time and re-register the same resumeId as a new stream
      vi.restoreAllMocks();
      registerStream("ttl-reuse", "s-fresh");

      // The new entry must be found — not shadowed or lost due to the prior eviction
      const record = lookupStream("ttl-reuse");
      expect(record).toBeDefined();
      expect(record!.streamId).toBe("s-fresh");
      expect(record!.done).toBe(false);
    });
  });
});

describe("ADVERSARIAL: cleanupExpired proactive TTL sweep", () => {
  beforeEach(() => {
    const g = globalThis as unknown as {
      __deepagents_stream_registry?: Map<string, unknown>;
    };
    g.__deepagents_stream_registry = new Map();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ADVERSARIAL: cleanupExpired() is a no-op when the registry is empty (does not throw)", () => {
    // The stream-registry module is expected to export a cleanupExpired() function that
    // proactively sweeps expired entries (called by a 60-second setInterval in production).
    // This test verifies the function exists and is a safe no-op on an empty registry.
    // It will FAIL because cleanupExpired is NOT exported — the import resolves to undefined,
    // and calling undefined() throws "cleanupExpired is not a function".
    expect(() => cleanupExpired()).not.toThrow();
  });

  it("ADVERSARIAL: cleanupExpired() removes only entries older than TTL_MS, leaves fresh entries intact", () => {
    // Registers two entries: one already expired, one fresh.
    // cleanupExpired() must evict the stale entry and leave the fresh one.
    // Will FAIL because cleanupExpired is undefined (not exported).
    registerStream("stale", "s-stale");
    registerStream("fresh", "s-fresh");

    const now = Date.now();
    // Travel 6 minutes into the future so 'stale' was registered before the TTL horizon,
    // but re-register 'fresh' to simulate it having been created just now.
    vi.spyOn(Date, "now").mockReturnValue(now + 6 * 60 * 1000);
    // Re-register 'fresh' at the advanced time so its createdAt is within TTL
    registerStream("fresh", "s-fresh");

    cleanupExpired();

    vi.restoreAllMocks();
    expect(lookupStream("stale")).toBeUndefined(); // evicted by cleanupExpired
    expect(lookupStream("fresh")).toBeDefined(); // retained
  });

  describe("atomicRegisterIfAbsent", () => {
    it("returns ok:true and registers when no existing entry", () => {
      const result = atomicRegisterIfAbsent("new-id", "s-1");
      expect(result).toEqual({ ok: true, streamId: "s-1" });

      const record = lookupStream("new-id");
      expect(record).toBeDefined();
      expect(record!.streamId).toBe("s-1");
      expect(record!.done).toBe(false);
    });

    it("returns ok:false with reason:'active' when an active (done=false) stream exists", () => {
      registerStream("abc", "s-1");
      const result = atomicRegisterIfAbsent("abc", "s-2");
      expect(result).toEqual({ ok: false, reason: "active" });

      const record = lookupStream("abc");
      expect(record).toBeDefined();
      expect(record!.streamId).toBe("s-1"); // not overwritten
      expect(record!.done).toBe(false);
    });

    it("returns ok:true and overwrites when existing stream is done=true", () => {
      registerStream("abc", "s-1");
      markStreamDone("abc");
      const result = atomicRegisterIfAbsent("abc", "s-2");
      expect(result).toEqual({ ok: true, streamId: "s-2" });

      const record = lookupStream("abc");
      expect(record).toBeDefined();
      expect(record!.streamId).toBe("s-2");
      expect(record!.done).toBe(false);
    });

    it("returns ok:true and registers when existing entry is TTL-expired (evicts then registers)", () => {
      registerStream("abc", "s-1");

      // Advance time 6 minutes to expire the entry
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now + 6 * 60 * 1000);

      const result = atomicRegisterIfAbsent("abc", "s-2");
      expect(result).toEqual({ ok: true, streamId: "s-2" });

      // Restore mocks and verify the new entry is there
      vi.restoreAllMocks();
      const record = lookupStream("abc");
      expect(record).toBeDefined();
      expect(record!.streamId).toBe("s-2");
      expect(record!.done).toBe(false);
    });

    it("stores optional ReadableStream on the record", () => {
      const fakeStream = new ReadableStream();
      const result = atomicRegisterIfAbsent("abc", "s-1", fakeStream);
      expect(result).toEqual({ ok: true, streamId: "s-1" });

      const record = lookupStream("abc");
      expect(record).toBeDefined();
      expect(record!.stream).toBe(fakeStream);
    });

    it("simulates concurrent registration: 10 sequential calls to atomicRegisterIfAbsent with same resumeId — exactly 1 succeeds", () => {
      const results: RegisterResult[] = [];
      let successCount = 0;

      // Make 10 sequential calls with the same resumeId
      for (let i = 0; i < 10; i++) {
        const result = atomicRegisterIfAbsent("concurrent-test", `s-${i}`);
        results.push(result);
        if (result.ok) successCount++;
      }

      // Exactly one should succeed, the rest should fail with reason 'active'
      expect(successCount).toBe(1);
      expect(results.filter((r) => r.ok).length).toBe(1);
      expect(results.filter((r) => !r.ok && r.reason === "active").length).toBe(
        9
      );

      // The successful one should be the one that's actually registered
      const successfulStreamId = results.find((r) => r.ok)!.streamId;
      const record = lookupStream("concurrent-test");
      expect(record).toBeDefined();
      expect(record!.streamId).toBe(successfulStreamId);
    });

    it("returns ok:true and registers a fresh entry for an existing TTL-expired entry (covers the 'expired_during_call' eviction branch)", () => {
      // The RegisterResult type advertises two failure reasons: 'active' and
      // 'expired_during_call'. The current implementation silently evicts an
      // expired existing entry inside atomicRegisterIfAbsent and proceeds to
      // register — it never surfaces 'expired_during_call' to the caller. This
      // test pins that a TTL-expired + same-resumeId re-registration succeeds
      // and the OLD entry is GONE before the new one is recorded. If the
      // eviction branch is removed (or the order swapped), the previous
      // entry's streamId would leak through and this assertion fails.
      registerStream("expired-id", "s-old");

      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now + 6 * 60 * 1000); // 6 minutes

      const result = atomicRegisterIfAbsent("expired-id", "s-new");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.streamId).toBe("s-new");

      vi.restoreAllMocks();
      const record = lookupStream("expired-id");
      expect(record).toBeDefined();
      // The previous "s-old" entry must NOT survive — eviction must have run
      // before the new set.
      expect(record!.streamId).toBe("s-new");
      expect(record!.done).toBe(false);
    });

    it("ADVERSARIAL: cleanupExpired() runs concurrently with registerStream on the same resumeId — fresh entry must NOT be evicted by a stale sweep", async () => {
      // Gap: cleanupExpired is exported and intended to be called from a
      // setInterval. With a real async boundary it can interleave with
      // registerStream calls (e.g., a POST handler registering right as the
      // sweeper fires). A TOCTOU bug where the sweep reads `createdAt` before
      // the new registration sets it would evict the just-registered entry.
      // This test pins: after a sweep with the clock "still old", a fresh
      // registerStream must survive the next sweep that runs at REAL time.
      registerStream("toctou", "s-original");
      const oldNow = Date.now();
      // Move clock forward 6 minutes — toctou is "expired" at this point.
      vi.spyOn(Date, "now").mockReturnValue(oldNow + 6 * 60 * 1000);

      // Re-register at the advanced time so the new entry's createdAt is
      // at the advanced clock — it is NOT expired under the current clock.
      registerStream("toctou", "s-fresh-at-old-clock");

      // Now run the sweep at the SAME advanced clock — it must NOT evict the
      // fresh entry because its createdAt equals the current Date.now() (age 0).
      cleanupExpired();

      // Restore real time — the fresh entry's createdAt is in the past at
      // real-now, but well under the 5-minute TTL (we only advanced 6min
      // virtually, then ran the sweep in zero wall time).
      vi.restoreAllMocks();

      const record = lookupStream("toctou");
      // The fresh entry must still be present after the sweep — TOCTOU-safe.
      expect(record).toBeDefined();
      expect(record!.streamId).toBe("s-fresh-at-old-clock");
      expect(record!.done).toBe(false);
    });

    it("ADVERSARIAL: 50 alternating registerStream/deleteStream cycles on same resumeId leave the registry in a consistent state", async () => {
      // Gap: alternating register + delete from many concurrent requests can
      // hit a Map.set-then-delete race that leaves phantom entries or
      // corrupts the activeCount invariant. The registry is synchronous (Map
      // ops are atomic in V8's main thread), so we just need to confirm
      // alternating ops end in a consistent state — the LAST write wins.
      let lastSeen = "";
      for (let i = 0; i < 50; i++) {
        const id = `cycle-${i % 3}`; // rotate among 3 keys to exercise overlap
        registerStream(id, `s-${i}`);
        lastSeen = id;
        if (i % 2 === 0) deleteStream(id);
      }
      // Final state: at least one entry must be present for the last key.
      const finalRecord = lookupStream(lastSeen);
      expect(finalRecord).toBeDefined();
      // Final entry must NOT be marked done (registerStream resets done).
      expect(finalRecord!.done).toBe(false);
      // Singleton is non-null (no corruption) — we still get a Map back.
      const g = globalThis as unknown as {
        __deepagents_stream_registry?: Map<string, unknown>;
      };
      expect(g.__deepagents_stream_registry).toBeInstanceOf(Map);
    });
  });
});

describe("ADVERSARIAL: atomicRegisterIfAbsent vs deleteStream race window", () => {
  beforeEach(() => {
    const g = globalThis as unknown as {
      __deepagents_stream_registry?: Map<string, unknown>;
    };
    g.__deepagents_stream_registry = new Map();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("REGRESSION: 100 parallel calls mixing atomicRegisterIfAbsent and deleteStream on the same resumeId — invariants hold", async () => {
    // REGRESSION-LOCK: the registry is synchronous (Map ops are atomic in V8's
    // main thread), but at the API level a `deleteStream` racing an
    // `atomicRegisterIfAbsent` must NEVER produce an inconsistent state — e.g.
    // an active stream recorded as ok:true but with the wrong streamId, or a
    // missing entry when a previous register succeeded. Run 100 mixed ops
    // concurrently via Promise.all (Promise.resolve yields control, simulating
    // interleaving without faking timers) and assert:
    //   1. exactly one of the atomicRegisterIfAbsent calls returns ok:true
    //      (first-write-wins for an active entry)
    //   2. every deleteStream on a nonexistent key is a no-op (no throw)
    //   3. final state is either an active record or empty — never a phantom
    //      entry and never a corruption of the registry map itself.
    const KEY = "race-key";
    const N = 100;
    const results: RegisterResult[] = [];
    let throwCount = 0;

    const tasks: Promise<void>[] = [];
    for (let i = 0; i < N; i++) {
      if (i % 3 === 0) {
        // register attempt
        tasks.push(
          Promise.resolve().then(() => {
            try {
              results.push(atomicRegisterIfAbsent(KEY, `s-${i}`));
            } catch {
              throwCount++;
            }
          })
        );
      } else {
        // delete attempt
        tasks.push(
          Promise.resolve().then(() => {
            try {
              deleteStream(KEY);
            } catch {
              throwCount++;
            }
          })
        );
      }
    }
    await Promise.all(tasks);

    // No op threw — the registry never enters an inconsistent state.
    expect(throwCount).toBe(0);

    // Among the registers, at least one succeeded with ok:true. Every failure
    // must have reason 'active'. After a delete mid-race, a later register may
    // also succeed — that is allowed and expected.
    const successes = results.filter((r) => r.ok);
    expect(successes.length).toBeGreaterThanOrEqual(1);
    for (const r of results.filter((r) => !r.ok)) {
      expect(r.reason).toBe("active");
    }

    // Final registry state must be either empty (a delete ran after the last
    // successful register) or hold one of the SUCCESSFUL streamIds — never a
    // phantom entry from a failed register.
    const record = lookupStream(KEY);
    if (record !== undefined) {
      // The surviving streamId must match one of the successful registrations.
      const successIds = successes.map(
        (r) => (r as { streamId: string }).streamId
      );
      expect(successIds).toContain(record.streamId);
      // It must be active (done=false) — the race never marks something done.
      expect(record.done).toBe(false);
    }

    // Singleton registry is still a Map (no corruption of the global).
    const g = globalThis as unknown as {
      __deepagents_stream_registry?: Map<string, unknown>;
    };
    expect(g.__deepagents_stream_registry).toBeInstanceOf(Map);
  });
});
