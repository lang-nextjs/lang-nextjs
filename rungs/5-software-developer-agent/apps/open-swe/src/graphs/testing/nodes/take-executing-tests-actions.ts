import { v4 as uuidv4 } from "uuid";
import {
  isAIMessage,
  isToolMessage,
  ToolMessage,
  AIMessage,
} from "@langchain/core/messages";
import {
  createShellTool,
  createPlaywrightTool,
} from "../../../tools/index.js";
import { GraphConfig } from "@openswe/shared/open-swe/types";
import {
  TestingAgentState,
  TestingAgentUpdate,
} from "@openswe/shared/open-swe/testing/types";
import { createLogger, LogLevel } from "../../../utils/logger.js";
import { zodSchemaToString } from "../../../utils/zod-to-string.js";
import { formatBadArgsError } from "../../../utils/zod-to-string.js";
import { truncateOutput } from "../../../utils/truncate-outputs.js";
import { createGrepTool } from "../../../tools/grep.js";
import { getSandboxWithErrorHandling } from "../../../utils/sandbox.js";
import { isLocalMode } from "@openswe/shared/open-swe/local-mode";
import { Command } from "@langchain/langgraph";
import { shouldDiagnoseError } from "../../../utils/tool-message-error.js";
import { filterHiddenMessages } from "../../../utils/message/filter-hidden.js";
import { createViewTool } from "../../../tools/builtin-tools/view.js";
import { filterUnsafeCommands } from "../../../utils/command-evaluation.js";

const logger = createLogger(LogLevel.INFO, "TakeExecutingTestsActions");

export async function takeExecutingTestsActions(
  state: TestingAgentState,
  config: GraphConfig,
): Promise<Command> {
  const { testingMessages } = state;
  const lastMessage = testingMessages[testingMessages.length - 1];

  if (!isAIMessage(lastMessage) || !lastMessage.tool_calls?.length) {
    throw new Error("Last message is not an AI message with tool calls.");
  }

  // Create a minimal adapter state for tools that need GraphState interface
  const adaptedState = {
    ...state,
    internalMessages: state.testingMessages,
    contextGatheringNotes: "",
    documentCache: new Map(),
    reviewsCount: 0,
    dependenciesInstalled: state.dependenciesInstalled,
  };

  const shellTool = createShellTool(adaptedState, config);
  const searchTool = createGrepTool(adaptedState, config);
  const viewTool = createViewTool(adaptedState, config);
  const playwrightTool = createPlaywrightTool(adaptedState, config);
  const allTools = [
    shellTool,
    searchTool,
    viewTool,
    playwrightTool,
  ];
  const toolsMap = Object.fromEntries(
    allTools.map((tool) => [tool.name, tool]),
  );

  let toolCalls = lastMessage.tool_calls;
  if (!toolCalls?.length) {
    throw new Error("No tool calls found.");
  }

  // Filter out unsafe commands only in local mode
  let modifiedMessage: AIMessage | undefined;
  let wasFiltered = false;
  if (isLocalMode(config)) {
    const filterResult = await filterUnsafeCommands(toolCalls, config);

    if (filterResult.wasFiltered) {
      wasFiltered = true;
      modifiedMessage = new AIMessage({
        ...lastMessage,
        tool_calls: filterResult.filteredToolCalls,
      });
      toolCalls = filterResult.filteredToolCalls;
    }
  }

  const { sandbox } = await getSandboxWithErrorHandling(
    state.sandboxSessionId,
    state.targetRepository,
    state.branchName,
    config,
  );

  const toolCallResultsPromise = toolCalls.map(async (toolCall) => {
    const tool = toolsMap[toolCall.name];
    if (!tool) {
      logger.error(`Unknown tool: ${toolCall.name}`);
      const toolMessage = new ToolMessage({
        id: uuidv4(),
        tool_call_id: toolCall.id ?? "",
        content: `Unknown tool: ${toolCall.name}`,
        name: toolCall.name,
        status: "error",
      });

      return toolMessage;
    }

    logger.info("Executing test execution action", {
      ...toolCall,
    });

    let result = "";
    let toolCallStatus: "success" | "error" = "success";
    try {
      const toolResult =
        // @ts-expect-error tool.invoke types are weird here...
        (await tool.invoke({
          ...toolCall.args,
          // Only pass sandbox session ID in sandbox mode, not local mode
          ...(isLocalMode(config) ? {} : { xSandboxSessionId: sandbox.id }),
        })) as {
          result: string;
          status: "success" | "error";
        };

      result = toolResult.result;
      toolCallStatus = toolResult.status;

      if (!result) {
        result =
          toolCallStatus === "success"
            ? "Tool call returned no result"
            : "Tool call failed";
      }
    } catch (e) {
      toolCallStatus = "error";
      if (
        e instanceof Error &&
        e.message === "Received tool input did not match expected schema"
      ) {
        logger.error("Received tool input did not match expected schema", {
          toolCall,
          expectedSchema: zodSchemaToString(tool.schema),
        });
        result = formatBadArgsError(tool.schema, toolCall.args);
      } else {
        logger.error("Failed to call tool", {
          ...(e instanceof Error
            ? { name: e.name, message: e.message, stack: e.stack }
            : { error: e }),
        });
        const errMessage = e instanceof Error ? e.message : "Unknown error";
        result = `FAILED TO CALL TOOL: "${toolCall.name}"\n\n${errMessage}`;
      }
    }

    const toolMessage = new ToolMessage({
      id: uuidv4(),
      tool_call_id: toolCall.id ?? "",
      content: truncateOutput(result),
      name: toolCall.name,
      status: toolCallStatus,
    });
    return toolMessage;
  });

  const toolCallResults = await Promise.all(toolCallResultsPromise);

  // Analyze test results to determine success
  const hasTestFailures = toolCallResults.some(result => {
    const content = typeof result.content === 'string' ? result.content.toLowerCase() : '';
    return content.includes('failed') || 
           content.includes('error') || 
           content.includes('failing') ||
           result.status === 'error';
  });

  const testsSuccessful = !hasTestFailures;

  logger.info("Completed test execution actions", {
    ...toolCallResults.map((tc) => ({
      tool_call_id: tc.tool_call_id,
      status: tc.status,
    })),
    testsSuccessful,
  });

  const userFacingMessagesUpdate = [...toolCallResults];

  // Include the modified message if it was filtered
  const testingMessagesUpdate =
    wasFiltered && modifiedMessage
      ? [modifiedMessage, ...toolCallResults]
      : toolCallResults;

  const commandUpdate: TestingAgentUpdate = {
    messages: userFacingMessagesUpdate,
    testingMessages: testingMessagesUpdate,
    testingActionsCount: (state.testingActionsCount || 0) + 1,
    testsSuccessful,
  };

  const maxTestingActions = 20; // Default max actions for testing
  const maxActionsCount = maxTestingActions * 2;
  // Exclude hidden messages, and messages that are not AI messages or tool messages.
  const filteredMessages = filterHiddenMessages([
    ...state.testingMessages,
    ...(commandUpdate.testingMessages ?? []),
  ]).filter((m) => isAIMessage(m) || isToolMessage(m));
  // If we've reached the max allowed testing actions, go to conclusion.
  if (filteredMessages.length >= maxActionsCount) {
    logger.info("Exceeded max actions count, going to conclusion.", {
      maxActionsCount,
      filteredMessages,
    });
    return new Command({
      goto: "conclusion",
      update: commandUpdate,
    });
  }

  const shouldRouteDiagnoseNode = shouldDiagnoseError([
    ...state.testingMessages,
    ...toolCallResults,
  ]);

  // If tests failed or there are errors, go to diagnose, otherwise conclude
  if (shouldRouteDiagnoseNode || !testsSuccessful) {
    return new Command({
      goto: "diagnose-error",
      update: commandUpdate,
    });
  }

  return new Command({
    goto: "conclusion",
    update: commandUpdate,
  });
}
