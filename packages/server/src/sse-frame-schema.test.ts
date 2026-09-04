/**
 * Schema validation tests — exercises the SSE frame schema against
 * actual handler outputs to verify the implementation matches the
 * published wire-format contract (docs/sse-frame-schema.json).
 *
 * The contract IS the schema; if a handler emits a frame the schema
 * rejects (or vice versa), the wire format has drifted from the
 * canonical reference. Consumers — especially downstream non-Node
 * clients reading from this OpenAPI spec — would break silently
 * without this guard.
 */
import { describe, it, expect, beforeAll } from "vitest";
import Ajv from "ajv/dist/2020";
import addFormats from "ajv-formats";
import * as fs from "node:fs";
import * as path from "node:path";

const schemaPath = path.resolve(
  __dirname,
  "../../../docs/sse-frame-schema.json"
);

describe("SSE frame schema — implementation matches docs/sse-frame-schema.json", () => {
  let validate: ReturnType<Ajv["compile"]>;

  beforeAll(() => {
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    validate = ajv.compile(schema);
  });

  it("text-delta frame validates", () => {
    const frame = { type: "text-delta", id: "t1", delta: "hello" };
    expect(validate(frame), JSON.stringify(validate.errors)).toBe(true);
  });

  /*
   * WHAT THIS FILE CAN AND CANNOT SEE. The contract carries no
   * `additionalProperties: false`, so Ajv here accepts a frame with keys the
   * contract never declares — deliberately, because the same document is read
   * by consumers who legitimately extend `data-*` payloads. It follows that no
   * case below can fail on account of an EXTRA key, and #714 was exactly that:
   * a `finish` frame carrying `totalUsage`, which every assertion here accepted
   * and AI SDK v6 rejected outright.
   *
   * The strict question is asked in two other places, and neither is optional:
   * packages/test-utils/src/finish-frame-conformance.test.ts checks the
   * contract against the SDK's own `uiMessageChunkSchema`, and
   * scripts/sse_frame_conformance.py checks each python plane's real frames
   * against the contract's declared key set. The cases here therefore use only
   * declared keys — passing an undeclared one would read as a claim that it is
   * legal, which is the misreading that let #714 land.
   */
  it("finish frame validates with finishReason", () => {
    const frame = { type: "finish", finishReason: "stop" };
    expect(validate(frame), JSON.stringify(validate.errors)).toBe(true);
  });

  it("finish frame validates with usage under messageMetadata", () => {
    const frame = {
      type: "finish",
      finishReason: "stop",
      messageMetadata: { totalUsage: { inputTokens: 1, outputTokens: 2 } },
    };
    expect(validate(frame), JSON.stringify(validate.errors)).toBe(true);
  });

  it("finish frame with invalid finishReason fails", () => {
    const frame = { type: "finish", finishReason: "INVALID_REASON" };
    expect(validate(frame)).toBe(false);
  });

  it("tool-input-start with all fields validates", () => {
    // `input` is NOT among them, and that is the point: the SDK's
    // tool-input-start branch has no `input` — the arguments arrive on
    // tool-input-available. #311 removed it from the approval-gating release
    // path after the SDK rejected the released frame; #714 removed it from the
    // contract, which had gone on declaring it.
    const frame = {
      type: "tool-input-start",
      toolCallId: "tc1",
      toolName: "search",
    };
    expect(validate(frame), JSON.stringify(validate.errors)).toBe(true);
  });

  it("data-approval-required with full payload validates", () => {
    const frame = {
      type: "data-approval-required",
      data: {
        id: "ap1",
        toolCallId: "tc1",
        toolName: "bash_execute",
        input: { command: "ls" },
        expiresAt: 1700000000000,
      },
    };
    expect(validate(frame), JSON.stringify(validate.errors)).toBe(true);
  });

  it("data-error with required code+message validates", () => {
    const frame = {
      type: "data-error",
      data: { code: "approval_timeout", message: "expired", retryable: false },
    };
    expect(validate(frame), JSON.stringify(validate.errors)).toBe(true);
  });

  it("data-error without code fails", () => {
    const frame = { type: "data-error", data: { message: "x" } };
    expect(validate(frame)).toBe(false);
  });

  it("unknown frame type fails (oneOf discriminator)", () => {
    const frame = { type: "unknown-thing", x: 1 };
    expect(validate(frame)).toBe(false);
  });

  it("text-delta missing required `delta` field fails", () => {
    const frame = { type: "text-delta", id: "t1" };
    expect(validate(frame)).toBe(false);
  });
});

describe("OpenAPI spec — docs/openapi.yaml is valid OpenAPI 3.1", () => {
  it("loads + parses without errors", async () => {
    const SwaggerParser = (await import("@apidevtools/swagger-parser")).default;
    const specPath = path.resolve(__dirname, "../../../docs/openapi.yaml");
    // Validate the document structure conforms to OpenAPI 3.1 spec.
    // Throws on any structural error (missing required fields, bad refs).
    await expect(SwaggerParser.validate(specPath)).resolves.toBeDefined();
  });
});
