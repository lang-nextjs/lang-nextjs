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
 * THE INSTRUMENT IS `uiMessageChunkSchema` RESOLVED FROM THE INSTALLED `ai`
 * PACKAGE, not a local re-description of it, which would go stale in exactly
 * the direction that hides a defect. `rejects the pre-#714 finish frame` below
 * is the control: it demonstrates on every run that this validator DOES refuse
 * the frame that shipped, so a green here means the contract passed rather than
 * that nothing was checked.
 */
import { describe, it, expect } from "vitest";
import { uiMessageChunkSchema } from "ai";
import * as fs from "node:fs";
import * as path from "node:path";

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

describe("docs/sse-frame-schema.json — every declared frame is one AI SDK v6 accepts", () => {
  it("declares at least one variant, so an empty contract cannot pass vacuously", () => {
    expect(contract.oneOf.length).toBeGreaterThan(10);
  });

  for (const [index, variant] of contract.oneOf.entries()) {
    const label = nameOf(variant, index);
    it(`${label} — a maximal instance is accepted`, async () => {
      const instance = maximalInstance(variant);
      const result = await validateChunk(instance);
      expect(
        result.success,
        `the contract declares ${label} with keys [${Object.keys(instance).join(
          ", "
        )}], and AI SDK v6 rejects it:\n${String(result.error).slice(0, 900)}`
      ).toBe(true);
    });
  }

  it("CONTROL — rejects the pre-#714 finish frame, so a green above means checked", async () => {
    const shipped = {
      type: "finish",
      finishReason: "stop",
      totalUsage: { inputTokens: 3110, outputTokens: 144, totalTokens: 3254 },
    };
    const result = await validateChunk(shipped);
    expect(result.success).toBe(false);
  });

  it("CONTROL — accepts usage carried under messageMetadata, the branch's own extension point", async () => {
    const fixed = {
      type: "finish",
      finishReason: "stop",
      messageMetadata: {
        totalUsage: { inputTokens: 3110, outputTokens: 144, totalTokens: 3254 },
      },
    };
    const result = await validateChunk(fixed);
    expect(result.success, String(result.error).slice(0, 600)).toBe(true);
  });
});
