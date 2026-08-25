import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Run } from "./types";
import {
  createRun,
  listRuns,
  getRun,
  cancelRun,
  getThreadState,
  circuitBreaker,
  CircuitOpenError,
} from "./langgraph-client";

describe("createRun", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("creates a thread then a run, returning both ids", async () => {
    // createRun is two-step: POST /threads, then POST /threads/{id}/runs.
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ thread_id: "thread-1" }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            run_id: "run-abc",
            thread_id: "thread-1",
            status: "pending",
            created_at: "2026-05-04T00:00:00Z",
          }),
          { status: 200 }
        )
      );

    const result = await createRun(
      { task: "echo hello" },
      "http://localhost:8000"
    );
    expect(result.run_id).toBe("run-abc");
    expect(result.thread_id).toBe("thread-1");
    expect(result.status).toBe("pending");
    // Run is created on the thread, with the task as a user message.
    const runCall = vi.mocked(fetch).mock.calls[1];
    expect(runCall[0]).toBe("http://localhost:8000/threads/thread-1/runs");
    const body = JSON.parse((runCall[1] as RequestInit).body as string);
    expect(body.input.messages[0]).toEqual({
      role: "user",
      content: "echo hello",
    });
  });

  it("throws PlatformError when Platform returns 5xx", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("Internal Server Error", { status: 500 })
    );
    await expect(
      createRun({ task: "echo hello" }, "http://localhost:8000")
    ).rejects.toThrow();
  });

  it("throws on timeout (AbortError)", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(
      Object.assign(new Error("aborted"), { name: "AbortError" })
    );
    await expect(
      createRun({ task: "echo hello" }, "http://localhost:8000")
    ).rejects.toThrow();
  });
});

describe("listRuns", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("maps threads (and their latest run) into dashboard runs", async () => {
    // listRuns is two-step: POST /threads/search, then GET the latest run per
    // thread. It maps thread state → {run_id, thread_id, status, task}.
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              thread_id: "th-1",
              created_at: "2026-05-04T00:00:00Z",
              status: "idle",
              values: {
                messages: [{ type: "human", content: "echo hello" }],
              },
            },
          ]),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([{ run_id: "run-abc", status: "success" }]),
          { status: 200 }
        )
      );

    const result = await listRuns("http://localhost:8000");
    expect(Array.isArray(result)).toBe(true);
    expect(result[0]).toMatchObject({
      run_id: "run-abc",
      thread_id: "th-1",
      status: "completed",
      task: "echo hello",
    });
    // First call is the thread search.
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(
      "http://localhost:8000/threads/search"
    );
  });

  it("throws PlatformError when Platform returns 5xx", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("Internal Server Error", { status: 500 })
    );
    await expect(listRuns("http://localhost:8000")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// ADVERSARIAL: getRun, cancelRun, env injection, runId encoding, singleton
// pollution from the module-level circuitBreaker.
// ---------------------------------------------------------------------------

describe("ADVERSARIAL — getRun / cancelRun / encoding / env / singleton", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    // CRITICAL: reset the shared circuit breaker so cross-test failure-count
    // pollution from neighbouring tests does not leak into these assertions.
    circuitBreaker.reset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    circuitBreaker.reset();
  });

  // ---------------------------------------------------------------------
  // Gap 1: getRun has ZERO direct test coverage.
  // Verify the URL path (/runs/{runId}) and HTTP method (GET) the handler
  // emits. If the impl ever drifts to /api/runs/{id} or POST this test fails.
  // ---------------------------------------------------------------------
  it("getRun sends GET to /runs/{runId} and returns parsed Run", async () => {
    const mockRun: Run = {
      run_id: "run-xyz",
      status: "running",
      created_at: "2026-05-04T00:00:00Z",
      task: "do thing",
    };
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(mockRun), { status: 200 })
    );
    const result = await getRun("run-xyz", "http://localhost:8000");
    expect(result.run_id).toBe("run-xyz");
    const call = vi.mocked(fetch).mock.calls[0];
    expect(call[0]).toBe("http://localhost:8000/runs/run-xyz");
    expect((call[1] as RequestInit).method).toBe("GET");
  });

  // ---------------------------------------------------------------------
  // Gap 2: cancelRun has ZERO direct test coverage. Verify the URL path
  // (/runs/{id}/cancel) and method (POST). A regression to /runs/{id} (DELETE)
  // would silently break cancel UX.
  // ---------------------------------------------------------------------
  it("cancelRun sends POST to /runs/{runId}/cancel and returns the updated Run", async () => {
    const cancelledRun: Run = {
      run_id: "run-c1",
      status: "failed",
      created_at: "2026-05-04T00:00:00Z",
      task: "abandoned",
    };
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(cancelledRun), { status: 200 })
    );
    const result = await cancelRun("run-c1", "http://localhost:8000");
    expect(result.status).toBe("failed");
    const call = vi.mocked(fetch).mock.calls[0];
    expect(call[0]).toBe("http://localhost:8000/runs/run-c1/cancel");
    expect((call[1] as RequestInit).method).toBe("POST");
  });

  // ---------------------------------------------------------------------
  // Gap 3: runId encoding. getRun/cancelRun interpolate runId into the path.
  // The current impl uses encodeURIComponent, but if anyone ever drops it
  // (or replaces with encodeURI), a runId containing "/" or ".." would
  // produce a path-traversal-shaped URL like "/runs/foo/../bar" — at best
  // hits a wrong endpoint, at worst returns the wrong run's data.
  // ---------------------------------------------------------------------
  it("getRun percent-encodes runIds containing '/' (no path traversal in URL)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 })
    );
    await getRun("../evil", "http://localhost:8000").catch(() => undefined);
    const url = vi.mocked(fetch).mock.calls[0][0] as string;
    // The '/' in '../evil' must be percent-encoded — otherwise the URL
    // contains an unexpected path segment.
    expect(url).toBe("http://localhost:8000/runs/..%2Fevil");
    expect(url).not.toContain("/runs/../");
  });

  it("cancelRun percent-encodes runIds containing reserved characters", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 })
    );
    // Space, '#', '?' and '/' are all reserved/special in URLs.
    await cancelRun("a b#c?d/e", "http://localhost:8000").catch(
      () => undefined
    );
    const url = vi.mocked(fetch).mock.calls[0][0] as string;
    // All four must be encoded; the path must still end with /cancel.
    expect(url).toBe("http://localhost:8000/runs/a%20b%23c%3Fd%2Fe/cancel");
    expect(url.endsWith("/cancel")).toBe(true);
  });

  // ---------------------------------------------------------------------
  // Gap 4: LANGGRAPH_API_KEY env injection. When set, makeHeaders MUST add
  // X-Api-Key. When unset, the header MUST be absent (sending an empty
  // X-Api-Key would be a silent auth misconfiguration).
  // ---------------------------------------------------------------------
  it("createRun sets X-Api-Key header when LANGGRAPH_API_KEY env is set", async () => {
    vi.stubEnv("LANGGRAPH_API_KEY", "sekret-token");
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 201 })
    );
    await createRun({ task: "x" }, "http://localhost:8000").catch(
      () => undefined
    );
    const init = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Api-Key"]).toBe("sekret-token");
  });

  it("createRun omits X-Api-Key entirely when LANGGRAPH_API_KEY is unset", async () => {
    vi.stubEnv("LANGGRAPH_API_KEY", "");
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 201 })
    );
    await createRun({ task: "x" }, "http://localhost:8000").catch(
      () => undefined
    );
    const init = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    // The key must be entirely absent — an empty-string X-Api-Key would be
    // a malformed header sent to the platform.
    expect(headers["X-Api-Key"]).toBeUndefined();
    expect("X-Api-Key" in headers).toBe(false);
  });

  // ---------------------------------------------------------------------
  // Gap 5: OPEN_SWE_ASSISTANT_ID env override. The current impl defaults to
  // "open-swe", but if an operator sets a custom assistant id the body's
  // assistant_id field MUST reflect it. A regression that hard-codes
  // "open-swe" silently breaks multi-tenant deployments.
  // ---------------------------------------------------------------------
  it("createRun uses OPEN_SWE_ASSISTANT_ID env value as assistant_id when set", async () => {
    vi.stubEnv("OPEN_SWE_ASSISTANT_ID", "custom-assistant");
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ thread_id: "t1" }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ run_id: "r1", thread_id: "t1" }), {
          status: 200,
        })
      );
    await createRun({ task: "x" }, "http://localhost:8000").catch(
      () => undefined
    );
    // assistant_id + messages input live on the run-create call (calls[1]).
    const init = vi.mocked(fetch).mock.calls[1][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.assistant_id).toBe("custom-assistant");
    expect(body.input).toEqual({ messages: [{ role: "user", content: "x" }] });
  });

  // ---------------------------------------------------------------------
  // Gap 6: createRun/listRuns/getRun/cancelRun share a module-level
  // CircuitBreaker singleton. After 5 consecutive failures it opens and
  // every subsequent call throws CircuitOpenError instead of PlatformError.
  // This is invisible to callers that only catch PlatformError and silently
  // hides the root failure. Pin the singleton behaviour so any change
  // (per-call breaker, raised threshold, etc.) is a deliberate decision.
  // ---------------------------------------------------------------------
  it("module-level circuitBreaker opens after 5 consecutive 5xx failures and subsequent calls throw CircuitOpenError (not PlatformError)", async () => {
    // 5 PlatformError-producing responses to drive the breaker to OPEN.
    for (let i = 0; i < 5; i++) {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response("boom", { status: 500 })
      );
    }
    for (let i = 0; i < 5; i++) {
      await expect(
        createRun({ task: `t${i}` }, "http://localhost:8000")
      ).rejects.toThrow();
    }

    // The 6th call must short-circuit with CircuitOpenError — fetch is never
    // invoked. If a future refactor isolates breakers per function or raises
    // the threshold, this assertion catches the change immediately.
    vi.mocked(fetch).mockClear();
    await expect(
      createRun({ task: "after-open" }, "http://localhost:8000")
    ).rejects.toThrow(CircuitOpenError);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();

    // CRITICAL: cross-function leakage. listRuns shares the same breaker, so
    // it must also fail-fast (no fetch call). If the breaker is ever scoped
    // per-function the singleton invariant is broken — and this assertion
    // fails.
    await expect(listRuns("http://localhost:8000")).rejects.toThrow(
      CircuitOpenError
    );
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ADVERSARIAL: getThreadState edge cases — thread with empty/missing messages.
// ---------------------------------------------------------------------------

describe("ADVERSARIAL — getThreadState with thread having empty messages array", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    circuitBreaker.reset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    circuitBreaker.reset();
  });

  it("returns the thread state verbatim when values.messages is an empty array (no crash)", async () => {
    // The langgraph platform returns {values:{messages:[]}} for a thread that
    // was created but has not received any human turn yet (race during
    // listing). getThreadState must NOT throw — callers render the run page
    // for completed threads and an empty messages list is valid.
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          thread_id: "th-empty",
          status: "idle",
          values: { messages: [] },
        }),
        { status: 200 }
      )
    );

    const result = await getThreadState("th-empty", "http://localhost:8000");
    expect(result.status).toBe("idle");
    expect(Array.isArray(result.values?.messages)).toBe(true);
    expect(result.values?.messages).toHaveLength(0);

    // The URL must be percent-encoded (threadId has no special chars here,
    // but the encode must happen regardless).
    const url = vi.mocked(fetch).mock.calls[0][0] as string;
    expect(url).toBe("http://localhost:8000/threads/th-empty");
  });

  it("accepts values missing entirely (values: undefined) — destructuring must not throw", async () => {
    // Some platform builds omit `values` when no checkpoint has run yet. The
    // implementation must not index into result.values.messages unconditionally.
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({ thread_id: "th-no-values", status: "idle" }),
        { status: 200 }
      )
    );

    // DESIGNED TO FAIL if the implementation does not guard for missing values.
    const result = await getThreadState(
      "th-no-values",
      "http://localhost:8000"
    );
    expect(result.status).toBe("idle");
    expect(result.values).toBeUndefined();
  });

  it("percent-encodes threadId containing '/' and '?' (path injection guard)", async () => {
    // threadId "../evil?injected=true" without encoding would produce
    // /threads/../evil?injected=true — at best a 404, at worst reads the wrong
    // thread. The implementation must encode these characters.
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ thread_id: "x", status: "idle" }), {
        status: 200,
      })
    );
    await getThreadState("../evil?x=1", "http://localhost:8000").catch(
      () => undefined
    );
    const url = vi.mocked(fetch).mock.calls[0][0] as string;
    // The '/' and '?' must be percent-encoded so the path doesn't get a
    // query string or a traversal segment.
    expect(url).not.toContain("/threads/../");
    expect(url).not.toContain("?");
    expect(url).toBe("http://localhost:8000/threads/..%2Fevil%3Fx%3D1");
  });
});

// ---------------------------------------------------------------------------
// Ported from apps/example/lib/langgraph-client.test.ts (#19).
// apps/example embedded a duplicate open-swe rung, deleted in PR #29.
//
// All three needed protocol adaptation — apps/example's client spoke a flat
// POST/GET /runs collection; this one is thread-scoped. The PROPERTY asserted
// is unchanged in each case; only the request/response fixtures moved. Three
// further example-only cases were DROPPED rather than ported because their
// assertions were about the /runs shape itself — see the #19 drop list.
// ---------------------------------------------------------------------------
describe("createRun — 10KB unicode task payload (ported #19)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    circuitBreaker.reset();
  });

  afterEach(() => {
    circuitBreaker.reset();
  });

  it("serializes a 10,240-character unicode task without truncation or JSON parse failure and preserves every byte", async () => {
    // Pins the exact upstream payload so any future truncation, lowercasing
    // or NFC normalisation is observable. Adapted: this client is two-step
    // (POST /threads, then POST /threads/{id}/runs) and nests the task at
    // input.messages[0].content rather than input.task.
    const block = "🚀أبجد中文café👨‍👩‍👧‍👦﻿Ω";
    const base = block.repeat(80);
    const task = base + "中".repeat(10_000 - base.length);
    expect(task.length).toBe(10_000);

    const fetchSpy = vi
      .mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ thread_id: "thread-unicode" }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            run_id: "run-unicode",
            thread_id: "thread-unicode",
            status: "pending",
            created_at: "2026-06-28T00:00:00Z",
            task,
          }),
          { status: 200 }
        )
      );

    const result = await createRun({ task }, "http://localhost:8000");
    expect(result.run_id).toBe("run-unicode");

    // Two-step: thread creation, then the run carrying the task.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const runInit = fetchSpy.mock.calls[1][1] as RequestInit;
    const parsed = JSON.parse(String(runInit.body)) as {
      assistant_id: string;
      input: { messages: Array<{ role: string; content: string }> };
    };
    expect(parsed.input.messages[0].content.length).toBe(task.length);
    expect(parsed.input.messages[0].content).toBe(task);
  });
});

describe("listRuns — abort timers are always cleared (ported #19, made deterministic #166)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    circuitBreaker.reset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    circuitBreaker.reset();
  });

  /*
   * WHY THIS NO LONGER RUNS 1000 ITERATIONS (#166).
   *
   * The old version drove N=1000 and asserted the timer count once at the end.
   * It carried no explicit budget — the 5s was vitest's DEFAULT per-test
   * timeout — but 1000 real async drains exceed it whenever the machine is
   * busy, so the test reported the runner's load. Four agents attributed that
   * to their own branches, and one of them (me) concluded main was broken.
   *
   * The scale was never doing the work. The property is "every abort timer
   * platformFetch opens gets cleared", and that is a PER-CALL property: a leak
   * on any single call is observable immediately. Checking after every
   * iteration is strictly STRONGER than checking once after a thousand —
   * end-only can be satisfied by a leak that some later call happens to
   * cancel out, and it reports "call #713 leaked" as a number that is merely
   * wrong at the end.
   *
   * So: fewer iterations, an assertion after each one, and no dependence on
   * how fast the machine happens to be. Raising the timeout was rejected
   * deliberately — it converts a frequent honest failure into a rare
   * mysterious one.
   */
  const N = 5;
  const PLATFORM = "http://localhost:8000";

  it("clears the abort timer on EVERY call, and returns a stable shape", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).includes("/threads/search")) {
        return new Response(
          JSON.stringify([
            {
              thread_id: "thread-leak",
              status: "idle",
              created_at: "2026-06-28T00:00:00Z",
              values: {},
            },
          ]),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify([{ run_id: "run-leak-test", status: "success" }]),
        { status: 200 }
      );
    });

    const baseline = vi.getTimerCount();
    const results: Run[][] = [];

    for (let i = 0; i < N; i++) {
      // NOTE: no runAllTimersAsync() here, and that is the whole point (#166).
      // Draining RUNS the abort timer, so the count returns to baseline whether
      // or not clearTimeout was called — which made the previous assertion
      // incapable of failing. The mocked fetch settles on a microtask, so the
      // call completes without any timer needing to fire.
      results.push(await listRuns(PLATFORM));
      expect(vi.getTimerCount(), `pending timers after call #${i + 1}`).toBe(
        baseline
      );
    }

    // Two fetches per call — POST /threads/search, then the per-thread runs —
    // and every search hits the same URL.
    expect(fetchMock).toHaveBeenCalledTimes(N * 2);
    for (let i = 0; i < N * 2; i += 2) {
      expect(String(fetchMock.mock.calls[i][0])).toBe(
        `${PLATFORM}/threads/search`
      );
    }

    // Shape is stable across calls: no degradation from accumulated state.
    expect(results).toHaveLength(N);
    expect(results[0]).toHaveLength(1);
    expect(results[0][0].run_id).toBe("run-leak-test");
    expect(results[0][0].thread_id).toBe("thread-leak");
    expect(results[0][0].created_at).toBe("2026-06-28T00:00:00Z");
    for (let i = 1; i < N; i++) expect(results[i]).toEqual(results[0]);
  });

  it("clears the abort timer on EVERY call when fetch REJECTS", async () => {
    // The rejection path must still reach `clearTimeout` in `finally`.
    //
    // circuitBreaker.reset() per iteration is deliberate: listRuns is wrapped
    // in circuitBreaker.execute, so consecutive failures would trip the
    // breaker and later calls would short-circuit without ever reaching
    // platformFetch — leaving the code under test unexercised.
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async () => {
      throw Object.assign(new Error("upstream rejected"), {
        name: "UpstreamError",
      });
    });

    const baseline = vi.getTimerCount();
    let rejected = 0;

    for (let i = 0; i < N; i++) {
      circuitBreaker.reset();
      // Same as above: settle on the microtask queue, never drain, so an
      // uncleared abort timer is still pending and therefore visible.
      const outcome = await listRuns(PLATFORM).then(
        () => "fulfilled" as const,
        () => "rejected" as const
      );
      if (outcome === "rejected") rejected++;
      expect(
        vi.getTimerCount(),
        `pending timers after rejected call #${i + 1}`
      ).toBe(baseline);
    }

    // The POSITIVE claim: every call really did reject and really did reach
    // fetch. Asserting only the timer count would pass if the circuit had
    // short-circuited them all and platformFetch never ran.
    expect(rejected).toBe(N);
    expect(fetchMock).toHaveBeenCalledTimes(N);
  });
});
