/**
 * Mock upstream backend for the HITL demo.
 *
 * Emits a scripted SSE stream:
 *   1. text-start / text-delta(s) — "Listing the /tmp directory…"
 *   2. tool-input-start — the bash_execute call the approval transform gates
 *   3. (pause via setTimeout — gives the human time to approve/reject)
 *   4. tool-output-available — the synthetic shell result
 *   5. text-delta(s) — a closing summary
 *   6. finish — flushes any trailing buffered frame from the approval transform
 *
 * Scenarios via ?scenario= query param:
 *   - default — the above
 *   - multi   — two gated tool-input-starts back-to-back (multi-interrupt)
 *   - timeout — pause exceeds the proxy's timeoutMs so the gate times out
 *
 * Proxied through /api/hitl-demo (createDeepAgentsHandler + approvalGating).
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const cmd = url.searchParams.get("cmd") ?? "ls -la /tmp";
  const scenario = url.searchParams.get("scenario") ?? "default";

  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      function frame(obj: Record<string, unknown>): void {
        controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
      }
      function sleep(ms: number): Promise<void> {
        return new Promise((r) => setTimeout(r, ms));
      }

      frame({ type: "text-start", id: "t1" });
      frame({
        type: "text-delta",
        id: "t1",
        delta: "Listing the /tmp directory…",
      });
      frame({ type: "text-end", id: "t1" });

      frame({
        type: "tool-input-start",
        toolCallId: "tc-hitl-1",
        toolName: "bash_execute",
        input: { command: cmd },
      });

      if (scenario === "timeout") {
        // Pause LONGER than the proxy's timeoutMs (the proxy is mounted with
        // 60_000ms by default; the timeout-scenario E2E mounts a separate
        // proxy with timeoutMs: 1_000). The human never resolves; the gate
        // emits data-error code=approval_timeout on the next upstream frame.
        await sleep(8_000);
      } else {
        // 4s is enough for Playwright to render the card and click; production
        // backends would not have this hard-coded delay — they pause naturally.
        await sleep(4_000);
      }

      frame({
        type: "tool-output-available",
        toolCallId: "tc-hitl-1",
        output: { stdout: "file.txt\nother.txt", exitCode: 0 },
      });

      if (scenario === "multi") {
        // A second gated tool-input-start immediately after the first finishes
        // — proves the gate can handle back-to-back approvals in one stream.
        frame({
          type: "tool-input-start",
          toolCallId: "tc-hitl-2",
          toolName: "write_file",
          input: { path: "/tmp/note.txt", contents: "hello" },
        });
        await sleep(4_000);
        frame({
          type: "tool-output-available",
          toolCallId: "tc-hitl-2",
          output: { bytesWritten: 5 },
        });
      }

      frame({ type: "text-start", id: "t2" });
      frame({
        type: "text-delta",
        id: "t2",
        delta: "Done. Two files in /tmp.",
      });
      frame({ type: "text-end", id: "t2" });

      // Trailing finish so the approval transform's readyQueue (which holds
      // the trigger tool-output-available after a drain) flushes.
      frame({ type: "finish", finishReason: "stop" });

      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "x-vercel-ai-ui-message-stream": "v1",
    },
  });
}
