import {
  getModelManager,
  loadModel,
  Provider,
  supportsParallelToolCallsParam,
} from "../../../../utils/llms/index.js";
import { LLMTask } from "@openswe/shared/open-swe/llm-task";
import {
  TestingAgentState,
  TestingAgentUpdate,
} from "@openswe/shared/open-swe/testing/types";
import { GraphConfig } from "@openswe/shared/open-swe/types";
import { createLogger, LogLevel } from "../../../../utils/logger.js";
import { getMessageContentString } from "@openswe/shared/messages";
import { SYSTEM_PROMPT } from "./prompt.js";
import { getRepoAbsolutePath } from "@openswe/shared/git";
import {
  createGrepTool,
  createShellTool,
  createPlaywrightTool,
} from "../../../../tools/index.js";
import { formatUserRequestPrompt } from "../../../../utils/user-request.js";
import { getActivePlanItems } from "@openswe/shared/open-swe/tasks";
import { formatPlanPromptWithSummaries } from "../../../../utils/plan-prompt.js";
import { BaseMessage, BaseMessageLike } from "@langchain/core/messages";
import { getMessageString } from "../../../../utils/message/content.js";
import {
  CacheablePromptSegment,
  convertMessagesToCacheControlledMessages,
  trackCachePerformance,
} from "../../../../utils/caching.js";
import { createTextEditorTool } from "../../../../tools/index.js";
import { createViewTool } from "../../../../tools/builtin-tools/view.js";
import { BindToolsInput } from "@langchain/core/language_models/chat_models";

const logger = createLogger(LogLevel.INFO, "GenWritingTestsActionsNode");

function formatSystemPrompt(
  state: TestingAgentState,
  _config: GraphConfig,
): string {
  const activePlan = getActivePlanItems(state.taskPlan);
  const tasksString = formatPlanPromptWithSummaries(activePlan);

  // Get test plan from recent testing messages
  const testPlanMessage = state.testingMessages
    .slice(-5)
    .find(msg => msg.additional_kwargs?.testPlan || 
                 (typeof msg.content === 'string' && msg.content.includes('Test Plan')));
  const testPlanContext = testPlanMessage?.content || "No test plan available";

  return SYSTEM_PROMPT.replaceAll(
    "{CODEBASE_TREE}",
    state.codebaseTree || "No codebase tree generated yet.",
  )
    .replaceAll(
      "{CURRENT_WORKING_DIRECTORY}",
      getRepoAbsolutePath(state.targetRepository),
    )
    .replaceAll("{CHANGED_FILES}", state.changedFiles.join('\n'))
    .replaceAll("{TARGET_REPOSITORY}", `${state.targetRepository.owner}/${state.targetRepository.repo}`)
    .replaceAll("{BRANCH_NAME}", state.branchName)
    .replaceAll("{COMPLETED_TASKS_AND_SUMMARIES}", tasksString)
    .replaceAll(
      "{DEPENDENCIES_INSTALLED}",
      state.dependenciesInstalled ? "Yes" : "No",
    )
    .replaceAll(
      "{TEST_PLAN_CONTEXT}",
      typeof testPlanContext === 'string' ? testPlanContext : JSON.stringify(testPlanContext),
    )
    .replaceAll(
      "{USER_REQUEST_PROMPT}",
      formatUserRequestPrompt(state.messages),
    );
}

const formatCacheablePrompt = (
  state: TestingAgentState,
  config: GraphConfig,
  args?: {
    excludeCacheControl?: boolean;
  },
): CacheablePromptSegment[] => {
  const segments: CacheablePromptSegment[] = [
    {
      type: "text",
      text: formatSystemPrompt(state, config),
      ...(!args?.excludeCacheControl
        ? { cache_control: { type: "ephemeral" } }
        : {}),
    },
  ];

  return segments.filter((segment) => segment.text.trim() !== "");
};

function formatUserConversationHistoryMessage(
  messages: BaseMessage[],
  args?: {
    excludeCacheControl?: boolean;
  },
): CacheablePromptSegment[] {
  return [
    {
      type: "text",
      text: `Here is the full conversation history of the programmer. This includes all of the actions taken by the programmer, as well as any user input.
If the history has been truncated, it is because the conversation was too long. In this case, you should only consider the most recent messages.

<conversation_history>
${messages.map(getMessageString).join("\n")}
</conversation_history>`,
      ...(!args?.excludeCacheControl
        ? { cache_control: { type: "ephemeral" } }
        : {}),
    },
  ];
}

function createToolsAndPrompt(
  state: TestingAgentState,
  config: GraphConfig,
): {
  providerTools: Record<Provider, BindToolsInput[]>;
  providerMessages: Record<Provider, BaseMessageLike[]>;
} {
  const tools = [
    createGrepTool(state, config),
    createShellTool(state, config),
    createViewTool(state, config),
    createTextEditorTool(state, config),
    createPlaywrightTool(state, config),
  ];
  const anthropicTools = tools;
  anthropicTools[anthropicTools.length - 1] = {
    ...anthropicTools[anthropicTools.length - 1],
    cache_control: { type: "ephemeral" },
  } as any;
  const nonAnthropicTools = tools;

  const anthropicMessages = [
    {
      role: "system",
      content: formatCacheablePrompt(state, config, {
        excludeCacheControl: false,
      }),
    },
    {
      role: "user",
      content: formatUserConversationHistoryMessage(state.messages, {
        excludeCacheControl: false,
      }),
    },
    ...convertMessagesToCacheControlledMessages(state.testingMessages),
  ];
  const nonAnthropicMessages = [
    {
      role: "system",
      content: formatCacheablePrompt(state, config, {
        excludeCacheControl: true,
      }),
    },
    {
      role: "user",
      content: formatUserConversationHistoryMessage(state.messages, {
        excludeCacheControl: true,
      }),
    },
    ...state.testingMessages,
  ];

  return {
    providerTools: {
      anthropic: anthropicTools,
      openai: nonAnthropicTools,
      "google-genai": nonAnthropicTools,
    },
    providerMessages: {
      anthropic: anthropicMessages,
      openai: nonAnthropicMessages,
      "google-genai": nonAnthropicMessages,
    },
  };
}

export async function genWritingTestsActions(
  state: TestingAgentState,
  config: GraphConfig,
): Promise<TestingAgentUpdate> {
  const modelManager = getModelManager();
  const modelName = modelManager.getModelNameForTask(config, LLMTask.PROGRAMMER);
  const modelSupportsParallelToolCallsParam = supportsParallelToolCallsParam(
    config,
    LLMTask.PROGRAMMER,
  );
  const isAnthropicModel = modelName.includes("claude-");

  const { providerTools, providerMessages } = createToolsAndPrompt(
    state,
    config,
  );

  const model = await loadModel(config, LLMTask.PROGRAMMER, {
    providerTools,
    providerMessages,
  });
  const modelWithTools = model.bindTools(
    isAnthropicModel ? providerTools.anthropic : providerTools.openai,
    {
      tool_choice: "auto",
      ...(modelSupportsParallelToolCallsParam
        ? {
            parallel_tool_calls: true,
          }
        : {}),
    },
  );

  const response = await modelWithTools.invoke(
    isAnthropicModel ? providerMessages.anthropic : providerMessages.openai,
  );

  logger.info("Generated writing tests actions", {
    ...(getMessageContentString(response.content) && {
      content: getMessageContentString(response.content),
    }),
    ...response.tool_calls?.map((tc) => ({
      name: tc.name,
      args: tc.args,
    })),
  });

  return {
    messages: [response],
    testingMessages: [response],
    testingActionsCount: (state.testingActionsCount || 0) + 1,
    tokenData: trackCachePerformance(response, modelName),
  };
}
