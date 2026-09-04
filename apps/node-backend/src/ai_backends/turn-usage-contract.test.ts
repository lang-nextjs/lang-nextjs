/**
 * The turn-usage contract, driven against THIS plane's real emitter (#727).
 *
 * THE CASES COME FROM scripts/fixtures/turn-usage-cases.json, which the two
 * Python planes' own tests read as well. That is what makes this a comparison
 * rather than three independent assertions: a case added there is added to every
 * plane at once, and a plane that drifts fails on the case rather than on
 * someone noticing.
 *
 * WHY THIS PLANE NEEDED ONE. #300 gave per-turn usage to fastapi and django in
 * the same shape and to this runtime not at all — `apps/node-backend` had ZERO
 * occurrences of `usage` or `token`, so every layer above the model here said a
 * turn cost nothing, which is the misreport #232 opened.
 *
 * `check:run-axes-parity` could not have seen it and is not the thing to widen:
 * it holds the two Python planes BYTE-IDENTICAL, which is the right test for two
 * copies of one Python source and has no meaning across languages — the README
 * says so, deliberately. A shared corpus is the mechanism this repo already had
 * for three-plane agreement (run-axes-cases.json, #616), and it had simply never
 * been pointed at usage.
 *
 * WHAT THIS ASSERTS IS THE VALUE, NOT THE WIRE LOCATION. Where usage rides on
 * the `finish` frame is #714's subject — `messageMetadata.totalUsage`, because
 * AI SDK v6 parses that frame with `z.strictObject()` and rejects the turn over
 * a top-level `totalUsage` — and it is guarded by finish-frame-conformance.
 * Keeping them apart means either can land or revert without dragging the other.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AIMessageChunk } from "@langchain/core/messages";

import { emitAiSdkV6 } from "./deepagents.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(
  HERE,
  "..",
  "..",
  "..",
  "..",
  "scripts",
  "fixtures",
  "turn-usage-cases.json"
);

type Usage = Record<string, number>;
type Case = {
  id: string;
  why: string;
  chunks: (Usage | null)[];
  expect: { reported: boolean; totalUsage?: Usage };
};

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as {
  cases: Case[];
  mustContain: string[];
};
const CASES = fixture.cases;

/** The root agent's namespace, as this runtime actually emits it. */
const ROOT_NS = ["model_request:aebca58a-f427-5fcd-b76f-5f11fc8371ee"];

function fakeGraph(chunks: (Usage | null)[]) {
  return {
    async stream() {
      return (async function* () {
        for (const u of chunks) {
          const msg = new AIMessageChunk({ content: "x" });
          // Set it the way the provider does, rather than through the
          // constructor, so a chunk carrying NO usage carries the field as
          // undefined — which is the case `interleaved-silence` turns on.
          if (u) (msg as { usage_metadata?: Usage }).usage_metadata = u;
          yield [ROOT_NS, "messages", [msg]];
        }
      })();
    },
  } as never;
}

async function reportedUsage(
  chunks: (Usage | null)[]
): Promise<Usage | undefined> {
  const frames: Record<string, unknown>[] = [];
  for await (const raw of emitAiSdkV6(fakeGraph(chunks), [])) {
    for (const line of String(raw).split("\n")) {
      if (line.startsWith("data: ")) frames.push(JSON.parse(line.slice(6)));
    }
  }
  const finish = frames.find((f) => f.type === "finish");
  if (!finish) {
    throw new Error(
      "the stream carried no `finish` frame, so there is no report to read — " +
        "that is a broken probe, not a turn that cost nothing"
    );
  }
  // ONE location. The transitional top-level fallback is gone, on the schedule
  // scripts/turn_usage_contract.py set for it: #714 has landed on both python
  // planes and this one never emitted anything else. Accepting the old shape
  // would mean going green on a frame AI SDK v6 rejects outright.
  const metadata = (finish.messageMetadata ?? {}) as { totalUsage?: Usage };
  return metadata.totalUsage;
}

describe("turn usage — the shared cross-plane contract", () => {
  it("has cases, and still has the ones that matter", () => {
    // A table-driven test over an empty table passes, and so does one whose
    // awkward cases were quietly dropped. Both halves, deliberately.
    expect(CASES.length).toBeGreaterThan(0);
    const ids = new Set(CASES.map((c) => c.id));
    const missing = fixture.mustContain.filter((i) => !ids.has(i));
    expect(
      missing,
      `the fixture no longer contains ${JSON.stringify(
        missing
      )} — each pins a ` +
        `DIFFERENT failure, and losing one silently is how it comes back`
    ).toEqual([]);
  });

  for (const c of CASES) {
    it(`${c.id} — reports what the shared contract says`, async () => {
      const usage = await reportedUsage(c.chunks);
      if (c.expect.reported) {
        expect(usage, c.why).toEqual(c.expect.totalUsage);
      } else {
        expect(usage, c.why).toBeUndefined();
      }
    });
  }
});
