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
import { FakeToolCallingModel } from "langchain";

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
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
  await new Promise<void>((resolve) => server!.listen(0, resolve));
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
  if (!res.body) return { status: res.status, raw: await res.text(), frames: [] };

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

function parts(frames: string[]): Array<Record<string, unknown>> {
  return frames.map((f) => JSON.parse(f.slice(6)) as Record<string, unknown>);
}

describe("node backend x langchainAdapter — the wire contract", () => {
  it("a streamed reply becomes text-start / text-delta / text-end / finish", async () => {
    const base = await bootWith(new FakeListChatModel({ responses: ["Hi there"] }));
    const { status, raw, frames } = await throughAdapter(base, {
      messages: [{ role: "user", content: "hi" }],
    });

    expect(status).toBe(200);

    // SANITY BEFORE INTERPRETATION. A backend that answered 200 with an empty
    // body would satisfy several assertions below by vacuity — there would be
    // no wrong frame because there would be no frame.
    expect(raw.length, "the backend produced no bytes at all").toBeGreaterThan(0);
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
    // TWO ASSERTIONS, BECAUSE THE SPACE IS LOST BETWEEN THEM AND THAT IS NOT
    // THIS BACKEND'S DOING. The wire carries `{"text":" "}`; langchainAdapter
    // drops it, because its token branch begins `if (!text.trim()) return null`
    // — a whitespace-only chunk is discarded, so "Hi there" reassembles as
    // "Hithere" on the client.
    //
    // That is a defect in the adapter and it affects the two PYTHON runtimes
    // identically — nothing here causes it and nothing here can fix it without
    // editing the adapter, which #7 explicitly forbids: the requirement is that
    // node matches the wire format, not that the transport bends to fit. Filed
    // separately. Both halves are pinned so that a future reader can see the
    // loss is downstream and does not "fix" this backend to compensate.
    expect(
      raw,
      "this backend must put the whitespace token on the wire — if it stops, the " +
        "adapter is no longer the only thing dropping it and the note below is wrong"
    ).toContain('{"text":" "}');

    const text = parts(frames)
      .filter((p) => p.type === "text-delta")
      .map((p) => p.delta)
      .join("");
    expect(
      text,
      "the adapter's whitespace-only-token drop; see the note above"
    ).toBe("Hithere");
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
        return (fetchSpy.getMockImplementation() as never) &&
          originalFetch(input as never, init as never);
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

    expect(input, "no tool-input-available frame reached the client").toBeTruthy();
    expect(output, "no tool-output-available frame reached the client").toBeTruthy();
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
