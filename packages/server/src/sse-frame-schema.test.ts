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
   * WHAT THIS FILE CAN AND CANNOT SEE. The contract carries
   * `additionalProperties: false` on all 21 variants as of #945, so Ajv here
   * REJECTS a frame carrying a key the contract does not declare at the top
   * level. #714 was exactly such a frame: a `finish` carrying `totalUsage`,
   * which every assertion here accepted, and AI SDK v6 rejected outright.
   *
   * WHAT #945 DID NOT REVERSE, because this comment used to give it as the
   * reason for the looseness: the same document is read by consumers who
   * extend `data-*` payloads, and that is still legal. `additionalProperties`
   * binds the frame's OWN keys — the siblings of `type` — not the inside of
   * `data`. Nine of the twelve `data-*` variants declare no payload properties
   * at all and none carries `additionalProperties: false` under `data`, so a
   * payload may still grow keys. MEASURED both ways rather than reasoned:
   * against the real file, a `data-plan`/`data-task`/`data-approval-required`
   * frame with an undeclared key INSIDE `data` validates, and the same frame
   * with an undeclared key beside `type` does not.
   *
   * The strict question is asked in two other places, and neither is optional:
   * packages/test-utils/src/finish-frame-conformance.test.ts checks the
   * contract against the SDK's own `uiMessageChunkSchema`, and
   * scripts/sse_frame_conformance.py checks each python plane's real frames
   * against the contract's declared key set. Those remain the reason the cases
   * here use only declared keys: passing an undeclared one would now fail, but
   * it would read as a claim that the key is legal, which is the misreading
   * that let #714 land.
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

  /*
   * BOTH PRODUCERS, AND THE FIXTURES COME FROM THEM RATHER THAN FROM THIS DOCUMENT (#951).
   *
   * The fixture here used to be `{id, toolCallId, toolName, input, expiresAt: <number>}` —
   * transcribed from the contract's own declaration, which is why it passed while no producer
   * had ever emitted that shape. A document-derived fixture validates the document against
   * itself: it can only fail when someone edits the document, never when an emitter drifts.
   * #944 corrected the declaration and this fixture went red, which is the mechanism working.
   *
   * SO THESE ARE THE TWO EMISSIONS, keyed to their sources so a reader can re-derive them:
   * approval-gating.ts's envelope (core, carries `expiresAt`) and sdaEnrich.ts's
   * request_human_help gate (rung 5, does NOT). The optionality of `expiresAt` is the whole
   * reason both are here — a single fixture would have made either producer unrepresented.
   */
  it("data-approval-required — core's emission (approval-gating.ts) validates", () => {
    const frame = {
      type: "data-approval-required",
      data: {
        id: "ap1",
        seq: 0,
        actionName: "bash_execute",
        description: "Approval required for bash_execute",
        arguments: { command: "ls" },
        status: "waiting",
        createdAt: "2026-09-07T10:00:00.000Z",
        expiresAt: "2026-09-07T10:00:30.000Z",
      },
    };
    expect(validate(frame), JSON.stringify(validate.errors)).toBe(true);
  });

  it("data-approval-required — rung 5's emission (sdaEnrich.ts, no expiresAt) validates", () => {
    const frame = {
      type: "data-approval-required",
      data: {
        id: "tc1",
        seq: 3,
        actionName: "request_human_help",
        description:
          "The agent is stuck and has asked for help before continuing.",
        arguments: { help_request: "which branch?" },
        status: "waiting",
        createdAt: "2026-09-07T10:00:00.000Z",
      },
    };
    expect(validate(frame), JSON.stringify(validate.errors)).toBe(true);
  });

  /*
   * THE SENTINEL IS ON THE WIRE, SO IT IS IN THE CORPUS. approval-gating.ts falls back to the
   * literal string when JSON.stringify throws on a self-referential input, deliberately, so the
   * approval UI renders a placeholder rather than the stream dying. A contract that rejected it
   * would fail exactly when the fallback fires.
   */
  it("data-approval-required — the <unserializable> arguments sentinel validates", () => {
    const frame = {
      type: "data-approval-required",
      data: {
        id: "ap2",
        seq: 1,
        actionName: "bash_execute",
        description: "Approval required for bash_execute",
        arguments: "<unserializable>",
        status: "waiting",
        createdAt: "2026-09-07T10:00:00.000Z",
        expiresAt: "2026-09-07T10:00:30.000Z",
      },
    };
    expect(validate(frame), JSON.stringify(validate.errors)).toBe(true);
  });

  /*
   * THE CONTROL. Every case above asserts the contract ACCEPTS something, and a contract that
   * accepts everything would pass all three. This is the shape the document declared until
   * #944 — and no producer has ever emitted it.
   */
  it("data-approval-required — the pre-#944 declared shape is REJECTED", () => {
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
    expect(validate(frame)).toBe(false);
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

/*
 * REQUIREDNESS AND THE CLOSED ENUMS ARE PINNED BY A FROZEN COPY, NOT BY FIXTURES (#987).
 *
 * WHY NO FIXTURE CAN DO THIS. Every accepting fixture supplies all seven fields, so removing
 * one from `data.required` leaves them all passing -- a superset always validates. Only a
 * REJECTING fixture missing exactly that field pins it, and the suite's one rejecting fixture
 * is missing six at once, so it isolates none of them. Measured on #970's suite: dropping any
 * single field left all 14 tests green, 7 of 7 unpinned.
 *
 * AND THE OBVIOUS CHEAP FIX IS VACUOUS, WHICH IS WHY THIS IS A LIST AND NOT A LOOP. #987
 * suggested "one parameterised fixture over the seven". A loop whose field list comes from
 * `data.required` CANNOT FAIL on the mutation it exists for, because removing a field removes
 * it from the iteration. Driven, with the prediction written first:
 *
 *     healthy contract     iterated 7   missed 0
 *     required -> []       iterated 0   missed 0   <- PASSES
 *     drop `status` only   iterated 6   missed 0   <- PASSES
 *
 * So the field list has to come from somewhere the mutation cannot reach. That is this file.
 * THE DUPLICATION IS THE MECHANISM, not a smell: the second copy is the only thing that can
 * disagree with the first.
 *
 * THE POPULATION IS FROZEN TOO, and that is the half most easily left out. Freezing three
 * variants' fields says nothing about a FOURTH variant gaining a `required` nobody pinned --
 * the list would simply not mention it, and silence is what an under-covering list produces.
 * So the set of variants carrying `data.required` is asserted as well as their contents.
 */
describe("the contract's closed declarations are pinned (#987)", () => {
  /** Every `data.required` the contract declares, by frame type. Hand-maintained ON PURPOSE. */
  const FROZEN_REQUIRED: Record<string, string[]> = {
    "data-approval-required": [
      "id",
      "seq",
      "actionName",
      "description",
      "arguments",
      "status",
      "createdAt",
    ],
    "data-human-response": ["response"],
    "data-error": ["code", "message"],
  };

  /** Closed enums inside a payload. Same argument: a fixture supplying a valid value cannot
   *  detect the enum being widened, because the value it supplies stays valid. */
  const FROZEN_ENUMS: Record<string, Record<string, string[]>> = {
    "data-approval-required": { status: ["waiting"] },
  };

  /*
   * READ HERE RATHER THAN REUSING THE OTHER SUITE'S, because that one lives inside a
   * `beforeAll` and is scoped to it. Sharing it would couple two describes through a mutable
   * binding for no gain; the read is cheap and this way each suite states its own subject.
   */
  const contract = JSON.parse(fs.readFileSync(schemaPath, "utf-8")) as {
    oneOf: Array<Record<string, any>>;
  };

  const branches = () =>
    contract.oneOf.map((b) => ({
      type: b.properties?.type?.const as string | undefined,
      data: (b.properties?.data ?? {}) as Record<string, any>,
    }));

  it("the SET of variants declaring data.required is exactly the frozen set", () => {
    const declaring = branches()
      .filter((b) => Array.isArray(b.data.required) && b.data.required.length)
      .map((b) => b.type)
      .sort();
    expect(declaring).toEqual(Object.keys(FROZEN_REQUIRED).sort());
  });

  for (const [type, required] of Object.entries(FROZEN_REQUIRED)) {
    it(`${type} requires exactly ${required.length} field(s)`, () => {
      const b = branches().find((x) => x.type === type);
      expect(b, `no branch declares type ${type}`).toBeDefined();
      expect(b!.data.required).toEqual(required);
    });
  }

  for (const [type, fields] of Object.entries(FROZEN_ENUMS)) {
    for (const [field, values] of Object.entries(fields)) {
      it(`${type}.data.${field} is closed to [${values.join(", ")}]`, () => {
        const b = branches().find((x) => x.type === type);
        expect(b, `no branch declares type ${type}`).toBeDefined();
        expect(b!.data.properties?.[field]?.enum).toEqual(values);
      });
    }
  }
});

/*
 * WHAT A GREEN HERE DOES NOT SAY.
 *
 * It asserts the contract's DECLARATION, not its BEHAVIOUR. It does not establish that ajv
 * enforces `required` or `enum` -- that is a property of the validator, which this repository
 * tests nowhere else and should not start testing here. If ajv stopped enforcing either, every
 * case above stays green and the accepting fixtures do too.
 *
 * It says nothing about whether the frozen values are RIGHT. They were taken from the emitters
 * in #970/#951 and this only holds them still; a field wrongly required at that point stays
 * wrongly required, pinned.
 *
 * And it reaches ONE LEVEL into `data` only. A `required` nested deeper -- inside a payload
 * object -- is neither frozen nor noticed by the population case, because the population case
 * asks which variants declare `data.required` and not which declare one anywhere.
 */
describe("OpenAPI spec — docs/openapi.yaml is valid OpenAPI 3.1", () => {
  it("loads + parses without errors", async () => {
    const SwaggerParser = (await import("@apidevtools/swagger-parser")).default;
    const specPath = path.resolve(__dirname, "../../../docs/openapi.yaml");
    // Validate the document structure conforms to OpenAPI 3.1 spec.
    // Throws on any structural error (missing required fields, bad refs).
    await expect(SwaggerParser.validate(specPath)).resolves.toBeDefined();
  });
});
