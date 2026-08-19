"use client";

import { useState } from "react";

export interface WsFile {
  id: string;
  path: string;
  name: string;
  language?: string | null;
  content?: string | null;
}
export interface WsTodo {
  id: string;
  text: string;
  status: "pending" | "in-progress" | "done";
}
export interface WsSubAgent {
  id: string;
  name: string;
  status: string;
}

const STATUS_MARK: Record<string, string> = {
  pending: "○",
  "in-progress": "◐",
  done: "●",
};

function FileRow({ file }: { file: WsFile }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/40">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
      >
        <span className="text-neutral-500">{open ? "▾" : "▸"}</span>
        <span className="font-mono text-[12px] text-neutral-200">
          {file.name}
        </span>
        <span className="ml-auto truncate font-mono text-[10px] text-neutral-600">
          {file.path}
        </span>
      </button>
      {open && file.content != null && (
        <pre className="max-h-60 overflow-auto border-t border-neutral-800 bg-black/40 p-2 font-mono text-[11px] text-neutral-300 whitespace-pre-wrap">
          {file.content}
        </pre>
      )}
    </div>
  );
}

export interface WsTool {
  name: string;
  description?: string;
  source?: string;
}

export function ChatWorkspace({
  files,
  todos,
  subAgents,
  tools = [],
  mcps = [],
}: {
  files: WsFile[];
  todos: WsTodo[];
  subAgents: WsSubAgent[];
  tools?: WsTool[];
  mcps?: string[];
}) {
  const empty =
    files.length === 0 && todos.length === 0 && subAgents.length === 0;

  return (
    <aside
      data-testid="chat-workspace"
      className="hidden w-80 shrink-0 overflow-y-auto border-l border-neutral-800/80 bg-[#0c0c0d] p-4 lg:block"
    >
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-400">
        Workspace
      </h2>

      {tools.length > 0 && (
        <section className="mb-5">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
            Tools ({tools.length})
          </div>
          <div className="flex flex-wrap gap-1">
            {tools.map((t) => (
              <span
                key={t.name}
                data-testid="ws-tool"
                title={t.description || t.name}
                className={`rounded-md border px-1.5 py-0.5 font-mono text-[10px] ${
                  t.source === "builtin"
                    ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-300"
                    : "border-neutral-700 bg-neutral-800/50 text-neutral-300"
                }`}
              >
                {t.name}
              </span>
            ))}
          </div>
          <div className="mt-2 text-[10px] text-neutral-600">
            MCP servers:{" "}
            {mcps.length > 0 ? (
              mcps.join(", ")
            ) : (
              <span className="italic">none configured</span>
            )}
          </div>
        </section>
      )}

      {empty && (
        <p className="text-xs text-neutral-600">
          Tasks, files, and sub-agents the agent produces will appear here.
        </p>
      )}

      {todos.length > 0 && (
        <section className="mb-5">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
            Tasks ({todos.filter((t) => t.status === "done").length}/
            {todos.length})
          </div>
          <ul className="space-y-1">
            {todos.map((t) => (
              <li
                key={t.id}
                data-testid="ws-task"
                className="flex items-start gap-2 text-[12px] text-neutral-300"
              >
                <span
                  className={
                    t.status === "done"
                      ? "text-emerald-400"
                      : t.status === "in-progress"
                      ? "text-blue-400"
                      : "text-neutral-600"
                  }
                >
                  {STATUS_MARK[t.status] ?? "○"}
                </span>
                <span
                  className={
                    t.status === "done" ? "line-through text-neutral-500" : ""
                  }
                >
                  {t.text}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {files.length > 0 && (
        <section className="mb-5">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
            Files ({files.length})
          </div>
          <div className="space-y-1.5">
            {files.map((f) => (
              <FileRow key={f.id} file={f} />
            ))}
          </div>
        </section>
      )}

      {subAgents.length > 0 && (
        <section>
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
            Sub-agents ({subAgents.length})
          </div>
          <ul className="space-y-1">
            {subAgents.map((s) => (
              <li
                key={s.id}
                data-testid="ws-subagent"
                className="flex items-center gap-2 text-[12px] text-neutral-300"
              >
                <span
                  className={
                    s.status === "done" ? "text-emerald-400" : "text-blue-400"
                  }
                >
                  ◆
                </span>
                <span className="font-mono">{s.name}</span>
                <span className="ml-auto text-[10px] text-neutral-600">
                  {s.status}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}
