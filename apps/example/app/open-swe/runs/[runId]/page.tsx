"use client";

import { Suspense } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { useRunStream } from "@/lib/hooks/useRunStream";
import { useToolState } from "@/lib/hooks/useToolState";
import { ToolCard } from "@/components/ToolCard";

function RunDetailContent() {
  const { runId } = useParams<{ runId: string }>();
  const searchParams = useSearchParams();
  const threadId = searchParams.get("threadId") ?? "";

  if (!threadId) {
    return (
      <main>
        <p data-testid="missing-thread-id">
          threadId is required. Pass ?threadId=... in the URL.
        </p>
      </main>
    );
  }

  const { events, status, error } = useRunStream({
    runId,
    threadId,
    enabled: true,
  });

  const toolCalls = useToolState(events);

  const text = events
    .filter((e) => e.type === "text-delta")
    .map((e) => (e as { type: "text-delta"; delta: string }).delta)
    .join("");

  return (
    <main>
      <h1>Run: {runId}</h1>
      <p data-testid="stream-status">Status: {status}</p>

      {error && (
        <p data-testid="stream-error" role="alert">
          Error: {error.message}
        </p>
      )}

      <section aria-label="Agent output">
        <pre data-testid="agent-text">{text}</pre>
      </section>

      <section aria-label="Tool calls">
        {toolCalls.map((tool) => (
          <ToolCard key={tool.toolCallId} tool={tool} />
        ))}
      </section>
    </main>
  );
}

export default function RunDetailPage() {
  return (
    <Suspense fallback={<p data-testid="stream-status">Status: loading</p>}>
      <RunDetailContent />
    </Suspense>
  );
}
