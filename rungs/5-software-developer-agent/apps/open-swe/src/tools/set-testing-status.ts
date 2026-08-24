import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { GraphState, GraphConfig } from "@openswe/shared/open-swe/types";
import { createLogger, LogLevel } from "../utils/logger.js";

const logger = createLogger(LogLevel.INFO, "SetTestingStatusTool");

const SetTestingStatusSchema = z.object({
  status: z.enum(["not_started", "required", "in_progress", "completed", "failed", "skipped"]).describe(
    "The testing status to set. Use 'skipped' when testing is not needed (e.g., only docs changed), 'required' when testing is needed, 'failed' when testing needs to be retried."
  ),
  reason: z.string().describe(
    "Brief explanation for why this testing status is being set"
  ),
});

export type SetTestingStatusInput = z.infer<typeof SetTestingStatusSchema>;

/**
 * Tool for setting the testing status of the current task
 */
export function createSetTestingStatusTool(
  state: GraphState,
  _config: GraphConfig,
) {
  return tool(
    async (input: SetTestingStatusInput): Promise<string> => {
      const { status, reason } = input;

      logger.info("Setting testing status", {
        previousStatus: state.testingStatus,
        newStatus: status,
        reason,
      });

      // Note: The actual state update will be handled by the graph's Command mechanism
      // This tool is primarily for the agent to signal intent to change testing status
      return `✅ Testing status requested to be updated to "${status}".

**Reason:** ${reason}

**Previous status:** ${state.testingStatus || "not_started"}
**Requested status:** ${status}

The testing workflow will proceed based on this updated status.`;
    },
    {
      name: "set_testing_status",
      description: `Set the testing status for the current task. Use this when you need to mark testing as skipped (e.g., only documentation changes), required (needs testing), or failed (testing needs to be retried).

Current testing status: ${state.testingStatus || "not_started"}

Status options:
- "skipped": Use when testing is not needed (documentation-only changes, config changes, etc.)
- "required": Use when testing is definitely needed
- "failed": Use when testing encountered issues and needs to be retried
- "completed": Testing was successful (usually set automatically)`,
      schema: SetTestingStatusSchema,
    }
  );
}

export const setTestingStatusToolFields = {
  name: "set_testing_status",
  description: "Set the testing status for the current task",
  schema: SetTestingStatusSchema,
};
