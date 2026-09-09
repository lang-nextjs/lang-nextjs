import { afterEach, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let agent: ChildProcess | undefined;
let backend: Server | undefined;
let directory: string | undefined;
let base: string;
let upstream: string;
let hits = 0;

async function eventually(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Condition did not become true");
}

async function stopAgent() {
  if (!agent) return;
  const exited = once(agent, "exit");
  agent.kill("SIGKILL");
  await exited;
  agent = undefined;
}

async function startAgent() {
  agent = spawn(
    process.execPath,
    [path.join(__dirname, "server.mjs"), "--port", "0"],
    {
      env: {
        ...process.env,
        OPENSWE_MODEL_URL: upstream,
        OPENSWE_STATE_FILE: path.join(directory!, "state.json"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  const output = await new Promise<string>((resolve, reject) => {
    agent!.stdout!.once("data", (data) => resolve(String(data)));
    agent!.once("exit", (code) => reject(new Error(`Agent exited: ${code}`)));
  });
  const port = output.match(/listening on :(\d+)/)?.[1];
  expect(port).toBeTruthy();
  expect(port).not.toBe("0");
  base = `http://127.0.0.1:${port}`;
}

async function setup(respond: (response: ServerResponse) => void) {
  directory = mkdtempSync(path.join(tmpdir(), "queue-lifecycle-"));
  hits = 0;
  backend = createServer((_request, response) => {
    hits += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    respond(response);
  });
  backend.listen(0, "127.0.0.1");
  await once(backend, "listening");
  upstream = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
  await startAgent();
}

async function post(route: string, body = {}) {
  const response = await fetch(base + route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return response.json();
}

async function createRun() {
  const thread = await post("/threads");
  const run = await post(`/threads/${thread.thread_id}/runs`, {
    input: { messages: [{ role: "user", content: "Remember this task" }] },
  });
  return {
    thread,
    run,
    stream: `/threads/${thread.thread_id}/runs/${run.run_id}/stream`,
  };
}

async function record(runId: string) {
  return fetch(`${base}/runs/${runId}`).then((response) => response.json());
}

afterEach(async () => {
  await stopAgent();
  backend?.closeAllConnections();
  await new Promise<void>((resolve) =>
    backend ? backend.close(() => resolve()) : resolve()
  );
  backend = undefined;
  if (directory) rmSync(directory, { recursive: true, force: true });
});

const answer =
  'data: {"type":"text-delta","id":"text","delta":"Actual answer"}\n\n';
const finish = 'data: {"type":"finish","finishReason":"stop"}\n\n';

it("accepts an explicit DONE marker after a real answer", async () => {
  await setup((response) => response.end(answer + "data: [DONE]\n\n"));
  const { run } = await createRun();
  await eventually(async () => (await record(run.run_id)).status === "success");
  expect((await record(run.run_id)).reply).toBe("Actual answer");
});

it("executes without subscribers, replays without reinference, and survives restart", async () => {
  await setup((response) => response.end(answer + finish));
  const { run, thread, stream } = await createRun();
  await eventually(async () => (await record(run.run_id)).status === "success");
  expect(hits).toBe(1);
  const streams = await Promise.all([
    fetch(base + stream).then((response) => response.text()),
    fetch(base + stream).then((response) => response.text()),
  ]);
  expect(streams[0]).toBe(streams[1]);
  expect(streams[0]).toContain("Actual answer");
  expect(hits).toBe(1);
  await stopAgent();
  await startAgent();
  expect((await record(run.run_id)).reply).toBe("Actual answer");
  expect(await fetch(base + stream).then((response) => response.text())).toBe(
    streams[0]
  );
  expect(hits).toBe(1);
  const next = await createRun();
  expect(next.thread.thread_id).not.toBe(thread.thread_id);
  expect(next.run.run_id).not.toBe(run.run_id);
});

it("shares an active execution and cancellation aborts upstream permanently", async () => {
  let disconnected = false;
  await setup((response) => {
    response.write(answer);
    response.on("close", () => {
      disconnected = true;
    });
  });
  const { run, stream } = await createRun();
  const first = await fetch(base + stream);
  const second = await fetch(base + stream);
  await first.body!.cancel();
  expect((await record(run.run_id)).status).toBe("running");
  expect(hits).toBe(1);
  await post(`/runs/${run.run_id}/cancel`);
  await second.text();
  await eventually(async () => disconnected);
  expect((await record(run.run_id)).status).toBe("interrupted");
  await fetch(base + stream).then((response) => response.text());
  expect(hits).toBe(1);
  expect((await record(run.run_id)).status).toBe("interrupted");
});

it("marks interrupted work on restart without replaying side effects", async () => {
  await setup((response) => response.write(answer));
  const { run } = await createRun();
  await eventually(async () => hits === 1);
  await stopAgent();
  await startAgent();
  expect((await record(run.run_id)).status).toBe("interrupted");
  expect(hits).toBe(1);
});

it.each([
  [
    "provider failure",
    answer +
      'data: {"type":"data-error","data":{"message":"overloaded"}}\n\n' +
      finish,
  ],
  ["missing finish", answer],
  ["empty response", finish],
])(
  "does not mark %s successful or invent a scripted answer",
  async (_label, frames) => {
    await setup((response) => response.end(frames));
    const { run, stream } = await createRun();
    const output = await fetch(base + stream).then((response) =>
      response.text()
    );
    expect((await record(run.run_id)).status).toBe("error");
    expect(output).not.toContain("parser");
    expect((await record(run.run_id)).scripted).not.toBe(true);
  }
);

it("parses a final frame without a trailing newline", async () => {
  await setup((response) => response.end(answer + finish.trimEnd()));
  const { run } = await createRun();
  await eventually(async () => (await record(run.run_id)).status === "success");
  expect((await record(run.run_id)).reply).toBe("Actual answer");
});
