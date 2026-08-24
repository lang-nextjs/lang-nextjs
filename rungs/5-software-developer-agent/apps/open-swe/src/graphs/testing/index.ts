import { END, START, StateGraph } from "@langchain/langgraph";
import { GraphConfiguration } from "@openswe/shared/open-swe/types";
import { TestingAgentStateObj, TestingAgentState } from "@openswe/shared/open-swe/testing/types";
import {
  initializeState,
  generateTestPlan,
  genWritingTestsActions,
  takeReviewActions,
  genExecutingTestsActions,
  takeExecutingTestsActions,
  diagnoseError,
  conclusion,
} from "./nodes/index.js";
import { createLogger, LogLevel } from "../../utils/logger.js";
import { isAIMessage } from "@langchain/core/messages";

const logger = createLogger(LogLevel.INFO, "TestingAgent:Graph");

/**
 * Route after generating test plan based on success
 */
function routeFromTestPlan(state: TestingAgentState): "gen-writing-tests-actions" | "conclusion" {
  const lastMessage = state.testingMessages[state.testingMessages.length - 1];
  const hasError = lastMessage?.additional_kwargs?.error;
  
  if (hasError) {
    logger.warn("Test plan generation failed, moving to conclusion");
    return "conclusion";
  }
  
  return "gen-writing-tests-actions";
}

/**
 * Route after generating writing test actions
 */
function routeFromWritingActions(state: TestingAgentState): "take-review-actions" | "gen-executing-tests-actions" {
  const lastMessage = state.testingMessages[state.testingMessages.length - 1];
  const hasToolCalls = isAIMessage(lastMessage) && lastMessage.tool_calls && lastMessage.tool_calls.length > 0;
  
  if (hasToolCalls) {
    return "take-review-actions";
  }
  
  return "gen-executing-tests-actions";
}

/**
 * Route after taking review actions
 */
function routeFromReviewActions(state: TestingAgentState): "gen-executing-tests-actions" | "diagnose-error" {
  const lastMessages = state.testingMessages.slice(-3);
  const hasErrors = lastMessages.some(msg => msg.additional_kwargs?.error);
  
  if (hasErrors) {
    return "diagnose-error";
  }
  
  return "gen-executing-tests-actions";
}

/**
 * Route after generating executing test actions
 */
function routeFromExecutingActions(state: TestingAgentState): "take-executing-tests-actions" | "conclusion" {
  const lastMessage = state.testingMessages[state.testingMessages.length - 1];
  const hasToolCalls = isAIMessage(lastMessage) && lastMessage.tool_calls && lastMessage.tool_calls.length > 0;
  
  if (hasToolCalls) {
    return "take-executing-tests-actions";
  }
  
  return "conclusion";
}

/**
 * Route after taking executing test actions
 */
function routeFromExecutingTestsActions(state: TestingAgentState): "conclusion" | "diagnose-error" {
  const testsSuccessful = state.testsSuccessful;
  
  if (testsSuccessful === false) {
    return "diagnose-error";
  }
  
  return "conclusion";
}

/**
 * Route from diagnose error - either retry or conclude
 */
function routeFromDiagnoseError(state: TestingAgentState): "gen-writing-tests-actions" | "conclusion" {
  const maxRetries = 3;
  const currentRetries = state.testingActionsCount || 0;
  
  const lastMessage = state.testingMessages[state.testingMessages.length - 1];
  const isDiagnosis = lastMessage?.additional_kwargs?.diagnosis;
  
  // If we have a diagnosis and haven't exceeded retries, try again
  if (isDiagnosis && currentRetries < maxRetries) {
    logger.info("Retrying test generation after diagnosis", { 
      currentRetries, 
      maxRetries 
    });
    return "gen-writing-tests-actions";
  }
  
  logger.info("Moving to conclusion after diagnosis", { 
    currentRetries, 
    maxRetries 
  });
  return "conclusion";
}

// Build the testing agent workflow
const workflow = new StateGraph(TestingAgentStateObj, GraphConfiguration)
  .addNode("initialize-state", initializeState)
  .addNode("generate-test-plan", generateTestPlan)
  .addNode("gen-writing-tests-actions", genWritingTestsActions)
  .addNode("take-review-actions", takeReviewActions)
  .addNode("gen-executing-tests-actions", genExecutingTestsActions)
  .addNode("take-executing-tests-actions", takeExecutingTestsActions)
  .addNode("diagnose-error", diagnoseError)
  .addNode("conclusion", conclusion)
  
  // Start with state initialization
  .addEdge(START, "initialize-state")
  .addEdge("initialize-state", "generate-test-plan")
  
  // Conditional routing based on state
  .addConditionalEdges("generate-test-plan", routeFromTestPlan, [
    "gen-writing-tests-actions",
    "conclusion",
  ])
  
  .addConditionalEdges("gen-writing-tests-actions", routeFromWritingActions, [
    "take-review-actions",
    "gen-executing-tests-actions",
  ])
  
  .addConditionalEdges("take-review-actions", routeFromReviewActions, [
    "gen-executing-tests-actions",
    "diagnose-error",
  ])
  
  .addConditionalEdges("gen-executing-tests-actions", routeFromExecutingActions, [
    "take-executing-tests-actions",
    "conclusion",
  ])
  
  .addConditionalEdges("take-executing-tests-actions", routeFromExecutingTestsActions, [
    "conclusion",
    "diagnose-error",
  ])
  
  .addConditionalEdges("diagnose-error", routeFromDiagnoseError, [
    "gen-writing-tests-actions",
    "conclusion",
  ])
  
  // End at conclusion
  .addEdge("conclusion", END);

// Compile and export the graph
export const graph = workflow.compile();
graph.name = "Open SWE - Testing Agent";
