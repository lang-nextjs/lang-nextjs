#!/usr/bin/env node
/**
 * Local Open-SWE-compatible agent backend.
 *
 * Speaks the subset of the LangGraph Server REST API that
 * apps/open-swe/lib/langgraph-client.ts calls — nothing more:
 *
 *   POST /threads                          POST /threads/search
 *   POST /threads/{t}/runs                 GET  /threads/{t}/runs
 *   GET  /threads/{t}                      GET  /runs/{r}
 *   POST /runs/{r}/cancel                  GET  /threads/{t}/runs/{r}/stream
 *
 * It lives inside apps/open-swe/ on purpose: `pnpm eject langchain` has to be
 * able to delete this rung without touching anything else, so nothing about it
 * may live at the repo root. This mirrors apps/{fastapi,django}-backend, which
 * each own their docker-compose.yml inside their own app directory.
 *
 * Run:  node apps/open-swe/agent/server.mjs --port 8100
 */
import http from "node:http";
import { resolveMode, stampMode } from "./mode.mjs";
import {
  cannedSteps,
  cannedFinalState,
  threadStatusFromRuns,
} from "./canned-run.mjs";

const portArg = process.argv.indexOf("--port");
const PORT = portArg !== -1 ? Number(process.argv[portArg + 1]) : 8100;

const threads = new Map();
const runs = new Map();
let nThreads = 0;
let nRuns = 0;

const json = (res, code, payload, mode) =>
  res.writeHead(
    code,
    stampMode({ "Content-Type": "application/json" }, mode)
  ) && res.end(JSON.stringify(payload));

const readBody = (req) =>
  new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      try {
        resolve(b ? JSON.parse(b) : {});
      } catch {
        resolve({});
      }
    });
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  const m = req.method;
  // Mode is resolved per-request by the code path that serves it, so the
  // header always describes THIS response rather than the process's config.
  const mode = resolveMode();
  let g;

  if (p === "/health") return json(res, 200, { ok: true, ...mode }, mode);

  if (m === "POST" && p === "/threads") {
    const id = `th-${++nThreads}`;
    threads.set(id, { thread_id: id, created_at: new Date().toISOString() });
    return json(res, 200, { thread_id: id }, mode);
  }

  if (m === "POST" && p === "/threads/search") {
    return json(res, 200, [...threads.values()], mode);
  }

  if ((g = p.match(/^\/threads\/([^/]+)\/runs$/)) && m === "POST") {
    const body = await readBody(req);
    const task = body?.input?.messages?.[0]?.content ?? "Untitled task";
    // THE THREAD REMEMBERS ITS TASK, so GET /threads/{id} can answer with the
    // run that was actually asked for. Without this the thread state was a
    // module constant and every card in the queue rendered the same
    // conversation — about a parser nobody had mentioned.
    const thread = threads.get(g[1]);
    if (thread) thread.task = task;
    const id = `run-${++nRuns}`;
    runs.set(id, {
      run_id: id,
      thread_id: g[1],
      status: "running",
      created_at: new Date().toISOString(),
      task,
    });
    return json(res, 200, runs.get(id), mode);
  }

  if ((g = p.match(/^\/threads\/([^/]+)\/runs$/)) && m === "GET") {
    return json(
      res,
      200,
      [...runs.values()].filter((r) => r.thread_id === g[1]),
      mode
    );
  }

  if (
    (g = p.match(/^\/threads\/([^/]+)\/runs\/([^/]+)\/stream$/)) &&
    m === "GET"
  ) {
    const runId = g[2];
    // The steps carry the task, so a stream reads as this run rather than as
    // the same scripted investigation every other card showed.
    const steps = cannedSteps(runs.get(runId)?.task ?? threads.get(g[1])?.task);
    res.writeHead(
      200,
      stampMode(
        {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
        mode
      )
    );
    for (const step of steps) {
      await sleep(step.delayMs);
      if (res.writableEnded) return;
      res.write(
        `event: events\ndata: ${JSON.stringify({
          event: step.event,
          name: step.name,
          run_id: runId,
          data: step.data,
        })}\n\n`
      );
    }
    const run = runs.get(runId);
    if (run) run.status = "success";
    res.write("event: end\ndata: [DONE]\n\n");
    return res.end();
  }

  if ((g = p.match(/^\/runs\/([^/]+)$/)) && m === "GET") {
    return runs.has(g[1])
      ? json(res, 200, runs.get(g[1]), mode)
      : json(res, 404, { error: "run not found" }, mode);
  }

  if ((g = p.match(/^\/runs\/([^/]+)\/cancel$/)) && m === "POST") {
    const run = runs.get(g[1]);
    if (run) run.status = "interrupted";
    return json(res, 200, { ok: true }, mode);
  }

  if ((g = p.match(/^\/threads\/([^/]+)$/)) && m === "GET") {
    if (!threads.has(g[1]))
      return json(res, 404, { error: "thread not found" }, mode);
    // agent_mode rides inside the state body as well as the header, so a
    // consumer that only reads JSON still learns who answered.
    // The thread's own task if it has one; otherwise the newest run's, which
    // is where the task lived before threads recorded it. Threads created by
    // an earlier build therefore still render what they were asked to do,
    // rather than falling back to "Untitled task" and losing it.
    const known =
      threads.get(g[1])?.task ??
      [...runs.values()]
        .filter((r) => r.thread_id === g[1])
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0]?.task;
    /**
     * THE THREAD'S STATUS IS DERIVED FROM ITS RUNS, not asserted.
     *
     * It was the constant "idle" inside the canned state. Nothing read it
     * until the board started to, and then a task went to "Not running" the
     * moment it was created: the run record said `running`, and the thread —
     * which now outranks it, deliberately — said idle and was simply wrong.
     *
     * `interrupted` first, because it is the state a person must act on and a
     * cancelled run should not read as merely stopped. Then `busy` if any run
     * is still in flight. `idle` only when nothing is executing, which is what
     * the word means.
     */
    const mine = [...runs.values()].filter((r) => r.thread_id === g[1]);
    const threadStatus = threadStatusFromRuns(mine);
    const state = cannedFinalState(known, threadStatus);
    return json(
      res,
      200,
      { ...state, values: { ...state.values, agent_mode: mode.mode } },
      mode
    );
  }

  json(res, 404, { error: `unhandled ${m} ${p}` }, mode);
});

server.listen(PORT, () => {
  const m = resolveMode();
  console.log(
    `[open-swe agent] listening on :${PORT}  mode=${m.mode} (${m.reason})`
  );
  if (m.reason === "live-graph-not-configured") {
    console.log(
      "[open-swe agent] OPENROUTER_API_KEY is set, but the live graph is not wired yet."
    );
    console.log(
      "[open-swe agent] Serving the canned run and reporting mode=canned."
    );
  }
});
