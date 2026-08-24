/**
 * The HITL harness routes proxy this mock with NO adapter.
 *
 * That is only correct while the mock emits AI SDK v6 frames the client can consume
 * unchanged. They previously ran through `deepagentsAdapter`, whose entire content is
 * `stripMessageIdTransform` — a no-op against a stream that carries no `messageId`. Dropping
 * it is what lets these harness routes stop depending on rung 3, so a rung-1 fork gets a
 * working HITL demo instead of a compile error.
 *
 * THIS TEST GUARDS THE PRECONDITION, not the refactor. If someone later teaches the mock to
 * emit `messageId`, removing the adapter silently becomes lossy: AI SDK v6 uses a
 * strictObject for finish frames and rejects the extra field, so the demo breaks at the
 * client with no server-side error. The failure would look like "HITL is flaky", which is
 * the worst kind of bug to inherit.
 *
 * Verified to be able to fail: adding `messageId` to the finish frame makes it red.
 */
import { describe, it, expect } from "vitest";
import { POST } from "./route";

async function collectFrames(scenario?: string): Promise<string[]> {
  const url = new URL("http://localhost/api/hitl-demo/backend");
  if (scenario) url.searchParams.set("scenario", scenario);
  const res = await POST(new Request(url, { method: "POST" }));
  const body = await res.text();
  return body
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.replace(/^data:\s?/, ""));
}

describe("HITL mock backend is adapter-free by construction", () => {
  it("emits no messageId on any frame", async () => {
    // 'timeout' is skipped: it sleeps 8s by design, and this precondition is about the
    // frame shape, which the other two scenarios already exercise.
    for (const scenario of [undefined, "multi"]) {
      const frames = await collectFrames(scenario);
      expect(frames.length, `scenario ${scenario ?? "default"} emitted nothing`).toBeGreaterThan(0);

      const offenders = frames.filter((f) => {
        try {
          return "messageId" in (JSON.parse(f) as Record<string, unknown>);
        } catch {
          // An unparseable frame is not evidence of absence — surface it rather than
          // counting it as clean, which is how a broken parse reads as a pass.
          return true;
        }
      });
      expect(offenders, `scenario ${scenario ?? "default"}`).toEqual([]);
    }
  }, 20_000);

  it("emits the finish frame the approval transform needs to flush", async () => {
    // Not decoration: the approval gating transform buffers, and `finish` is what drains it.
    // A mock that stopped emitting finish would hang the demo rather than fail it.
    const frames = await collectFrames();
    expect(frames.some((f) => f.includes('"type":"finish"'))).toBe(true);
  }, 20_000);
});
