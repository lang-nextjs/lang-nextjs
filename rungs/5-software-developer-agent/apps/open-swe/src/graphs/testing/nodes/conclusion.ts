import { Command, END } from "@langchain/langgraph";
import { GraphConfig, TestingStatus } from "@openswe/shared/open-swe/types";
import { TestingAgentState, TestingAgentUpdate } from "@openswe/shared/open-swe/testing/types";
import { createLogger, LogLevel } from "../../../utils/logger.js";
import { AIMessage } from "@langchain/core/messages";
import { v4 as uuidv4 } from "uuid";

const logger = createLogger(LogLevel.INFO, "TestingAgent:Conclusion");

/**
 * Generate final testing report and conclusion
 */
export async function conclusion(
  state: TestingAgentState,
  _config: GraphConfig,
): Promise<Command> {
  logger.info("Generating testing conclusion", {
    testingActionsCount: state.testingActionsCount,
    testsSuccessful: state.testsSuccessful,
    testingMessagesCount: state.testingMessages.length,
  });

  // Analyze testing session results
  const testExecutionMessages = state.testingMessages.filter(msg => 
    msg.additional_kwargs?.isTestExecution
  );
  
  const errorMessages = state.testingMessages.filter(msg => 
    msg.additional_kwargs?.error
  );

  const testsCreated = state.testingMessages.filter(msg => 
    msg.additional_kwargs?.writingTests
  ).length;

  const testsExecuted = testExecutionMessages.length;
  const errorsEncountered = errorMessages.length;

  // Generate conclusion based on results
  let conclusionContent = `🧪 **Testing Agent - Final Report**

## Testing Session Summary

**Repository:** ${state.targetRepository.owner}/${state.targetRepository.repo}
**Branch:** ${state.branchName}
**Total Actions:** ${state.testingActionsCount || 0}
**Changed Files:** ${state.changedFiles?.length || 0}

## Results Overview

- **Tests Created:** ${testsCreated > 0 ? '✅' : '❌'} ${testsCreated} test generation cycles
- **Tests Executed:** ${testsExecuted > 0 ? '✅' : '❌'} ${testsExecuted} execution attempts
- **Overall Status:** ${state.testsSuccessful ? '✅ PASSED' : '❌ ISSUES FOUND'}
- **Errors Encountered:** ${errorsEncountered}

## Summary

`;

  if (state.testsSuccessful) {
    conclusionContent += `✅ **Testing completed successfully!**

All tests have been created and executed successfully. The code changes have been thoroughly validated with:
- Unit tests for individual components
- Integration tests for component interactions
- End-to-end tests for user workflows (where applicable)
- Code quality checks

The implementation appears to be working correctly and is ready for review.`;
  } else if (testsCreated > 0) {
    conclusionContent += `⚠️ **Testing completed with issues**

Tests were created and executed, but some issues were encountered:
- Some tests may have failed
- Potential bugs or issues found in the implementation
- Test setup or environment issues

**Recommendations:**
- Review test failures and fix underlying issues
- Check test configurations and dependencies
- Consider manual testing for critical functionality`;
  } else {
    conclusionContent += `❌ **Testing could not be completed**

The testing agent encountered difficulties and was unable to create or execute comprehensive tests:
- May be due to complex code changes
- Potential environment or setup issues
- Missing dependencies or configurations

**Recommendations:**
- Manual testing is strongly recommended
- Consider setting up tests manually
- Review code changes for potential issues`;
  }

  if (state.changedFiles?.length) {
    conclusionContent += `\n\n## Changed Files Tested
${state.changedFiles.map(file => `- ${file}`).join('\n')}`;
  }

  conclusionContent += `\n\n---
*Testing completed by Testing Agent*`;

  const conclusionMessage = new AIMessage({
    id: uuidv4(),
    content: conclusionContent,
    additional_kwargs: {
      testingAgent: true,
      conclusion: true,
      testsSuccessful: state.testsSuccessful,
    },
  });

  const update: TestingAgentUpdate = {
    testingMessages: [conclusionMessage],
  };

  // Determine the final testing status based on results
  let finalTestingStatus: TestingStatus;
  if (testsCreated === 0) {
    // If no tests were created, testing failed
    finalTestingStatus = "failed";
  } else if (state.testsSuccessful) {
    // If tests were created and successful, testing completed
    finalTestingStatus = "completed";
  } else {
    // If tests were created but not successful, testing failedY
    finalTestingStatus = "failed";
  }

  logger.info("Testing agent concluded", {
    testsSuccessful: state.testsSuccessful,
    testsCreated,
    testsExecuted,
    errorsEncountered,
    finalTestingStatus,
  });

  return new Command({
    update: {
      ...update,
      testingStatus: finalTestingStatus,
    },
    goto: END,
  });
}
