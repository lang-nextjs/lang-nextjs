import { describe, expect, it, beforeEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { AddressInfo } from "node:net";
import path from "node:path";
import { listGraphIds, circuitBreaker } from "../lib/langgraph-client";
import { classifyTopology } from "../lib/backend-topology";

/**
 * THE QUEUE AGENT ANSWERS #423's PROBE.
 *
 * Reported on a working live run: every card carried
 *
 *   Could not determine whether this backend runs more than one graph
 *   ({"error":"unhandled POST /assistants/search"}). This view follows a
 *   single thread, so it may be showing part of the agent.
 *
 * The notice was correct. `POST /assistants/search` was the one Platform route
 * this agent did not implement, so the app genuinely could not tell a COMPLETE
 * single-thread view from one third of a three-graph Open SWE — and
 * backend-topology.ts is explicit that collapsing "I could not ask" into "it is
 * single-run" is the defect #423 exists to prevent.
 *
 * WHY THIS DRIVES THE APP'S OWN CLIENT. The interesting failure is not "the
 * route returns 200" — it is whether what this agent emits survives the code
 * that reads it. `listGraphIds` and `classifyTopology` are imported and run
 * here, not reimplemented: a test that re-derived their two lines would agree
 * with itself while the app disagreed, which is the seam this repo keeps
 * finding on the wrong side of.
 */

const AGENT = path.join(__dirname, "server.mjs");

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

async function withAgent<T>(
  env: Record<string, string>,
  fn: (url: string) => Promise<T>
): Promise<T> {
  const port = await freePort();
  let agent: ChildProcess | undefined;
  try {
    agent = spawn(process.execPath, [AGENT, "--port", String(port)], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(await waitForHealth(port)).toBe(true);
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    agent?.kill("SIGKILL");
  }
}

/** A backend that speaks HTTP and does not know the route — the old behaviour. */
async function backendWithoutTheRoute<T>(
  fn: (url: string) => Promise<T>
): Promise<T> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unhandled POST /assistants/search" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

describe("the queue agent, asked what graphs it registers", () => {
  // The breaker is module state shared by every caller in this file. Five
  // failures open it, and the control arm below deliberately produces one.
  beforeEach(() => circuitBreaker.reset());

  it("answers the app's own probe with the one graph it runs", async () => {
    const ids = await withAgent({}, (url) => listGraphIds(url));
    expect(ids).toEqual(["agent"]);
  }, 30_000);

  it("and the app classifies that as KNOWN and single-graph", async () => {
    /*
     * The user-visible claim. `known: false` is what put the notice on screen;
     * `known: true, multiGraph: false` is what makes RunTopologyNotice render
     * nothing — which is correct here, because against this backend the
     * single-thread view really is the whole agent.
     */
    const ids = await withAgent({}, (url) => listGraphIds(url));
    expect(classifyTopology(ids)).toEqual({
      known: true,
      graphs: ["agent"],
      multiGraph: false,
    });
  }, 30_000);

  it("names the graph the app asks runs for, not a literal of its own", async () => {
    /*
     * `createRun` sends `OPEN_SWE_ASSISTANT_ID ?? "agent"` as `assistant_id`.
     * If this agent hardcoded "agent" instead of reading the same variable, a
     * forker who set it would get a backend advertising a graph the app never
     * requests — two facts that must agree, with nothing asserting they do.
     *
     * This case is also what stops the two above from passing on a hardcoded
     * literal: they cannot tell the two implementations apart.
     */
    const ids = await withAgent({ OPEN_SWE_ASSISTANT_ID: "manager" }, (url) =>
      listGraphIds(url)
    );
    expect(ids).toEqual(["manager"]);
  }, 30_000);

  it("THE CONTROL: a backend without the route still reports unknown", async () => {
    /*
     * Without this the three cases above are satisfied by a `listGraphIds` that
     * returns ["agent"] for anything. This is the pre-fix behaviour, reproduced
     * exactly — a 404 carrying the error body the notice quoted — and it must
     * still fail, so that "known" above is a fact about the agent rather than
     * about the client.
     */
    await expect(
      backendWithoutTheRoute((url) => listGraphIds(url))
    ).rejects.toThrow();

    circuitBreaker.reset();
    // And the app turns that failure into UNKNOWN, never into single-run.
    expect(classifyTopology([])).toEqual({
      known: false,
      reason: "the backend registered no graphs",
    });
  }, 30_000);
});
