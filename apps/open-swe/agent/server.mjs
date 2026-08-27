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
import { resolveMode, resolveServedMode, stampMode } from "./mode.mjs";

/** Provenance for a run that has not finished. Mirrors REASON_IN_PROGRESS. */
const IN_PROGRESS = { mode: "unknown", reason: "run-in-progress" };
import {
  cannedSteps,
  cannedFinalState,
  liveFinalState,
  threadStatusFromRuns,
} from "./canned-run.mjs";
import {
  collectToolCalls,
  dataPayloads,
  frameToEvents,
  isTerminal,
} from "./live-run.mjs";

/**
 * WHERE A REAL MODEL LIVES, if one does.
 *
 * `FASTAPI_URL` is what dev-all.sh already exports for the chat surface, so a
 * normal `pnpm dev` wires the queue to the same backend the chat uses without
 * anyone configuring a second thing. Trimmed back to the origin because that
 * variable names the chat STREAM path and this needs the backend root.
 */
const MODEL_BACKEND = (process.env.OPENSWE_MODEL_URL ??
  process.env.FASTAPI_URL ??
  "")
  .replace(/\/api\/chat\/stream.*$/, "")
  .replace(/\/$/, "");

/** The rung the queue drives when it runs for real. Overridable per install. */
const LIVE_FRAMEWORK = process.env.OPENSWE_FRAMEWORK ?? "deepagents";
const LIVE_TOPOLOGY = process.env.OPENSWE_TOPOLOGY ?? "react";

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

/**
 * Drive the real model for one run, translating its frames into the events
 * this backend speaks. Returns what actually happened.
 *
 * RETURNS RATHER THAN THROWS on an unreachable backend, because the caller has
 * a scripted run to fall back to and a dead model must not take the queue with
 * it. The distinction it returns — did the model produce anything — is what
 * decides the banner, and it is deliberately about OUTPUT, not about the
 * request succeeding: a 200 that streams nothing has not answered.
 */
async function streamFromModel(res, runId, task) {
  if (!MODEL_BACKEND) return { modelAnswered: false, text: "" };

  let upstream;
  try {
    upstream = await fetch(
      `${MODEL_BACKEND}/api/chat/stream/${LIVE_FRAMEWORK}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          topology: LIVE_TOPOLOGY,
          messages: [{ role: "user", content: task }],
        }),
      }
    );
  } catch {
    return { modelAnswered: false, text: "" };
  }
  if (!upstream.ok || !upstream.body) return { modelAnswered: false, text: "" };

  const dec = new TextDecoder();
  const reader = upstream.body.getReader();
  let buffered = "";
  let text = "";
  let sawAnything = false;
  // The tools this run called, so the finished transcript can show them. They
  // were visible while streaming and lost on completion.
  const tools = collectToolCalls();

  /**
   * A MID-STREAM FAILURE MUST NOT TAKE THE QUEUE DOWN.
   *
   * The `try` above wraps only the initial `fetch`, so `reader.read()` here was
   * unguarded — and a socket that closes mid-response rejects it. That is an
   * unhandled rejection, which kills the process.
   *
   * Observed: restarting the model backend while a run was streaming crashed
   * this agent outright with
   *
   *   SocketError: other side closed  (UND_ERR_SOCKET, remotePort 8001)
   *
   * and the whole queue went to "Agent backend — fetch failed / not
   * responding". One flaky backend restart took down every card, not just the
   * run that was in flight.
   *
   * A dropped stream is now the same outcome as a backend that never answered:
   * whatever tokens arrived are kept, `modelAnswered` reflects whether any did,
   * and the caller falls back to the scripted run. The agent stays up.
   */
  for (;;) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch {
      // Whatever arrived before the drop was already written to the client.
      // Stopping here keeps it; the outcome below reports honestly whether the
      // model produced anything at all.
      break;
    }
    const { done, value } = chunk;
    if (done) break;
    if (res.writableEnded) {
      // The browser left. Stop pulling tokens we are paying for.
      await reader.cancel().catch(() => {});
      break;
    }
    // BUFFER ACROSS READS. A chunk boundary lands mid-frame routinely, and
    // parsing each read in isolation drops whatever straddles it.
    buffered += dec.decode(value, { stream: true });
    const lastBreak = buffered.lastIndexOf("\n\n");
    if (lastBreak === -1) continue;
    const ready = buffered.slice(0, lastBreak);
    buffered = buffered.slice(lastBreak + 2);

    for (const payload of dataPayloads(ready)) {
      if (isTerminal(payload)) continue;
      try {
        const parsed = JSON.parse(payload);
        if (parsed?.type === "text-delta" && typeof parsed.delta === "string")
          text += parsed.delta;
      } catch {
        /* not readable — frameToEvents drops it too */
      }
      tools.accept(payload);
      for (const ev of frameToEvents(payload, runId)) {
        sawAnything = true;
        res.write(`event: events\ndata: ${JSON.stringify(ev)}\n\n`);
      }
    }
  }
  for (const payload of dataPayloads(buffered)) {
    tools.accept(payload);
    for (const ev of frameToEvents(payload, runId)) {
      sawAnything = true;
      res.write(`event: events\ndata: ${JSON.stringify(ev)}\n\n`);
    }
  }

  // A partial answer is still an answer: the frames that arrived were already
  // written to the client, so reporting `modelAnswered: false` after a drop
  // would leave a transcript contradicting what a person just watched stream
  // past. `sawAnything` is the honest measure either way.
  return { modelAnswered: sawAnything, text, tools: tools.list() };
}

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
    const task = runs.get(runId)?.task ?? threads.get(g[1])?.task ?? "Untitled task";
    const steps = cannedSteps(task);
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
    /**
     * A REAL RUN WHEN ONE IS POSSIBLE, the scripted one when it is not.
     *
     * Reported as "we need real run, not fake ones": the queue showed a
     * scripted parser fix while the chat surface, on the same machine, was
     * answering real questions from the same backend.
     *
     * The model is TRIED FIRST and the script is the fallback, never a blend.
     * A run that streamed real tokens and then finished with scripted ones
     * would be the worst of both — indistinguishable from a real run and
     * partly invented.
     */
    const outcome = await streamFromModel(res, runId, task);

    if (!outcome.modelAnswered) {
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
    }

    const run = runs.get(runId);
    if (run) {
      run.status = "success";
      // What the thread renders afterwards, and the banner it carries. Recorded
      // on the RUN because the run is what was served; the thread reads it.
      run.served = resolveServedMode({
        modelAnswered: outcome.modelAnswered,
        detail: outcome.modelAnswered
          ? `${LIVE_FRAMEWORK}/${LIVE_TOPOLOGY}`
          : undefined,
      });
      if (outcome.modelAnswered && outcome.text.trim()) {
        run.reply = outcome.text.trim();
      }
      if (outcome.modelAnswered && outcome.tools?.length) {
        run.tools = outcome.tools;
      }
    }
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
    // WHAT THIS THREAD ACTUALLY SERVED, not what this process could serve.
    // `mode` above is resolveMode() — a prediction from configuration. A run
    // that already streamed knows better, and the banner must follow it.
    const newest = mine
      .slice()
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
    /**
     * A RUN STILL IN FLIGHT HAS NOT PRODUCED AN ANSWER TO "WHAT MADE THIS".
     *
     * `mode` is resolveMode() — a prediction from configuration, and always
     * `canned` because a key does not wire a graph. Falling back to it while a
     * run was streaming meant the banner read "Scripted run — no LLM was
     * called" during a run that was calling one, then flipped to "Live agent
     * run" when it finished. Reported exactly that way.
     *
     * The first of those is a POSITIVE CLAIM, and it was false while on
     * screen. `unknown` + `run-in-progress` says the true thing: not yet
     * determined. It resolves the moment the run does.
     */
    const inFlight = mine.some((r) => r.status === "running");
    const served = newest?.served ?? (inFlight ? IN_PROGRESS : mode);
    const state =
      served.mode === "live"
        ? liveFinalState(known, newest?.reply, threadStatus, newest?.tools)
        : cannedFinalState(known, threadStatus);
    return json(
      res,
      200,
      { ...state, values: { ...state.values, agent_mode: served.mode } },
      served
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
