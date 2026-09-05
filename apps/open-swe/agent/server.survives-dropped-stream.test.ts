import { describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { AddressInfo } from "node:net";
import path from "node:path";

/**
 * A DROPPED MODEL STREAM MUST NOT TAKE THE QUEUE AGENT DOWN.
 *
 * Reported as "says Agent backend / http://localhost:8100 — fetch failed / not
 * responding". The agent was not misconfigured and had not been killed: it had
 * CRASHED, hours earlier, with an unhandled rejection —
 *
 *   SocketError: other side closed
 *     code: 'UND_ERR_SOCKET', remotePort: 8001
 *
 * — thrown by `reader.read()` while a run was streaming, at the moment the
 * model backend on :8001 was restarted underneath it.
 *
 * THE `try` GUARDED THE WRONG LINE. It wrapped the initial `fetch`, so a
 * backend that was down when the run started degraded gracefully to the
 * scripted fallback — the case that was designed for, and the case that got
 * tested. A backend that died *mid-response* rejected the read instead, which
 * no `try` covered, and an unhandled rejection kills the process.
 *
 * The blast radius is why this is worth an integration test rather than a unit
 * one. The failure is not "this run degrades": it is EVERY card going dark,
 * including the runs that were nowhere near the backend, because they all live
 * in the one process that died. So the assertion here is deliberately not
 * about the run's transcript — it is that the agent is STILL SERVING after the
 * drop. A test of the read loop in isolation would pass against a build that
 * still crashes.
 *
 * The stub below sends a valid opening frame and then destroys the socket
 * without a close frame, which is what a container restart looks like from the
 * client side — not an empty response, and not a clean end.
 */

const AGENT = path.join(__dirname, "server.mjs");

/** A backend that starts answering and then has its socket yanked. */
async function droppingBackend(): Promise<{
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
    // A real frame first: the agent must be mid-read, not mid-connect.
    res.write(`data: {"type":"text-delta","id":"t1","delta":"work"}\n\n`);
    // Then the yank — destroy the underlying socket, no terminal frame.
    setTimeout(() => res.socket?.destroy(), 30);
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

describe("the queue agent, when the model backend dies mid-stream", () => {
  it("keeps serving instead of crashing the process", async () => {
    const backend = await droppingBackend();
    let agent: ChildProcess | undefined;
    try {
      const port = 8100 + Math.floor(process.hrtime()[1] % 400) + 100;
      agent = spawn(process.execPath, [AGENT, "--port", String(port)], {
        env: {
          ...process.env,
          AGENT_PORT: String(port),
          FASTAPI_URL: backend.url,
          OPENSWE_MODEL_URL: backend.url,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      expect(await waitForHealth(port)).toBe(true);

      /**
       * DRIVE A REAL RUN. The route sequence matters and the first version of
       * this test got it wrong: it POSTed to `/threads/{t}/runs/stream`, which
       * matches no route, took a 404, and never reached the read loop at all.
       * It passed against the unguarded build — a check that named the
       * property and could not fail. The three steps below are the actual
       * protocol: create thread, create run, then GET the stream.
       */
      const thread = await fetch(`http://127.0.0.1:${port}/threads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ metadata: {} }),
      }).then((r) => r.json() as Promise<{ thread_id: string }>);

      const runId = (
        await fetch(
          `http://127.0.0.1:${port}/threads/${thread.thread_id}/runs`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              input: {
                messages: [{ role: "user", content: "fix the parser" }],
              },
            }),
          }
        ).then((r) => r.json() as Promise<{ run_id: string }>)
      ).run_id;

      await fetch(
        `http://127.0.0.1:${port}/threads/${thread.thread_id}/runs/${runId}/stream`
      )
        .then((r) => r.text())
        .catch(() => "");

      /**
       * GUARD THE GUARD. This test already passed once while exercising
       * nothing — a 404 on a mistyped route meant the agent never opened a
       * stream, and "the process is still alive" was true for the boring
       * reason. Asserting the backend was actually reached is what makes the
       * survival assertion below mean something; without it, any future
       * refactor of the route shape silently turns this back into a check that
       * cannot fail.
       */
      expect(backend.hits()).toBeGreaterThan(0);

      // THE ASSERTION. Against the unguarded build the process is gone by now
      // and this fetch fails the same way the settings panel did.
      expect(agent.exitCode).toBeNull();
      expect(await waitForHealth(port, 3_000)).toBe(true);
    } finally {
      agent?.kill("SIGKILL");
      backend.close();
    }
  }, 30_000);
});
