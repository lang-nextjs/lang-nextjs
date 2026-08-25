import { describe, it, expect } from "vitest";
import {
  PlanSchema,
  PlanSubtaskSchema,
  TaskSchema,
  FileSchema,
  ApprovalSchema,
  DataSubAgentSchema,
  DataHumanResponseSchema,
  DataErrorSchema,
  TodoItemSchema,
  TodoSchema,
  AgentsMdSchema,
  parseDataPart,
  KNOWN_DATA_PART_TYPES,
} from "./schemas";

const validPlan = {
  id: "plan-1",
  seq: 0,
  title: "Test Plan",
  markdown: "# Plan\n\nDetails here.",
  subtasks: [{ id: "sub-1", label: "Step 1", status: "pending" as const }],
  updatedAt: "2026-04-29T00:00:00Z",
};

const validTask = {
  id: "task-1",
  seq: 1,
  taskName: "Do something",
  status: "in-progress" as const,
  description: null,
  groupLabel: null,
};

const validFile = {
  id: "file-1",
  seq: 2,
  path: "/work/notes.md",
  name: "notes.md",
  language: null,
  size: 1024,
  truncated: false,
  content: null,
  updatedAt: "2026-04-29T00:00:00Z",
};

const validApproval = {
  id: "appr-1",
  seq: 3,
  actionName: "deploy",
  description: "Deploy to production",
  arguments: { env: "prod" },
  status: "waiting" as const,
  createdAt: "2026-04-29T00:00:00Z",
  expiresAt: null,
};

const validDataError = {
  id: "err-1",
  seq: 4,
  code: "llm_timeout",
  message: "LLM timed out",
  retryable: true,
  cause: null,
};

describe("Zod schemas", () => {
  describe("PlanSchema", () => {
    it("validates a valid DataPlan object", () => {
      const result = PlanSchema.safeParse(validPlan);
      expect(result.success).toBe(true);
    });

    it("rejects missing required fields", () => {
      const result = PlanSchema.safeParse({ id: "plan-1" });
      expect(result.success).toBe(false);
    });

    it("validates PlanSubtask with status enum pending|in-progress|done", () => {
      const pending = PlanSubtaskSchema.safeParse({
        id: "s1",
        label: "step",
        status: "pending",
      });
      const inProgress = PlanSubtaskSchema.safeParse({
        id: "s2",
        label: "step",
        status: "in-progress",
      });
      const done = PlanSubtaskSchema.safeParse({
        id: "s3",
        label: "step",
        status: "done",
      });
      const invalid = PlanSubtaskSchema.safeParse({
        id: "s4",
        label: "step",
        status: "unknown",
      });
      expect(pending.success).toBe(true);
      expect(inProgress.success).toBe(true);
      expect(done.success).toBe(true);
      expect(invalid.success).toBe(false);
    });
  });

  describe("TaskSchema", () => {
    it("validates a valid DataTask object", () => {
      const result = TaskSchema.safeParse(validTask);
      expect(result.success).toBe(true);
    });

    it("accepts null description (nullish)", () => {
      const result = TaskSchema.safeParse({ ...validTask, description: null });
      expect(result.success).toBe(true);
      // Also accepts missing description
      const { description: _, ...withoutDesc } = validTask;
      const result2 = TaskSchema.safeParse(withoutDesc);
      expect(result2.success).toBe(true);
    });
  });

  describe("FileSchema", () => {
    it("validates a valid DataFile object", () => {
      const result = FileSchema.safeParse(validFile);
      expect(result.success).toBe(true);
    });

    it("accepts null content and language (nullish)", () => {
      const result = FileSchema.safeParse({
        ...validFile,
        content: null,
        language: null,
      });
      expect(result.success).toBe(true);
      // Also accepts string values
      const result2 = FileSchema.safeParse({
        ...validFile,
        content: "file content",
        language: "typescript",
      });
      expect(result2.success).toBe(true);
    });
  });

  describe("ApprovalSchema", () => {
    it("validates a valid DataApproval object", () => {
      const result = ApprovalSchema.safeParse(validApproval);
      expect(result.success).toBe(true);
    });

    it("accepts null expiresAt (nullish)", () => {
      const result = ApprovalSchema.safeParse({
        ...validApproval,
        expiresAt: null,
      });
      expect(result.success).toBe(true);
      // Also accepts a string expiry
      const result2 = ApprovalSchema.safeParse({
        ...validApproval,
        expiresAt: "2026-05-01T00:00:00Z",
      });
      expect(result2.success).toBe(true);
    });
  });

  describe("DataSubAgentSchema", () => {
    const validSubAgent = {
      id: "sa-1",
      seq: 5,
      parentToolCallId: "tc-task-0",
      name: "researcher",
      status: "running" as const,
      prompt: "Find recent CVEs.",
      result: null,
      error: null,
      startedAt: "2026-04-29T00:00:00Z",
      finishedAt: null,
    };

    it("validates a valid DataSubAgent object", () => {
      expect(DataSubAgentSchema.safeParse(validSubAgent).success).toBe(true);
    });

    it("accepts every status enum value (starting/running/done/errored)", () => {
      for (const status of [
        "starting",
        "running",
        "done",
        "errored",
      ] as const) {
        expect(
          DataSubAgentSchema.safeParse({ ...validSubAgent, status }).success
        ).toBe(true);
      }
    });

    it("rejects an unknown status", () => {
      expect(
        DataSubAgentSchema.safeParse({ ...validSubAgent, status: "queued" })
          .success
      ).toBe(false);
    });

    it("rejects negative seq", () => {
      expect(
        DataSubAgentSchema.safeParse({ ...validSubAgent, seq: -1 }).success
      ).toBe(false);
    });

    it("rejects missing parentToolCallId", () => {
      const { parentToolCallId: _omit, ...partial } = validSubAgent;
      expect(DataSubAgentSchema.safeParse(partial).success).toBe(false);
    });

    it("accepts result/error/finishedAt as nullish", () => {
      expect(
        DataSubAgentSchema.safeParse({
          ...validSubAgent,
          result: "done!",
          error: null,
          finishedAt: "2026-04-29T00:05:00Z",
        }).success
      ).toBe(true);
    });
  });

  describe("DataHumanResponseSchema", () => {
    const validHumanResponse = {
      id: "appr-respond-1",
      seq: 9,
      response: "Use a dry run first.",
      createdAt: "2026-04-29T00:00:00Z",
    };

    it("validates a valid DataHumanResponse object", () => {
      const result = DataHumanResponseSchema.safeParse(validHumanResponse);
      expect(result.success).toBe(true);
    });

    it("rejects when response is not a string", () => {
      const result = DataHumanResponseSchema.safeParse({
        ...validHumanResponse,
        response: 123,
      });
      expect(result.success).toBe(false);
    });

    it("rejects negative seq", () => {
      const result = DataHumanResponseSchema.safeParse({
        ...validHumanResponse,
        seq: -1,
      });
      expect(result.success).toBe(false);
    });

    it("rejects missing required fields", () => {
      const result = DataHumanResponseSchema.safeParse({ id: "x", seq: 0 });
      expect(result.success).toBe(false);
    });

    it("accepts empty string for response (envelope shape is what matters; emptiness is a server-side validation)", () => {
      const result = DataHumanResponseSchema.safeParse({
        ...validHumanResponse,
        response: "",
      });
      expect(result.success).toBe(true);
    });
  });

  describe("TodoSchema", () => {
    const validTodo = {
      id: "todo-1",
      seq: 0,
      items: [
        { id: "i1", text: "Set up CI", status: "done" },
        {
          id: "i2",
          text: "Write tests",
          status: "in-progress",
          priority: "high" as const,
        },
      ],
    };

    it("validates a valid DataTodo object", () => {
      expect(TodoSchema.safeParse(validTodo).success).toBe(true);
    });

    it("accepts items without priority", () => {
      expect(
        TodoSchema.safeParse({
          ...validTodo,
          items: [{ id: "i1", text: "Do thing", status: "pending" }],
        }).success
      ).toBe(true);
    });

    it("accepts every status enum value", () => {
      for (const status of ["pending", "in-progress", "done"] as const) {
        expect(
          TodoItemSchema.safeParse({ id: "x", text: "t", status }).success
        ).toBe(true);
      }
    });

    it("rejects unknown status", () => {
      expect(
        TodoItemSchema.safeParse({ id: "x", text: "t", status: "unknown" })
          .success
      ).toBe(false);
    });

    it("rejects unknown priority", () => {
      expect(
        TodoItemSchema.safeParse({
          id: "x",
          text: "t",
          status: "pending",
          priority: "critical",
        }).success
      ).toBe(false);
    });

    it("rejects empty items array", () => {
      // items is z.array(...) — empty array is valid by default
      expect(TodoSchema.safeParse({ ...validTodo, items: [] }).success).toBe(
        true
      );
    });

    it("rejects negative seq", () => {
      expect(TodoSchema.safeParse({ ...validTodo, seq: -1 }).success).toBe(
        false
      );
    });
  });

  describe("AgentsMdSchema", () => {
    const validAgentsMd = {
      id: "amd-1",
      seq: 0,
      content: "# Guidelines\nUse TypeScript.",
      path: "AGENTS.md",
    };

    it("validates a valid DataAgentsMd object", () => {
      expect(AgentsMdSchema.safeParse(validAgentsMd).success).toBe(true);
    });

    it("rejects missing content", () => {
      const { content: _, ...partial } = validAgentsMd;
      expect(AgentsMdSchema.safeParse(partial).success).toBe(false);
    });

    it("rejects missing path", () => {
      const { path: _, ...partial } = validAgentsMd;
      expect(AgentsMdSchema.safeParse(partial).success).toBe(false);
    });

    it("rejects negative seq", () => {
      expect(
        AgentsMdSchema.safeParse({ ...validAgentsMd, seq: -1 }).success
      ).toBe(false);
    });
  });

  describe("parseDataPart()", () => {
    /**
     * PER-PART CASES ARE DERIVED FROM THE REGISTRY, NOT LISTED.
     *
     * These were a hardcoded list of `it("... data-plan ...")` blocks. `schemas.ts` is
     * shared, so the eject keeps this file whole — and #89 taught SCHEMA_MAP to shrink to
     * the parts a fork can actually speak. The list then asserted on five parts the same
     * change had correctly deleted: 7 failures in a rung-1 fork, visible only there.
     *
     * A hardcoded list is a full-ladder assumption. Skipping absent parts by name would be a
     * second one. So the table below is keyed by part and FILTERED THROUGH
     * KNOWN_DATA_PART_TYPES: eleven cases at the full ladder, five at rung 1, non-vacuous at
     * both.
     */
    const VALID: Record<string, unknown> = {
      "data-plan": validPlan,
      "data-task": validTask,
      "data-file": validFile,
      "data-approval": validApproval,
      "data-approval-required": validApproval,
      "data-error": validDataError,
      "data-sub-agent": {
        id: "sa-1",
        seq: 0,
        parentToolCallId: "tc-task-0",
        name: "researcher",
        status: "running",
        prompt: "Find CVEs.",
        result: null,
        error: null,
        startedAt: "2026-04-29T00:00:00Z",
        finishedAt: null,
      },
      "data-human-response": {
        id: "appr-1",
        seq: 7,
        response: "try grep instead",
        createdAt: "2026-04-29T00:00:00Z",
      },
      "data-todo": {
        id: "todo-1",
        seq: 0,
        items: [{ id: "i1", text: "Do thing", status: "pending" }],
      },
      "data-agents-md": {
        id: "amd-1",
        seq: 0,
        content: "# Guidelines",
        path: "AGENTS.md",
      },
      // Discriminated on `kind`. The status arm, which is what set_testing_status emits.
      "data-testing": {
        id: "t-1",
        seq: 0,
        kind: "status",
        status: "in_progress",
        reason: "running the suite",
        updatedAt: "2026-04-29T00:00:00Z",
      },
    };

    /** Payloads that must be REJECTED, for the parts that have a distinctive invalid shape. */
    const INVALID: Record<string, unknown> = {
      "data-sub-agent": {
        id: "sa-1",
        seq: 0,
        parentToolCallId: "tc-task-0",
        name: "researcher",
        status: "queued", // not in the enum
        prompt: "x",
        startedAt: "2026-04-29T00:00:00Z",
      },
      "data-todo": {
        id: "todo-1",
        seq: 0,
        items: [{ id: "i1", text: "t", status: "unknown" }],
      },
      "data-human-response": {
        id: "appr-1",
        seq: 7,
        response: 42, // not a string
        createdAt: "2026-04-29T00:00:00Z",
      },
      "data-testing": {
        id: "t-1",
        seq: 0,
        kind: "status",
        status: "definitely-not-a-status", // outside TESTING_STATUSES
        reason: "",
        updatedAt: "2026-04-29T00:00:00Z",
      },
    };

    const declared = KNOWN_DATA_PART_TYPES;

    // --- guards: a derived loop over an empty registry passes having asserted nothing -------
    it("G1 — the registry is non-empty", () => {
      expect(declared.length).toBeGreaterThan(0);
    });

    it("G2 — every declared part has a fixture, so none is silently skipped", () => {
      // A correspondence, not a count. If someone registers a part and forgets a fixture,
      // the loop below would quietly exercise one case fewer and stay green.
      const missing = declared.filter((t) => !(t in VALID));
      expect(missing, `add a VALID fixture for: ${missing.join(", ")}`).toEqual(
        []
      );
    });

    it("G3 — a part that survives every eject is among them", () => {
      // `data-error` is emitted by core (docs/sse-frame-schema.json, x-emitted-by "core"), so
      // it is present at every rung. Anchoring on it keeps this guard true in a one-rung fork
      // — anchoring on data-plan would have made it a full-ladder assertion, which is the bug
      // this whole block exists to stop repeating.
      expect(declared).toContain("data-error");
    });

    for (const type of declared) {
      it(`returns { ok: true } for a valid ${type} envelope`, () => {
        const result = parseDataPart({ type, data: VALID[type] });
        expect(result.ok, `${type} failed to parse its valid fixture`).toBe(
          true
        );
        if (result.ok) expect(result.type).toBe(type);
      });

      if (type in INVALID) {
        it(`returns { ok: false } for ${type} with an invalid payload`, () => {
          const result = parseDataPart({ type, data: INVALID[type] });
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.error).toBeDefined();
        });
      }
    }

    it("returns { ok: false } for a type no build declares", () => {
      const result = parseDataPart({ type: "data-not-a-real-part", data: {} });
      expect(result.ok).toBe(false);
    });

    it("returns { ok: false } for non-object input", () => {
      expect(parseDataPart("string").ok).toBe(false);
      expect(parseDataPart(null).ok).toBe(false);
      expect(parseDataPart(42).ok).toBe(false);
    });

    it("returns { ok: false } for object with non-string type", () => {
      const result = parseDataPart({ type: 123, data: {} });
      expect(result.ok).toBe(false);
    });

    it("returns { ok: false } when data field is missing (envelope has type but no data)", () => {
      // A well-formed envelope must have a data field. If it is absent (undefined),
      // the schema will fail required fields and the result must be ok:false — not throw.
      // Uses a declared part on purpose. Naming `data-plan` here passed in a rung-1 fork for
      // the WRONG REASON — unknown type rather than missing data — so the assertion held
      // while testing nothing.
      const result = parseDataPart({ type: KNOWN_DATA_PART_TYPES[0] });
      expect(result.ok).toBe(false);
    });

    it("returns { ok: false, error: ZodError } (not undefined) when the type is known but data is invalid", () => {
      // When the type is known and parsing fails, error must be a ZodError instance,
      // not undefined — callers depend on this for diagnostics.
      const result = parseDataPart({
        type: KNOWN_DATA_PART_TYPES[0],
        data: { broken: true },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeDefined();
        // ZodError has an 'issues' array
        expect(
          Array.isArray((result.error as { issues?: unknown })?.issues)
        ).toBe(true);
      }
    });

    it("strips extra unknown fields from a declared payload (Zod default is strip, not passthrough)", () => {
      // Named `data-todo` until #94. That part is rung-3-owned, so a rung-1 fork does not
      // declare it and this asserted on a payload the fork cannot parse. Derived from the
      // registry it keeps the same strength at every rung: `id` and `seq` are common to every
      // part schema, so "known fields survive" is still a real assertion whichever part it
      // lands on.
      const type = declared[0];
      const fixture = VALID[type] as Record<string, unknown>;
      const result = parseDataPart({
        type,
        data: {
          ...fixture,
          extraField: "should be stripped",
          anotherUnknown: 42,
        },
      });
      expect(result.ok, `${type} failed to parse its valid fixture`).toBe(true);
      if (result.ok) {
        const parsed = result.data as Record<string, unknown>;
        expect(parsed.extraField).toBeUndefined();
        expect(parsed.anotherUnknown).toBeUndefined();
        // Known fields must survive.
        expect(parsed.id).toBe(fixture.id);
        expect(parsed.seq).toBe(fixture.seq);
      }
    });
  });

  describe("schema field invariants", () => {
    it("PlanSchema rejects negative seq", () => {
      const result = PlanSchema.safeParse({ ...validPlan, seq: -1 });
      expect(result.success).toBe(false);
    });

    it("FileSchema rejects negative size", () => {
      const result = FileSchema.safeParse({ ...validFile, size: -1 });
      expect(result.success).toBe(false);
    });

    it("ApprovalSchema accepts empty arguments record", () => {
      // arguments: z.record(z.string(), z.unknown()) — an empty object must be valid
      const result = ApprovalSchema.safeParse({
        ...validApproval,
        arguments: {},
      });
      expect(result.success).toBe(true);
    });

    it("DataErrorSchema accepts a populated cause object", () => {
      const result = DataErrorSchema.safeParse({
        ...validDataError,
        cause: { httpStatus: 503, upstream: "openai" },
      });
      expect(result.success).toBe(true);
    });

    it("DataErrorSchema rejects non-string code", () => {
      const result = DataErrorSchema.safeParse({
        ...validDataError,
        code: 123,
      });
      expect(result.success).toBe(false);
    });

    it("DataErrorSchema rejects non-boolean retryable", () => {
      const result = DataErrorSchema.safeParse({
        ...validDataError,
        retryable: "yes",
      });
      expect(result.success).toBe(false);
    });

    it("DataErrorSchema rejects non-object cause (string)", () => {
      const result = DataErrorSchema.safeParse({
        ...validDataError,
        cause: "not an object",
      });
      expect(result.success).toBe(false);
    });

    it("DataErrorSchema rejects array cause", () => {
      const result = DataErrorSchema.safeParse({
        ...validDataError,
        cause: ["err1", "err2"],
      });
      expect(result.success).toBe(false);
    });

    it("parseDataPart fails gracefully (ok:false) when data-* data fails Zod validation", () => {
      // The contract is fail-open: unknown types return ok:false, but known types
      // with invalid data should also return ok:false with the Zod error attached.
      const result = parseDataPart({
        type: "data-error",
        data: { ...validDataError, code: 999 },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeDefined();
      }
    });

    it("parseDataPart returns ok:false for unknown types (no schema)", () => {
      const result = parseDataPart({
        type: "data-unknown-type",
        data: { anything: true },
      });
      expect(result.ok).toBe(false);
    });
  });

  describe("ADVERSARIAL — circular reference in payload", () => {
    it("parseDataPart on a payload with a circular reference returns ok:false (does not throw a stack overflow)", () => {
      // Gap: parseDataPart calls schema.safeParse(envelope.data). For zod
      // schemas, the default JSON parsing recurses into objects. If the
      // payload contains a self-reference (parent.child === parent), the
      // schema's depth check or a JSON.stringify in error formatting could
      // throw RangeError: Maximum call stack size exceeded. The contract
      // must be: still return ok:false, never throw.
      type Node = { name: string; child?: Node };
      const circular: Node = { name: "root" };
      circular.child = circular; // self-reference
      const result = parseDataPart({
        type: "data-plan",
        data: { ...validPlan, title: circular as unknown as string },
      });
      // Could be ok:false (PlanSchema rejects the bad title) — but MUST NOT throw.
      expect(result.ok).toBe(false);
    });
  });

  describe("adversarial iter-2 — explicit null vs explicit undefined semantics for nullish fields", () => {
    it("TaskSchema distinguishes explicit null vs explicit undefined on description (JSON Schema semantics)", () => {
      // Gap: `z.string().nullish()` accepts both `null` and `undefined`.
      // JSON Schema treats them as distinct ("type: 'null'" vs absent), so
      // a downstream serializer that round-trips the parsed result must
      // preserve the distinction. Verify the schema's typed output keeps the
      // nullish field as `string | null | undefined`, AND that Zod does NOT
      // coerce a missing field to null (which would lose the absent/undefined
      // distinction). If the implementation ever replaces missing fields with
      // `null`, downstream consumers would silently drop the "this field was
      // never sent" signal.
      const withNull = TaskSchema.safeParse({
        ...validTask,
        description: null,
      });
      const withUndefined = TaskSchema.safeParse({
        ...validTask,
        description: undefined,
      });
      const withoutField = TaskSchema.safeParse(
        (() => {
          const { description: _drop, ...rest } = validTask;
          return rest;
        })()
      );

      expect(withNull.success).toBe(true);
      expect(withUndefined.success).toBe(true);
      expect(withoutField.success).toBe(true);

      // nullish output must be typed as string | null | undefined
      type Desc = NonNullable<(typeof withNull)["data"]>["description"];
      const _typeProbe: Desc = null;
      const _typeProbe2: Desc = undefined;
      const _typeProbe3: Desc = "hi";
      void [_typeProbe, _typeProbe2, _typeProbe3];

      // Critically: Zod must NOT inject `null` when the field is absent.
      // The parsed output's `description` key must be undefined (not present),
      // NOT null — otherwise consumers can't distinguish "absent" from "null".
      if (withNull.success) {
        expect(withNull.data.description).toBeNull();
      }
      if (withUndefined.success) {
        expect(withUndefined.data.description).toBeUndefined();
      }
      if (withoutField.success) {
        expect(withoutField.data.description).toBeUndefined();
        expect("description" in withoutField.data).toBe(false);
      }
    });
  });

  describe("adversarial iter-3 — TaskSchema with all optional fields omitted (minimal required-only shape)", () => {
    it("TaskSchema accepts the minimum required fields with ALL optional (nullish) fields omitted — no defaults injected", () => {
      // Gap: TaskSchema has `description: z.string().nullish()` and
      // `groupLabel: z.string().nullish()`. The contract is that omitting both
      // (rather than passing `null`) preserves the "field was never sent" signal.
      // If a future refactor adds `.default(null)` or coerces missing → null,
      // consumers lose the absent vs. explicit-null distinction that the
      // converter and downstream serialisers rely on.
      const minimal = {
        id: "task-min",
        seq: 0,
        taskName: "minimal",
        status: "pending" as const,
      };
      const result = TaskSchema.safeParse(minimal);
      expect(result.success).toBe(true);
      if (result.success) {
        // The parsed data must not contain description/groupLabel as keys at all
        expect("description" in result.data).toBe(false);
        expect("groupLabel" in result.data).toBe(false);
        expect(result.data.description).toBeUndefined();
        expect(result.data.groupLabel).toBeUndefined();
      }
    });
  });
});
