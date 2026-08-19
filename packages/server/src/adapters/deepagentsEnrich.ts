/**
 * Enrichment transform for the live-chat adapters (deepagents / langgraph /
 * langchain). DeepAgents' built-in tools — write_todos, write_file, edit_file,
 * read_file, task — arrive as plain AI SDK v6 tool frames. This fans out a
 * `data-*` part next to each so the chat can render the workspace (Tasks, Files,
 * Sub-agents) with the published cards, the same way openSweEnrich does for the
 * OpenSWE queue.
 *
 * Operates on AI SDK v6 native frames:
 *   tool-input-available { toolCallId, toolName, input }
 *   tool-output-available { toolCallId, output }
 */
import type { SseFrame, SseMultiTransform } from "../accumulator";

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
  c: "c",
  h: "c",
  cpp: "cpp",
  cs: "csharp",
  sh: "bash",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  md: "markdown",
  html: "html",
  css: "css",
  sql: "sql",
  txt: "text",
};

function basename(path: string): string {
  const clean = path.replace(/\/+$/, "");
  const idx = clean.lastIndexOf("/");
  return idx >= 0 ? clean.slice(idx + 1) : clean;
}

function languageFor(path: string): string | null {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  return EXT_LANG[name.slice(dot + 1).toLowerCase()] ?? null;
}

function pathOf(input: Record<string, unknown>): string {
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.path === "string") return input.path;
  return "";
}

function toText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function dataFrame(type: string, data: Record<string, unknown>): SseFrame {
  return { raw: `data: ${JSON.stringify({ type, data })}` };
}

const TODO_STATUS: Record<string, "pending" | "in-progress" | "done"> = {
  pending: "pending",
  in_progress: "in-progress",
  "in-progress": "in-progress",
  completed: "done",
  done: "done",
};

export function createDeepAgentsEnrichTransform(): SseMultiTransform {
  let seq = 0;
  const byToolCall = new Map<
    string,
    { toolName: string; input: Record<string, unknown> }
  >();

  return function deepAgentsEnrich(
    frame: SseFrame
  ): SseFrame | SseFrame[] | null {
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
    if (parsed === null || typeof parsed !== "object") return frame;

    // ── tool-input-available: capture meta + emit start-side parts ──────────
    if (parsed.type === "tool-input-available") {
      const toolCallId = parsed.toolCallId as string | undefined;
      const toolName = parsed.toolName as string | undefined;
      const input = (parsed.input as Record<string, unknown>) ?? {};
      if (!toolCallId || !toolName) return frame;
      byToolCall.set(toolCallId, { toolName, input });
      const now = new Date().toISOString();

      if (toolName === "write_todos") {
        const todos = Array.isArray(input.todos)
          ? (input.todos as Array<Record<string, unknown> | null | undefined>)
          : [];
        return [
          frame,
          dataFrame("data-todo", {
            id: toolCallId,
            seq: seq++,
            items: todos.map((t, i) => ({
              id: `${toolCallId}-${i}`,
              text: toText(t?.content ?? t?.text ?? ""),
              status: TODO_STATUS[String(t?.status)] ?? "pending",
            })),
          }),
        ];
      }

      if (toolName === "write_file" && typeof input.content === "string") {
        const path = pathOf(input);
        return [
          frame,
          dataFrame("data-file", {
            id: toolCallId,
            seq: seq++,
            path,
            name: basename(path),
            language: languageFor(path),
            size: Buffer.byteLength(input.content, "utf8"),
            truncated: false,
            content: input.content,
            updatedAt: now,
          }),
        ];
      }

      if (toolName === "task") {
        return [
          frame,
          dataFrame("data-sub-agent", {
            id: toolCallId,
            seq: seq++,
            parentToolCallId: toolCallId,
            name: toText(input.subagent_type ?? input.subagent ?? "subagent"),
            status: "starting",
            prompt: toText(input.description ?? input.prompt ?? input),
            startedAt: now,
          }),
        ];
      }
      return frame;
    }

    // ── tool-output-available: emit completion-side parts ───────────────────
    if (parsed.type === "tool-output-available") {
      const toolCallId = parsed.toolCallId as string | undefined;
      const output = parsed.output;
      if (!toolCallId) return frame;
      const meta = byToolCall.get(toolCallId);
      if (!meta) return frame;
      byToolCall.delete(toolCallId);
      const now = new Date().toISOString();

      if (meta.toolName === "read_file" || meta.toolName === "edit_file") {
        const path = pathOf(meta.input);
        const content = toText(output);
        return [
          frame,
          dataFrame("data-file", {
            id: toolCallId,
            seq: seq++,
            path,
            name: basename(path),
            language: languageFor(path),
            size: Buffer.byteLength(content, "utf8"),
            truncated: false,
            content,
            updatedAt: now,
          }),
        ];
      }

      if (meta.toolName === "task") {
        return [
          frame,
          dataFrame("data-sub-agent", {
            id: toolCallId,
            seq: seq++,
            parentToolCallId: toolCallId,
            name: toText(
              meta.input.subagent_type ?? meta.input.subagent ?? "subagent"
            ),
            status: "done",
            prompt: toText(
              meta.input.description ?? meta.input.prompt ?? meta.input
            ),
            result: toText(output),
            startedAt: now,
            finishedAt: now,
          }),
        ];
      }
      return frame;
    }

    return frame;
  };
}
