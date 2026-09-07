// @vitest-environment jsdom
/**
 * THE ORDERING PROPERTY, DRIVEN — the step the CI trace could not observe (#1009).
 *
 * The trace showed two requests ten milliseconds apart and a banner that never rendered. It
 * could not show WHICH RESOLVED LAST, so "the 200 landed after the 500 and erased the error"
 * was the strongest available explanation and not an observation. These cases make it one:
 * both fetches are held open and released in a chosen order, so the property under test is
 * the ordering itself rather than the symptom.
 *
 * WHY THAT DISTINCTION IS WORTH A FILE. A test that only asserted "the banner is visible"
 * would pass the moment the race stopped losing, including for reasons having nothing to do
 * with ordering -- a scheduling change, a faster mock, a different React version. It would go
 * green while the defect remained reachable on a slower network.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useRuns } from "./useRuns";

/** A fetch whose every call is held open until the test releases it, in the order it chooses. */
function deferredFetch() {
  const gates: Array<(v: Response) => void> = [];
  const impl = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        gates.push(resolve);
      })
  );
  return {
    impl: impl as unknown as typeof fetch,
    calls: () => gates.length,
    /** Release call `i` (0-based) with a status and body. */
    settle(i: number, status: number, body: unknown) {
      gates[i](
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        })
      );
    },
  };
}

/*
 * THE FIXTURE MUST SATISFY `parseRuns`, WHICH KEYS ON `run_id` AND NOT `id`. The first draft
 * used `id`; every run was silently dropped, `runs` came back empty, and the case failed for a
 * reason that had nothing to do with ordering. A fixture the parser rejects makes a test
 * measure something other than its own name -- so the accepted shape is asserted below rather
 * than assumed.
 */

/** Long enough that the interval never fires inside a test; the races here are at mount. */
const NO_INTERVAL = { pollIntervalMs: 3_600_000 };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useRuns — the last poll ISSUED wins, not the last to resolve (#1009)", () => {
  it("a 200 that resolves AFTER a 500 does not erase the outage", async () => {
    const f = deferredFetch();
    vi.stubGlobal("fetch", f.impl);

    const { result } = renderHook(() => useRuns(NO_INTERVAL));
    await waitFor(() => expect(f.calls()).toBe(1));

    // A second poll is issued while the first is still open -- the mount race, made explicit.
    result.current.refresh();
    await waitFor(() => expect(f.calls()).toBe(2));

    // The NEWER one answers 500 first, then the OLDER 200 lands.
    f.settle(1, 500, {});
    await waitFor(() => expect(result.current.error).not.toBeNull());
    f.settle(0, 200, [{ run_id: "r1", status: "running", task: "t" }]);

    /*
     * THE ASSERTION IS THAT NOTHING CHANGES, which needs a settling window or it passes
     * before the stale write would have happened. Two `waitFor` turns is enough for a
     * resolved promise's continuation to run.
     */
    await waitFor(() => expect(f.calls()).toBe(2));
    await waitFor(() => expect(f.calls()).toBe(2));

    expect(
      result.current.error,
      "the superseded 200 called setError(null) and erased a live outage"
    ).not.toBeNull();
  });

  /*
   * THE CASE ONLY THE E2E CAUGHT, BROUGHT DOWN TO THE UNIT (#1012). The first guard dropped
   * every answer a newer REQUEST had superseded, which also discarded answers nothing would
   * replace: at mount the two fetches get DIFFERENT bodies, and when the older carried the runs
   * and the newer a 500, `setRuns` never ran. The board showed an outage over an EMPTY list,
   * having been handed the runs and thrown them away. Four E2E cases reported `element(s) not
   * found` for a run that should have been on screen, and both unit arms stayed green -- so the
   * property is asserted here rather than left to an eight-minute job.
   */
  it("a poll that FAILS keeps the runs an earlier poll already delivered", async () => {
    const f = deferredFetch();
    vi.stubGlobal("fetch", f.impl);

    const { result } = renderHook(() => useRuns(NO_INTERVAL));
    await waitFor(() => expect(f.calls()).toBe(1));
    result.current.refresh();
    await waitFor(() => expect(f.calls()).toBe(2));

    // The mount order the dev server actually produces: runs first, then the failure.
    f.settle(0, 200, [{ run_id: "r1", status: "running", task: "still mine" }]);
    await waitFor(() => expect(result.current.runs).toHaveLength(1));
    f.settle(1, 500, {});
    await waitFor(() => expect(result.current.error).not.toBeNull());

    expect(
      result.current.runs.map((r) => r.run_id),
      "the board dropped the runs it had already been given"
    ).toEqual(["r1"]);
  });

  /*
   * THE SAME TWO ANSWERS, RELEASED IN THE OTHER ORDER -- and this is the one that regressed
   * open-swe-queue-polling :153 and :174 (#1012 -> #1033). The arm above settles the 200
   * before the 500 and passes; nothing covered the case where the NEWER failure resolves
   * FIRST and the older success lands after it.
   *
   * `serveSequence` hands request N response N, so at mount the first request gets the runs
   * and the second gets the 500. Whichever RESOLVES first is a race -- and when the 500 won,
   * it claimed, and the 200 that carried the only card the board would ever see was dropped
   * as superseded. `locator resolved to 0 elements`: the board was never populated at all,
   * which reads exactly like the erasure the specs were written to forbid.
   *
   * ONE TOKEN CANNOT ORDER TWO QUANTITIES. A failure carries no runs, so it must not
   * supersede a success's RUNS -- and a success carries no outage, so it must not clear an
   * error a NEWER failure reported. Those are different writers and they need different
   * high-water marks.
   */
  it("a FAILURE that resolves first does not discard an older success's runs", async () => {
    const f = deferredFetch();
    vi.stubGlobal("fetch", f.impl);

    const { result } = renderHook(() => useRuns(NO_INTERVAL));
    await waitFor(() => expect(f.calls()).toBe(1));
    result.current.refresh();
    await waitFor(() => expect(f.calls()).toBe(2));

    // The NEWER request answers 500 first; the OLDER one carrying the runs lands after it.
    f.settle(1, 500, {});
    await waitFor(() => expect(result.current.error).not.toBeNull());
    f.settle(0, 200, [{ run_id: "r1", status: "running", task: "still mine" }]);

    await waitFor(() =>
      expect(
        result.current.runs.map((r) => r.run_id),
        "the only answer that ever carried a run was dropped, so the board was never populated"
      ).toEqual(["r1"])
    );

    expect(
      result.current.error,
      "the older 200 cleared an outage a NEWER poll had reported"
    ).not.toBeNull();
  });

  it("...and the newest answer IS applied, so the guard does not simply freeze state", async () => {
    const f = deferredFetch();
    vi.stubGlobal("fetch", f.impl);

    const { result } = renderHook(() => useRuns(NO_INTERVAL));
    await waitFor(() => expect(f.calls()).toBe(1));
    result.current.refresh();
    await waitFor(() => expect(f.calls()).toBe(2));

    // Older resolves first and is stale; newest resolves last and must WIN.
    f.settle(0, 500, {});
    f.settle(1, 200, [{ run_id: "r1", status: "running", task: "kept" }]);

    /*
     * WAIT ON THE POSITIVE SIGNAL, NOT ON `error === null`. The first draft waited for the
     * error to clear -- which was ALREADY null, because the stale 500 was correctly dropped
     * and never set it. The waiter returned immediately and `runs` was read before the 200's
     * continuation had run. A wait for a state that is already true is not a wait.
     */
    await waitFor(() => expect(result.current.runs).toHaveLength(1));
    expect(result.current.runs.map((r) => r.run_id)).toEqual(["r1"]);
    expect(
      result.current.error,
      "the newest answer arrived but left an error behind"
    ).toBeNull();
  });
});
