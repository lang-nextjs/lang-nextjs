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
/**
 * The steps a scripted run streams, for a given task.
 *
 * A FUNCTION, FOR THE SAME REASON THE FINAL STATE IS. This was a constant that
 * named `src/parser.ts`, reported "2 failing cases in parser.test.ts" and
 * planned to "Read the failing module" — for every task anyone ever submitted.
 * A run for "Refactor the auth module" streamed an investigation of a parser.
 *
 * WHAT IS DELIBERATELY *NOT* DONE HERE: inventing plausible work per task.
 * Generating a believable plan for whatever was typed would make a scripted run
 * HARDER to tell from a real one, which is the opposite of what this file is
 * for. The step SHAPES stay fixed, because their job is to exercise the UI
 * surfaces — a plan card, a file read, a subagent task, a write, an approval
 * gate. Only the content changes, and it says what it is.
 */
export function cannedSteps(task) {
  const clean =
    typeof task === "string" && task.trim() ? task.trim() : "Untitled task";
  const note = `Scripted run — no model was called. Task: ${clean}`;

  return [
    {
      event: "on_tool_start",
      name: "save_plan",
      delayMs: 250,
      data: {
        input: {
          plan_markdown:
            `# Plan (scripted)\n\nNo model produced this. It is a fixed ` +
            `sequence used to exercise the run UI.\n\nTask as submitted:\n\n` +
            `> ${clean}\n`,
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
      // Not `src/parser.ts`. Claiming to have opened a file that may not exist
      // in the reader's repo is the specific thing that made these runs read
      // as real work about someone else's code.
      data: { input: { file_path: "SCRIPTED_RUN.md" } },
    },
    {
      event: "on_tool_end",
      name: "read_file",
      delayMs: 200,
      data: { output: { content: `${note}\n` } },
    },

    {
      event: "on_tool_start",
      name: "task",
      delayMs: 250,
      data: { input: { description: "scripted-subagent", subagent_type: "explorer" } },
    },
    {
      event: "on_tool_end",
      name: "task",
      delayMs: 200,
      // Was "2 failing cases in parser.test.ts" — a specific finding about a
      // test file nobody had run.
      data: { output: "no subagent ran; this output is scripted" },
    },

    {
      event: "on_tool_start",
      name: "write_file",
      delayMs: 250,
      data: { input: { file_path: "SCRIPTED_RUN.md", content: `${note}\n` } },
    },
    {
      event: "on_tool_end",
      name: "write_file",
      delayMs: 200,
      data: { output: { content: `${note}\n` } },
    },

    // Approval gating — the card the run page renders as an ApprovalCard.
    {
      event: "on_tool_start",
      name: "enter_plan_mode",
      delayMs: 250,
      data: {
        input: {
          plan: `Scripted approval gate. Nothing will be executed for "${clean}".`,
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
}

/**
 * Kept for callers with no task to hand. Prefer `cannedSteps(task)`.
 */
export const CANNED_STEPS = cannedSteps(null);

/**
 * Terminal thread state a completed canned run leaves behind, so GET /state
 * renders history for a finished run (the endpoint behind 12 of #22's 15 e2e
 * failures — it is load-bearing for the rung, not just for tests).
 *
 * A FUNCTION OF THE TASK, NOT A CONSTANT.
 *
 * This was a module-level object with `"Fix the failing parser test"` hardcoded
 * into it, returned for every thread. So a person who submitted "Refactor the
 * auth module" saw their own task on the card, opened it, and read a
 * conversation about a parser they had never mentioned — and every card in the
 * queue showed the same one. The board and the transcript disagreed about what
 * the run WAS.
 *
 * The canned run still exercises the same surfaces (a user turn, an assistant
 * turn, a written file), because that is what it is for. It just uses the task
 * it was actually given.
 *
 * THE REPLY DOES NOT CLAIM TO HAVE DONE THE WORK. The previous one said "Added
 * a null-guard to parse() and re-ran the suite", which is a specific technical
 * assertion no model made — believable enough to be mistaken for a real result,
 * and wrong for every task but one. A scripted run should be recognisable as
 * scripted from its own words, not only from the banner above it.
 */
export function cannedFinalState(task) {
  const clean = typeof task === "string" && task.trim() ? task.trim() : "Untitled task";
  return {
    status: "idle",
    interrupts: null,
    values: {
      messages: [
        { role: "user", content: clean },
        {
          role: "assistant",
          content:
            `This run was scripted — no model was called, so nothing was done ` +
            `about "${clean}". Point LANGGRAPH_PLATFORM_URL at a real ` +
            `deployment to execute it.`,
        },
      ],
      files: {
        // A single illustrative file, so the file surface still has something
        // to render. Named for what it is rather than pretending to be the
        // output of the task above.
        "SCRIPTED_RUN.md":
          `# Scripted run\n\nNo model was called.\n\n` +
          `Task as submitted:\n\n> ${clean}\n`,
      },
      plan_mode: null,
    },
  };
}

/**
 * Kept for callers that only need the shape and have no task to hand.
 * Prefer `cannedFinalState(task)` — a state that ignores its task is what this
 * file existed to stop producing.
 */
export const CANNED_FINAL_STATE = cannedFinalState(null);
