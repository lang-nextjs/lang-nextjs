import { useMemo } from "react";
import { StreamEvent, ToolCallState } from "../types";

export function useToolState(events: StreamEvent[]): ToolCallState[] {
  return useMemo(() => {
    // Use two passes to handle out-of-order events:
    // Pass 1: collect all tool-input-start events
    // Pass 2: apply tool-output-available events (whether or not input arrived first)
    const state = new Map<string, ToolCallState>();
    const pendingOutputs = new Map<string, unknown>();

    for (const event of events) {
      if (event.type === "tool-input-start") {
        const existing = state.get(event.toolCallId);
        if (existing) {
          // input arrived after output (out-of-order): apply pending output
          state.set(event.toolCallId, {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: event.input,
            output: existing.output ?? pendingOutputs.get(event.toolCallId),
            status: pendingOutputs.has(event.toolCallId) ? "completed" : existing.status,
          });
        } else {
          const pendingOutput = pendingOutputs.get(event.toolCallId);
          state.set(event.toolCallId, {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: event.input,
            output: pendingOutput,
            status: pendingOutput !== undefined ? "completed" : "pending",
          });
        }
      } else if (event.type === "tool-output-available") {
        const existing = state.get(event.toolCallId);
        if (existing) {
          // Normal case: input arrived first
          if (existing.status !== "completed") {
            state.set(event.toolCallId, {
              ...existing,
              output: event.output,
              status: "completed",
            });
          }
          // Duplicate output-available: ignore (do not overwrite completed state)
        } else {
          // Out-of-order: output arrived before input; stash for later
          pendingOutputs.set(event.toolCallId, event.output);
        }
      }
    }

    return Array.from(state.values());
  }, [events]);
}
