/**
 * software-developer-agent (rung 5) enrichment transform.
 *
 * Runs AFTER `createOpenSweTransform()`, exactly like `createOpenSweEnrichTransform()`
 * does for rung 4: the base transform turns LangGraph `on_tool_start`/`on_tool_end`
 * into AI SDK v6 `tool-input-start` / `tool-output-available` frames, and this
 * transform recognizes meaningful tool names and FANS OUT an extra `data-*` frame
 * next to the original (the tool frame is preserved so the generic ToolCard still
 * renders everything).
 *
 * ── Why this exists rather than reusing openSweEnrich ────────────────────────────
 *
 * The base transform IS reusable — it switches on three LangGraph event types
 * (`on_chat_model_stream`, `on_tool_start`, `on_tool_end`) and is entirely
 * graph-agnostic. The ENRICHER is not, because it keys on tool NAMES, and rung 5's
 * vocabulary is almost disjoint from rung 4's. Measured against the vendored source
 * at `rungs/5-software-developer-agent/` (pinned 3fb3ee1):
 *
 *   save_plan        0 occurrences      write_file   present
 *   enter_plan_mode  0 occurrences      read_file    present
 *   edit_file        0 occurrences
 *   task             0 occurrences
 *
 * Four of openSweEnrich's six mappings are dead here. Pointing it at rung 5 does not
 * throw — every unmatched name falls through `return frame` — it just silently
 * renders nothing. That silence is the whole reason this file exists.
 *
 * ── Two mappings that are deliberately NOT the obvious one ──────────────────────
 *
 * `update_plan` does NOT emit data-plan. Its entire schema is
 * `{ update_plan_reasoning: string }` — a justification for why the plan should be
 * revised. It carries no plan. Mapping it to data-plan would render a plan panel
 * containing the agent's reasoning about editing a plan: plausible, wrong, and
 * invisible to any check that only asks whether the stream rendered. The real plan
 * carrier is `session_plan`, whose schema is `{ title, plan: string[] }`.
 *
 * `request_human_help` is rung 5's human gate, not `enter_plan_mode`. Unlike rung 4,
 * it genuinely pauses execution until the user responds, so it maps to
 * `data-approval-required` rather than the advisory `data-approval`.
 *
 * Tool schemas referenced here live in
 * `rungs/5-software-developer-agent/packages/shared/src/open-swe/tools.ts`.
 */

import type { SseFrame, SseMultiTransform, SseTransform } from "../accumulator";
import type { SseAdapter } from "../adapter-contract";
import { createOpenSweTransform } from "./openSwe";

/** Plan content. `{ title: string, plan: string[] }`. */
const PLAN_TOOL = "session_plan";

/** Blocking human gate. `{ help_request: string }`. */
const HUMAN_HELP_TOOL = "request_human_help";

/**
 * Anthropic text-editor tool. `{ command: "view"|"create"|"str_replace"|"insert",
 * path, file_text?, old_str?, new_str?, insert_line? }`. Rung 5's primary editor —
 * rung 4's `edit_file` does not exist here.
 */
const TEXT_EDITOR_TOOL = "str_replace_based_edit_tool";

/** Plain file tools, shared with rung 4. */
const FILE_WRITE_TOOLS = new Set(["write_file", "apply_patch"]);
const FILE_READ_TOOLS = new Set(["read_file", "view"]);

/** Task completion signals. `{ completed_task_summary }` / `{ reasoning }`. */
const TASK_DONE_TOOL = "mark_task_completed";
const TASK_NOT_DONE_TOOL = "mark_task_not_completed";

/**
 * Testing graph. `set_testing_status` is `{ status, reason }`; `playwright` is
 * `{ command, test_file?, browser?, headless?, ... }`. These are the only two tools
 * that produce information no existing `data-*` part can carry — see data-testing.
 */
const TESTING_STATUS_TOOL = "set_testing_status";
const PLAYWRIGHT_TOOL = "playwright";

/**
 * The six states `set_testing_status` accepts, verbatim from its Zod enum in
 * `rungs/5-software-developer-agent/apps/open-swe/src/tools/set-testing-status.ts`.
 * A status outside this set is coerced to "unknown" rather than passed through, so a
 * misbehaving model cannot inject an arbitrary string into a rendered status chip.
 */
const TESTING_STATUSES = new Set([
  "not_started",
  "required",
  "in_progress",
  "completed",
  "failed",
  "skipped",
]);

/**
 * Reviewer graph verdicts. Both take `{ review: string }`; the not-complete variant
 * adds `{ additional_actions: string[] }`.
 *
 * NOTE: `review_started` is deliberately NOT mapped. It is not a tool the model
 * calls — `graphs/reviewer/nodes/initialize-state.ts` fabricates an AIMessage
 * carrying a synthetic `review_started` tool call marked
 * `additional_kwargs: { hidden: true }`, so upstream's own client can detect that
 * review began. Nothing executes it, so it emits no `on_tool_start` and a mapping
 * for it would be dead code that looks like reviewer coverage without being any.
 */
const REVIEW_DONE_TOOL = "code_review_mark_task_completed";
const REVIEW_NOT_DONE_TOOL = "code_review_mark_task_not_complete";

const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash",
  bash: "bash",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  md: "markdown",
  html: "html",
  css: "css",
  scss: "scss",
  sql: "sql",
};

function basename(path: string): string {
  const clean = path.replace(/\/+$/, "");
  const idx = clean.lastIndexOf("/");
  return idx >= 0 ? clean.slice(idx + 1) : clean;
}

function languageFor(path: string): string | undefined {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  if (dot < 0) return undefined;
  return EXT_LANG[name.slice(dot + 1).toLowerCase()];
}

/**
 * Safely extract a file path from untrusted tool args. Rung 5's text editor uses
 * `path`; the plain file tools use `file_path`. A non-string from a misbehaving
 * model must not reach basename()'s string ops.
 */
function pathOf(input: Record<string, unknown>): string {
  if (typeof input.path === "string") return input.path;
  if (typeof input.file_path === "string") return input.file_path;
  return "";
}

/** Coerce an unknown LLM/tool value to a display string. */
function toText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Build a `data-*` frame. `JSON.stringify` throws on a circular structure — a
 * proxied value, a misbehaving model, a backend bug — so this mirrors the
 * langgraph/openSwe hardening: the transform never throws, and a consumer that
 * filters on `type` still sees a valid frame.
 */
function dataFrame(type: string, data: Record<string, unknown>): SseFrame {
  let raw: string;
  try {
    raw = `data: ${JSON.stringify({ type, data })}`;
  } catch {
    raw = `data: ${JSON.stringify({ type, error: "<unserializable>" })}`;
  }
  return { raw };
}

/**
 * Resolve file content + path from an on_tool_end output. Rung 5 returns editor
 * results as a message body rather than rung 4's `artifact.diff` envelope, so this
 * is deliberately simpler than openSweEnrich's equivalent — but still tolerant of
 * both shapes, because `apply_patch` results vary.
 */
function extractFileResult(output: unknown): {
  content: string | undefined;
  path: string | undefined;
} {
  if (output && typeof output === "object") {
    const o = output as Record<string, unknown>;
    const artifact = o.artifact as Record<string, unknown> | undefined;
    const diff = artifact?.diff as Record<string, unknown> | undefined;
    if (diff && diff.newContent != null) {
      return {
        content:
          typeof diff.newContent === "string"
            ? diff.newContent
            : toText(diff.newContent),
        path: typeof diff.filePath === "string" ? diff.filePath : undefined,
      };
    }
    if (typeof o.content === "string")
      return { content: o.content, path: undefined };
    if (typeof o.result === "string")
      return { content: o.result, path: undefined };
  }
  if (typeof output === "string") return { content: output, path: undefined };
  return { content: undefined, path: undefined };
}

interface ToolMeta {
  toolName: string;
  input: Record<string, unknown>;
}

/**
 * ─────────────────────────────────────────────────────────────────────────────────
 * DECISION POINT — how the Testing and Reviewer graphs surface. See the note below.
 * ─────────────────────────────────────────────────────────────────────────────────
 *
 * These are the two graphs that make rung 5 rung 5 — the Playwright Testing graph is
 * the fork author's single largest original contribution, and the Reviewer is what
 * closes the loop before a PR opens. Neither has an equivalent anywhere in rungs 1-4,
 * so neither has an established `data-*` part.
 *
 * Tools in play, with their real schemas:
 *
 *   set_testing_status  { status: "not_started" | "required" | "in_progress"
 *                                 | "completed" | "failed" | "skipped",
 *                         reason: string }
 *   playwright          { command: "run_tests" | "run_test_file" | "install" | "init"
 *                                  | "codegen" | "show_report" | "check_config",
 *                         test_file?, options?, browser?, headless?, ui_mode?, debug? }
 *   review_started      (reviewer graph entry)
 *   code_review_mark_task_completed / code_review_mark_task_not_complete
 *
 * The `data-*` parts the client already understands: data-plan, data-file,
 * data-todo, data-sub-agent, data-approval, data-approval-required, data-error,
 * data-human-response.
 *
 * @param toolName  the rung-5 tool name from `tool-input-start`
 * @param input     that tool call's arguments
 * @param toolCallId stable id — use as the `data-*` part's `id` so repeat calls upsert
 * @param seq       monotonic sequence number for ordering
 * @returns a `data-*` frame to fan out alongside the tool frame, or null to emit
 *          only the generic tool card
 */
function testingAndReviewFrame(
  toolName: string,
  input: Record<string, unknown>,
  toolCallId: string,
  seq: number
): SseFrame | null {
  const now = new Date().toISOString();

  // Testing gets a part of its own. Its six states are a real state machine, and
  // the distinction the Testing graph exists to express — tests FAILED versus tests
  // were SKIPPED because only docs changed — is exactly what collapses if these are
  // squeezed into data-todo's generic vocabulary.
  if (toolName === TESTING_STATUS_TOOL) {
    // Coerced to "unknown", NOT to "not_started". A model that sends garbage must
    // not be silently reported as a real state the graph never entered — and
    // "unknown" is a value this transform genuinely emits, so the published schema
    // and the Zod schema must both accept it. (The react converter is fail-open: an
    // unparseable part is warned about and DROPPED, so a status the schema forgot is
    // a part the user never sees.)
    const status =
      typeof input.status === "string" && TESTING_STATUSES.has(input.status)
        ? input.status
        : "unknown";
    return dataFrame("data-testing", {
      id: toolCallId,
      seq,
      kind: "status",
      status,
      reason: typeof input.reason === "string" ? input.reason : "",
      updatedAt: now,
    });
  }

  if (toolName === PLAYWRIGHT_TOOL) {
    // A playwright invocation is a test RUN, not a status transition. Same part
    // type so both land in one panel; `kind` keeps them distinguishable.
    return dataFrame("data-testing", {
      id: toolCallId,
      seq,
      kind: "run",
      command: typeof input.command === "string" ? input.command : "run_tests",
      testFile: typeof input.test_file === "string" ? input.test_file : null,
      browser: typeof input.browser === "string" ? input.browser : null,
      headless: input.headless !== false,
      status: "in_progress",
      updatedAt: now,
    });
  }

  // The reviewer reuses an existing part rather than getting its own. A review
  // verdict is "this task is / is not done, and here is why", which is exactly what
  // data-todo already carries — no information is lost, so a data-review part would
  // be a second name for a thing already represented. Nothing here is rung-5-owned,
  // so nothing here has to be stripped when a fork ejects to rung 4.
  if (toolName === REVIEW_DONE_TOOL || toolName === REVIEW_NOT_DONE_TOOL) {
    const passed = toolName === REVIEW_DONE_TOOL;
    const actions = Array.isArray(input.additional_actions)
      ? input.additional_actions.filter(
          (a): a is string => typeof a === "string"
        )
      : [];
    const review = typeof input.review === "string" ? input.review : "";
    // Same TodoSchema shape constraint as the task-completion mapping above: a
    // list of items, no flat fields. The verdict is item 0; each requested
    // follow-up action becomes its own pending item, which is more useful than
    // concatenating them into one blob of text.
    return dataFrame("data-todo", {
      id: toolCallId,
      seq,
      items: [
        {
          id: `${toolCallId}-verdict`,
          text: review || (passed ? "Review passed" : "Review found issues"),
          status: passed ? "done" : "in-progress",
        },
        ...actions.map((a, i) => ({
          id: `${toolCallId}-action-${i}`,
          text: a,
          status: "pending" as const,
        })),
      ],
    });
  }

  return null;
}

export function createSdaEnrichTransform(): SseMultiTransform {
  let seq = 0;
  // toolCallId → { toolName, input } captured at tool-input-start, so the matching
  // tool-output-available can emit a completion-side data-* part.
  const byToolCall = new Map<string, ToolMeta>();

  return function sdaEnrich(frame: SseFrame): SseFrame | SseFrame[] | null {
    const line = frame.raw;
    if (!line.startsWith("data: ")) return frame;
    const raw = line.slice(6);
    if (raw === "[DONE]") return frame;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return frame;
    }
    // Valid JSON that isn't an object (`data: null`, `data: 42`) doesn't throw
    // above — guard before property access so untrusted input can't crash the stream.
    if (parsed === null || typeof parsed !== "object") return frame;

    const partType = parsed.type;

    // ── tool-input-start ────────────────────────────────────────────────────────
    if (partType === "tool-input-start") {
      const toolCallId = parsed.toolCallId as string | undefined;
      const toolName = parsed.toolName as string | undefined;
      const input = (parsed.input as Record<string, unknown>) ?? {};
      if (!toolCallId || !toolName) return frame;
      byToolCall.set(toolCallId, { toolName, input });

      const now = new Date().toISOString();

      if (toolName === PLAN_TOOL) {
        // { title, plan: string[] } — richer than rung 4's markdown blob, so the
        // steps become real subtasks rather than a wall of text.
        const steps = Array.isArray(input.plan)
          ? input.plan.filter((s): s is string => typeof s === "string")
          : [];
        const title =
          typeof input.title === "string" && input.title ? input.title : "Plan";
        return [
          frame,
          dataFrame("data-plan", {
            id: toolCallId,
            seq: seq++,
            title,
            markdown: steps.map((s, i) => `${i + 1}. ${s}`).join("\n"),
            // `label`, NOT `title` — PlanSubtaskSchema in @deepagents-nextjs/react
            // requires `label`, and its status enum is pending|in-progress|done.
            // Emitting `title` here parses cleanly as JSON and then fails
            // safeParse, and the converter is fail-open: the part is warned about
            // and DROPPED, so the plan panel silently never appears. Producing a
            // frame is not enough; it has to satisfy the schema that guards it.
            subtasks: steps.map((s, i) => ({
              id: `${toolCallId}-${i}`,
              label: s,
              status: "pending",
            })),
            updatedAt: now,
          }),
        ];
      }

      if (toolName === HUMAN_HELP_TOOL) {
        // Genuinely blocking, unlike rung 4's advisory plan gate — the run pauses
        // until the user answers, so this is data-approval-REQUIRED.
        return [
          frame,
          dataFrame("data-approval-required", {
            id: toolCallId,
            seq: seq++,
            actionName: HUMAN_HELP_TOOL,
            description:
              typeof input.help_request === "string"
                ? input.help_request
                : "The agent is stuck and has asked for help before continuing.",
            arguments: input,
            status: "waiting",
            createdAt: now,
          }),
        ];
      }

      if (toolName === TASK_DONE_TOOL || toolName === TASK_NOT_DONE_TOOL) {
        const done = toolName === TASK_DONE_TOOL;
        // TodoSchema is `{ id, seq, items: TodoItem[] }` — it carries a LIST, and
        // has no title/status/detail/updatedAt fields at all. A flat single-task
        // shape here would fail safeParse and be dropped fail-open. One completion
        // signal becomes a one-item list.
        return [
          frame,
          dataFrame("data-todo", {
            id: toolCallId,
            seq: seq++,
            items: [
              {
                id: toolCallId,
                text: toText(
                  done ? input.completed_task_summary : input.reasoning
                ),
                status: done ? "done" : "in-progress",
              },
            ],
          }),
        ];
      }

      if (toolName === TEXT_EDITOR_TOOL) {
        // Only `create` carries the full body in args (`file_text`). `str_replace`
        // and `insert` carry fragments, so their content resolves at tool-output.
        // `view` is a read and likewise resolves at output.
        if (input.command === "create" && typeof input.file_text === "string") {
          const path = pathOf(input);
          return [
            frame,
            dataFrame("data-file", {
              id: toolCallId,
              seq: seq++,
              path,
              name: basename(path),
              language: languageFor(path) ?? null,
              size: Buffer.byteLength(input.file_text, "utf8"),
              truncated: false,
              content: input.file_text,
              updatedAt: now,
            }),
          ];
        }
        return frame;
      }

      if (FILE_WRITE_TOOLS.has(toolName) && typeof input.content === "string") {
        const path = pathOf(input);
        return [
          frame,
          dataFrame("data-file", {
            id: toolCallId,
            seq: seq++,
            path,
            name: basename(path),
            language: languageFor(path) ?? null,
            size: Buffer.byteLength(input.content, "utf8"),
            truncated: false,
            content: input.content,
            updatedAt: now,
          }),
        ];
      }

      const extra = testingAndReviewFrame(toolName, input, toolCallId, seq);
      if (extra) {
        seq++;
        return [frame, extra];
      }

      // update_plan lands here deliberately — it carries no plan body, so it gets a
      // generic tool card and nothing more. See the header note.
      return frame;
    }

    // ── tool-output-available ───────────────────────────────────────────────────
    if (partType === "tool-output-available") {
      const toolCallId = parsed.toolCallId as string | undefined;
      const output = parsed.output;
      if (!toolCallId) return frame;
      const meta = byToolCall.get(toolCallId);
      if (!meta) return frame;
      byToolCall.delete(toolCallId);

      const now = new Date().toISOString();

      const isEditorResolve =
        meta.toolName === TEXT_EDITOR_TOOL && meta.input.command !== "create";

      if (
        isEditorResolve ||
        FILE_WRITE_TOOLS.has(meta.toolName) ||
        FILE_READ_TOOLS.has(meta.toolName)
      ) {
        const { content, path: outPath } = extractFileResult(output);
        const path =
          typeof outPath === "string" && outPath ? outPath : pathOf(meta.input);
        // A `create` already emitted on start with the same id (upsert); re-emit
        // only when we actually resolved content.
        if (content === undefined && FILE_WRITE_TOOLS.has(meta.toolName)) {
          return frame;
        }
        const body = content ?? "";
        return [
          frame,
          dataFrame("data-file", {
            id: toolCallId,
            seq: seq++,
            path,
            name: basename(path),
            language: languageFor(path) ?? null,
            size: Buffer.byteLength(body, "utf8"),
            truncated: false,
            content: body,
            updatedAt: now,
          }),
        ];
      }

      return frame;
    }

    // text-delta, [DONE], anything unknown — untouched.
    return frame;
  };
}

/**
 * sdaAdapter — the rung-5 (software-developer-agent) SSE adapter.
 *
 * Stage 1 is rung 4's base transform, REUSED UNCHANGED. That is not an oversight:
 * `createOpenSweTransform` switches only on the three LangGraph event types
 * (`on_chat_model_stream`, `on_tool_start`, `on_tool_end`) and never inspects graph
 * names, node names or `checkpoint_ns`, so it is genuinely graph-agnostic. Rung 5's
 * extra graphs change WHICH tools run, not the shape of the tool events.
 *
 * Stage 2 is the rung-5 enricher. Only the vocabulary differs between rungs, which
 * is why this rung needed a new enricher and not a new adapter.
 *
 * `transforms` is a getter for the same reason rung 4's is: each access returns
 * fresh closures so per-request state cannot leak between streams.
 *
 * KNOWN LIMITATION, stated rather than assumed: rung 5's three registered graphs
 * dispatch SEPARATE runs on SEPARATE threads, so a
 * single-thread subscription sees one of the three. This adapter transforms
 * whichever stream it is given correctly; it does not solve correlation. That is
 * upstream `langchain-ai/open-swe` behaviour inherited by rung 5, and it is rung
 * 4's problem too — see PROVENANCE.md.
 */
export const sdaAdapter: SseAdapter = {
  name: "software-developer-agent",
  get transforms(): SseTransform[] {
    return [
      createOpenSweTransform() as unknown as SseTransform,
      createSdaEnrichTransform() as unknown as SseTransform,
    ];
  },
} as const;
