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
    <div className="rounded-lg border border-border bg-card/40">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
      >
        <span className="text-muted-foreground">{open ? "▾" : "▸"}</span>
        <span className="font-mono text-[12px] text-foreground">
          {file.name}
        </span>
        <span className="ml-auto truncate font-mono text-[10px] text-muted-foreground">
          {file.path}
        </span>
      </button>
      {open && file.content != null && (
        <pre className="max-h-60 overflow-auto border-t border-border bg-black/40 p-2 font-mono text-[11px] text-foreground whitespace-pre-wrap">
          {file.content}
        </pre>
      )}
    </div>
  );
}

/**
 * A `data-*` part that arrived and could not be read (#140).
 *
 * This is deliberately NOT folded into the other collections. A rejected part
 * is not a task with missing fields — it is a fact about the backend contract,
 * and it is the only thing in this panel that tells you the stream is wrong
 * rather than empty.
 */
export interface WsUnreadable {
  id: string;
  partType: string;
  reason: string;
  detail?: string;
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
  unreadable = [],
}: {
  files: WsFile[];
  todos: WsTodo[];
  subAgents: WsSubAgent[];
  tools?: WsTool[];
  mcps?: string[];
  unreadable?: WsUnreadable[];
}) {
  // #140: unreadable parts make the panel NOT empty. Before this, a run whose
  // every frame was rejected rendered the same "nothing yet" text as a run
  // that produced nothing — and the worse the drift, the more parts were
  // dropped, so a badly broken backend looked calmer than a slightly broken
  // one. Emptiness must mean "nothing arrived", not "nothing survived".
  const empty =
    files.length === 0 &&
    todos.length === 0 &&
    subAgents.length === 0 &&
    unreadable.length === 0;

  return (
    <aside
      data-testid="chat-workspace"
      className="hidden w-80 shrink-0 overflow-y-auto border-l border-border/80 bg-[#0c0c0d] p-4 lg:block"
    >
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Workspace
      </h2>

      {tools.length > 0 && (
        <section className="mb-5">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
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
                    ? "border-success/20 bg-success/10 text-success"
                    : "border-border bg-muted/50 text-foreground"
                }`}
              >
                {t.name}
              </span>
            ))}
          </div>
          <div className="mt-2 text-[10px] text-muted-foreground">
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
        <p className="text-xs text-muted-foreground">
          Tasks, files, and sub-agents the agent produces will appear here.
        </p>
      )}

      {unreadable.length > 0 && (
        <section className="mb-5" data-testid="ws-unreadable">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-warning">
            Unreadable output ({unreadable.length})
          </div>
          <p className="mb-2 text-xs text-foreground">
            The agent sent {unreadable.length}{" "}
            {unreadable.length === 1 ? "part" : "parts"}{" "}
            this page could not read. This is not an empty run — something
            arrived and was rejected, which usually means the backend&apos;s
            output has drifted from what this page expects.
          </p>
          <ul className="space-y-1">
            {unreadable.map((u) => (
              <li
                key={u.id}
                data-testid="ws-unreadable-part"
                data-part-type={u.partType}
                data-reason={u.reason}
                className="text-[11px] text-muted-foreground"
              >
                <code className="text-foreground">{u.partType}</code>{" "}
                {u.reason === "unknown-type"
                  ? "— no schema for this type"
                  : "— rejected by its schema"}
                {u.detail ? (
                  <span className="block pl-2 italic">{u.detail}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      )}

      {todos.length > 0 && (
        <section className="mb-5">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Tasks ({todos.filter((t) => t.status === "done").length}/
            {todos.length})
          </div>
          <ul className="space-y-1">
            {todos.map((t) => (
              <li
                key={t.id}
                data-testid="ws-task"
                className="flex items-start gap-2 text-[12px] text-foreground"
              >
                <span
                  className={
                    t.status === "done"
                      ? "text-success"
                      : t.status === "in-progress"
                      ? "text-info"
                      : "text-muted-foreground"
                  }
                >
                  {STATUS_MARK[t.status] ?? "○"}
                </span>
                <span
                  className={
                    t.status === "done" ? "line-through text-muted-foreground" : ""
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
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
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
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Sub-agents ({subAgents.length})
          </div>
          <ul className="space-y-1">
            {subAgents.map((s) => (
              <li
                key={s.id}
                data-testid="ws-subagent"
                className="flex items-center gap-2 text-[12px] text-foreground"
              >
                <span
                  className={
                    s.status === "done" ? "text-success" : "text-info"
                  }
                >
                  ◆
                </span>
                <span className="font-mono">{s.name}</span>
                <span className="ml-auto text-[10px] text-muted-foreground">
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
