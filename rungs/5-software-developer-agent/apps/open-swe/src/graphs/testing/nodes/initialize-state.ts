import { Command } from "@langchain/langgraph";
import { GraphConfig } from "@openswe/shared/open-swe/types";
import { TestingAgentState, TestingAgentUpdate } from "@openswe/shared/open-swe/testing/types";
import { createLogger, LogLevel } from "../../../utils/logger.js";
import { AIMessage } from "@langchain/core/messages";
import { v4 as uuidv4 } from "uuid";

const logger = createLogger(LogLevel.INFO, "TestingAgent:InitializeState");

/**
 * Initialize the testing agent state with necessary information from the programmer graph
 */
export async function initializeState(
  state: TestingAgentState,
  _config: GraphConfig,
): Promise<Command> {
  logger.info("Initializing testing agent state", {
    sandboxSessionId: state.sandboxSessionId,
    changedFilesCount: state.changedFiles?.length ?? 0,
    taskPlanItemsCount: state.taskPlan?.tasks?.length ?? 0,
  });

  // Initialize testing messages with a welcome message
  const initMessage = new AIMessage({
    id: uuidv4(),
    content: `🧪 **Testing Agent Initialized**

I'm now analyzing the changes made by the programmer and will create comprehensive tests to validate the implementation.

**Context:**
- Repository: ${state.targetRepository.owner}/${state.targetRepository.repo}
- Branch: ${state.branchName}
- Changed files: ${state.changedFiles?.length ?? 0}
- Task plan items: ${state.taskPlan?.tasks?.length ?? 0}

Let me start by analyzing the changes and generating a test plan...`,
    additional_kwargs: {
      testingAgent: true,
    },
  });

  const update: TestingAgentUpdate = {
    testingMessages: [initMessage],
    testingActionsCount: 0,
    testsSuccessful: false,
  };

  return new Command({
    update,
    goto: "generate-test-plan",
  });
}
