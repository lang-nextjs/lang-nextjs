/**
 * WHAT THIS REPO PUBLISHES AS A VALID FRAME MUST BE A FRAME THE CLIENT ACCEPTS (#714).
 *
 * `docs/sse-frame-schema.json` is the wire-format contract: the python planes
 * emit against it, `packages/server/src/sse-frame-schema.test.ts` validates
 * handler output against it, and downstream non-Node clients read it. But it is
 * a hand-written JSON Schema, and nothing compared it to the validator that
 * actually runs in the browser. So it drifted WIDER than the SDK, and a
 * backend that honoured the contract to the letter produced a frame the client
 * threw away.
 *
 * #714 was exactly that: the doc declared `totalUsage` on `finish`, a python
 * backend emitted it, and AI SDK v6 — which builds the UI-message chunk union
 * out of `z.strictObject()` — rejected the terminal frame and discarded the
 * whole turn. `totalUsage` is a field of the SDK's onFinish/StepResult CALLBACK
 * shape, not of the wire chunk; the two share a name, which is how a comment
 * asserting "the shape AI SDK v6 already defines" got written and believed.
 *
 * THE GUARD NAMES THE PROPERTY, NOT A FIELD. `stripMessageIdTransform` already
 * existed for this same hazard on this same frame, and it names ONE key —
 * `messageId`. The next unknown key added to `finish`, by the same reasoning,
 * walked straight past it. This asks the general question instead: for every
 * frame variant the contract declares, is a maximal instance of it — every
 * declared property present — accepted by the SDK's own schema?
 *
 * THE INSTRUMENT IS THE SDK'S DECLARATIONS, NOT ITS VALIDATOR (#972). It was
 * `uiMessageChunkSchema`, the runtime validator, which answered this question
 * while the chunk union was built from `z.strictObject()`. Under `ai` v7 it is
 * `looseObject` and it stops answering. Measured with both installed:
 *
 *     ai@6.0.197  REJECT   { type:"finish", finishReason:"stop", totalUsage:{...} }
 *     ai@7.0.93   ACCEPT   the same frame
 *
 * THE DEFECT DID NOT GO AWAY, IT WENT QUIET. `totalUsage` is a field of the
 * onFinish/StepResult CALLBACK shape, not of the wire chunk. Under v6 the client
 * refused the terminal frame and discarded the turn, loudly. Under v7 it accepts
 * the frame and silently drops the usage — the turn renders, the number is
 * missing, and nothing reports a problem. A quiet defect is worse than a loud
 * one, and a repair that only restored a red control would leave it unsaid.
 *
 * AND THE 21 ACCEPTANCE ASSERTIONS WENT VACUOUS WITH IT, which is the larger
 * half: a loose reader accepts a maximal instance of anything. Run against v7
 * this file reported `1 failed | 23 passed`, and the 23 included every one of
 * them. So the target was discrimination for 22 assertions, not for the control.
 *
 * The control below is NOT weakened — the property it asserts is unchanged, that
 * a known-bad frame is refused. Only the reader changed, because the old one
 * stopped being able to refuse anything. See `sdk-declared-chunks.ts` for why a
 * `.d.ts` is the right source for *what does the SDK declare* and was the wrong
 * source for *did validation get looser*.
 */
import { describe, it, expect } from "vitest";
import { uiMessageChunkSchema } from "ai";
import * as fs from "node:fs";
import * as path from "node:path";

import { declaredKeysFor, undeclaredKeys } from "./sdk-declared-chunks";

type Validator = (v: unknown) => Promise<{ success: boolean; error?: unknown }>;
const validateChunk: Validator = (
  uiMessageChunkSchema as unknown as () => { validate: Validator }
)().validate;

const schemaPath = path.resolve(
  __dirname,
  "../../../docs/sse-frame-schema.json"
);

/**
 * A missing contract file must not read as a clean run. `readFileSync` would
 * throw inside `describe` and surface as a collection error, which is legible;
 * asserting existence first makes the reason legible too.
 */
if (!fs.existsSync(schemaPath)) {
  throw new Error(
    `contract not found at ${schemaPath} — this guard cannot report a verdict`
  );
}

type Fragment = {
  const?: unknown;
  enum?: unknown[];
  type?: string;
  properties?: Record<string, Fragment>;
  required?: string[];
  title?: string;
};

const contract = JSON.parse(fs.readFileSync(schemaPath, "utf-8")) as {
  oneOf: Fragment[];
};

/**
 * Build a value the contract would accept for one declared property.
 *
 * Derived from the declaration rather than hand-written per frame: a
 * hand-written corpus can only test the keys whoever wrote it remembered, which
 * is the same blind spot that let `totalUsage` through.
 */
function sampleFor(fragment: Fragment): unknown {
  if (fragment.const !== undefined) return fragment.const;
  if (fragment.enum && fragment.enum.length > 0) return fragment.enum[0];
  switch (fragment.type) {
    case "string":
      return "x";
    case "number":
    case "integer":
      return 1;
    case "boolean":
      return true;
    case "array":
      return [];
    case "object":
    default:
      return {};
  }
}

/** Every declared property present — the widest frame the contract permits. */
function maximalInstance(variant: Fragment): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, fragment] of Object.entries(variant.properties ?? {})) {
    out[key] = sampleFor(fragment);
  }
  return out;
}

function nameOf(variant: Fragment, index: number): string {
  if (variant.title) return variant.title;
  const constType = variant.properties?.type?.const;
  return typeof constType === "string" ? constType : `oneOf[${index}]`;
}

const SHIPPED_PRE_714 = {
  type: "finish",
  finishReason: "stop",
  totalUsage: { inputTokens: 3110, outputTokens: 144, totalTokens: 3254 },
};

const FIXED_UNDER_MESSAGE_METADATA = {
  type: "finish",
  finishReason: "stop",
  messageMetadata: {
    totalUsage: { inputTokens: 3110, outputTokens: 144, totalTokens: 3254 },
  },
};

describe("docs/sse-frame-schema.json — every declared frame is one the SDK declares", () => {
  it("declares at least one variant, so an empty contract cannot pass vacuously", () => {
    expect(contract.oneOf.length).toBeGreaterThan(10);
  });

  for (const [index, variant] of contract.oneOf.entries()) {
    const label = nameOf(variant, index);
    it(`${label} — every declared property is one the SDK declares`, async () => {
      const instance = maximalInstance(variant);
      const frameType = variant.properties?.type?.const;

      /*
       * THE DISCRIMINATING ASSERTION. `undeclaredKeys` returns null when the SDK declares no
       * such chunk type at all, which is a different failure from a declared chunk carrying an
       * extra key, and is reported as its own sentence rather than as every key being extra.
       */
      const extra = undeclaredKeys(String(frameType), Object.keys(instance));
      expect(
        extra,
        `the contract declares a frame of type ${JSON.stringify(
          frameType
        )} and the SDK declares no such chunk`
      ).not.toBeNull();
      expect(
        extra,
        `the contract declares ${label} with keys [${Object.keys(instance).join(
          ", "
        )}], and the SDK does not declare ${JSON.stringify(
          extra
        )} for that chunk — a client will accept the frame and silently drop those values`
      ).toEqual([]);

      /*
       * AND THE RUNTIME READER IS KEPT, for what it can still answer. Under a loose union it no
       * longer refuses an undeclared key, but it does refuse a declared key carrying the wrong
       * JSON type, which the key comparison above cannot see. Two readers, two questions; this
       * one is not a control and is not relied on for discrimination.
       */
      const result = await validateChunk(instance);
      expect(
        result.success,
        `the contract declares ${label}, and the SDK's runtime reader rejects a maximal ` +
          `instance of it:\n${String(result.error).slice(0, 900)}`
      ).toBe(true);
    });
  }

  /*
   * THE READER ITSELF MUST BE ALIVE, asserted here as a second method rather than relying only
   * on the module's own floor. A key that MUST be found and a key that MUST NOT: if the walk
   * silently recovered an empty or wrong key set, every assertion above would pass for want of
   * anything to compare against.
   */
  it("CONTROL — the reader recovered the SDK's finish chunk", () => {
    const declared = declaredKeysFor("finish");
    expect(declared, "the SDK declares no `finish` chunk").not.toBeNull();
    expect([...declared!].sort()).toContain("finishReason");
    expect([...declared!].sort()).not.toContain("totalUsage");
  });

  it("CONTROL — refuses the pre-#714 finish frame, so a green above means checked", () => {
    expect(
      undeclaredKeys("finish", Object.keys(SHIPPED_PRE_714))
    ).toEqual(["totalUsage"]);
  });

  it("CONTROL — accepts usage carried under messageMetadata, the branch's own extension point", () => {
    expect(
      undeclaredKeys("finish", Object.keys(FIXED_UNDER_MESSAGE_METADATA))
    ).toEqual([]);
  });
});
