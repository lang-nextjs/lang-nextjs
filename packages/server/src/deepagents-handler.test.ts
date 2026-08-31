/**
 * Behavioural tests for createDeepAgentsHandler — the DeepAgents rung's convenience entry point.
 *
 * These lived in index.test.ts, which is a CORE barrel test. That put rung-3 behaviour in a file
 * every fork keeps, so `pnpm eject langgraph` left index.test.ts calling a symbol its own barrel
 * no longer exported — a hard type error that failed the fork.
 *
 * The split is not cosmetic. index.test.ts asserts things about the barrel that are true at every
 * rung (defaultTransforms is a non-empty array of callables). These assert the behaviour of one
 * rung's wrapper, and so belong to that rung: rungs.json claims this file for `deepagents`, and
 * eject deletes it alongside deepagents-handler.ts itself.
 *
 * Core transport behaviour is NOT tested here — createSseProxyHandler is the rung-free
 * constructor and keeps its own coverage, which survives every eject.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createDeepAgentsHandler } from "./deepagents-handler";
import { createSseProxyHandler } from "./handler";

describe("createDeepAgentsHandler — the DeepAgents rung entry point", () => {
  it("is a function", () => {
    expect(typeof createDeepAgentsHandler).toBe("function");
  });

  it("returns a handler function (factory smoke test)", () => {
    const handler = createDeepAgentsHandler({ backendUrl: "http://backend" });
    expect(typeof handler).toBe("function");
  });

  it("does not throw at construction time on an empty backendUrl", () => {
    // The handler is a factory — construction must succeed regardless of backendUrl value;
    // runtime guards (e.g. 503) live in the handler body.
    // DESIGNED TO FAIL if the factory eagerly validates and throws.
    expect(() => createDeepAgentsHandler({ backendUrl: "" })).not.toThrow();
  });
});

/**
 * THE DEFAULT BINDING, OBSERVED (#518).
 *
 * Everything above is a callability assertion. Measured: delete `?? deepagentsAdapter`
 * from deepagents-handler.ts and all three still pass, because none of them looks at a
 * frame. The same was true of the only other call site that omits the adapter —
 * packages/edge/src/readme-quickstart.test.ts asserts `typeof handler` and nothing else.
 * So ADAPT-02's claim, "`deepagentsAdapter` as default", was implemented, documented in
 * this file's own header, and asserted NOWHERE.
 *
 * HOW IT GOT THAT WAY, because the mechanism is reusable and worth naming. #17b migrated
 * handler.test.ts off `createDeepAgentsHandler` onto `createSseProxyHandler` with an
 * explicitly-passed `coreDefaultAdapter`, so the transport tests would survive
 * `eject langchain`. That migration was correct and its own comment says it "changes no
 * assertion" — true of what the assertions CLAIM, false of what they COVER. Every test
 * that had incidentally exercised the default binding now passes an adapter explicitly.
 * THE COVERAGE WAS THINNED IN A RELOCATION AND THE ✓ DID NOT NOTICE.
 *
 * The assertion below is the one that dies when the binding does.
 */
describe("the default adapter is bound, not merely documented", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A finish frame carrying a messageId — exactly what the default adapter must strip. */
  const FINISH_WITH_ID = 'data: {"type":"finish","messageId":"msg-1"}\n\n';

  const stubBackend = (body: string) =>
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(new TextEncoder().encode(body), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      )
    );

  const makeRequest = () =>
    ({
      headers: new Headers(),
      arrayBuffer: async () => new TextEncoder().encode("").buffer,
    } as never);

  async function drain(response: Response): Promise<string> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
    return out + decoder.decode();
  }

  it("omitting `adapter` still strips messageId from a finish frame", async () => {
    stubBackend(FINISH_WITH_ID);
    // NO adapter. This is the whole point: the binding is the only thing that can put a
    // transform in the pipeline here.
    const handler = createDeepAgentsHandler({ backendUrl: "http://backend" });
    const out = await drain(await handler(makeRequest()));

    // The frame reached the output at all — otherwise "no messageId" is a fact about an
    // empty stream rather than about the strip.
    expect(out, "the finish frame never reached the output").toContain(
      '"type":"finish"'
    );
    expect(
      out,
      "messageId survived with no adapter passed — `?? deepagentsAdapter` is not binding the default, so the DeepAgents entry point is now a bare transport proxy"
    ).not.toContain("messageId");
  });

  it("CONTROL: the transport core does NOT strip it, so the strip above is the binding's doing", async () => {
    // Without this, the first test passes just as well if the CORE strips messageId
    // unconditionally — and deleting the binding would leave it green. The control fails
    // if the strip ever moves into the core, which is the one change that would make the
    // first assertion stop meaning what it says.
    stubBackend(FINISH_WITH_ID);
    const bare = createSseProxyHandler({
      backendUrl: "http://backend",
      adapter: { name: "no-op (control)", transforms: [] },
    });
    const out = await drain(await bare(makeRequest()));

    expect(out, "the finish frame never reached the output").toContain(
      '"type":"finish"'
    );
    expect(
      out,
      "the transport core stripped messageId with an empty adapter — the strip is no longer evidence that the default was bound"
    ).toContain("messageId");
  });
});
