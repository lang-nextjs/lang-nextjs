import { test, expect, type APIRequestContext } from "@playwright/test";

/**
 * THE MATRIX, EXECUTED — framework × runtime × mode, driving the real tools.
 *
 * `e2e/matrix/matrix.spec.ts` already covers all twelve cells and is honest
 * about what it checks: its own title says "proxy body coords for all 12 cells
 * (real behavior in e2e-django/fastapi)". It mocks `/api/chat/stream` and
 * asserts the selected cell reaches the proxy body. That is the correct subject
 * for a UI test and it is not this one.
 *
 * What nothing covered is whether a cell, once dispatched, actually WORKS. The
 * only place the tools appear today is a curl step in the workflow:
 *
 *     -d '{"messages":[{"role":"user","content":"increment the counter once"}],
 *          "topology":"plan-execute"}'
 *     test "$http_code" = "200"
 *     grep -q '"type":' /tmp/pe-django.txt
 *
 * HTTP 200 and "some frame has a type field". That passes if the model ignores
 * the tool entirely, answers "I cannot do that", and streams a polite refusal —
 * which is exactly the failure a tool-calling matrix needs to detect.
 *
 * THE INVARIANT HERE SURVIVES A NON-DETERMINISTIC MODEL. We do not assert the
 * model calls `increment` exactly once; it may call it twice, or none. We
 * assert that the counter advanced by EXACTLY the number of `increment`
 * invocations the stream reported. That ties observed tool calls to observed
 * state, and it is false for every interesting failure: a tool that is
 * advertised but not wired (calls reported, counter unmoved), a tool that fires
 * twice per request (counter ahead of the calls), and a model that narrates a
 * tool call it never made.
 *
 * SERIAL BY NECESSITY. The counter is one number in one backend process, so
 * cells racing each other would each see the others' increments.
 */

test.describe.configure({ mode: "serial" });

const FRAMEWORKS = ["langchain", "langgraph", "deepagents"] as const;
const TOPOLOGIES = ["react", "plan-execute"] as const;

/**
 * The runtime under test, supplied by the job that stood the backend up.
 *
 * FAILS rather than skips when absent, for the reason llm.spec.ts gives: a
 * silent skip in a job that exists to exercise a live path is a false green.
 */
const RUNTIME = process.env.LIVE_RUNTIME;

interface Observed {
  tools: string[];
  text: string;
}

/** Drive one cell through the app's proxy and report what the stream said. */
async function ask(
  request: APIRequestContext,
  prompt: string,
  framework: string,
  topology: string
): Promise<Observed> {
  const res = await request.post("/api/chat/stream", {
    data: {
      messages: [{ role: "user", parts: [{ type: "text", text: prompt }] }],
      aiBackend: framework,
      pythonBackend: RUNTIME,
      topology,
    },
    timeout: 120_000,
  });
  expect(res.status(), "the proxy should accept this cell").toBe(200);

  const tools: string[] = [];
  const text: string[] = [];
  for (const line of (await res.text()).split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === "[DONE]") continue;
    let frame: { type?: string; toolName?: string; delta?: string };
    try {
      frame = JSON.parse(payload);
    } catch {
      continue;
    }
    if (frame.type === "tool-input-available" && frame.toolName)
      tools.push(frame.toolName);
    if (frame.type === "text-delta") text.push(frame.delta ?? "");
  }
  return { tools, text: text.join("") };
}

/** Read the counter through the agent, and parse the number it reports. */
async function readCounter(
  request: APIRequestContext,
  framework: string,
  topology: string
): Promise<number> {
  const o = await ask(
    request,
    "Use the get_counter tool to read the counter. Reply with only the number.",
    framework,
    topology
  );
  expect(
    o.tools,
    "reading the counter must actually call get_counter, not answer from memory"
  ).toContain("get_counter");
  const m = o.text.match(/-?\d+/);
  expect(m, `no number in the reply: ${JSON.stringify(o.text)}`).not.toBeNull();
  return Number(m![0]);
}

test.beforeAll(() => {
  if (!RUNTIME) {
    throw new Error(
      "LIVE_RUNTIME is not set — this suite exercises a live backend and must " +
        "not silently skip in a job that exists to run it."
    );
  }
});

for (const framework of FRAMEWORKS) {
  for (const topology of TOPOLOGIES) {
    test(`cell ${framework} × ${topology}: the counter advances by exactly the increments reported`, async ({
      request,
    }) => {
      test.setTimeout(300_000);

      const before = await readCounter(request, framework, topology);

      const run = await ask(
        request,
        "Call the increment tool exactly once. Do not call any other tool.",
        framework,
        topology
      );
      const increments = run.tools.filter((t) => t === "increment").length;
      expect(
        increments,
        `this cell reported no increment call at all; tools seen: ${JSON.stringify(run.tools)}`
      ).toBeGreaterThan(0);

      const after = await readCounter(request, framework, topology);

      // The invariant. Not "it went up" — by exactly as much as the stream
      // claimed. "It went up" is satisfied by a tool that double-fires, and a
      // counter that drifts upward faster than the calls that move it is a
      // worse bug than one that does not move.
      expect(
        after - before,
        `${framework} × ${topology}: reported ${increments} increment call(s) ` +
          `but the counter moved from ${before} to ${after}`
      ).toBe(increments);
    });
  }
}

test("every framework advertises both tools for this runtime", async ({
  request,
}) => {
  // The floor the cells stand on. A framework that advertises neither tool
  // would fail every cell above with a confusing message about increments;
  // this says plainly which half is missing.
  for (const framework of FRAMEWORKS) {
    const res = await request.get(`/api/chat/tools?aiBackend=${framework}`);
    if (res.status() !== 200) continue; // not every app exposes this route
    const body = (await res.json()) as
      | string[]
      | { tools?: Array<string | { name?: string }> };
    const names = (Array.isArray(body) ? body : (body.tools ?? [])).map((t) =>
      typeof t === "string" ? t : t?.name
    );
    expect(names, `${framework} should advertise increment`).toContain(
      "increment"
    );
    expect(names, `${framework} should advertise get_counter`).toContain(
      "get_counter"
    );
  }
});
