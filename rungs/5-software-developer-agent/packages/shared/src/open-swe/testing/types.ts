import "@langchain/langgraph/zod";
import { z } from "zod";
import {
  Messages,
  messagesStateReducer,
  MessagesZodState,
} from "@langchain/langgraph";
import {
  CustomRules,
  ModelTokenData,
  TargetRepository,
  TaskPlan,
} from "../types.js";
import { withLangGraph } from "@langchain/langgraph/zod";
import { BaseMessage } from "@langchain/core/messages";
import { tokenDataReducer } from "../../caching.js";

export const TestingAgentStateObj = MessagesZodState.extend({
  /**
   * A separate list of messages for the testing agent. Used to track both
   * internal messages which do not need to be shown to the user/propagated
   * back to the programmer, and to determine how many testing actions have
   * been executed.
   */
  testingMessages: withLangGraph(z.custom<BaseMessage[]>(), {
    reducer: {
      schema: z.custom<Messages>(),
      fn: messagesStateReducer,
    },
    jsonSchemaExtra: {
      langgraph_type: "messages",
    },
    default: () => [],
  }),
  sandboxSessionId: withLangGraph(z.string(), {
    reducer: {
      schema: z.string(),
      fn: (_state, update) => update,
    },
  }),
  targetRepository: withLangGraph(z.custom<TargetRepository>(), {
    reducer: {
      schema: z.custom<TargetRepository>(),
      fn: (_state, update) => update,
    },
  }),
  githubIssueId: withLangGraph(z.custom<number>(), {
    reducer: {
      schema: z.custom<number>(),
      fn: (_state, update) => update,
    },
  }),
  branchName: withLangGraph(z.string(), {
    reducer: {
      schema: z.string(),
      fn: (_state, update) => update,
    },
  }),
  codebaseTree: withLangGraph(z.custom<string>().optional(), {
    reducer: {
      schema: z.custom<string>().optional(),
      fn: (_state, update) => update,
    },
  }),
  changedFiles: withLangGraph(z.custom<string[]>(), {
    reducer: {
      schema: z.custom<string[]>(),
      fn: (_state: string[], update: string[]) => update,
    },
    default: (): string[] => [],
  }),
  dependenciesInstalled: withLangGraph(z.boolean(), {
    reducer: {
      schema: z.boolean(),
      fn: (_state, update) => update,
    },
  }),
  /**
   * The task plan that the testing agent should validate
   */
  taskPlan: withLangGraph(z.custom<TaskPlan>(), {
    reducer: {
      schema: z.custom<TaskPlan>(),
      fn: (_state, update) => update,
    },
  }),
  /**
   * Custom rules for testing approach
   */
  customRules: withLangGraph(z.custom<CustomRules>().optional(), {
    reducer: {
      schema: z.custom<CustomRules>().optional(),
      fn: (_state, update) => update,
    },
  }),
  /**
   * The number of times testing actions have been executed.
   */
  testingActionsCount: withLangGraph(z.custom<number>(), {
    reducer: {
      schema: z.custom<number>(),
      fn: (_state, update) => update,
    },
    default: () => 0,
  }),
  /**
   * Whether the tests have passed successfully
   */
  testsSuccessful: withLangGraph(z.boolean().optional(), {
    reducer: {
      schema: z.boolean().optional(),
      fn: (_state, update) => update,
    },
  }),
  tokenData: withLangGraph(z.custom<ModelTokenData[]>().optional(), {
    reducer: {
      schema: z.custom<ModelTokenData[]>().optional(),
      fn: tokenDataReducer,
    },
  }),
});

export type TestingAgentState = z.infer<typeof TestingAgentStateObj>;
export type TestingAgentUpdate = Partial<TestingAgentState>;
