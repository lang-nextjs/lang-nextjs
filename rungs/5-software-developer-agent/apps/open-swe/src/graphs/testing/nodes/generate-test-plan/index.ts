import {
  getModelManager,
  loadModel,
  Provider,
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

const logger = createLogger(LogLevel.INFO, "GenerateTestPlanNode");

function formatSystemPrompt(
  state: TestingAgentState,
  _config: GraphConfig,
): string {
  const activePlan = getActivePlanItems(state.taskPlan);
  const tasksString = formatPlanPromptWithSummaries(activePlan);

  return SYSTEM_PROMPT.replaceAll(
    "{CODEBASE_TREE}",
    state.codebaseTree || "No codebase tree generated yet.",
  )
    .replaceAll(
      "{CURRENT_WORKING_DIRECTORY}",
      getRepoAbsolutePath(state.targetRepository),
    )
    .replaceAll("{CHANGED_FILES}", state.changedFiles.join('\n'))
    .replaceAll("{BASE_BRANCH_NAME}", "main") // Testing agent doesn't have baseBranchName, use default
    .replaceAll("{TARGET_REPOSITORY}", `${state.targetRepository.owner}/${state.targetRepository.repo}`)
    .replaceAll("{BRANCH_NAME}", state.branchName)
    .replaceAll("{COMPLETED_TASKS_AND_SUMMARIES}", tasksString)
    .replaceAll(
      "{DEPENDENCIES_INSTALLED}",
      state.dependenciesInstalled ? "Yes" : "No",
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

function createPrompt(
  state: TestingAgentState,
  config: GraphConfig,
): {
  providerMessages: Record<Provider, BaseMessageLike[]>;
} {
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
    providerMessages: {
      anthropic: anthropicMessages,
      openai: nonAnthropicMessages,
      "google-genai": nonAnthropicMessages,
    },
  };
}

export async function generateTestPlan(
  state: TestingAgentState,
  config: GraphConfig,
): Promise<TestingAgentUpdate> {
  const modelManager = getModelManager();
  const modelName = modelManager.getModelNameForTask(config, LLMTask.PLANNER);
  const isAnthropicModel = modelName.includes("claude-");

  const { providerMessages } = createPrompt(state, config);

  const model = await loadModel(config, LLMTask.PLANNER, {
    providerMessages,
  });

  const response = await model.invoke(
    isAnthropicModel ? providerMessages.anthropic : providerMessages.openai,
  );

  logger.info("Generated test plan", {
    ...(getMessageContentString(response.content) && {
      content: getMessageContentString(response.content),
    }),
  });

  return {
    messages: [response],
    testingMessages: [response],
    tokenData: trackCachePerformance(response, modelName),
  };
}
