/**
 * open-swe enrichment transform — emits DeepAgents `data-*` parts from the
 * normalized tool frames produced by `createOpenSweTransform()`.
 *
 * open-swe is a real DeepAgents agent (`create_deep_agent`), so its rich
 * narrative arrives as tool calls with canonical DeepAgents names. The base
 * openSwe transform turns LangGraph `on_tool_start`/`on_tool_end` into AI SDK
 * v6 `tool-input-start` / `tool-output-available` frames; this transform runs
 * AFTER it, recognizes the meaningful tool names, and FANS OUT an extra
 * `data-*` frame next to the original tool frame (the tool frame is preserved
 * so the generic ToolCard still works for everything).
 *
 * Mapping (grounded in the open-swe source vocabulary):
 *   save_plan         → data-plan        (input.plan_markdown is the plan body)
 *   enter_plan_mode   → data-approval    (open-swe's HITL gate: the agent has
 *                                          entered plan mode and is awaiting a
 *                                          human approve/reject — see note below)
 *   write_file        → data-file        (path + content from args)
 *   edit_file         → data-file        (path from args; new content from the
 *                                          on_tool_end diff artifact)
 *   read_file         → data-file        (path from args; content from output)
 *   task              → data-sub-agent   (starting on input, done on output)
 *
 * NOTE on HITL: open-swe does NOT use langgraph `interrupt()`. `enter_plan_mode`
 * flips `plan_mode=True` and the run ends; a human then approves/rejects via the
 * dashboard plan API which DISPATCHES A NEW RUN. So the `data-approval` emitted
 * here is the *signal* that a plan gate is open; the consumer resolves it by
 * POSTing approve/reject (which starts a follow-up run), NOT by resuming this
 * stream. The approval `id` is the toolCallId so the consumer can correlate.
 *
 * Stateless per request: `createOpenSweEnrichTransform()` returns a fresh
 * closure each call (mirrors the base transform's no-leak contract).
 */

import type { SseFrame, SseMultiTransform } from "../accumulator";

/** Tool names that carry structured DeepAgents narrative. */
const PLAN_TOOL = "save_plan";
const APPROVAL_TOOL = "enter_plan_mode";
const FILE_WRITE_TOOLS = new Set(["write_file", "edit_file"]);
const FILE_READ_TOOLS = new Set(["read_file"]);
const SUBAGENT_TOOL = "task";

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
  cc: "cpp",
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

/** Safely extract a string file path from untrusted tool args. A non-string
 * file_path (number/object/null from a misbehaving model) must not reach
 * basename()'s string ops — return "" rather than crash the stream. */
function pathOf(input: Record<string, unknown>): string {
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.path === "string") return input.path;
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
 * Extract the resolved file content + path hint from an on_tool_end output.
 * open-swe stamps write_file/edit_file results with
 * `artifact.diff = { filePath, newContent, isNewFile }` (ToolArtifactMiddleware);
 * read_file returns the content as the message body.
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
      // newContent is the authoritative resolved body. Coerce a non-string
      // (a malformed backend could send a number/object) via toText rather than
      // letting it fall through to an empty data-file content downstream.
      return {
        content:
          typeof diff.newContent === "string"
            ? diff.newContent
            : toText(diff.newContent),
        path: typeof diff.filePath === "string" ? diff.filePath : undefined,
      };
    }
    if (typeof o.content === "string") {
      return { content: o.content, path: undefined };
    }
  }
  if (typeof output === "string") return { content: output, path: undefined };
  return { content: undefined, path: undefined };
}

function dataFrame(type: string, data: Record<string, unknown>): SseFrame {
  // `JSON.stringify({type, data})` throws `TypeError: Converting circular
  // structure to JSON` if `data` carries a self-reference — a proxied value,
  // a misbehaving model, or a backend bug. Wrapping stringify in try/catch
  // with a `{type, error: "<unserializable>"}` fallback matches the
  // langgraph/openSwe hardening pattern: the transform never throws, and a
  // downstream consumer that filters on `type` still sees a valid frame.
  let raw: string;
  try {
    raw = `data: ${JSON.stringify({ type, data })}`;
  } catch {
    raw = `data: ${JSON.stringify({
      type,
      error: "<unserializable>",
    })}`;
  }
  return { raw };
}

interface ToolMeta {
  toolName: string;
  input: Record<string, unknown>;
}

export function createOpenSweEnrichTransform(): SseMultiTransform {
  let seq = 0;
  // toolCallId → { toolName, input } captured at tool-input-start, so the
  // matching tool-output-available can emit a completion data-* part.
  const byToolCall = new Map<string, ToolMeta>();

  return function openSweEnrich(frame: SseFrame): SseFrame | SseFrame[] | null {
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

    // Valid JSON that isn't an object (`data: null`, `data: 42`, …) doesn't
    // throw above — guard before property access so untrusted input can't crash
    // the stream.
    if (parsed === null || typeof parsed !== "object") return frame;

    const partType = parsed.type;

    // ── tool-input-start: capture meta + emit start-side data-* parts ──────
    if (partType === "tool-input-start") {
      const toolCallId = parsed.toolCallId as string | undefined;
      const toolName = parsed.toolName as string | undefined;
      const input = (parsed.input as Record<string, unknown>) ?? {};
      if (!toolCallId || !toolName) return frame;
      byToolCall.set(toolCallId, { toolName, input });

      const now = new Date().toISOString();

      if (toolName === PLAN_TOOL) {
        const markdown =
          (typeof input.plan_markdown === "string" && input.plan_markdown) ||
          (typeof input.plan === "string" && input.plan) ||
          toText(input);
        return [
          frame,
          dataFrame("data-plan", {
            id: toolCallId,
            seq: seq++,
            title: "Plan",
            markdown,
            subtasks: [],
            updatedAt: now,
          }),
        ];
      }

      if (toolName === APPROVAL_TOOL) {
        // open-swe HITL gate — agent entered plan mode, awaiting human decision.
        return [
          frame,
          dataFrame("data-approval", {
            id: toolCallId,
            seq: seq++,
            actionName: APPROVAL_TOOL,
            description:
              "The agent has finished planning and is waiting for you to approve or reject the plan before it starts implementing.",
            arguments: input,
            status: "waiting",
            createdAt: now,
          }),
        ];
      }

      if (toolName === SUBAGENT_TOOL) {
        const name =
          (typeof input.subagent_type === "string" && input.subagent_type) ||
          (typeof input.description === "string" && input.description) ||
          "sub-agent";
        return [
          frame,
          dataFrame("data-sub-agent", {
            id: toolCallId,
            seq: seq++,
            parentToolCallId: toolCallId,
            name,
            status: "starting",
            prompt: toText(input.prompt ?? input.description ?? input),
            startedAt: now,
          }),
        ];
      }

      if (FILE_WRITE_TOOLS.has(toolName) && typeof input.content === "string") {
        // write_file has the full content in args — emit immediately.
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

      return frame;
    }

    // ── tool-output-available: emit completion-side data-* parts ───────────
    if (partType === "tool-output-available") {
      const toolCallId = parsed.toolCallId as string | undefined;
      const output = parsed.output;
      if (!toolCallId) return frame;
      const meta = byToolCall.get(toolCallId);
      if (!meta) return frame;
      byToolCall.delete(toolCallId);

      const now = new Date().toISOString();

      if (meta.toolName === SUBAGENT_TOOL) {
        const name =
          (typeof meta.input.subagent_type === "string" &&
            meta.input.subagent_type) ||
          "sub-agent";
        return [
          frame,
          dataFrame("data-sub-agent", {
            id: toolCallId,
            seq: seq++,
            parentToolCallId: toolCallId,
            name,
            status: "done",
            prompt: toText(
              meta.input.prompt ?? meta.input.description ?? meta.input
            ),
            result: toText(output),
            startedAt: now,
            finishedAt: now,
          }),
        ];
      }

      if (
        FILE_WRITE_TOOLS.has(meta.toolName) ||
        FILE_READ_TOOLS.has(meta.toolName)
      ) {
        const { content, path: outPath } = extractFileResult(output);
        const path =
          typeof outPath === "string" && outPath ? outPath : pathOf(meta.input);
        // edit_file content only lands here; write_file already emitted on
        // start with the same id (upsert), so re-emit only when we have content.
        if (content === undefined && meta.toolName === "write_file")
          return frame;
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

    // Everything else (text-delta, [DONE], unknown) passes through untouched.
    return frame;
  };
}
