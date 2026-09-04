import { describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { AddressInfo } from "node:net";
import path from "node:path";

/**
 * THE REASON A RUN WAS SCRIPTED MUST REACH THE READER.
 *
 * #697 gave `streamFromModel` a named reason at every site that can fail, and
 * gave the banner a sentence for each. Both halves shipped. The line that
 * carries one to the other did not:
 *
 *   detail: outcome.modelAnswered ? `${FRAMEWORK}/${TOPOLOGY}` : undefined
 *                                                               ^^^^^^^^^
 *
 * So every reason was computed and dropped one step before anybody could read
 * it, `resolveServedMode` fell through to configuration, and all six failures
 * rendered as `live-decided-per-run` — "a model API key is set, the model did
 * not answer". Which is the exact sentence #697 exists to stop showing.
 *
 * NOTHING CAUGHT IT because nothing joined the two halves. The emit sites had
 * tests, `resolveServedMode` had tests, `describeProvenance` had tests, and a
 * count of emit sites read as "the feature landed". Two facts that must agree,
 * with no assertion that they do.
 *
 * So this test is deliberately end-to-end and deliberately about the OUTPUT
 * token: it spawns the real agent against a real (stub) backend, drives a real
 * run, and reads `served.reason` off the finished run. It cannot pass while any
 * link in that chain drops the reason, and it cannot pass by reading the same
 * constant the implementation reads.
 *
 * THE THIRD CASE IS THE POSITIVE CONTROL. Two failure cases that both come back
 * `canned` prove nothing about a harness where every run fails for an unrelated
 * reason — a mistyped route, an agent that never reached the backend. A backend
 * that answers must produce `live`, or the two reds below are not evidence.
 */

const AGENT = path.join(__dirname, "server.mjs");

/**
 * The frame a REAL backend sent, captured from the running stack while
 * diagnosing this. HTTP 200, one `data-error`, one `finish` — no text at all.
 *
 * This is what a provider under load looks like from here, and it is common:
 * one request in three to a healthy backend with a valid key came back exactly
 * like this. `frameToEvents` returns `[]` for it (correctly — an error is not a
 * transcript event), which is how it used to be recorded as `stream-empty`,
 * "the model backend streamed zero frames". It streamed the one frame that
 * explained everything.
 */
const OVERLOADED =
  `data: {"type": "data-error", "data": {"id": "stream-error", "seq": 0, ` +
  `"code": "backend_error", "message": "Service temporarily overloaded", ` +
  `"retryable": false, "origin": "provider", "cause": {"exception": "APIError"}}}\n\n` +
  `data: {"type":"finish","finishReason":"error"}\n\n`;

/** A backend that answers properly, so the control arm can go `live`. */
const ANSWERED =
  `data: {"type":"text-delta","id":"t1","delta":"QuickSort"}\n\n` +
  `data: {"type":"finish","finishReason":"stop"}\n\n`;

async function backendServing(body: string): Promise<{
  url: string;
  hits: () => number;
  close: () => void;
}> {
  let hits = 0;
  const server: Server = createServer((_req, res) => {
    hits += 1;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    res.end(body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/api/chat/stream`,
    hits: () => hits,
    close: () => server.close(),
  };
}

/** A port that was open a moment ago and is now closed — nothing will answer. */
async function deadPort(): Promise<string> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((r) => server.close(() => r()));
  return `http://127.0.0.1:${port}/api/chat/stream`;
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

async function waitForHealth(port: number, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * Spawn the agent pointed at `modelUrl`, drive one full run, and hand back the
 * run record the agent kept — which is what the queue reads to draw a card.
 */
async function runAgainst(modelUrl: string): Promise<{
  served?: { mode: string; reason?: string };
  status?: string;
}> {
  const port = await freePort();
  let agent: ChildProcess | undefined;
  try {
    agent = spawn(process.execPath, [AGENT, "--port", String(port)], {
      env: {
        ...process.env,
        AGENT_PORT: String(port),
        FASTAPI_URL: modelUrl,
        OPENSWE_MODEL_URL: modelUrl,
        // A key must LOOK configured, or `resolveMode()`'s fallback would say
        // `no-model-api-key` and the test could pass without the reason ever
        // travelling. The value is never used: this process does not call a
        // model, and the stub backend does not read it.
        NVIDIA_API_KEY: "test-key-not-used",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(await waitForHealth(port)).toBe(true);

    // The route sequence, which a sibling test got wrong once and passed
    // anyway: create thread, create run, THEN GET the stream.
    const thread = (await fetch(`http://127.0.0.1:${port}/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ metadata: {} }),
    }).then((r) => r.json())) as { thread_id: string };

    const run = (await fetch(
      `http://127.0.0.1:${port}/threads/${thread.thread_id}/runs`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input: {
            messages: [{ role: "user", content: "name 2 sorting algorithm" }],
          },
        }),
      }
    ).then((r) => r.json())) as { run_id: string };

    await fetch(
      `http://127.0.0.1:${port}/threads/${thread.thread_id}/runs/${run.run_id}/stream`
    )
      .then((r) => r.text())
      .catch(() => "");

    return (await fetch(`http://127.0.0.1:${port}/runs/${run.run_id}`).then(
      (r) => r.json()
    )) as { served?: { mode: string; reason?: string }; status?: string };
  } finally {
    agent?.kill("SIGKILL");
  }
}

describe("the queue agent, asked why it served a script", () => {
  it("names the backend's OWN error rather than calling the stream empty", async () => {
    const backend = await backendServing(OVERLOADED);
    try {
      const run = await runAgainst(backend.url);

      // GUARD THE GUARD: a run that never reached the backend would also be
      // scripted, for a reason that has nothing to do with what is asserted.
      expect(
        backend.hits(),
        "the agent never called the backend"
      ).toBeGreaterThan(0);

      expect(run.served?.mode).toBe("canned");
      // The whole point. `stream-empty` is the answer the old build gave, and
      // it sends a reader to look for a stream that carried nothing.
      expect(run.served?.reason).toBe(
        "stream-error:Service temporarily overloaded"
      );
    } finally {
      backend.close();
    }
  }, 30_000);

  it("carries a reason that was decided at the failure site, not inferred from config", async () => {
    // The narrowest statement of the dropped-`detail` defect, with no frame
    // parsing involved: the agent could not connect at all, `streamFromModel`
    // said so by name, and the run must still say so. The old build answered
    // `live-decided-per-run` here — a reading of configuration, produced
    // because the observation was thrown away.
    const run = await runAgainst(await deadPort());
    expect(run.served?.mode).toBe("canned");
    expect(run.served?.reason).toBe("backend-unreachable");
  }, 30_000);

  it("still reports a real answer as live — the failures above are not the only verdict", async () => {
    const backend = await backendServing(ANSWERED);
    try {
      const run = await runAgainst(backend.url);
      expect(backend.hits()).toBeGreaterThan(0);
      expect(run.served?.mode).toBe("live");
    } finally {
      backend.close();
    }
  }, 30_000);
});

/**
 * WHETHER THIS AGENT HAS ANYWHERE TO ASK — the fact /health could not report.
 *
 * `mode` on that endpoint is `resolveMode()`, a reading of CONFIGURATION whose
 * only input is whether an API key exists. It answered `live-decided-per-run`
 * for weeks on an agent started with no backend address at all: a key WAS set,
 * so the endpoint was telling the truth about the only thing it could see.
 *
 * dev-all.sh forked this process ten lines above `export FASTAPI_URL`, and a
 * child inherits the environment as it was at fork — so `MODEL_BACKEND` was ""
 * and every queue run was scripted, always. Measured directly, same binary and
 * same shell, only the order changed:
 *
 *   fork-then-export  {"mode":"canned","reason":"live-decided-per-run","modelBackend":false}
 *   export-then-fork  {"mode":"canned","reason":"live-decided-per-run","modelBackend":true}
 *
 * The `reason` is IDENTICAL in both. That is the whole argument for the field.
 */
async function healthWith(env: Record<string, string | undefined>): Promise<{
  modelBackend?: boolean;
  reason?: string;
}> {
  const port = await freePort();
  let agent: ChildProcess | undefined;
  try {
    const child = { ...process.env, ...env };
    for (const [k, v] of Object.entries(env))
      if (v === undefined) delete child[k];
    agent = spawn(process.execPath, [AGENT, "--port", String(port)], {
      env: child as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(await waitForHealth(port)).toBe(true);
    return (await fetch(`http://127.0.0.1:${port}/health`).then((r) =>
      r.json()
    )) as { modelBackend?: boolean; reason?: string };
  } finally {
    agent?.kill("SIGKILL");
  }
}

describe("the queue agent's /health, asked whether it can reach a model at all", () => {
  it("says false when it was forked without a backend address", async () => {
    const h = await healthWith({
      FASTAPI_URL: undefined,
      OPENSWE_MODEL_URL: undefined,
      NVIDIA_API_KEY: "test-key-not-used",
    });
    expect(h.modelBackend).toBe(false);
  }, 30_000);

  it("says true when it was forked with one", async () => {
    const h = await healthWith({
      FASTAPI_URL: "http://127.0.0.1:9/api/chat/stream",
      OPENSWE_MODEL_URL: undefined,
      NVIDIA_API_KEY: "test-key-not-used",
    });
    // Deliberately an address nothing listens on. The question is whether the
    // agent HAS one, not whether it answers — conflating those is how "a key is
    // set" came to stand in for "a model can be reached".
    expect(h.modelBackend).toBe(true);
  }, 30_000);

  it("and `reason` cannot tell those two apart — which is why the field exists", async () => {
    /*
     * THE POINT OF THE WHOLE FIELD, asserted rather than described. If a future
     * change made `reason` distinguish these, this test failing is the correct
     * outcome: it means the cheaper signal now carries the fact and this one
     * should be revisited. A test that merely checked `modelBackend` differs
     * would never notice that.
     */
    const without = await healthWith({
      FASTAPI_URL: undefined,
      OPENSWE_MODEL_URL: undefined,
      NVIDIA_API_KEY: "test-key-not-used",
    });
    const with_ = await healthWith({
      FASTAPI_URL: "http://127.0.0.1:9/api/chat/stream",
      OPENSWE_MODEL_URL: undefined,
      NVIDIA_API_KEY: "test-key-not-used",
    });
    expect(without.reason).toBe(with_.reason);
    expect(without.modelBackend).not.toBe(with_.modelBackend);
  }, 40_000);
});
