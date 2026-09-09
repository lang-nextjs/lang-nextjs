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
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
  frameErrorText,
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
const MODEL_BACKEND = (
  process.env.OPENSWE_MODEL_URL ??
  process.env.FASTAPI_URL ??
  ""
)
  .replace(/\/api\/chat\/stream.*$/, "")
  .replace(/\/$/, "");

/** The rung the queue drives when it runs for real. Overridable per install. */
const LIVE_FRAMEWORK = process.env.OPENSWE_FRAMEWORK ?? "deepagents";
const LIVE_TOPOLOGY = process.env.OPENSWE_TOPOLOGY ?? "react";

/**
 * THE ONE GRAPH THIS AGENT REGISTERS.
 *
 * Read from the SAME variable, with the SAME default, as the app's own
 * `createRun` (`OPEN_SWE_ASSISTANT_ID ?? "agent"` in lib/langgraph-client.ts).
 * The app already sends this id as `assistant_id` on every run it creates; a
 * second literal here would be two facts that must agree with nothing asserting
 * they do, and a forker who overrode it would get a backend claiming to register
 * a graph the app never asks for.
 */
const GRAPH_ID = process.env.OPEN_SWE_ASSISTANT_ID ?? "agent";

/**
 * When this assistant came into existence, which for a stub is when the process
 * did. NOT the epoch: `1970-01-01` is a truthful "there is no real timestamp
 * here" and reads to anyone looking at it as a bug, which costs a reader more
 * than the missing precision saves them.
 */
const STARTED_AT = new Date().toISOString();

/*
 * TOOLS THIS QUEUE RUNS WITHOUT ASKING, AND WHY THAT IS SAFE HERE.
 *
 * The wire carries the READ-ONLY ALLOWLIST, never the gated names. _common.py's
 * policy block is explicit that an unrecognised tool is GATED — "of the two
 * mistakes only one is unrecoverable" — and that "the list does not have to be
 * complete". So naming what we vouch for is the sanctioned use, and anything the
 * backend grows later stays gated rather than arriving ungated.
 *
 * WHAT THESE ARE: `increment` and `get_counter`, the demo counter in _common.py's
 * TOOLS. They mutate an in-process integer.
 *
 * WHERE THEY RUN: the fastapi backend, in Docker. This file never executes a
 * tool — it only collects the calls for the transcript. The blast radius of an
 * unapproved call is a counter inside a container.
 *
 * `[]` — everything gated — was right when the request was first made valid
 * (#700): a policy is a claim, and an empty one claims the least. It is the
 * wrong default HERE, because a queue run that pauses on `increment` is friction
 * with nothing behind it.
 *
 * DELIBERATELY NOT web_search, which is in RESEARCH_TOOLS and reaches the
 * network. Set OPENSWE_TOPOLOGY=deep-research and it stays gated — the
 * fail-closed rule working without this list needing to know it happened.
 */
const QUEUE_READ_ONLY_TOOLS = ["increment", "get_counter"];

const portArg = process.argv.indexOf("--port");
const PORT = portArg !== -1 ? Number(process.argv[portArg + 1]) : 8100;

const threads = new Map();
const runs = new Map();
let nThreads = 0;
let nRuns = 0;
const executions = new Map();
const STATE_FILE = process.env.OPENSWE_STATE_FILE;

function persist() {
  if (!STATE_FILE) return;
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(
    `${STATE_FILE}.tmp`,
    JSON.stringify({
      threads: [...threads],
      runs: [...runs],
      nThreads,
      nRuns,
    }),
    { mode: 0o600 }
  );
  renameSync(`${STATE_FILE}.tmp`, STATE_FILE);
}

if (STATE_FILE) {
  try {
    const saved = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    for (const [id, thread] of saved.threads) threads.set(id, thread);
    for (const [id, run] of saved.runs) {
      if (run.status === "running") {
        run.status = "interrupted";
        run.error = "Agent restarted; review tool effects before retrying.";
        run.served = { mode: "unknown", reason: "run-restarted" };
      }
      runs.set(id, run);
    }
    nThreads = saved.nThreads;
    nRuns = saved.nRuns;
    persist();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

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

async function streamFromModel(sink, runId, task, signal) {
  if (!MODEL_BACKEND)
    return { modelAnswered: false, text: "", reason: "no-model-backend" };
  let upstream;
  try {
    upstream = await fetch(
      `${MODEL_BACKEND}/api/chat/stream/${LIVE_FRAMEWORK}`,
      {
        method: "POST",
        signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          topology: LIVE_TOPOLOGY,
          messages: [{ role: "user", content: task }],
          approvalPolicy: { readOnlyTools: QUEUE_READ_ONLY_TOOLS },
          sessionId: runs.get(runId).session_id,
        }),
      }
    );
  } catch {
    return { modelAnswered: false, text: "", reason: "backend-unreachable" };
  }
  if (!upstream.ok) {
    await upstream.body?.cancel();
    return {
      modelAnswered: false,
      text: "",
      reason: `backend-status-${upstream.status}`,
    };
  }
  if (!upstream.body)
    return { modelAnswered: false, text: "", reason: "backend-no-body" };
  const decoder = new TextDecoder();
  const reader = upstream.body.getReader();
  const tools = collectToolCalls();
  let buffered = "";
  let text = "";
  let sawAnything = false;
  let completed = false;
  let streamError = null;
  function accept(frames) {
    if (/^data:\s*\[DONE\]\s*$/m.test(frames)) completed = true;
    for (const payload of dataPayloads(frames)) {
      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
      if (isTerminal(payload)) completed = true;
      if (parsed.type === "finish" && parsed.finishReason === "error")
        streamError ??= "Backend reported an unsuccessful finish";
      streamError ??= frameErrorText(parsed);
      if (parsed.type === "text-delta" && typeof parsed.delta === "string")
        text += parsed.delta;
      tools.accept(payload);
      for (const event of frameToEvents(payload, runId)) {
        sawAnything = true;
        sink.write(`event: events\ndata: ${JSON.stringify(event)}\n\n`);
      }
    }
  }
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      buffered = buffered.replace(/\r\n/g, "\n");
      const boundary = buffered.lastIndexOf("\n\n");
      if (boundary !== -1) {
        accept(buffered.slice(0, boundary));
        buffered = buffered.slice(boundary + 2);
      }
    }
    accept(buffered + decoder.decode());
  } catch {
    streamError ??= "Backend stream disconnected";
  } finally {
    reader.releaseLock();
  }
  if (!completed) streamError ??= "Backend stream ended without a finish";
  return {
    modelAnswered: sawAnything,
    text,
    tools: tools.list(),
    failed: streamError !== null,
    ...(streamError !== null
      ? { reason: streamError ? `stream-error:${streamError}` : "stream-error" }
      : sawAnything
      ? {}
      : { reason: "stream-empty" }),
  };
}

function publish(run, execution, frame) {
  run.events.push(frame);
  execution.bytes += Buffer.byteLength(frame);
  if (execution.bytes > 4 * 1024 * 1024) {
    execution.controller.abort();
    throw new Error("Run output exceeded the 4 MiB limit");
  }
  for (const subscriber of execution.subscribers) {
    if (subscriber.destroyed || !subscriber.write(frame)) {
      execution.subscribers.delete(subscriber);
      subscriber.destroy();
    }
  }
}

async function executeRun(run, execution) {
  const timer = setTimeout(() => execution.controller.abort(), 300_000);
  try {
    const outcome = await streamFromModel(
      {
        write: (frame) => publish(run, execution, frame),
      },
      run.run_id,
      run.task,
      execution.controller.signal
    );
    run.reply = outcome.text;
    run.tools = outcome.tools ?? [];
    if (run.status !== "running") return;
    if (execution.controller.signal.aborted)
      throw new Error("Run timed out or exceeded its output limit");
    if (!MODEL_BACKEND) {
      run.scripted = true;
      for (const step of cannedSteps(run.task)) {
        await sleep(step.delayMs);
        if (run.status !== "running") return;
        publish(
          run,
          execution,
          `event: events\ndata: ${JSON.stringify({
            event: step.event,
            name: step.name,
            run_id: run.run_id,
            data: step.data,
          })}\n\n`
        );
      }
    }
    run.status =
      MODEL_BACKEND && (!outcome.modelAnswered || outcome.failed)
        ? "error"
        : "success";
    if (run.status === "error") run.error = outcome.reason;
    run.served =
      outcome.modelAnswered || run.scripted
        ? resolveServedMode({
            modelAnswered: outcome.modelAnswered,
            detail: outcome.reason ?? `${LIVE_FRAMEWORK}/${LIVE_TOPOLOGY}`,
          })
        : { mode: "unknown", reason: outcome.reason };
  } catch (error) {
    if (run.status === "running") {
      run.status = "error";
      run.error = error.message;
      run.served = { mode: "unknown", reason: "run-failed" };
    }
  } finally {
    clearTimeout(timer);
    executions.delete(run.run_id);
    try {
      persist();
    } catch (error) {
      run.status = "error";
      run.error = "Could not persist run state";
      console.error("[open-swe] state persistence failed:", error.code);
    }
    for (const subscriber of execution.subscribers)
      subscriber.end("event: end\ndata: [DONE]\n\n");
    execution.subscribers.clear();
  }
}

const publicRun = ({ events, ...run }) => run;

async function handleRequest(req, res) {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  const m = req.method;
  // Mode is resolved per-request by the code path that serves it, so the
  // header always describes THIS response rather than the process's config.
  const mode = resolveMode();
  let g;

  /*
   * `modelBackend` IS THE FACT NOBODY COULD SEE.
   *
   * `mode` here is `resolveMode()` — a reading of CONFIGURATION, and the only
   * thing it can read is whether a key exists. It said `live-decided-per-run`
   * for weeks on an agent that had no backend address at all, because a key was
   * set and nothing on this endpoint knew the difference between "we will find
   * out when a run happens" and "no run can ever reach a model".
   *
   * dev-all.sh forked this process ten lines before it exported FASTAPI_URL, so
   * `MODEL_BACKEND` was the empty string and every queue run was scripted —
   * always, not intermittently. Three rounds of diagnosis went past it, and the
   * script's own "queue agent already running — leaving it alone" branch meant
   * restarting `pnpm dev` could not clear it.
   *
   * Measured, same binary and same shell, only the fork order changed:
   *
   *   fork-then-export  reason=live-decided-per-run  modelBackend=false
   *   export-then-fork  reason=live-decided-per-run  modelBackend=true
   *
   * The reason is IDENTICAL in both, which is the whole argument for the field.
   *
   * A BOOLEAN, NEVER THE URL. This endpoint is unauthenticated and the address
   * can carry a host, a port, and in a forker's setup a token. Whether one is
   * configured is the whole question a caller has; the value is not.
   */
  if (p === "/health")
    return json(
      res,
      200,
      { ok: true, ...mode, modelBackend: MODEL_BACKEND !== "" },
      mode
    );

  /**
   * WHAT THIS BACKEND REGISTERS (#423's probe).
   *
   * Reported as a notice on every live run: "Could not determine whether this
   * backend runs more than one graph ({"error":"unhandled POST
   * /assistants/search"}). This view follows a single thread, so it may be
   * showing part of the agent."
   *
   * The notice was RIGHT — nothing here answered, so the app could not tell a
   * complete single-thread view from one third of a three-graph agent, and
   * `backend-topology.ts` is explicit that collapsing "I could not ask" into
   * "it is single-run" is the defect #423 exists to prevent. It said the true
   * thing available to it, on a backend that is in fact complete.
   *
   * This was the ONLY unimplemented route: the app calls nine Platform paths
   * (threads, threads/search, threads/{id}, .../runs, runs/{id}, .../cancel,
   * the run stream, and this) and the other eight were already here.
   *
   * ONE ASSISTANT, because there is one graph. `classifyTopology` treats an
   * EMPTY list as unknown rather than single-run — deliberately, same reasoning
   * — so answering with `[]` would have left the notice on screen while looking
   * like a fix.
   */
  if (m === "POST" && p === "/assistants/search") {
    return json(
      res,
      200,
      [
        {
          assistant_id: GRAPH_ID,
          graph_id: GRAPH_ID,
          name: GRAPH_ID,
          config: {},
          metadata: {},
          version: 1,
          created_at: STARTED_AT,
          updated_at: STARTED_AT,
        },
      ],
      mode
    );
  }

  if (m === "POST" && p === "/threads") {
    const id = `th-${++nThreads}`;
    threads.set(id, { thread_id: id, created_at: new Date().toISOString() });
    persist();
    return json(res, 200, { thread_id: id }, mode);
  }

  if (m === "POST" && p === "/threads/search") {
    return json(res, 200, [...threads.values()], mode);
  }

  if ((g = p.match(/^\/threads\/([^/]+)\/runs$/)) && m === "POST") {
    const body = await readBody(req);
    const task = body?.input?.messages?.[0]?.content ?? "Untitled task";
    if (typeof task !== "string" || !task.trim())
      return json(res, 422, { error: "task must be a nonempty string" }, mode);
    // THE THREAD REMEMBERS ITS TASK, so GET /threads/{id} can answer with the
    // run that was actually asked for. Without this the thread state was a
    // module constant and every card in the queue rendered the same
    // conversation — about a parser nobody had mentioned.
    const thread = threads.get(g[1]);
    if (!thread) return json(res, 404, { error: "thread not found" }, mode);
    if (thread) thread.task = task;
    const id = `run-${++nRuns}`;
    runs.set(id, {
      run_id: id,
      thread_id: g[1],
      status: "running",
      created_at: new Date().toISOString(),
      task,
      session_id: randomUUID(),
      events: [],
    });
    persist();
    const execution = {
      controller: new AbortController(),
      subscribers: new Set(),
      bytes: 0,
    };
    executions.set(id, execution);
    void executeRun(runs.get(id), execution);
    return json(res, 200, publicRun(runs.get(id)), mode);
  }

  if ((g = p.match(/^\/threads\/([^/]+)\/runs$/)) && m === "GET") {
    return json(
      res,
      200,
      [...runs.values()].filter((r) => r.thread_id === g[1]).map(publicRun),
      mode
    );
  }

  if (
    (g = p.match(/^\/threads\/([^/]+)\/runs\/([^/]+)\/stream$/)) &&
    m === "GET"
  ) {
    const run = runs.get(g[2]);
    if (!run || run.thread_id !== g[1])
      return json(res, 404, { error: "run not found" }, mode);
    res.writeHead(
      200,
      stampMode(
        {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
        run.served ?? IN_PROGRESS
      )
    );
    for (const frame of run.events ?? []) res.write(frame);
    const execution = executions.get(run.run_id);
    if (!execution || run.status !== "running") {
      return res.end("event: end\ndata: [DONE]\n\n");
    }
    execution.subscribers.add(res);
    res.on("close", () => execution.subscribers.delete(res));
    return;
  }

  if ((g = p.match(/^\/runs\/([^/]+)$/)) && m === "GET") {
    return runs.has(g[1])
      ? json(res, 200, publicRun(runs.get(g[1])), mode)
      : json(res, 404, { error: "run not found" }, mode);
  }

  if ((g = p.match(/^\/runs\/([^/]+)\/cancel$/)) && m === "POST") {
    const run = runs.get(g[1]);
    if (!run) return json(res, 404, { error: "run not found" }, mode);
    if (run.status === "running") {
      run.status = "interrupted";
      run.error = "Run cancelled; review tool effects before retrying.";
      run.served = { mode: "unknown", reason: "run-cancelled" };
      executions.get(g[1])?.controller.abort();
      persist();
    }
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
        .sort((a, b) =>
          String(b.created_at).localeCompare(String(a.created_at))
        )[0]?.task;
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
      .sort((a, b) =>
        String(b.created_at).localeCompare(String(a.created_at))
      )[0];
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
    const state = newest?.scripted
      ? cannedFinalState(known, threadStatus)
      : liveFinalState(
          known,
          newest?.reply ||
            newest?.error ||
            (inFlight ? "Run in progress." : "No model response recorded."),
          threadStatus,
          newest?.tools
        );
    return json(
      res,
      200,
      { ...state, values: { ...state.values, agent_mode: served.mode } },
      served
    );
  }

  json(res, 404, { error: `unhandled ${m} ${p}` }, mode);
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error("[open-swe] request failed:", error.code ?? error.name);
    if (res.headersSent) return res.destroy();
    json(
      res,
      500,
      { error: "Agent request failed" },
      { mode: "unknown", reason: "request-failed" }
    );
  });
});

server.listen(PORT, () => {
  const m = resolveMode();
  console.log(
    `[open-swe agent] listening on :${server.address().port}  mode=${m.mode} (${
      m.reason
    })`
  );
  if (m.reason === "live-decided-per-run") {
    // This used to name OPENROUTER_API_KEY outright. The comment in
    // lib/agent-mode.ts records that exact bug being fixed for the in-app
    // banner — and it survived here, in the line a person reads first, so
    // somebody running NVIDIA was told about a key they had never set.
    console.log(
      "[open-swe agent] A model API key is set. Configured-backend failures fail the run; scripted runs are only used without a backend URL."
    );
  }
});
