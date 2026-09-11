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
import { repoRoot } from "./__testing__/repo-root";

const REPO_ROOT = repoRoot(__dirname);
const schemaPath = path.join(REPO_ROOT, "docs/sse-frame-schema.json");

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

  /*
   * data-approval, THE VARIANT THAT COULD NOT GO RED (#988).
   *
   * Its `data` was declared `{"type": "object"}` -- no properties, no required -- while
   * openSweEnrich.ts emitted seven named fields into it. That is #944's defect in its EMPTY
   * form, and it is the worse form: a WRONG description eventually contradicts a producer and
   * someone investigates, whereas one that constrains nothing is green against the producer it
   * describes, green against a producer emitting different fields, and green against one
   * emitting none. It survived #944's sweep because that sweep looked for descriptions which
   * DISAGREED with emissions, and this one agreed with everything.
   *
   * ONE PRODUCER, so the fixture is that emission rather than the sibling's shape. Taken from
   * openSweEnrich.ts's `enter_plan_mode` branch and not from the document, for the reason the
   * block above gives: a document-derived fixture validates the document against itself.
   */
  /*
   * DECLARED HERE? A fork below rung 4 has this variant PRUNED from the contract, because it can
   * never emit the frame. So the two arms below assert opposite things in the two trees, and both
   * are the right answer: where the variant exists the emission must validate, and where it does
   * not the fork must REJECT a frame it cannot produce. Skipping in the ejected tree would have
   * been a vacuous pass over exactly the case severability exists to check.
   */
  const declaresApproval = (
    JSON.parse(fs.readFileSync(schemaPath, "utf-8")) as {
      oneOf: Array<{ properties?: { type?: { const?: string } } }>;
    }
  ).oneOf.some((b) => b.properties?.type?.const === "data-approval");

  it(`data-approval -- openSweEnrich's emission ${
    declaresApproval
      ? "validates"
      : "is REJECTED by a fork that pruned the variant"
  }`, () => {
    const frame = {
      type: "data-approval",
      data: {
        id: "r--enter_plan_mode-0",
        seq: 0,
        actionName: "enter_plan_mode",
        description:
          "The agent has finished planning and is waiting for you to approve or reject the plan before it starts implementing.",
        arguments: {},
        status: "waiting",
        createdAt: "2026-09-07T10:00:00.000Z",
      },
    };
    expect(validate(frame), JSON.stringify(validate.errors)).toBe(
      declaresApproval
    );
  });

  /*
   * AND THE SAME EMISSION CARRYING `attribution`, which dataFrame() adds to every data-* payload
   * when the upstream frame had a namespace. No variant in this document declares it and no zod
   * schema does either, so it rides as an undeclared key -- legal only because
   * `additionalProperties` is unset inside `data`. Pinned so a future tightening has to confront
   * it rather than discover it in production.
   */
  it(`data-approval -- the same emission carrying attribution ${
    declaresApproval
      ? "still validates"
      : "is REJECTED by a fork that pruned the variant"
  }`, () => {
    const frame = {
      type: "data-approval",
      data: {
        id: "r--enter_plan_mode-0",
        seq: 0,
        actionName: "enter_plan_mode",
        description: "waiting for approval",
        arguments: {},
        status: "waiting",
        createdAt: "2026-09-07T10:00:00.000Z",
        attribution: { rung: "open-swe", depth: 1 },
      },
    };
    expect(validate(frame), JSON.stringify(validate.errors)).toBe(
      declaresApproval
    );
  });

  /*
   * THE CONTROLS, AND THEY ARE THE POINT OF #988. Every one of them PASSED before this change,
   * because a bare object accepts anything. Each removes exactly one thing.
   */
  it("data-approval -- a payload missing a required field is REJECTED", () => {
    const frame = {
      type: "data-approval",
      data: {
        id: "r--enter_plan_mode-0",
        seq: 0,
        description: "no actionName",
        arguments: {},
        status: "waiting",
        createdAt: "2026-09-07T10:00:00.000Z",
      },
    };
    expect(validate(frame)).toBe(false);
  });

  it("data-approval -- an EMPTY payload is REJECTED, which is what a bare object accepted", () => {
    expect(validate({ type: "data-approval", data: {} })).toBe(false);
  });

  it("data-approval -- a different actionName is REJECTED, since the producer hardcodes it", () => {
    const frame = {
      type: "data-approval",
      data: {
        id: "r--enter_plan_mode-0",
        seq: 0,
        actionName: "some_other_tool",
        description: "x",
        arguments: {},
        status: "waiting",
        createdAt: "2026-09-07T10:00:00.000Z",
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
  /*
   * THESE PINS ARE SCOPED TO THE VARIANTS THIS TREE ACTUALLY HAS (#988, found on an eject).
   *
   * `data-approval` is rung-4-owned, and `pnpm eject langchain` PRUNES it from the contract because
   * a fork below rung 4 can never emit it. Every frozen entry here before it belonged to `core` or
   * carried a null attribution, so every one survived every eject and the question never arose --
   * the first rung-owned pin added was the first to fail on a fork, and it failed on two TS planes
   * at once.
   *
   * WHICH QUESTION LIVES WHERE, because the alternative is two rung tables that must agree.
   * `sse-frame-payload-coverage.test.ts` owns WHICH variants should exist here: it reads rungs.json
   * -- the manifest the ejector rewrites, never the contract, which is the file under test -- and
   * intersects its roster with the surviving rungs, so a variant vanishing from a FULL tree fails
   * THERE. This file owns WHAT THE PRESENT ONES DECLARE. Duplicating the rung mapping to answer both
   * here would be the declared-here-consumed-there shape with nothing asserting the copies agree.
   */
  const declaredTypes = () => new Set(branches().map((b) => b.type));

  const FROZEN_REQUIRED: Record<string, string[]> = {
    "data-approval": [
      "id",
      "seq",
      "actionName",
      "description",
      "arguments",
      "status",
      "createdAt",
    ],
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

  /*
   * CLOSED ENUMS ARE KEYED BY PATH, NOT BY FIELD-UNDER-`data` (#1048).
   *
   * Same argument as the requiredness above: a fixture supplying a valid value cannot detect
   * the enum being WIDENED, because the value it supplies stays valid. A superset always
   * validates.
   *
   * WHAT THE PREVIOUS SHAPE COULD NOT SAY. It was `Record<type, Record<field, values>>`, read
   * as `b.data.properties?.[field]?.enum`, so it could only address enums INSIDE
   * `data.properties`. The contract declares exactly two closed enums and only one of them
   * lives there:
   *
   *     oneOf[14]  data-approval-required   properties.data.properties.status   ["waiting"]
   *     oneOf[20]  finish                   properties.finishReason             6 values
   *
   * `finish` has NO `data` at all — its properties are `type`, `finishReason`,
   * `messageMetadata`. So adding `finish: { finishReason: [...] }` to the old map was not
   * merely ineffective, it was UNSATISFIABLE: the accessor yields `undefined` and the case
   * fails permanently with no edit to the contract able to make it pass.
   *
   * AND MIRRORING THE REQUIREDNESS POPULATION CASE WOULD NOT HAVE CLOSED IT. That case asks
   * which variants declare `data.required` — it carries the SAME one-level-into-`data`
   * restriction, which the closing note below already admits. An enum population case built
   * to match it would have been blind to `finishReason` for exactly the reason the map was.
   * The accessor limit and the population limit are one limit, so one repair answers both.
   *
   * THE CENSUS IS DERIVED, THE EXPECTATION IS HAND-WRITTEN, and that split is what keeps this
   * non-vacuous — the same reason `FROZEN_REQUIRED` is a list and not a loop over the
   * contract. Walking the branch finds every enum wherever it sits; comparing the walk to a
   * literal below is what a mutation cannot reach. A third enum appearing anywhere in any
   * variant shows up as an extra row rather than as silence.
   *
   * ORDER IS PINNED AS WELL AS MEMBERSHIP, deliberately and now said out loud. A reorder of
   * the values in the JSON fails identically to a widening. That is defensible for a frozen
   * copy — it is a byte-level second opinion, and a reorder is still an edit someone made
   * that a human should look at — but it is stricter than "is closed to these values" sounds,
   * so the case names the order rather than leaving the reader to infer it.
   */
  type FrozenEnum = readonly [type: string, path: string, values: unknown[]];
  const FROZEN_ENUMS: readonly FrozenEnum[] = [
    ["start", "properties.type", ["start"]],
    ["text-start", "properties.type", ["text-start"]],
    ["text-delta", "properties.type", ["text-delta"]],
    ["text-end", "properties.type", ["text-end"]],
    ["tool-input-start", "properties.type", ["tool-input-start"]],
    ["tool-input-available", "properties.type", ["tool-input-available"]],
    ["tool-output-available", "properties.type", ["tool-output-available"]],
    ["data-plan", "properties.type", ["data-plan"]],
    ["data-todo", "properties.type", ["data-todo"]],
    ["data-task", "properties.type", ["data-task"]],
    ["data-file", "properties.type", ["data-file"]],
    ["data-sub-agent", "properties.type", ["data-sub-agent"]],
    ["data-approval", "properties.type", ["data-approval"]],
    ["data-approval-pause", "properties.type", ["data-approval-pause"]],
    ["data-approval-required", "properties.type", ["data-approval-required"]],
    ["data-human-response", "properties.type", ["data-human-response"]],
    ["data-agents-md", "properties.type", ["data-agents-md"]],
    ["data-error", "properties.type", ["data-error"]],
    ["data-testing", "properties.type", ["data-testing"]],
    ["finish-step", "properties.type", ["finish-step"]],
    ["finish", "properties.type", ["finish"]],
    [
      "data-approval",
      "properties.data.properties.actionName",
      ["enter_plan_mode"],
    ],
    ["data-approval", "properties.data.properties.status", ["waiting"]],
    [
      "data-approval-required",
      "properties.data.properties.status",
      ["waiting"],
    ],
    [
      "finish",
      "properties.finishReason",
      ["stop", "length", "content-filter", "tool-calls", "error", "other"],
    ],
  ];

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
    const expected = Object.keys(FROZEN_REQUIRED)
      .filter((t) => declaredTypes().has(t))
      .sort();
    /*
     * NON-VACUITY, AND NOTHING MORE THAN THAT. Scoping to present variants makes this satisfiable by
     * a contract carrying none of them, so the floor refuses a filter that emptied.
     *
     * THE CONSTANT IS ONE BELOW THE MEASURED MINIMUM, WHICH IS THE WHOLE OF ITS DERIVATION. Ejecting
     * each of the five rungs in turn leaves 3, 3, 3, 4, 4 of these four entries, so 2 catches a
     * collapse to nothing or to one and does NOT catch the filter wrongly dropping a single core
     * entry. A floor of 3 would catch that and would be a threshold pinned to today -- it breaks the
     * first time a core variant legitimately becomes rung-owned, which is a change this repository
     * exists to make easy. So this is insurance against vacuity, not a check that the filter behaves;
     * what checks that the filter behaves is the equality below, over the set it did produce.
     */
    expect(
      expected.length,
      "no frozen required-set survived the scope filter"
    ).toBeGreaterThanOrEqual(2);
    expect(declaring).toEqual(expected);
  });

  for (const [type, required] of Object.entries(FROZEN_REQUIRED).filter(([t]) =>
    declaredTypes().has(t)
  )) {
    it(`${type} requires exactly ${required.length} field(s)`, () => {
      const b = branches().find((x) => x.type === type);
      expect(b, `no branch declares type ${type}`).toBeDefined();
      expect(b!.data.required).toEqual(required);
    });
  }

  /**
   * Every `enum` anywhere inside a branch, as `[type, dotted path from the branch root]`.
   * Recursive on purpose: the defect this replaces came from an accessor that could only
   * look in one place, so the census must not have a favourite place to look.
   */
  const enumCensus = (): Array<{
    type: string | undefined;
    path: string;
    values: unknown[];
  }> => {
    const out: Array<{
      type: string | undefined;
      path: string;
      values: unknown[];
    }> = [];
    const walk = (
      node: unknown,
      path: string,
      type: string | undefined
    ): void => {
      if (Array.isArray(node)) {
        node.forEach((v, i) => walk(v, `${path}[${i}]`, type));
        return;
      }
      if (node === null || typeof node !== "object") return;
      const rec = node as Record<string, unknown>;
      if (Array.isArray(rec.enum)) out.push({ type, path, values: rec.enum });
      else if (Object.prototype.hasOwnProperty.call(rec, "const"))
        out.push({ type, path, values: [rec.const] });
      for (const [k, v] of Object.entries(rec)) {
        walk(v, path ? `${path}.${k}` : k, type);
      }
    };
    for (const b of contract.oneOf) {
      walk(b, "", (b as any).properties?.type?.const);
    }
    return out;
  };

  it("the SET of closed enums the contract declares is exactly the frozen set", () => {
    const declared = enumCensus()
      .map((e) => `${e.type} @ ${e.path}`)
      .sort();
    const expected = FROZEN_ENUMS.filter(([t]) => declaredTypes().has(t))
      .map(([type, path]) => `${type} @ ${path}`)
      .sort();
    /*
     * NON-VACUITY, AND THE CONSTANT IS NOT THE ONE ABOVE. Same shape as the required-set floor and a
     * different number, because the number is derived per table rather than copied. Two of these four
     * entries are the two `data-approval` pins, so ejecting each of the five rungs leaves 2, 2, 2, 4,
     * 4 -- a MEASURED MINIMUM OF 2, where the other table's is 3. A floor of 2 here would sit exactly
     * ON the minimum and fail the first time a third enum became rung-owned, which is the pinned-to-
     * today shape the other comment declines. One below the minimum is 1, and 1 is what this refuses:
     * a filter that emptied, leaving `[] === []` here and ZERO generated arms in the loop below.
     *
     * That loop is why the floor belongs on the census and not only in the loop. A `for` over an
     * empty array reports nothing -- no skip, no red, just a suite that quietly got smaller, which is
     * the inert-arm class #1122 exists for. Flooring the set the loop iterates is what makes the arms
     * below unable to silently stop existing.
     */
    expect(
      expected.length,
      "no frozen enum survived the scope filter"
    ).toBeGreaterThanOrEqual(1);
    expect(declared).toEqual(expected);
  });

  for (const [type, path, values] of FROZEN_ENUMS.filter(([t]) =>
    declaredTypes().has(t)
  )) {
    it(`${type} @ ${path} is closed to exactly [${values.join(
      ", "
    )}], in that order`, () => {
      const found = enumCensus().filter(
        (e) => e.type === type && e.path === path
      );
      expect(
        found.length,
        `expected exactly one enum at ${type} @ ${path}, found ${found.length}`
      ).toBe(1);
      expect(found[0].values).toEqual(values);
    });
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
 * And THE REQUIREDNESS HALF reaches ONE LEVEL into `data` only. A `required` nested deeper --
 * inside a payload object -- is neither frozen nor noticed by its population case, because
 * that case asks which variants declare `data.required` and not which declare one anywhere.
 * THE ENUM HALF NO LONGER HAS THIS LIMIT (#1048): its census walks each branch and keys by
 * path, so an enum at any depth, under `data` or beside it, is counted. The two halves are
 * deliberately asymmetric and this note is the only place that says so -- a `required`
 * nested deeper is the remaining hole, and it is where the next defect of this shape would
 * be expected.
 */
describe("OpenAPI spec — docs/openapi.yaml is valid OpenAPI 3.1", () => {
  it("loads + parses without errors", async () => {
    const SwaggerParser = (await import("@apidevtools/swagger-parser")).default;
    const specPath = path.join(REPO_ROOT, "docs/openapi.yaml");
    // Validate the document structure conforms to OpenAPI 3.1 spec.
    // Throws on any structural error (missing required fields, bad refs).
    await expect(SwaggerParser.validate(specPath)).resolves.toBeDefined();
  });
});
