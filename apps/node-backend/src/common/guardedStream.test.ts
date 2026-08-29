/**
 * A mid-stream failure must arrive as a NAMED ERROR, not as a disconnect.
 *
 * #247: chat failed with "upstream backend disconnected mid-stream" while the
 * backend held a 410 saying the model had reached end of life. One environment
 * variable would have fixed it, and the person who could set it was told the
 * connection had dropped. The response head is already flushed by the time the
 * agent can throw, so an unguarded throw and a real disconnect are
 * INDISTINGUISHABLE ON THE WIRE — this is the only layer that still holds the
 * reason.
 */
import { describe, expect, it } from "vitest";
import { errorCode, guardedStream } from "./guardedStream.js";

async function* ok(): AsyncGenerator<string> {
  yield "event: token\ndata: {\"text\":\"hi\"}\n\n";
}

async function* boom(err: unknown): AsyncGenerator<string> {
  yield "event: token\ndata: {\"text\":\"partial\"}\n\n";
  throw err;
}

async function drain(g: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const c of g) out += c;
  return out;
}

describe("guardedStream", () => {
  it("passes a healthy stream through untouched", async () => {
    // The control. Without it, a guard that swallowed everything and emitted
    // only an error frame would satisfy every assertion below.
    expect(await drain(guardedStream(ok()))).toBe(await drain(ok()));
  });

  it("turns a throw into a data-error frame AND a terminal finish", async () => {
    const err = Object.assign(new Error("model reached end of life"), {
      status: 410,
    });
    const out = await drain(guardedStream(boom(err)));

    // What was already streamed is not lost.
    expect(out).toContain('"text":"partial"');

    const payload = JSON.parse(
      out.split("\n").find((l) => l.includes('"data-error"'))!.slice(6)
    );
    expect(payload.data.code).toBe("upstream_410");
    // The provider's own words. Summarising here would discard the only
    // actionable part — the EOL notice IS the fix instruction.
    expect(payload.data.message).toBe("model reached end of life");
    expect(payload.data.retryable).toBe(false);

    // EMITTING THE ERROR IS NOT ENOUGH ON ITS OWN. Without the trailing finish
    // the proxy still reports a disconnect and the client shows BOTH the real
    // cause and the lie that displaced it.
    expect(out.trimEnd().endsWith('data: {"type":"finish","finishReason":"error"}')).toBe(
      true
    );
  });

  it("closes any text block left open by the failure", async () => {
    // An unterminated text-start leaves the client rendering a part that never
    // completes, which reads as a hang rather than an error — the same
    // misattribution one layer up. Only the AI-SDK-v6-native wire opens these;
    // the rung that emits it lands here later, and the guard is ported now.
    async function* v6(): AsyncGenerator<string> {
      yield 'data: {"type":"text-start","id":"t1"}\n\n';
      throw new Error("nope");
    }
    const out = await drain(guardedStream(v6()));
    expect(out).toContain('{"type":"text-end","id":"t1"}');
    expect(out.indexOf("text-end")).toBeLessThan(out.indexOf("data-error"));
  });

  it("a client going away is not reported as a backend failure", async () => {
    // "nobody is left to read the frame, and reporting it would invent an error
    // the run never had."
    async function* aborted(): AsyncGenerator<string> {
      yield "event: token\ndata: {\"text\":\"x\"}\n\n";
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }
    const out = await drain(guardedStream(aborted()));
    expect(out).not.toContain("data-error");
    expect(out).not.toContain("finish");
  });

  it("codes name what the client can do", () => {
    expect(errorCode({ status: 429 })).toEqual({
      code: "upstream_429",
      retryable: true,
    });
    expect(errorCode({ status: 503 })).toEqual({
      code: "upstream_503",
      retryable: true,
    });
    // 4xx is a configuration problem a person must fix — 408/429 are the two
    // documented exceptions, so status class alone is not the rule.
    expect(errorCode({ status: 401 })).toEqual({
      code: "upstream_401",
      retryable: false,
    });
    expect(errorCode(new Error("who knows"))).toEqual({
      code: "backend_error",
      retryable: false,
    });
  });
});
