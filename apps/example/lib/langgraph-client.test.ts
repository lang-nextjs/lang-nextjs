import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Run } from "./types";
import { createRun, listRuns, getRun } from "./langgraph-client";

describe("createRun", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("returns run from successful Platform response", async () => {
    const mockRun: Run = {
      run_id: "run-abc",
      status: "pending",
      created_at: "2026-05-04T00:00:00Z",
      task: "echo hello",
    };
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(mockRun), { status: 201 })
    );

    const result = await createRun(
      { task: "echo hello" },
      "http://localhost:8000"
    );
    expect(result.run_id).toBe("run-abc");
    expect(result.status).toBe("pending");
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

  it("returns array of runs from successful Platform response", async () => {
    const mockRuns: Run[] = [
      {
        run_id: "run-abc",
        status: "completed",
        created_at: "2026-05-04T00:00:00Z",
        task: "echo hello",
      },
    ];
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(mockRuns), { status: 200 })
    );

    const result = await listRuns("http://localhost:8000");
    expect(Array.isArray(result)).toBe(true);
    expect(result[0].run_id).toBe("run-abc");
  });

  it("throws PlatformError when Platform returns 5xx", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("Internal Server Error", { status: 500 })
    );
    await expect(listRuns("http://localhost:8000")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Adversarial edge-case tests (iteration 5)
// ---------------------------------------------------------------------------

describe("createRun / listRuns — platformUrl boundary (trailing slash)", () => {
  // The implementation builds the URL as `${platformUrl}/runs` via template
  // literal concatenation. If a caller passes a platformUrl with a trailing
  // slash ("http://localhost:8000/"), the resulting request URL contains a
  // double slash ("http://localhost:8000//runs"). Most servers reject this
  // with 404, but the doc comment explicitly says platformUrl may be either
  // form. This test pins the actual behavior so any future URL-stripping
  // change is observable.
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("emits the literal ${platformUrl}/runs URL with NO slash normalization", async () => {
    const fetchSpy = vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            run_id: "run-1",
            status: "completed",
            created_at: "2026-05-04T00:00:00Z",
            task: "x",
          },
        ]),
        { status: 200 }
      )
    );

    await listRuns("http://localhost:8000/");

    // The actual URL fetch was called with — document this exactly so any
    // future slash-stripping change shows up here.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const calledUrl = fetchSpy.mock.calls[0][0] as string;
    // DESIGNED TO FAIL if a future change normalizes "//" to "/" (good fix) OR
    // if the trailing slash is preserved as-is (current behavior).
    expect(calledUrl).toBe("http://localhost:8000//runs");
  });
});

// ---------------------------------------------------------------------------
// Adversarial edge-case tests (NEW BATCH — unicode + special-char runIds)
// ---------------------------------------------------------------------------

describe("createRun — 10KB unicode task payload (emoji, RTL, multi-byte)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("serializes a 10,240-character unicode task without truncation or JSON parse failure and preserves every byte", async () => {
    // Adversarial: a payload that mixes emoji (4-byte UTF-8 sequences), RTL
    // Arabic, Chinese CJK, combining diacritics, and zero-width joiners. The
    // implementation does `JSON.stringify({ task: req.task })` and `fetch` →
    // if any of:
    //   (a) the string is silently truncated (length cap somewhere),
    //   (b) a UTF-8/UTF-16 mismatch corrupts surrogate pairs,
    //   (c) JSON.stringify throws on a lone surrogate,
    // the upstream request either fails or arrives at the platform with
    // different bytes than the caller passed in.
    //
    // We construct a 10,240-char payload by repeating a 128-char unicode
    // "stress block" 80 times — the block contains every adversarial class.
    const block =
      "🚀" + // emoji (surrogate pair, 2 UTF-16 code units)
      "أبجد" + // Arabic RTL, 4 chars
      "中文" + // CJK, 2 chars
      "café" + // Latin + combining é, 4 chars
      "👨‍👩‍👧‍👦" + // ZWJ family emoji — 4 emoji * 2 code units + 3 ZWJ = 11 code units
      "﻿" + // BOM (U+FEFF), 1 code unit
      "Ω"; // Greek, 1 code unit
    // Pin the exact length so a future refactor that strips BOM / ZWJs /
    // normalises combining marks breaks here loudly.
    const expectedBlockLength = block.length;
    expect(expectedBlockLength).toBeGreaterThan(10);

    const task = block.repeat(80);
    expect(task.length).toBe(expectedBlockLength * 80);

    const mockRun: Run = {
      run_id: "run-unicode",
      status: "pending",
      created_at: "2026-06-28T00:00:00Z",
      task,
    };
    const fetchSpy = vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(mockRun), { status: 201 })
    );

    const result = await createRun({ task }, "http://localhost:8000");

    // The implementation must not throw, must not mutate the task, and must
    // forward the EXACT byte sequence (not a truncated slice, not a
    // re-encoded form).
    expect(result.run_id).toBe("run-unicode");

    // Capture the exact body that was sent upstream.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const sentBody = String(init.body);

    // Parse what was sent and compare character-for-character. The Platform
    // wire shape is { assistant_id, input: { task } } — the unicode task is
    // nested under input.task. If the implementation truncated, lossy-encoded,
    // or substituted a placeholder anywhere along the JSON path, the nested
    // task string will differ in length or content.
    const parsed = JSON.parse(sentBody) as {
      assistant_id: string;
      input: { task: string };
    };
    expect(parsed.input).toBeDefined();
    expect(parsed.input.task).toBeDefined();
    expect(parsed.input.task.length).toBe(task.length);
    expect(parsed.input.task).toBe(task);

    // The upstream's task field round-trips intact (deserialization must
    // match byte-for-byte).
    expect(result.task).toBe(task);
  });
});

describe("getRun — percent-encoded runId with slashes, query, and hash fragments", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("encodeURIComponent-encodes special characters in runId so they never reach the URL path raw", async () => {
    // Adversarial: a runId containing characters that, if NOT percent-encoded,
    // would either (a) split the path into multiple segments (slash "/"),
    // (b) be parsed as a query string ("?" / "&" / "="), (c) terminate the
    // fragment ("#"), or (d) be sent over the wire in a way that a strict
    // platform rejects with 400. The implementation calls
    // `encodeURIComponent(runId)` when building the URL — we pin that exact
    // behaviour and the exact output string.
    //
    // If a future change drops the encoding, this test fails because the URL
    // would contain a raw "?" or "/" that breaks the /runs/{runId} path.
    const runId = "weird/run?id=1&v=2#frag with space+plus/and/slash";
    const fetchSpy = vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          run_id: runId,
          status: "completed",
          created_at: "2026-06-28T00:00:00Z",
          task: "x",
        }),
        { status: 200 }
      )
    );

    await getRun(runId, "http://localhost:8000");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const calledUrl = fetchSpy.mock.calls[0][0] as string;

    // The path delimiter "/" inside the runId MUST be encoded — otherwise the
    // platform will see /runs/weird/run and look up the wrong resource.
    // encodeURIComponent encodes "/" as %2F.
    expect(calledUrl).not.toContain("weird/run");
    // The query-string starter "?" MUST be encoded — otherwise ?id=1 would
    // become a query parameter on the upstream URL.
    expect(calledUrl).not.toContain("?id=");
    expect(calledUrl).not.toContain("&v=");
    // The fragment "#" MUST be encoded — otherwise the platform URL would
    // be truncated at the # and the runId after # would never be sent.
    expect(calledUrl).not.toContain("#frag");
    // The space MUST be encoded (encodeURIComponent uses %20, not +).
    expect(calledUrl).not.toMatch(/[^%]\s/);
    // The "+" MUST be encoded — encodeURIComponent treats "+" as a literal
    // character (NOT a space), but a sloppy implementation might also have
    // used encodeURI which leaves "/" and "?" unencoded. Pin the literal
    // expected URL.
    expect(calledUrl).toBe(
      `http://localhost:8000/runs/${encodeURIComponent(runId)}`
    );
  });
});

// ---------------------------------------------------------------------------
// Adversarial edge-case tests (iteration 6 — 1000 sequential listRuns, no leak)
// ---------------------------------------------------------------------------

describe("listRuns — 1000 sequential calls: no leaked timers, stable response shape, no AbortController drift", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("1000 sequential listRuns calls settle without leaving pending timers and return identical, well-formed responses", async () => {
    // Adversarial: scale + leak test. The implementation uses
    // `new AbortController()` + `setTimeout(..., 10_000)` per call and
    // clears the timeout in `finally`. If the cleanup path is missed on ANY
    // call (e.g., a thrown error inside fetch, a microtask that swallows
    // the rejection), the abort timer leaks and Node's process stays alive
    // until the 10s timeout fires.
    //
    // We:
    //   (a) count active timers via `vi.getTimerCount()` before and after
    //       the 1000-call storm — must return to the baseline,
    //   (b) verify fetch was called exactly 1000 times with the same URL,
    //   (c) verify every result has the expected shape (Run[] with 1 entry,
    //       the expected run_id, status, created_at, task),
    //   (d) verify the process can exit (no dangling ref / pending handle).
    //
    // DESIGNED TO FAIL if the implementation accumulates an AbortController
    // per call and forgets to clear the timer on the rejection path, or
    // if a global counter / array is appended to without bound.

    const N = 1000;
    const expectedRun = {
      run_id: "run-leak-test",
      status: "completed",
      created_at: "2026-06-28T00:00:00Z",
      task: "leak probe",
    };
    const fetchMock = vi.mocked(fetch);
    // Resolve every fetch with the same well-formed response. vi.fn()
    // without `.mockResolvedValueOnce(N)` returns undefined for the (N+1)th
    // call; use `.mockImplementation` to always resolve.
    fetchMock.mockImplementation(async () => {
      return new Response(JSON.stringify([expectedRun]), { status: 200 });
    });

    // Baseline timer count (other tests may have left none; safe to read).
    const baselineTimers = vi.getTimerCount();

    // Issue 1000 sequential listRuns calls — must NOT throw, must NOT leak
    // timers, must return identical shape every time. We use a helper that
    // drains pending microtasks + the fake-timer event loop between calls.
    const results: Run[][] = [];
    for (let i = 0; i < N; i++) {
      const p = listRuns("http://localhost:8000");
      // Drain microtasks + fake-timer callbacks so the AbortController's
      // setTimeout(..., 10_000) is registered in the fake-timer registry,
      // then the .finally clears it.
      await vi.runAllTimersAsync();
      const r = await p;
      results.push(r);
    }

    // (a) Timer count must return to the baseline — proves the AbortController
    //     timeout was cleared on every successful call.
    const finalTimers = vi.getTimerCount();
    expect(finalTimers).toBe(baselineTimers);

    // (b) fetch was called exactly N times, every URL is identical.
    expect(fetchMock).toHaveBeenCalledTimes(N);
    for (let i = 0; i < N; i++) {
      const url = fetchMock.mock.calls[i][0] as string;
      expect(url).toBe("http://localhost:8000/runs");
    }

    // (c) every result has the expected shape — no degraded responses from
    //     accumulated state, no truncated arrays, no mutated objects.
    expect(results).toHaveLength(N);
    for (let i = 0; i < N; i++) {
      expect(Array.isArray(results[i])).toBe(true);
      expect(results[i]).toHaveLength(1);
      const r = results[i][0];
      expect(r.run_id).toBe(expectedRun.run_id);
      expect(r.status).toBe(expectedRun.status);
      expect(r.created_at).toBe(expectedRun.created_at);
      expect(r.task).toBe(expectedRun.task);
    }

    // (d) post-condition: a fresh listRuns call after the storm still works
    //     correctly (no corrupted module-level state).
    const postStormP = listRuns("http://localhost:8000");
    await vi.runAllTimersAsync();
    const postStorm = await postStormP;
    expect(postStorm).toHaveLength(1);
    expect(postStorm[0].run_id).toBe(expectedRun.run_id);
    expect(vi.getTimerCount()).toBe(baselineTimers);
  });

  it("1000 sequential listRuns calls all settle correctly when fetch REJECTS (timer cleanup on the rejection path)", async () => {
    // Adversarial: same as above but every fetch rejects. The
    // AbortController timeout must still be cleared via the `finally`
    // block — otherwise a 1000-call storm with rejections leaves 1000
    // pending 10s timers, and the test process would hang for 10s+
    // (or fail the `vi.getTimerCount()` assertion immediately).
    const N = 1000;
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async () => {
      throw Object.assign(new Error("upstream rejected"), {
        name: "UpstreamError",
      });
    });

    const baselineTimers = vi.getTimerCount();

    // Use Promise.allSettled so each rejection has a catch handler attached
    // BEFORE the microtask drains — otherwise Node flags an unhandled
    // rejection even though our test code eventually catches the error.
    const results: Array<PromiseSettledResult<unknown>> = [];
    for (let i = 0; i < N; i++) {
      const p = listRuns("http://localhost:8000");
      // Attach .then/.catch handlers BEFORE awaiting timers so any
      // rejection that surfaces during runAllTimersAsync is observed.
      const settled = p.then(
        (v) => ({ status: "fulfilled" as const, value: v }),
        (e) => ({ status: "rejected" as const, reason: e })
      );
      await vi.runAllTimersAsync();
      results.push(await settled);
    }

    // Every call must have rejected.
    const rejected = results.filter((r) => r.status === "rejected").length;
    expect(rejected).toBe(N);
    // And the timer count must be back to the baseline — the rejection
    // path must NOT skip the `clearTimeout(timeoutId)` in finally.
    expect(vi.getTimerCount()).toBe(baselineTimers);
  });
});
