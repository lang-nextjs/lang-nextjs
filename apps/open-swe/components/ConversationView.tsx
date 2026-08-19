"use client";

import { useState } from "react";
import type { ConversationItem } from "../lib/thread-state";

function ToolItem({ item }: { item: ConversationItem }) {
  const [open, setOpen] = useState(false);
  const argSummary = Object.entries(item.args ?? {})
    .map(([k, v]) => {
      const val = typeof v === "string" ? v : JSON.stringify(v);
      return `${k}: ${val.length > 60 ? val.slice(0, 60) + "…" : val}`;
    })
    .join("  ·  ");

  return (
    <div
      data-testid="conv-tool"
      className="rounded-lg border border-neutral-800 bg-neutral-900/40"
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${item.ok ? "bg-emerald-400" : "bg-red-400"}`}
        />
        <code className="shrink-0 rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[11px] text-neutral-200">
          {item.toolName}
        </code>
        <span className="truncate font-mono text-[11px] text-neutral-500">
          {argSummary}
        </span>
        <span className="ml-auto shrink-0 text-neutral-500">
          {open ? "−" : "+"}
        </span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-neutral-800 px-3 py-2">
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">
              Arguments
            </div>
            <pre className="overflow-x-auto rounded bg-black/40 p-2 font-mono text-[11px] text-neutral-300">
              {JSON.stringify(item.args ?? {}, null, 2)}
            </pre>
          </div>
          {item.result !== undefined && (
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">
                Result
              </div>
              <pre className="max-h-72 overflow-auto rounded bg-black/40 p-2 font-mono text-[11px] text-neutral-300 whitespace-pre-wrap">
                {item.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ConversationView({
  items,
}: {
  items: ConversationItem[];
}): React.JSX.Element {
  return (
    <div data-testid="conversation-view" className="space-y-3">
      {items.map((item) => {
        if (item.kind === "user") {
          return (
            <div
              key={item.id}
              data-testid="conv-user"
              className="rounded-lg border border-neutral-700/60 bg-neutral-800/40 px-4 py-3"
            >
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
                You
              </div>
              <p className="whitespace-pre-wrap text-sm text-neutral-100">
                {item.text}
              </p>
            </div>
          );
        }
        if (item.kind === "assistant") {
          return (
            <div key={item.id} data-testid="conv-assistant" className="px-1">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-500/80">
                Agent
              </div>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-neutral-200">
                {item.text}
              </p>
            </div>
          );
        }
        return <ToolItem key={item.id} item={item} />;
      })}
    </div>
  );
}
