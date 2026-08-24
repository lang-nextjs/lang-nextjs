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

describe("listRuns — 1000 sequential calls: no leaked timers, stable response shape (ported #19)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    circuitBreaker.reset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    circuitBreaker.reset();
  });

  it("1000 sequential listRuns calls settle without leaving pending timers and return identical, well-formed responses", async () => {
    // platformFetch does `new AbortController()` + setTimeout(TIMEOUT_MS) per
    // call and clears it in `finally` (langgraph-client.ts:26-31). If that
    // cleanup is ever missed, a call storm leaves pending abort timers.
    // Adapted: each listRuns is now 2 fetches — POST /threads/search, then
    // GET /threads/{id}/runs?limit=1 for the one thread returned.
    const N = 1000;
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/threads/search")) {
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

    const baselineTimers = vi.getTimerCount();

    const results: Run[][] = [];
    for (let i = 0; i < N; i++) {
      const p = listRuns("http://localhost:8000");
      await vi.runAllTimersAsync();
      results.push(await p);
    }

    // (a) no leaked abort timers after the storm
    expect(vi.getTimerCount()).toBe(baselineTimers);

    // (b) two fetches per call, and every search URL is identical
    expect(fetchMock).toHaveBeenCalledTimes(N * 2);
    for (let i = 0; i < N * 2; i += 2) {
      expect(String(fetchMock.mock.calls[i][0])).toBe(
        "http://localhost:8000/threads/search"
      );
    }

    // (c) every result is well-formed AND identical to the first — no
    //     degraded responses from accumulated state, no truncation, no drift.
    expect(results).toHaveLength(N);
    expect(results[0]).toHaveLength(1);
    expect(results[0][0].run_id).toBe("run-leak-test");
    expect(results[0][0].thread_id).toBe("thread-leak");
    expect(results[0][0].created_at).toBe("2026-06-28T00:00:00Z");
    for (let i = 0; i < N; i++) {
      expect(results[i]).toEqual(results[0]);
    }

    // (d) a fresh call after the storm still works — no corrupted module state
    const postStormP = listRuns("http://localhost:8000");
    await vi.runAllTimersAsync();
    expect(await postStormP).toEqual(results[0]);
    expect(vi.getTimerCount()).toBe(baselineTimers);
  });

  it("listRuns settles and clears its abort timer when fetch REJECTS (timer cleanup on the rejection path)", async () => {
    // apps/example ran this at N=1000. THAT SCALE IS NOT EXPRESSIBLE HERE and
    // the reason is a feature, not a gap: listRuns is wrapped in
    // circuitBreaker.execute (langgraph-client.ts:227), so consecutive
    // failures trip the breaker and later calls short-circuit without ever
    // reaching fetch — the timer path would go unexercised for most of the
    // storm. Resetting the breaker each iteration (the same idiom this file
    // already uses in beforeEach) keeps every iteration reaching platformFetch,
    // which is the code under test. Property preserved: the rejection path
    // must still hit `clearTimeout` in `finally`.
    const N = 50;
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async () => {
      throw Object.assign(new Error("upstream rejected"), {
        name: "UpstreamError",
      });
    });

    const baselineTimers = vi.getTimerCount();

    let rejected = 0;
    for (let i = 0; i < N; i++) {
      circuitBreaker.reset();
      const p = listRuns("http://localhost:8000");
      // Attach handlers BEFORE draining timers so no rejection is reported
      // unhandled while runAllTimersAsync is in flight.
      const settled = p.then(
        () => "fulfilled" as const,
        () => "rejected" as const
      );
      await vi.runAllTimersAsync();
      if ((await settled) === "rejected") rejected++;
    }

    expect(rejected).toBe(N);
    expect(fetchMock).toHaveBeenCalledTimes(N);
    // The rejection path must NOT skip clearTimeout(timeoutId) in finally.
    expect(vi.getTimerCount()).toBe(baselineTimers);
  });
});
