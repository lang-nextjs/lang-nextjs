/**
 * ADAPT-01: THE PIPELINE IS `[...adapter.transforms, ...options.transforms]`, IN THAT ORDER.
 *
 * WHY THIS FILE EXISTS — the previous test could not fail on the property it named:
 *
 *     const seen: string[] = [];
 *     const spy: SseTransform = (f) => { seen.push("user"); return f; };
 *     const combined = [...defaultTransforms, spy];   // the TEST builds the order
 *     applyPipeline(combined, frame);
 *     expect(seen).toEqual(["user"]);                 // true under EITHER order
 *
 * Two independent defects, and the second is the one that made it VACUOUS rather than
 * merely weak:
 *
 *   1. ITS SUBJECT WAS ITS OWN CONSTRUCTION. It built `combined` by hand and then checked
 *      that `applyPipeline` ran what it had been handed. The claim is about the ORDER THE
 *      HANDLER ASSEMBLES, which that arrangement never consults.
 *   2. ONLY ONE STAGE RECORDED. `seen` was written by the spy alone, so it read `["user"]`
 *      whichever side of `defaultTransforms` the spy sat on. Flipping the order left every
 *      assertion identical — measured: all 12 tests still passed.
 *
 * A test whose recorded value is invariant under the mutation it exists to catch is not a
 * weak test, it is an absent one wearing a test's name — and it is worse than nothing,
 * because someone looking for coverage of ADAPT-01 finds it, sees the requirement in the
 * title, and stops.
 *
 * SO THE REPAIR HAS TWO PARTS, and both are required:
 *   · exercise the HANDLER, so the order under test is the one production builds;
 *   · have BOTH stages write to the same record, so swapping them changes it.
 *
 * DO NOT "SIMPLIFY" THIS BY ASSERTING ONLY THAT THE USER TRANSFORM RAN. That is precisely
 * the shape that was here before, and it passes with the pipeline reversed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createSseProxyHandler } from "./handler";
import type { SseAdapter } from "./adapter-contract";
import type { SseFrame, SseTransform } from "./accumulator";

/**
 * A transform that appends its own letter to the frame's `text`.
 *
 * The APPEND is what makes order observable: two stages writing to one string leave their
 * sequence in the result, where a boolean "did it run" leaves nothing. `A` for the adapter
 * stage, `U` for the user stage — so the pipeline's order is legible as `xAU` or `xUA`
 * rather than inferred.
 */
const appendMark = (mark: string): SseTransform =>
  ((frame: SseFrame): SseFrame => {
    const body = frame.raw.slice("data: ".length);
    try {
      const parsed = JSON.parse(body) as { type?: string; text?: string };
      if (parsed.type !== "text") return frame;
      return {
        ...frame,
        raw: `data: ${JSON.stringify({ ...parsed, text: `${parsed.text ?? ""}${mark}` })}`,
      };
    } catch {
      return frame;
    }
  }) as SseTransform;

const adapterMarking = (mark: string): SseAdapter =>
  ({ name: `mark-${mark}`, transforms: [appendMark(mark)] }) as unknown as SseAdapter;

function upstream(body: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      status: 200,
      headers: new Headers(),
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(body));
          c.close();
        },
      }),
    }))
  );
}

const makeRequest = () =>
  ({
    headers: new Headers(),
    arrayBuffer: async () => new TextEncoder().encode("{}").buffer,
  }) as never;

async function textOf(res: Response): Promise<string> {
  const raw = await new Response(res.body).text();
  const line = raw.split("\n").find((l) => l.includes('"type":"text"'));
  return line ? (JSON.parse(line.slice("data: ".length)).text as string) : "";
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe("ADAPT-01 — adapter transforms run BEFORE user transforms", () => {
  it("records both stages, so the order is in the result rather than inferred", async () => {
    // THE ASSERTION THE OLD TEST COULD NOT MAKE. `xAU` says the adapter's transform ran
    // first and the user's second. Reverse the pipeline and this reads `xUA` — a different
    // value, so the test goes red. That is the entire difference from the version this
    // replaces, which recorded a value identical under both orders.
    upstream('data: {"type":"text","text":"x"}\n\n');
    const handler = createSseProxyHandler({
      backendUrl: "http://backend",
      adapter: adapterMarking("A"),
      transforms: [appendMark("U")],
    });
    const res = (await handler(makeRequest())) as unknown as Response;
    expect(await textOf(res)).toBe("xAU");
  });

  it("CONTROL: the marks are order-sensitive, not merely both present", async () => {
    // Guards the assertion above against a weaker reading. If `appendMark` were
    // order-insensitive — writing to a set, or sorting — then `xAU` would hold under a
    // reversed pipeline too and the first test would be vacuous again for a new reason.
    // Applying the same two transforms in the opposite order must produce a DIFFERENT
    // string; if it does not, the instrument cannot see order and nothing above means
    // anything.
    const frame: SseFrame = { raw: 'data: {"type":"text","text":"x"}' };
    const forward = appendMark("U")(appendMark("A")(frame) as SseFrame) as SseFrame;
    const reverse = appendMark("A")(appendMark("U")(frame) as SseFrame) as SseFrame;
    expect(forward.raw).not.toBe(reverse.raw);
  });

  it("an adapter with no transforms still runs the user's, in the user's order", async () => {
    // The degenerate case, kept because `?? []` on an absent adapter is exactly where an
    // off-by-one in the spread would hide: with nothing to prepend, a wrong order is
    // invisible unless the user stage is checked on its own.
    upstream('data: {"type":"text","text":"x"}\n\n');
    const handler = createSseProxyHandler({
      backendUrl: "http://backend",
      transforms: [appendMark("U"), appendMark("V")],
    });
    const res = (await handler(makeRequest())) as unknown as Response;
    expect(await textOf(res)).toBe("xUV");
  });
});
