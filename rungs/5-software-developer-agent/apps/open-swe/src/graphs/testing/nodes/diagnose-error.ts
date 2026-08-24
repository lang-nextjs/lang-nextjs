import { Command } from "@langchain/langgraph";
import { GraphConfig } from "@openswe/shared/open-swe/types";
import { TestingAgentState, TestingAgentUpdate } from "@openswe/shared/open-swe/testing/types";
import { createLogger, LogLevel } from "../../../utils/logger.js";
import { AIMessage } from "@langchain/core/messages";
import { v4 as uuidv4 } from "uuid";
import { loadModel } from "../../../utils/llms/index.js";
import { LLMTask } from "@openswe/shared/open-swe/llm-task";

const logger = createLogger(LogLevel.INFO, "TestingAgent:DiagnoseError");

/**
 * Diagnose testing errors and determine next steps
 */
export async function diagnoseError(
  state: TestingAgentState,
  config: GraphConfig,
): Promise<Command> {
  logger.info("Diagnosing testing errors", {
    testingActionsCount: state.testingActionsCount,
    testsSuccessful: state.testsSuccessful,
  });

  const model = await loadModel(config, LLMTask.PROGRAMMER);

  // Get recent error messages
  const recentMessages = state.testingMessages.slice(-5);
  const errorMessages = recentMessages
    .filter(msg => msg.additional_kwargs?.error || (typeof msg.content === 'string' && msg.content.includes('Error')))
    .map(msg => typeof msg.content === 'string' ? msg.content : String(msg.content))
    .join('\n\n');

  const testResults = recentMessages
    .filter(msg => msg.additional_kwargs?.isTestExecution)
    .map(msg => typeof msg.content === 'string' ? msg.content : String(msg.content))
    .join('\n\n');

  const maxRetries = 3;
  const shouldRetry = (state.testingActionsCount || 0) < maxRetries;

  const prompt = `You are a testing expert diagnosing test failures and errors.

**Repository:** ${state.targetRepository.owner}/${state.targetRepository.repo}
**Branch:** ${state.branchName}
**Attempts:** ${state.testingActionsCount || 0}/${maxRetries}

**Recent Errors:**
${errorMessages || 'No specific error messages found'}

**Test Results:**
${testResults || 'No test results available'}

**Your Task:**
Analyze the errors and determine the best course of action:

1. **If errors are fixable and retries remain:** Suggest specific fixes
2. **If too many retries or unfixable errors:** Conclude with current status

**Analysis:**
- Identify root causes of test failures
- Suggest specific code fixes or test adjustments
- Determine if issues are environment-related vs code-related
- Consider if tests need different setup or configuration

**Output:**
Provide a clear analysis and recommendation for next steps.
${shouldRetry ? 'If fixable, suggest specific actions to resolve the issues.' : 'Provide final assessment as retry limit reached.'}`;

  try {
    const response = await model.invoke([
      {
        role: "user",
        content: prompt,
      },
    ]);

    const diagnosisMessage = new AIMessage({
      id: uuidv4(),
      content: `🔍 **Error Diagnosis**\n\n${response.content}`,
      additional_kwargs: {
        testingAgent: true,
        diagnosis: true,
      },
    });

    const update: TestingAgentUpdate = {
      testingMessages: [diagnosisMessage],
    };

    // Decide next step based on retry count and error severity
    if (shouldRetry && errorMessages) {
      // Try to fix the issues by going back to writing tests
      logger.info("Retrying test generation due to fixable errors");
      return new Command({
        update,
        goto: "gen-writing-tests-actions",
      });
    } else {
      // Too many retries or unfixable errors, conclude
      logger.info("Moving to conclusion due to retry limit or unfixable errors");
      return new Command({
        update,
        goto: "conclusion",
      });
    }
  } catch (error) {
    logger.error("Failed to diagnose error", { error });
    
    const errorMessage = new AIMessage({
      id: uuidv4(),
      content: `❌ **Failed to diagnose errors**\n\nError: ${error instanceof Error ? error.message : 'Unknown error'}\n\nMoving to conclusion.`,
      additional_kwargs: {
        testingAgent: true,
        error: true,
      },
    });

    return new Command({
      update: { testingMessages: [errorMessage] },
      goto: "conclusion",
    });
  }
}
