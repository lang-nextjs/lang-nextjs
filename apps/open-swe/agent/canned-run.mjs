/**
 * The scripted run. Emits LangGraph `astream_events` v2 frames using the tool
 * names the open-swe adapter enriches on (packages/server/src/adapters/
 * openSweEnrich.ts): save_plan, enter_plan_mode, write_file, read_file, task.
 *
 * Every step here exists to exercise one thing this repo actually owns —
 * SSE delivery, tool-call cards, plan enrichment, approval gating, run
 * lifecycle. The LLM is the part this repo does NOT own, which is why a
 * scripted producer is a complete demonstration of the glue layer rather
 * than a reduced one.
 */

/** Steps as (event, name, data) triples. `delayMs` paces them so the stream is
 *  visibly progressive rather than arriving as one frame. */
export const CANNED_STEPS = [
  {
    event: "on_tool_start",
    name: "save_plan",
    delayMs: 250,
    data: {
      input: {
        plan_markdown:
          "# Plan\n1. Read the failing module\n2. Write the fix\n3. Re-run the suite",
      },
    },
  },
  {
    event: "on_tool_end",
    name: "save_plan",
    delayMs: 150,
    data: { output: "plan saved" },
  },

  {
    event: "on_tool_start",
    name: "read_file",
    delayMs: 250,
    data: {
      input: {
        file_path: "src/parser.ts",
      },
    },
  },
  {
    event: "on_tool_end",
    name: "read_file",
    delayMs: 200,
    data: {
      output: {
        content:
          "export function parse(s: string) {\n  return JSON.parse(s);\n}\n",
      },
    },
  },

  {
    event: "on_tool_start",
    name: "task",
    delayMs: 250,
    data: {
      input: {
        description: "inspect-tests",
        subagent_type: "explorer",
      },
    },
  },
  {
    event: "on_tool_end",
    name: "task",
    delayMs: 200,
    data: { output: "2 failing cases in parser.test.ts" },
  },

  {
    event: "on_tool_start",
    name: "write_file",
    delayMs: 250,
    data: {
      input: {
        file_path: "src/parser.ts",
        content:
          "export function parse(s: string) {\n  if (!s) return null;\n  return JSON.parse(s);\n}\n",
      },
    },
  },
  {
    event: "on_tool_end",
    name: "write_file",
    delayMs: 200,
    data: {
      output: {
        content:
          "export function parse(s: string) {\n  if (!s) return null;\n  return JSON.parse(s);\n}\n",
      },
    },
  },

  // Approval gating — the card the run page renders as an ApprovalCard.
  {
    event: "on_tool_start",
    name: "enter_plan_mode",
    delayMs: 250,
    data: {
      input: {
        plan: "Apply the null-guard fix to src/parser.ts and re-run the suite.",
      },
    },
  },
  {
    event: "on_tool_end",
    name: "enter_plan_mode",
    delayMs: 150,
    data: { output: "awaiting approval" },
  },
];

/** Terminal thread state a completed canned run leaves behind, so GET /state
 *  renders history for a finished run (the endpoint behind 12 of #22's 15
 *  e2e failures — it is load-bearing for the rung, not just for tests). */
export const CANNED_FINAL_STATE = {
  status: "idle",
  interrupts: null,
  values: {
    messages: [
      { role: "user", content: "Fix the failing parser test" },
      {
        role: "assistant",
        content: "Added a null-guard to parse() and re-ran the suite.",
      },
    ],
    files: {
      "src/parser.ts":
        "export function parse(s: string) {\n  if (!s) return null;\n  return JSON.parse(s);\n}\n",
    },
    plan_mode: null,
  },
};
