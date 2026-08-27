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
  runTask?: string;
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
          {
            run_id: "run-1",
            status: opts.runStatus ?? "running",
            ...(opts.runTask ? { task: opts.runTask } : {}),
          },
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

  it("and it is NOT fetched when NOTHING still needs it", async () => {
    // The pair. Fetching unconditionally would be a second N+1 against every
    // platform that answers properly — a real cost, paid on every poll.
    //
    // THERE ARE TWO REASONS TO FETCH, and this case must satisfy both or it
    // asserts nothing about the one it names. It originally supplied only the
    // status and broke when the task fallback was added — correctly: with no
    // run task and no values, the thread was genuinely the only source left.
    const calls = platform({
      searchStatus: "idle",
      threadStatus: "idle",
      runStatus: "running",
      runTask: "already known",
    });
    await listRuns("http://platform");
    expect(calls.filter((c) => c === "GET /threads/th-1")).toEqual([]);
  });

  it("IS fetched when the task is unknown, even if the status is not", async () => {
    // The other half of that contract, stated so the skip cannot widen into
    // "never fetch" and quietly bring back "Untitled task" on every card.
    const calls = platform({ searchStatus: "idle", threadStatus: "idle" });
    await listRuns("http://platform");
    expect(calls).toContain("GET /threads/th-1");
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

/**
 * EVERY CARD READ "Untitled task", AND THE TEXT WAS NEVER MISSING.
 *
 * `taskFromValues` reads a thread's first human message out of `values` — and
 * `/threads/search`, which is what the board lists from, does not return
 * `values`. So the fallback fired for every run on the board while the text
 * sat in two other places:
 *
 *   the RUN record      task, exactly as submitted
 *   GET /threads/{id}   values.messages[0], the human turn
 *   /threads/search     neither
 *
 * Same shape as the status bug this file was written for: the board asks an
 * endpoint that does not carry the field, and renders the fallback as though
 * it were an answer.
 */
describe("the task a card shows", () => {
  function platformWithTask(opts: {
    searchValues?: unknown;
    runTask?: string;
    threadValues?: unknown;
  }) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/threads/search")) {
          return enc([
            {
              thread_id: "th-1",
              created_at: "2026-08-26T00:00:00Z",
              ...(opts.searchValues !== undefined
                ? { values: opts.searchValues }
                : {}),
            },
          ]);
        }
        if (/\/threads\/[^/]+\/runs/.test(u)) {
          return enc([
            {
              run_id: "run-1",
              status: "success",
              ...(opts.runTask ? { task: opts.runTask } : {}),
            },
          ]);
        }
        if (/\/threads\/[^/]+$/.test(u)) {
          return enc({
            status: "idle",
            ...(opts.threadValues !== undefined
              ? { values: opts.threadValues }
              : {}),
          });
        }
        void init;
        throw new Error(`unexpected fetch: ${u}`);
      })
    );
  }

  it("USES THE TEXT THAT WAS SUBMITTED", async () => {
    // The reported bug: three cards, all reading "Untitled task".
    platformWithTask({ runTask: "Add a health endpoint" });
    const runs = await listRuns("http://platform");
    expect(runs[0].task).toBe("Add a health endpoint");
  });

  it("falls back to the thread's first human message", async () => {
    // A run created outside this app has no record of the original request,
    // and the thread's own transcript is the next best witness.
    platformWithTask({
      threadValues: {
        messages: [{ type: "human", content: "Fix the flaky test" }],
      },
    });
    expect((await listRuns("http://platform"))[0].task).toBe(
      "Fix the flaky test"
    );
  });

  it("prefers the RUN record over the thread — it is what was typed", async () => {
    // A thread's first message can be rewritten by a graph; the run record is
    // the request as made.
    platformWithTask({
      runTask: "what was typed",
      threadValues: { messages: [{ type: "human", content: "something else" }] },
    });
    expect((await listRuns("http://platform"))[0].task).toBe("what was typed");
  });

  it("an empty run task does not win over a real thread message", async () => {
    // `task: ""` is what a half-populated record looks like, and preferring it
    // would trade a real title for a blank one.
    platformWithTask({
      runTask: "   ",
      threadValues: { messages: [{ type: "human", content: "the real task" }] },
    });
    expect((await listRuns("http://platform"))[0].task).toBe("the real task");
  });

  it("STILL SAYS 'Untitled task' WHEN NOTHING KNOWS", async () => {
    // The control. A card must not be blank, and the fallback is correct when
    // no source carries the text — the bug was firing it when they did.
    platformWithTask({});
    expect((await listRuns("http://platform"))[0].task).toBe("Untitled task");
  });
});
