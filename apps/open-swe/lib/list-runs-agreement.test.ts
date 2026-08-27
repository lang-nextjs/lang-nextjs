import { describe, expect, it, vi, afterEach } from "vitest";
import { listRuns } from "./langgraph-client";

/**
 * THE BOARD AND THE DETAIL PAGE READ THE SAME SOURCE (#246, reported twice).
 *
 * #246 was fixed and the symptom came back: the same card reads "Running" on
 * the board and "idle" on its own page.
 *
 * The mapper was not at fault the second time. It never received the thread's
 * status at all, because the two surfaces ask different endpoints and only one
 * of them carries the field:
 *
 *   the board   POST /threads/search   -> { thread_id, created_at }
 *   the detail  GET  /threads/{id}     -> { status: "idle", ... }
 *
 * So `t.status` was ALWAYS undefined, the precedence rule added in #246 —
 * "a thread with no answer does not refute the run" — could never fire, and
 * the stale run record won forever.
 *
 * WHY THE EXISTING TESTS COULD NOT SEE IT, which is the part worth keeping.
 * status-mapper-agreement.test.ts calls `mapStatus("idle", "running")` and
 * asserts "idle", correctly. Production never makes that call: it makes
 * `mapStatus(undefined, "running")`. THE TEST WAS RIGHT ABOUT THE FUNCTION AND
 * WRONG ABOUT THE WORLD, and no amount of testing the mapper harder would have
 * found that — the missing coverage was one level up, at the boundary where
 * the arguments are gathered.
 *
 * These tests therefore drive `listRuns` against the WIRE SHAPES the platform
 * really returns, stubbing fetch rather than the mapper.
 */

const enc = (body: unknown, ok = true) =>
  ({
    ok,
    status: ok ? 200 : 500,
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as Response;

/**
 * A platform whose /threads/search omits `status` — which is what the local
 * stub does, and what any implementation is free to do since the field is
 * optional on that endpoint.
 */
function platform(opts: {
  searchStatus?: string;
  threadStatus?: string;
  runStatus?: string;
  threadFetchFails?: boolean;
}) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      calls.push(`${init?.method ?? "GET"} ${u.replace(/^https?:\/\/[^/]+/, "")}`);
      if (u.includes("/threads/search")) {
        return enc([
          {
            thread_id: "th-1",
            created_at: "2026-08-26T00:00:00Z",
            ...(opts.searchStatus ? { status: opts.searchStatus } : {}),
          },
        ]);
      }
      if (/\/threads\/[^/]+\/runs/.test(u)) {
        return enc([
          { run_id: "run-1", status: opts.runStatus ?? "running" },
        ]);
      }
      if (/\/threads\/[^/]+$/.test(u)) {
        if (opts.threadFetchFails) return enc({ error: "boom" }, false);
        return enc({
          status: opts.threadStatus,
          values: { messages: [{ type: "human", content: "task" }] },
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    })
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("the reported symptom, driven through listRuns", () => {
  it("A RUN RECORD SAYING running LOSES TO AN IDLE THREAD", async () => {
    // The headline, and the exact live shape: search carries no status, the
    // run record says running, the thread says idle. Before this fix the board
    // reported "running" — twenty-one of them, all day.
    platform({ threadStatus: "idle", runStatus: "running" });
    const runs = await listRuns("http://platform");
    expect(runs[0].status).toBe("idle");
  });

  it("THE THREAD IS ACTUALLY FETCHED when search omits its status", async () => {
    // Asserted on the CALL, not the result. A mapper that happened to return
    // "idle" for another reason would satisfy the case above while the board
    // still never asked the endpoint that knows.
    const calls = platform({ threadStatus: "idle", runStatus: "running" });
    await listRuns("http://platform");
    expect(calls).toContain("GET /threads/th-1");
  });

  it("and it is NOT fetched when search already carries the status", async () => {
    // The pair. Fetching unconditionally would be a second N+1 against every
    // platform that answers properly — a real cost, paid on every poll.
    const calls = platform({
      searchStatus: "idle",
      threadStatus: "idle",
      runStatus: "running",
    });
    await listRuns("http://platform");
    expect(calls.filter((c) => c === "GET /threads/th-1")).toEqual([]);
  });
});

describe("the run record still wins where it is the only witness", () => {
  it("a TERMINAL run record beats an idle thread", async () => {
    // The asymmetry from #246, preserved end to end: a thread that failed an
    // hour ago and one that never started both read `idle`, so the record is
    // the only place the difference survives.
    platform({ threadStatus: "idle", runStatus: "success" });
    expect((await listRuns("http://platform"))[0].status).toBe("completed");

    platform({ threadStatus: "idle", runStatus: "error" });
    expect((await listRuns("http://platform"))[0].status).toBe("failed");
  });

  it("an UNREADABLE thread leaves the run record standing", async () => {
    // Degrades to the previous behaviour rather than inventing a new failure.
    // A platform we cannot reach is not evidence that a run stopped.
    platform({ runStatus: "running", threadFetchFails: true });
    expect((await listRuns("http://platform"))[0].status).toBe("running");
  });

  it("a thread reporting busy is still running", async () => {
    platform({ threadStatus: "busy", runStatus: "running" });
    expect((await listRuns("http://platform"))[0].status).toBe("running");
  });

  it("INTERRUPTED reaches the board — the needs-approval column, end to end", async () => {
    // Both halves of #246 plus this fix are required for this one line: the
    // type must hold it, the thread must outrank the record, AND the thread's
    // status has to be fetched at all.
    platform({ threadStatus: "interrupted", runStatus: "running" });
    expect((await listRuns("http://platform"))[0].status).toBe("interrupted");
  });
});

describe("what the board reports is what the detail page would", () => {
  it("agrees with the thread across every status the platform emits", async () => {
    // The property the whole issue is about, asserted as a property rather
    // than case by case. For any non-terminal run record, the board must say
    // what the thread says — because that is what the detail page will say.
    const expected: Record<string, string> = {
      idle: "idle",
      busy: "running",
      interrupted: "interrupted",
      error: "failed",
      success: "completed",
      pending: "pending",
    };
    for (const [threadStatus, want] of Object.entries(expected)) {
      platform({ threadStatus, runStatus: "running" });
      const got = (await listRuns("http://platform"))[0].status;
      expect(got, `thread said ${threadStatus}`).toBe(want);
      vi.unstubAllGlobals();
    }
  });
});
