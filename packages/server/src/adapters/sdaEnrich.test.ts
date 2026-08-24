/**
 * sdaEnrich — rung 5 (software-developer-agent) enrichment transform.
 *
 * ── WHAT THESE TESTS PROVE, AND WHAT THEY DO NOT ────────────────────────────────
 *
 * PROVE: given a `tool-input-start` / `tool-output-available` frame carrying a
 * rung-5 tool name and its documented argument shape, the transform emits the
 * correct `data-*` part with the correct field names.
 *
 * DO NOT PROVE: that a live rung-5 graph actually emits these tool calls in this
 * shape. The fixtures are hand-built from the tool schemas in the vendored source
 * (`rungs/5-software-developer-agent/packages/shared/src/open-swe/tools.ts` and
 * `apps/open-swe/src/tools/set-testing-status.ts`) at pinned commit 3fb3ee1 — they
 * are NOT recordings from a running agent. Verifying the live shape needs an LLM
 * key and a running LangGraph server; that assertion is still owed.
 *
 * Determinism is the point rather than a consolation: a fixed payload is a stable
 * regression baseline in a way a live model's output is not.
 *
 * ── WHY THE FIELD NAMES ARE ASSERTED SO LITERALLY ───────────────────────────────
 *
 * packages/server does not depend on @deepagents-nextjs/react, so these cannot
 * import the Zod schemas that guard these parts downstream. The exact field names
 * below ARE that contract, restated. Two real bugs were caught by checking them
 * against `packages/react/src/schemas.ts` by hand:
 *
 *   - data-plan subtasks used `title`; PlanSubtaskSchema requires `label`
 *   - data-todo used flat `{title,status,detail}`; TodoSchema requires `{items:[]}`
 *
 * Both produce valid JSON, both fail safeParse, and converter.ts is FAIL-OPEN — it
 * warns and drops. The panel silently never renders. If you change a field name
 * here, change it in packages/react/src/schemas.ts in the same commit.
 */

import { describe, it, expect } from "vitest";
import { createSdaEnrichTransform } from "./sdaEnrich";
import type { SseFrame } from "../accumulator";

/** Build the `tool-input-start` frame the base openSwe transform would emit. */
function startFrame(
  toolName: string,
  input: Record<string, unknown>,
  toolCallId = "run-1--tool-0"
): SseFrame {
  return {
    raw: `data: ${JSON.stringify({
      type: "tool-input-start",
      toolCallId,
      toolName,
      input,
    })}`,
  };
}

/** Build the `tool-output-available` frame. */
function endFrame(output: unknown, toolCallId = "run-1--tool-0"): SseFrame {
  return {
    raw: `data: ${JSON.stringify({
      type: "tool-output-available",
      toolCallId,
      output,
    })}`,
  };
}

/** Run frames through a fresh transform, flatten, and parse the data payloads. */
function emit(frames: SseFrame[]): Array<Record<string, unknown>> {
  const t = createSdaEnrichTransform();
  const out: Array<Record<string, unknown>> = [];
  for (const f of frames) {
    const r = t(f);
    if (r === null) continue;
    for (const one of Array.isArray(r) ? r : [r]) {
      out.push(JSON.parse(one.raw.slice(6)) as Record<string, unknown>);
    }
  }
  return out;
}

/** The single `data-*` part of a given type, or undefined. */
function partOf(
  emitted: Array<Record<string, unknown>>,
  type: string
): Record<string, unknown> | undefined {
  const hit = emitted.find((e) => e.type === type);
  return hit?.data as Record<string, unknown> | undefined;
}

describe("sdaEnrich — data-plan from session_plan", () => {
  it("ACCEPT: session_plan emits a plan whose subtasks use `label`", () => {
    const emitted = emit([
      startFrame("session_plan", {
        title: "Add a health endpoint",
        plan: ["Write the route", "Add a test"],
      }),
    ]);
    const plan = partOf(emitted, "data-plan");
    expect(plan).toBeDefined();
    expect(plan!.title).toBe("Add a health endpoint");
    expect(plan!.subtasks).toEqual([
      { id: "run-1--tool-0-0", label: "Write the route", status: "pending" },
      { id: "run-1--tool-0-1", label: "Add a test", status: "pending" },
    ]);
    // The regression that PlanSubtaskSchema would have rejected.
    expect(Object.keys(plan!.subtasks as object[])).not.toContain("title");
    for (const s of plan!.subtasks as Array<Record<string, unknown>>) {
      expect(s).toHaveProperty("label");
      expect(s).not.toHaveProperty("title");
    }
  });

  it("ACCEPT: the tool frame is preserved alongside the data part", () => {
    const emitted = emit([
      startFrame("session_plan", { title: "T", plan: ["a"] }),
    ]);
    expect(emitted.map((e) => e.type)).toEqual([
      "tool-input-start",
      "data-plan",
    ]);
  });

  it("REJECT: update_plan emits NO data-plan — it carries no plan body", () => {
    // Its whole schema is { update_plan_reasoning }. Mapping it would render a
    // plan panel containing reasoning about editing a plan.
    const emitted = emit([
      startFrame("update_plan", {
        update_plan_reasoning: "the third step is now unnecessary",
      }),
    ]);
    expect(partOf(emitted, "data-plan")).toBeUndefined();
    expect(emitted.map((e) => e.type)).toEqual(["tool-input-start"]);
  });

  it("REJECT: a non-array `plan` does not crash and yields no subtasks", () => {
    const emitted = emit([
      startFrame("session_plan", { title: "T", plan: "not an array" }),
    ]);
    expect(partOf(emitted, "data-plan")!.subtasks).toEqual([]);
  });
});

describe("sdaEnrich — data-testing", () => {
  it("ACCEPT: every status in set_testing_status's enum round-trips", () => {
    for (const status of [
      "not_started",
      "required",
      "in_progress",
      "completed",
      "failed",
      "skipped",
    ]) {
      const emitted = emit([
        startFrame("set_testing_status", { status, reason: "because" }),
      ]);
      const t = partOf(emitted, "data-testing");
      expect(t, `status ${status}`).toBeDefined();
      expect(t!.kind).toBe("status");
      expect(t!.status, `status ${status}`).toBe(status);
      expect(t!.reason).toBe("because");
    }
  });

  it("ACCEPT: `failed` and `skipped` stay distinguishable — the whole point", () => {
    // This is the reason data-testing exists rather than reusing data-todo,
    // whose vocabulary (pending|in-progress|done) cannot express either one.
    const failed = partOf(
      emit([startFrame("set_testing_status", { status: "failed", reason: "2 specs red" })]),
      "data-testing"
    );
    const skipped = partOf(
      emit([startFrame("set_testing_status", { status: "skipped", reason: "docs only" })]),
      "data-testing"
    );
    expect(failed!.status).toBe("failed");
    expect(skipped!.status).toBe("skipped");
    expect(failed!.status).not.toBe(skipped!.status);
  });

  it("REJECT: an out-of-enum status becomes `unknown`, not a real state", () => {
    const t = partOf(
      emit([startFrame("set_testing_status", { status: "ha_ha_pwned", reason: "" })]),
      "data-testing"
    );
    expect(t!.status).toBe("unknown");
    // Specifically NOT coerced to a state the graph could genuinely have entered.
    expect(t!.status).not.toBe("not_started");
  });

  it("REJECT: a non-string status becomes `unknown` rather than crashing", () => {
    const t = partOf(
      emit([startFrame("set_testing_status", { status: 42, reason: null })]),
      "data-testing"
    );
    expect(t!.status).toBe("unknown");
    expect(t!.reason).toBe("");
  });

  it("ACCEPT: playwright emits kind=run with its command", () => {
    const t = partOf(
      emit([
        startFrame("playwright", {
          command: "run_test_file",
          test_file: "e2e/login.spec.ts",
          browser: "chromium",
          headless: false,
        }),
      ]),
      "data-testing"
    );
    expect(t!.kind).toBe("run");
    expect(t!.command).toBe("run_test_file");
    expect(t!.testFile).toBe("e2e/login.spec.ts");
    expect(t!.browser).toBe("chromium");
    expect(t!.headless).toBe(false);
  });

  it("ACCEPT: headless defaults to true when absent (matches the tool's default)", () => {
    const t = partOf(
      emit([startFrame("playwright", { command: "run_tests" })]),
      "data-testing"
    );
    expect(t!.headless).toBe(true);
    expect(t!.testFile).toBeNull();
  });
});

describe("sdaEnrich — data-todo shape (list, not flat)", () => {
  it("ACCEPT: mark_task_completed emits a one-item list with status `done`", () => {
    const todo = partOf(
      emit([
        startFrame("mark_task_completed", {
          completed_task_summary: "Added the route and a test.",
        }),
      ]),
      "data-todo"
    );
    expect(todo).toBeDefined();
    // TodoSchema requires `items`; a flat {title,status,detail} is dropped.
    expect(todo).toHaveProperty("items");
    expect(todo).not.toHaveProperty("title");
    expect(todo!.items).toEqual([
      { id: "run-1--tool-0", text: "Added the route and a test.", status: "done" },
    ]);
  });

  it("ACCEPT: mark_task_not_completed uses `in-progress`, the schema's spelling", () => {
    const todo = partOf(
      emit([startFrame("mark_task_not_completed", { reasoning: "tests fail" })]),
      "data-todo"
    );
    const items = todo!.items as Array<Record<string, unknown>>;
    expect(items[0].status).toBe("in-progress");
    // NOT the snake_case "in_progress" — TodoItemSchema's enum is hyphenated.
    expect(items[0].status).not.toBe("in_progress");
  });

  it("ACCEPT: a review verdict lists each follow-up action as its own item", () => {
    const todo = partOf(
      emit([
        startFrame("code_review_mark_task_not_complete", {
          review: "Missing error handling.",
          additional_actions: ["Wrap the fetch", "Add a test"],
        }),
      ]),
      "data-todo"
    );
    const items = todo!.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(3);
    expect(items[0].text).toBe("Missing error handling.");
    expect(items[0].status).toBe("in-progress");
    expect(items[1]).toEqual({
      id: "run-1--tool-0-action-0",
      text: "Wrap the fetch",
      status: "pending",
    });
  });

  it("REJECT: review_started emits nothing — it is never actually executed", () => {
    // Upstream fabricates it as a hidden synthetic tool call in
    // graphs/reviewer/nodes/initialize-state.ts; nothing runs it, so no
    // on_tool_start reaches us. A mapping would be dead code reading as coverage.
    const emitted = emit([startFrame("review_started", { review_started: true })]);
    expect(emitted.map((e) => e.type)).toEqual(["tool-input-start"]);
  });
});

describe("sdaEnrich — data-approval-required from request_human_help", () => {
  it("ACCEPT: emits a blocking gate carrying the help request", () => {
    const a = partOf(
      emit([
        startFrame("request_human_help", { help_request: "Where does auth live?" }),
      ]),
      "data-approval-required"
    );
    expect(a).toBeDefined();
    expect(a!.actionName).toBe("request_human_help");
    expect(a!.description).toBe("Where does auth live?");
    expect(a!.status).toBe("waiting");
    // ApprovalSchema requires `arguments` to be a record or "<unserializable>".
    expect(typeof a!.arguments).toBe("object");
  });

  it("REJECT: does NOT emit data-approval, which is rung-4-owned", () => {
    const emitted = emit([
      startFrame("request_human_help", { help_request: "x" }),
    ]);
    expect(partOf(emitted, "data-approval")).toBeUndefined();
  });
});

describe("sdaEnrich — file parts", () => {
  it("ACCEPT: text editor `create` emits data-file from file_text on start", () => {
    const f = partOf(
      emit([
        startFrame("str_replace_based_edit_tool", {
          command: "create",
          path: "/repo/src/a.ts",
          file_text: "export const a = 1;\n",
        }),
      ]),
      "data-file"
    );
    expect(f!.path).toBe("/repo/src/a.ts");
    expect(f!.name).toBe("a.ts");
    expect(f!.language).toBe("typescript");
    expect(f!.content).toBe("export const a = 1;\n");
    expect(f!.truncated).toBe(false);
  });

  it("ACCEPT: `str_replace` resolves its content at tool-output, not start", () => {
    const t = createSdaEnrichTransform();
    const started = t(
      startFrame("str_replace_based_edit_tool", {
        command: "str_replace",
        path: "/repo/src/b.ts",
        old_str: "1",
        new_str: "2",
      })
    );
    // Start emits the tool frame only — the new body is not known yet.
    expect(Array.isArray(started)).toBe(false);

    const ended = t(endFrame("export const b = 2;\n"));
    const parts = (Array.isArray(ended) ? ended : [ended!]).map(
      (f) => JSON.parse(f.raw.slice(6)) as Record<string, unknown>
    );
    const file = parts.find((p) => p.type === "data-file")
      ?.data as Record<string, unknown>;
    expect(file.path).toBe("/repo/src/b.ts");
    expect(file.content).toBe("export const b = 2;\n");
  });

  it("REJECT: a non-string path does not reach basename()", () => {
    const f = partOf(
      emit([
        startFrame("str_replace_based_edit_tool", {
          command: "create",
          path: { evil: true },
          file_text: "x",
        }),
      ]),
      "data-file"
    );
    expect(f!.path).toBe("");
    expect(f!.name).toBe("");
  });
});

describe("sdaEnrich — pass-through and hostile input", () => {
  it("ACCEPT: text-delta and [DONE] pass through untouched", () => {
    const t = createSdaEnrichTransform();
    const delta: SseFrame = {
      raw: `data: ${JSON.stringify({ type: "text-delta", delta: "hi" })}`,
    };
    expect(t(delta)).toBe(delta);
    const done: SseFrame = { raw: "data: [DONE]" };
    expect(t(done)).toBe(done);
  });

  it("REJECT: malformed JSON passes through instead of throwing", () => {
    const t = createSdaEnrichTransform();
    const bad: SseFrame = { raw: "data: {not json" };
    expect(t(bad)).toBe(bad);
  });

  it("REJECT: `data: null` does not crash on property access", () => {
    const t = createSdaEnrichTransform();
    const nul: SseFrame = { raw: "data: null" };
    expect(() => t(nul)).not.toThrow();
    expect(t(nul)).toBe(nul);
  });

  it("REJECT: an unknown tool name yields only the generic tool frame", () => {
    const emitted = emit([startFrame("shell", { command: ["ls"] })]);
    expect(emitted.map((e) => e.type)).toEqual(["tool-input-start"]);
  });

  it("REJECT: an output with no matching start is passed through, not paired", () => {
    const t = createSdaEnrichTransform();
    const orphan = endFrame("result", "never-started");
    expect(t(orphan)).toBe(orphan);
  });
});
