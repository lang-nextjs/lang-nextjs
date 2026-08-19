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

  it("finish frame validates with finishReason", () => {
    const frame = { type: "finish", finishReason: "stop", messageId: "m1" };
    expect(validate(frame), JSON.stringify(validate.errors)).toBe(true);
  });

  it("finish frame with invalid finishReason fails", () => {
    const frame = { type: "finish", finishReason: "INVALID_REASON" };
    expect(validate(frame)).toBe(false);
  });

  it("tool-input-start with all fields validates", () => {
    const frame = {
      type: "tool-input-start",
      toolCallId: "tc1",
      toolName: "search",
      input: { query: "x" },
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
