/**
 * THE ACCEPTANCE CRITERION OF #7, AS A TEST.
 *
 * "POST /api/chat/stream/langchain on the Node backend produces a stream the
 * existing langchainAdapter consumes UNMODIFIED."
 *
 * So this drives the real server over real HTTP, takes the real bytes, and runs
 * them through the real adapter imported from @deepagents-nextjs/server — no
 * fixture, no re-implementation of the transform, and nothing in
 * packages/server touched. If this backend's wire format is wrong, the fix
 * belongs here and not in the adapter; that is the point of pinning the
 * direction of the dependency this way round.
 *
 * ── WHY "IT DID NOT THROW" IS NOT THE ASSERTION ────────────────────────────
 *
 * langchainAdapter's switch ends in `default: return frame` — an unrecognised
 * event type is PASSED THROUGH UNCHANGED, not rejected. So a backend emitting
 * `event: chunk` instead of `event: token` would produce a green test under any
 * assertion that only checks the pipeline ran: the frames would sail through
 * un-normalised and reach the browser as gibberish, which is the failure this
 * criterion exists to prevent, wearing a pass.
 *
 * The assertion that distinguishes them is NO OUTPUT FRAME MAY STILL CARRY AN
 * `event:` HEADER. A frame the adapter understood has been rewritten into an AI
 * SDK v6 `data: {...}` part; a frame it did not understand still looks like
 * what this backend sent. `expectFullyNormalized` below is that check, and
 * every test here runs it.
 *
 * The model is faked, deliberately — this is a test about a WIRE FORMAT, and a
 * real model would make it slow, non-deterministic, and dependent on a key.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import {
  langchainAdapter,
  transformSseStream,
} from "@deepagents-nextjs/server";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { RunnableLambda } from "@langchain/core/runnables";
import type { BaseMessage } from "@langchain/core/messages";
import { FakeToolCallingModel } from "langchain";

/**
 * A fake that reproduces THE THING THAT MAKES #8's PLANNER DANGEROUS.
 *
 * `withStructuredOutput` here is a chat model that emits the JSON as ordinary
 * string CONTENT, parsed on the way out. That is not an invented convenience —
 * it is what apps/fastapi-backend/ai_backends/langgraph.py documents about this
 * exact stack: "Nodes whose `on_chat_model_stream` events emit raw JSON from
 * `with_structured_output` chains." Its `_STRUCTURED_OUTPUT_NODES` exists
 * because that JSON is otherwise user-visible.
 *
 * It matters that the fake behaves this way rather than returning a canned
 * object: a fake whose structured output never reaches `on_chat_model_stream`
 * would make the leak test below UNFALSIFIABLE — routing the planner through
 * the streaming helper would emit nothing and the test would pass on the bug.
 */
class JsonModeFakeModel extends FakeListChatModel {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withStructuredOutput<T = any>(_schema: unknown): any {
    return (this as unknown as RunnableLambda<unknown, BaseMessage>).pipe(
      RunnableLambda.from(
        (m: BaseMessage) => JSON.parse(String(m.content)) as T
      )
    );
  }
}

/*
 * PAY THE COLD IMPORT ONCE, OUTSIDE ANY PER-TEST BUDGET (#411).
 *
 * `bootWith` runs inside the TEST body here, not in a hook, so the cold
 * `import("./server.js")` — measured at 3.2s to 18.7s on 8 cores under
 * contention — was charged to the 5s testTimeout. That is observation 1 in
 * #411: "Test timed out in 5000ms" on the first test, passing on re-run.
 * server.test.ts pays the same cost against a 10s hookTimeout, which is why
 * the same defect wears two different numbers.
 *
 * `vi.resetModules()` does not re-pay it — the transform cache survives, so
 * every later import is single-digit to double-digit milliseconds. One import
 * here makes all of them warm. NO BUDGET IS RAISED; the work stops happening
 * inside one.
 */
await import("./server.js");

let server: Server | undefined;

afterEach(async () => {
  /*
   * Clear the handle BEFORE awaiting, and do not discard what close() reports.
   *
   * The old form threw the callback's error away: `close(() => resolve())`
   * resolves identically whether the server closed or answered
   * `Error: Server is not running.` — so a teardown against a dead handle
   * looked like a successful one. See the paired assertions in server.test.ts;
   * this is the same rule at its second call site, written out rather than
   * shared, because two four-line sites read better than an indirection.
   */
  const s = server;
  server = undefined;
  if (s) {
    await new Promise<void>((resolve, reject) => {
      s.close((err) => (err ? reject(err) : resolve()));
    });
  }
  vi.resetModules();
  vi.doUnmock("./common/llm.js");
});

/**
 * Boot the real app with a given fake model in place of makeLlm().
 *
 * `vi.resetModules()` + a dynamic import per test, rather than a reset hook
 * exported from the backend: `getExecutor()` memoises its agent, so a
 * production-code seam would exist only to let tests swap it — and a seam that
 * only tests use is a second code path nobody runs in anger.
 */
async function bootWith(model: unknown): Promise<string> {
  vi.resetModules();
  vi.doMock("./common/llm.js", () => ({
    makeLlm: () => model,
    llmStatus: () => ({ configured: true, provider: "fake" }),
  }));
  const { createApp } = await import("./server.js");
  server = createApp();
  /*
   * Resolve on LISTENING, reject on ERROR. Awaiting only the success callback
   * means a startup that fails never settles and the test dies at its budget —
   * so "did not start" and "started slowly" produce the same observation, which
   * is most of why #411 read as a load problem for four sightings.
   */
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(0, () => {
      server!.removeListener("error", reject);
      resolve();
    });
  });
  const { port } = server!.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/** POST a turn and return the AI SDK v6 frames the adapter produced. */
async function throughAdapter(
  base: string,
  body: Record<string, unknown>
): Promise<{ status: number; raw: string; frames: string[] }> {
  const res = await fetch(`${base}/api/chat/stream/langchain`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.body)
    return { status: res.status, raw: await res.text(), frames: [] };

  // Tee, so the same bytes can be asserted on in both forms: what this backend
  // put on the wire, and what the adapter made of it.
  const [toAdapter, toRaw] = res.body.tee();
  const rawText = await new Response(toRaw).text();

  const out = transformSseStream(toAdapter, langchainAdapter.transforms);
  const outText = await new Response(out).text();
  const frames = outText
    .split("\n\n")
    .map((f) => f.trim())
    .filter(Boolean);
  return { status: res.status, raw: rawText, frames };
}

/** Every emitted frame is an AI SDK v6 part — none survived un-normalised. */
function expectFullyNormalized(frames: string[]): void {
  const leftovers = frames.filter((f) => /(^|\n)event:/.test(f));
  expect(
    leftovers,
    "the adapter passed these frames through unchanged, which means it did not " +
      "recognise them. Its `default` branch does that silently, so this is what " +
      "a wire-format mismatch looks like — not an exception."
  ).toEqual([]);
  for (const f of frames) {
    expect(f.startsWith("data: "), `not an SSE data frame: ${f}`).toBe(true);
    expect(() => JSON.parse(f.slice(6))).not.toThrow();
  }
}

/**
 * The text THIS BACKEND put on the wire, reassembled from its token frames.
 *
 * Needed because the wire is CHUNKED PER WORD — "did step one" arrives as
 * `{"text":"did"}`, `{"text":" "}`, `{"text":"step"}` — so a substring search
 * over `raw` fails on text that is genuinely there, one frame at a time.
 *
 * It joins the `token` frames and nothing else, which is exactly "what this
 * backend emitted as prose", and it is deliberately NOT the adapter's output:
 * these are claims about what THIS BACKEND sends, and checking them after
 * normalisation would also pass if the adapter mangled them.
 *
 * (An earlier draft justified this partly by the adapter dropping
 * whitespace-only tokens. #347 fixed that — a space is content now — so the
 * reason above is the one that still holds. Noted rather than silently edited,
 * because a comment whose stated reason has expired is how a test ends up
 * defending a behaviour nobody has any more.)
 */
function rawTokenText(raw: string): string {
  return raw
    .split("\n\n")
    .filter((f) => f.startsWith("event: token"))
    .map((f) => {
      const line = f.split("\n").find((l) => l.startsWith("data: "));
      return line
        ? (JSON.parse(line.slice(6)) as { text?: string }).text ?? ""
        : "";
    })
    .join("");
}

function parts(frames: string[]): Array<Record<string, unknown>> {
  return frames.map((f) => JSON.parse(f.slice(6)) as Record<string, unknown>);
}

describe("node backend x langchainAdapter — the wire contract", () => {
  it("a streamed reply becomes text-start / text-delta / text-end / finish", async () => {
    const base = await bootWith(
      new FakeListChatModel({ responses: ["Hi there"] })
    );
    const { status, raw, frames } = await throughAdapter(base, {
      messages: [{ role: "user", content: "hi" }],
    });

    expect(status).toBe(200);

    // SANITY BEFORE INTERPRETATION. A backend that answered 200 with an empty
    // body would satisfy several assertions below by vacuity — there would be
    // no wrong frame because there would be no frame.
    expect(raw.length, "the backend produced no bytes at all").toBeGreaterThan(
      0
    );
    expect(frames.length, "the adapter produced no frames").toBeGreaterThan(0);

    expectFullyNormalized(frames);

    const types = parts(frames).map((p) => p.type);
    expect(types[0]).toBe("text-start");
    expect(types).toContain("text-delta");
    // The order AI SDK v6 requires: the text block is closed before finish.
    expect(types.indexOf("text-end")).toBeLessThan(types.indexOf("finish"));
    expect(types.at(-1)).toBe("finish");

    // THE TEXT ACTUALLY ARRIVED. Asserting only the frame TYPES would pass on a
    // stream of empty deltas.
    //
    // TWO ASSERTIONS, AND THEY NOW AGREE (#347 fixed the adapter).
    //
    // This pair used to document a LOSS: the wire carried `{"text":" "}`, langchainAdapter's
    // token branch began `if (!text.trim()) return null`, and "Hi there" reassembled as
    // "Hithere" on the client. Both halves were pinned deliberately so nobody would "fix"
    // this backend to compensate for a defect one layer downstream.
    //
    // The adapter now distinguishes an EMPTY delta from a WHITESPACE one, so the space
    // survives and the two halves say the same thing. THE FIRST ASSERTION IS STILL WORTH ITS
    // LINE, and more so than before: it is what tells a future reader that this backend put
    // the space on the wire, so if the reassembly below ever regresses, the cause is upstream
    // of here and not in this file.
    expect(
      raw,
      "this backend must put the whitespace token on the wire — the reassembly below is only " +
        "meaningful if the space was actually sent"
    ).toContain('{"text":" "}');

    const text = parts(frames)
      .filter((p) => p.type === "text-delta")
      .map((p) => p.delta)
      .join("");
    expect(
      text,
      "the adapter must preserve a whitespace-only token — see #347; this read 'Hithere' " +
        "while it did not"
    ).toBe("Hi there");
  });

  it("a tool call becomes tool-input-available and tool-output-available, paired", async () => {
    // `responses` is accepted at runtime but absent from the published type
    // for this version, so the shape is asserted here rather than silently
    // dropped by a cast of the whole constructor.
    const model = new FakeToolCallingModel({
      toolCalls: [[{ name: "get_counter", args: {}, id: "call_1" }], []],
      ...({ responses: ["", "done"] } as Record<string, unknown>),
    });
    // The tool itself is stubbed at the network boundary — this test is about
    // frame pairing, not about the counter app being up.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        if (String(input).includes("/api/counter")) {
          return new Response(JSON.stringify({ counter: 7 }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        return (
          (fetchSpy.getMockImplementation() as never) &&
          originalFetch(input as never, init as never)
        );
      });

    const base = await bootWith(model);
    const { status, raw, frames } = await throughAdapter(base, {
      messages: [{ role: "user", content: "read the counter" }],
    });
    fetchSpy.mockRestore();

    expect(status).toBe(200);
    expect(raw.length).toBeGreaterThan(0);
    expectFullyNormalized(frames);

    const p = parts(frames);
    const input = p.find((x) => x.type === "tool-input-available");
    const output = p.find((x) => x.type === "tool-output-available");

    expect(
      input,
      "no tool-input-available frame reached the client"
    ).toBeTruthy();
    expect(
      output,
      "no tool-output-available frame reached the client"
    ).toBeTruthy();
    expect(input!.toolName).toBe("get_counter");

    // THE PAIRING IS THE WHOLE THING. The client matches result to call by
    // toolCallId alone; a mismatch does not error, it leaves the card pending
    // forever — which looks like a slow tool rather than a broken one.
    expect(
      output!.toolCallId,
      "the result's id does not match the call's, so the UI card can never be completed"
    ).toBe(input!.toolCallId);
    expect(String(output!.output)).toContain("Counter is 7");

    // The arguments are an OBJECT, not LangChain JS's `{input: "<json>"}`
    // wrapper. See unwrapToolInput — passing the wrapper through would render
    // every tool as having one string argument called `input`.
    expect(input!.input).toEqual({});
  });
});

const originalFetch = globalThis.fetch;

/**
 * #8 — PLAN-EXECUTE, AND THE ONE FRAME THAT MUST NEVER APPEAR.
 *
 * The planner is a `withStructuredOutput` chain. Streaming it puts the raw JSON
 * of the Plan object on the wire as `event: token`, which every layer accepts:
 * the frames are well-formed, the adapter normalises them, and the user reads a
 * serialised object where a plan should be. `expectFullyNormalized` CANNOT
 * catch it — the frames are perfectly valid, they are just wrong.
 *
 * That is the third distinct way a port of this backend has gone wrong. #9 was
 * omitting a named filter; #10 was a correct Python line inverting in JS. This
 * one has NOTHING TO CARRY OVER: the protection is `invoke` instead of
 * `streamEvents`, an absence with no artifact to copy or forget — so the
 * idiomatic move, reusing the streaming helper that is already there, is the
 * broken one.
 */
describe("node backend x plan-execute — the planner must not reach the wire", () => {
  const PLAN = { steps: ["call increment()", "report the value"] };
  const EXECUTOR_REPLIES = ["did step one", "did step two"];

  /**
   * THE PLANNER AND THE EXECUTOR NEED DIFFERENT ANSWERS, and the first version
   * of this suite did not give them any. `bootWith` swaps makeLlm() globally,
   * so one canned response served both — and the executor dutifully replied
   * with the plan JSON as its prose. The leak assertion then failed against
   * the EXECUTOR's output while the planner was behaving perfectly.
   *
   * A false positive, but an instructive one: it would have been just as easy
   * for it to fail the other way and report a passing leak test that was
   * actually reading the wrong stream.
   *
   * FakeListChatModel advances through `responses` per call, so index 0 is the
   * planner's invoke and 1..n are the per-step executor runs.
   */
  async function bootPlanner() {
    return bootWith(
      new JsonModeFakeModel({
        responses: [JSON.stringify(PLAN), ...EXECUTOR_REPLIES],
      })
    );
  }

  it("THE HEADLINE: no token frame carries the serialised plan object", async () => {
    const base = await bootPlanner();
    const { status, raw, frames } = await throughAdapter(base, {
      messages: [{ role: "user", content: "increment twice" }],
      topology: "plan-execute",
    });

    expect(status).toBe(200);
    // Sanity before interpretation — a backend that produced nothing would
    // satisfy every "must not contain" assertion below by vacuity.
    expect(raw.length, "the backend produced no bytes at all").toBeGreaterThan(
      0
    );
    expect(frames.length, "the adapter produced no frames").toBeGreaterThan(0);

    // The leak, asserted on the RAW wire rather than on the adapter's output,
    // because this is a claim about what this backend emits. Checking after
    // normalisation would also pass if the adapter happened to drop it.
    const emitted = rawTokenText(raw);
    expect(
      emitted,
      "the planner's structured output reached the wire — the planner was " +
        "streamed instead of invoked. See streamAgentEvents in ai_backends/langchain.ts."
    ).not.toContain('"steps"');
    // Belt and braces on the untouched bytes too: the reconstruction above
    // only reads `token` frames, so a leak arriving as some OTHER frame type
    // would slip past it.
    expect(raw).not.toContain('\\"steps\\"');

    // And the same claim stated positively about what the user actually reads.
    const text = parts(frames)
      .filter((p) => p.type === "text-delta")
      .map((p) => String(p.delta))
      .join("");
    expect(text).not.toContain('"steps"');
    expect(text).not.toContain("{");
  });

  it("the plan is rendered as PROSE, which is what the leak would replace", async () => {
    // The companion. "No JSON on the wire" is fully satisfied by a topology
    // that emits nothing at all, and a planner that silently produced no
    // output is a real failure mode — it is what #9 looked like from the far
    // side. These assert the plan DID arrive, in the form it should.
    const base = await bootPlanner();
    const { raw, frames } = await throughAdapter(base, {
      messages: [{ role: "user", content: "increment twice" }],
      topology: "plan-execute",
    });
    const text = parts(frames)
      .filter((p) => p.type === "text-delta")
      .map((p) => String(p.delta))
      .join("");

    expect(text).toContain("Planning");
    expect(text).toContain("Plan:");
    for (const step of PLAN.steps) expect(text).toContain(step);
    expect(text).toContain("Step 1:");
    expect(text).toContain("Step 2:");

    /*
     * THE EXECUTOR ACTUALLY RAN, asserted on the RAW WIRE rather than on the
     * adapter's output, because this is a claim about what THIS BACKEND emits.
     * Checking it after normalisation would also pass if the adapter mangled
     * it — which it did until #347, and the point of asserting here is that it
     * would not have mattered either way.
     *
     * Without this assertion the prelude alone satisfies everything above, and
     * a plan that is printed but never executed is exactly what a broken loop
     * looks like from the outside.
     */
    expect(
      rawTokenText(raw),
      "the executor produced no output — the plan was printed but never run"
    ).toContain(EXECUTOR_REPLIES[0]);
  });

  it("every frame is still fully normalised — the wire format did not drift", async () => {
    const base = await bootPlanner();
    const { frames } = await throughAdapter(base, {
      messages: [{ role: "user", content: "increment twice" }],
      topology: "plan-execute",
    });
    expectFullyNormalized(frames);
  });

  it("ONE terminator for the whole run, not one per step", async () => {
    // Each step streams an agent run, and the obvious per-step loop emits a
    // terminator with it. `event: message` is the adapter's isTerminal
    // predicate, so a second one ends the stream early: the client would stop
    // reading after step 1 and every later step would be silently discarded.
    const base = await bootPlanner();
    const { raw, frames } = await throughAdapter(base, {
      messages: [{ role: "user", content: "increment twice" }],
      topology: "plan-execute",
    });

    expect(raw.split("event: message").length - 1).toBe(1);
    expect(
      parts(frames).filter((p) => p.type === "finish").length,
      "more than one finish means the client stopped reading mid-plan"
    ).toBe(1);
  });

  it("a planner that returns no steps says so and still terminates", async () => {
    // A DELIBERATE DIVERGENCE FROM PYTHON, on an error path. Python reads
    // plan.steps straight into a comprehension, so an empty plan raises
    // mid-generator and the stream ends with no terminator — which
    // guardedStream reports as `upstream_disconnect`, blaming the transport
    // for a modelling failure and sending the debugger to the wrong layer.
    const base = await bootWith(
      new JsonModeFakeModel({ responses: [JSON.stringify({ steps: [] })] })
    );
    const { status, raw, frames } = await throughAdapter(base, {
      messages: [{ role: "user", content: "do nothing" }],
      topology: "plan-execute",
    });

    expect(status).toBe(200);
    expect(raw).toContain("event: message");
    const types = parts(frames).map((p) => p.type);
    expect(types.at(-1)).toBe("finish");
    const text = parts(frames)
      .filter((p) => p.type === "text-delta")
      .map((p) => String(p.delta))
      .join("");
    expect(text).toContain("no steps");
  });
});
