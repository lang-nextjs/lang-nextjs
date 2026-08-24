import { createLangGraphClient } from "../../utils/langgraph-client.js";
import {
  PLANNER_GRAPH_ID,
  GITHUB_USER_ID_HEADER,
  GITHUB_USER_LOGIN_HEADER,
  GITHUB_INSTALLATION_ID,
  GITHUB_INSTALLATION_NAME,
  GITHUB_INSTALLATION_TOKEN_COOKIE,
} from "@openswe/shared/constants";
import { z } from "zod";
import {
  loadModel,
  supportsParallelToolCallsParam,
} from "../../utils/llms/index.js";
import { LLMTask } from "@openswe/shared/open-swe/llm-task";
import { GraphConfig } from "@openswe/shared/open-swe/types";
import {
  WebhookHandlerBase,
  WebhookHandlerContext,
} from "./webhook-handler-base.js";
import { dynamoRunStore, DynamoDBRunStore } from "../../utils/dynamodb.js";
import { encryptSecret } from "@openswe/shared/crypto";

type HumanResponseType = "accept" | "response" | "ignore";

// Tool schema for comment analysis - only 3 options
const CommentAnalysisToolSchema = z.object({
  action: z
    .enum(["approve", "reject", "clarify"])
    .describe(
      "The user's intent: 'approve' to proceed with the plan, 'reject' to stop/decline the plan, 'clarify' for questions or requests for changes",
    ),
  reasoning: z
    .string()
    .describe("Brief explanation of why this action was chosen"),
  user_message: z
    .string()
    .optional()
    .describe(
      "If action is 'clarify', include the user's specific question or feedback",
    ),
});

type CommentAnalysisResult = z.infer<typeof CommentAnalysisToolSchema>;

class PlanInteractionWebhookHandler extends WebhookHandlerBase {
  constructor() {
    super("PlanInteractionHandler");
  }

  /**
   * Analyze comment intent using tool calls method
   */
  private async analyzeCommentWithTools(
    commentBody: string,
    config: GraphConfig,
  ): Promise<CommentAnalysisResult> {
    try {
      const analyzeCommentTool = {
        name: "analyze_comment",
        description:
          "Analyze a GitHub comment to determine the user's intent regarding a proposed plan.",
        schema: CommentAnalysisToolSchema,
      };

      const model = await loadModel(config, LLMTask.ROUTER);
      const modelSupportsParallelToolCallsParam =
        supportsParallelToolCallsParam(config, LLMTask.ROUTER);
      const modelWithTools = model.bindTools([analyzeCommentTool], {
        tool_choice: analyzeCommentTool.name,
        ...(modelSupportsParallelToolCallsParam
          ? {
              parallel_tool_calls: false,
            }
          : {}),
      });

      const response = await modelWithTools.invoke([
        {
          role: "system",
          content: `You are analyzing GitHub comments to determine user intent regarding a proposed development plan.

Your task is to classify the user's comment into exactly one of these 3 categories:

1. "approve" - User wants to proceed with the plan
   - Clear approval words: approve, accept, lgtm, looks good, go ahead, yes, proceed, continue, good, fine, ok, okay, 👍, +1
   - Phrases like: "let's do it", "sounds good", "I agree", "that works"
   - Be DECISIVE: If the comment contains ANY approval keywords, choose "approve"

2. "reject" - User wants to stop/decline the plan  
   - Clear rejection words: reject, no, disagree, don't, stop, cancel, decline, abort, 👎, -1
   - Phrases like: "I don't want", "not good", "don't do this"
   - Be DECISIVE: If the comment contains ANY rejection keywords, choose "reject"

3. "clarify" - ONLY for genuine questions or requests for changes
   - Must contain question words: what, how, why, when, where, can you, could you, please change, modify
   - Must be asking for information or requesting modifications to the plan
   - Examples: "What does step 2 involve?", "Can you change the approach?", "How long will this take?"

IMPORTANT RULES:
- DEFAULT to "approve" or "reject" whenever possible - don't be overly cautious
- Only use "clarify" for actual questions or change requests
- If you see both approval AND question words, choose "approve" (user is approving while asking minor questions)
- Single word responses like "accept", "approve", "yes", "ok" should ALWAYS be "approve"
- Single word responses like "reject", "no", "stop" should ALWAYS be "reject"
- If unsure between approve/reject vs clarify, choose approve/reject`,
        },
        {
          role: "user",
          content: `Analyze this comment: "${commentBody}"`,
        },
      ]);

      const toolCall = response.tool_calls?.[0];
      if (!toolCall) {
        throw new Error("No tool call found in response");
      }

      const result = toolCall.args as CommentAnalysisResult;
      return result;
    } catch (error) {
      this.logger.error("Error analyzing comment with tools:", error);
      // Fallback to simple keyword analysis
      return this.fallbackCommentAnalysis(commentBody);
    }
  }

  /**
   * Fallback comment analysis using simple keywords
   */
  private fallbackCommentAnalysis(commentBody: string): CommentAnalysisResult {
    const lowerComment = commentBody.toLowerCase().trim();

    // Approval keywords - be more inclusive
    if (
      lowerComment.includes("approve") ||
      lowerComment.includes("accept") ||
      lowerComment.includes("lgtm") ||
      lowerComment.includes("looks good") ||
      lowerComment.includes("👍") ||
      lowerComment.includes("+1") ||
      lowerComment.includes("go ahead") ||
      lowerComment.includes("proceed") ||
      lowerComment.includes("continue") ||
      lowerComment.includes("yes") ||
      lowerComment.includes("good") ||
      lowerComment.includes("fine") ||
      lowerComment.includes("ok") ||
      lowerComment.includes("okay") ||
      lowerComment === "y" ||
      lowerComment.includes("sounds good") ||
      lowerComment.includes("let's do it") ||
      lowerComment.includes("i agree") ||
      lowerComment.includes("that works")
    ) {
      return {
        action: "approve",
        reasoning: "Contains approval keywords or positive indicators",
      };
    }

    // Rejection keywords - be more inclusive
    if (
      lowerComment.includes("reject") ||
      lowerComment.includes("no") ||
      lowerComment.includes("👎") ||
      lowerComment.includes("-1") ||
      lowerComment.includes("disagree") ||
      lowerComment.includes("don't") ||
      lowerComment.includes("stop") ||
      lowerComment.includes("cancel") ||
      lowerComment.includes("decline") ||
      lowerComment.includes("abort") ||
      lowerComment === "n" ||
      lowerComment.includes("not good") ||
      lowerComment.includes("i don't want")
    ) {
      return {
        action: "reject",
        reasoning: "Contains rejection keywords or negative indicators",
      };
    }

    // Only classify as clarify if it actually contains question words or change requests
    if (
      lowerComment.includes("what") ||
      lowerComment.includes("how") ||
      lowerComment.includes("why") ||
      lowerComment.includes("when") ||
      lowerComment.includes("where") ||
      lowerComment.includes("can you") ||
      lowerComment.includes("could you") ||
      lowerComment.includes("please change") ||
      lowerComment.includes("modify") ||
      lowerComment.includes("?")
    ) {
      return {
        action: "clarify",
        reasoning: "Contains genuine questions or requests for changes",
        user_message:
          commentBody.length > 100
            ? commentBody.substring(0, 100) + "..."
            : commentBody,
      };
    }

    // If no clear indicators, default to approve (be more decisive)
    return {
      action: "approve",
      reasoning:
        "No clear rejection or question indicators found, defaulting to approve",
    };
  }

  /**
   * Resume planner run with human response
   */
  private async resumePlannerRun(
    threadId: string,
    humanResponseType: HumanResponseType,
    context: WebhookHandlerContext,
    args: Record<string, any> = {},
    runId?: string, // Add runId parameter
  ): Promise<void> {
    if (!process.env.SECRETS_ENCRYPTION_KEY) {
      throw new Error(
        "SECRETS_ENCRYPTION_KEY environment variable is required",
      );
    }

    const langGraphClient = createLangGraphClient({
      defaultHeaders: {
        [GITHUB_INSTALLATION_TOKEN_COOKIE]: encryptSecret(
          context.token || "",
          process.env.SECRETS_ENCRYPTION_KEY,
        ),
        [GITHUB_INSTALLATION_NAME]: context.owner || "",
        [GITHUB_USER_ID_HEADER]: context.userId?.toString() || "",
        [GITHUB_USER_LOGIN_HEADER]: context.userLogin || "",
        [GITHUB_INSTALLATION_ID]: context.installationId?.toString() || "",
      },
    });

    try {
      this.logger.info("Attempting to resume planner run", {
        threadId,
        runId: runId || "no-runId",
        humanResponseType,
        graphId: PLANNER_GRAPH_ID,
        args,
      });

      // Resume the run - use the thread-based approach as run-specific streaming might not be supported
      const stream = langGraphClient.runs.stream(threadId, PLANNER_GRAPH_ID, {
        input: null,
        config: {
          recursion_limit: 400,
          configurable: {
            [GITHUB_USER_ID_HEADER]: context.userId?.toString(),
            [GITHUB_USER_LOGIN_HEADER]: context.userLogin,
            [GITHUB_INSTALLATION_ID]: context.installationId?.toString(),
            [GITHUB_INSTALLATION_NAME]: context.owner,
            [GITHUB_INSTALLATION_TOKEN_COOKIE]: context.token,
            ...(runId ? { run_id: runId } : {}), // Include run_id in configurable if available
          },
        },
        command: {
          resume: [
            {
              type: humanResponseType,
              args,
            },
          ],
        },
      });

      // Start processing the stream in background to avoid blocking graph continuation
      let eventCount = 0;
      (async () => {
        try {
          for await (const event of stream) {
            eventCount++;
            if (eventCount <= 10) {
              this.logger.debug("Planner stream event", {
                threadId,
                eventCount,
                eventType: event?.event,
                eventData: event?.data ? JSON.stringify(event.data).slice(0, 100) : 'no-data',
              });
            }
            
            // Log stream progress periodically
            if (eventCount % 5 === 0) {
              this.logger.info("Stream progress", {
                threadId,
                eventCount,
                eventType: event?.event,
              });
            }
          }
          this.logger.info("Stream processing completed", {
            threadId,
            humanResponseType,
            totalEvents: eventCount,
          });
        } catch (streamError) {
          this.logger.error("Error during stream processing:", {
            error: streamError,
            threadId,
            humanResponseType,
          });
        }
      })(); // Execute immediately but don't await

      this.logger.info("Successfully started planner resume", {
        threadId,
        runId: runId || "no-runId",
        humanResponseType,
        args,
        note: "Stream processing continues in background with run-specific resume",
      });
    } catch (error) {
      this.logger.error("Error resuming planner run:", error);
      throw error;
    }
  }

  /**
   * Ask user to provide explicit response (accept or ignore) when their comment is unclear
   */
  private async askForExplicitResponse(
    context: WebhookHandlerContext,
    issue: any,
    repository: any,
  ): Promise<void> {
    try {
      const commentBody = `### 🤔 Please Clarify Your Response

Your comment wasn't clear about whether you want to proceed with the proposed plan or not.

Please respond with one of these options:
- **"accept"** or **"approve"** - to proceed with the plan
- **"ignore"** or **"reject"** - to decline/close this issue

I'll wait for your clear response before taking any action.`;

      await context.octokit.request(
        "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
        {
          owner: context.owner,
          repo: repository?.name || context.repo,
          issue_number: issue?.number,
          body: commentBody,
        },
      );

      this.logger.info("Posted clarification request", {
        issueNumber: issue?.number,
        repository: repository?.full_name,
      });
    } catch (error) {
      this.logger.error("Error posting clarification request:", error);
      throw error;
    }
  }

  /**
   * Find run metadata from DynamoDB
   */
  private async findRunMetadataFromDB(
    repositoryFullName: string,
    issueNumber: number,
  ): Promise<{
    runId?: string;
    threadId?: string;
    assistantId?: string;
  } | null> {
    try {
      const [owner, repo] = repositoryFullName.split("/");
      if (!owner || !repo) {
        this.logger.error("Invalid repository format", { repositoryFullName });
        return null;
      }

      const issueKey = DynamoDBRunStore.createIssueKey(
        owner,
        repo,
        issueNumber,
      );
      const runMetadata = await dynamoRunStore.getRunMetadata(issueKey);

      if (!runMetadata) {
        this.logger.debug("No run metadata found in DynamoDB", { issueKey });
        return null;
      }

      return {
        runId: runMetadata.runId,
        threadId: runMetadata.threadId,
        assistantId: runMetadata.assistantId,
      };
    } catch (error) {
      this.logger.error("Error retrieving run metadata from DynamoDB", error);
      return null;
    }
  }

  /**
   * Handle reaction-style comments for plan approval/disapproval
   * Since GitHub reactions don't have separate webhooks, we check comment content for reaction-like feedback
   */
  async handlePlanReaction(payload: any): Promise<void> {
    try {
      const { comment, issue, repository, sender, action } = payload;

      // Skip bot comments and non-created actions
      if (sender?.type === "Bot" || action !== "created") {
        this.logger.debug(
          "Ignoring reaction check: bot comment or non-created action",
        );
        return;
      }

      const commentBody = comment?.body || "";

      // Check if this is a simple reaction-style comment (short, clear intent)
      const isReactionStyle =
        commentBody.length < 50 &&
        (/^(👍|👎|\+1|-1|approve|reject|lgtm|no)$/i.test(commentBody.trim()) ||
          /^(approve|reject|lgtm|no|yes|good|bad)!?$/.test(
            commentBody.trim().toLowerCase(),
          ));

      if (!isReactionStyle) {
        this.logger.debug(
          "Comment not reaction-style, skipping reaction handler",
        );
        return;
      }

      this.logger.info("Processing reaction-style comment", {
        issueNumber: issue?.number,
        repository: repository?.full_name,
        reaction: commentBody.trim(),
        sender: sender?.login,
      });

      // Find run metadata from DynamoDB
      const runMetadata = await this.findRunMetadataFromDB(
        repository?.full_name,
        issue?.number,
      );

      if (!runMetadata?.threadId) {
        this.logger.debug(
          "No run metadata found in DynamoDB for reaction, cannot resume planner",
        );
        return;
      }

      // Setup webhook context for the response
      const context = await this.setupWebhookContext(payload);
      if (!context) {
        this.logger.warn("Failed to setup webhook context for plan reaction");
        return;
      }

      // Analyze the reaction content
      const lowerContent = commentBody.toLowerCase().trim();
      let humanResponseType: "accept" | "ignore" | "response" | null = null;

      if (
        lowerContent.includes("👍") ||
        lowerContent.includes("+1") ||
        lowerContent === "approve" ||
        lowerContent === "lgtm" ||
        lowerContent === "yes" ||
        lowerContent === "good"
      ) {
        humanResponseType = "accept";
      } else if (
        lowerContent.includes("👎") ||
        lowerContent.includes("-1") ||
        lowerContent === "reject" ||
        lowerContent === "no" ||
        lowerContent === "bad"
      ) {
        humanResponseType = "ignore";
      } else {
        // Treat other short comments as clarification requests
        humanResponseType = "response";
      }

      this.logger.info("Resuming planner with reaction feedback", {
        threadId: runMetadata.threadId,
        reaction: commentBody.trim(),
        responseType: humanResponseType,
      });

      const args =
        humanResponseType === "response" ? { response: commentBody } : {};
      await this.resumePlannerRun(
        runMetadata.threadId,
        humanResponseType,
        context,
        args,
        runMetadata.runId, // Pass the specific run ID
      );
    } catch (error) {
      this.logger.error("Error handling plan reaction:", error);
      throw error;
    }
  }

  /**
   * Handle GitHub issue comments for plan feedback/iteration
   */
  async handlePlanComment(payload: any): Promise<void> {
    try {
      const { comment, issue, repository, sender, action } = payload;

      // Skip bot comments and non-created actions
      if (sender?.type === "Bot" || action !== "created") {
        this.logger.debug(
          `Ignoring comment: bot=${sender?.type === "Bot"}, action=${action}`,
        );
        return;
      }

      // Set up webhook context with proper user configuration
      const context = await this.setupWebhookContext(payload);
      if (!context) {
        this.logger.warn("Failed to setup webhook context for plan comment");
        return;
      }

      const commentBody = comment?.body || "";

      const runMetadata = await this.findRunMetadataFromDB(
        repository?.full_name,
        issue?.number,
      );

      if (!runMetadata?.threadId) {
        this.logger.debug(
          "No run metadata found in DynamoDB, cannot resume planner",
        );
        return;
      }

      if (!runMetadata.assistantId) {
        this.logger.debug(
          "No assistantId found in run metadata, cannot analyze comment with tools",
        );
        return;
      }

      // Create proper config with user context and thread/assistant info
      const analysisConfig: GraphConfig = {
        configurable: {
          thread_id: runMetadata.threadId,
          assistant_id: runMetadata.assistantId,
          [GITHUB_USER_ID_HEADER]: context.userId?.toString(),
          [GITHUB_USER_LOGIN_HEADER]: context.userLogin,
          [GITHUB_INSTALLATION_ID]: context.installationId?.toString(),
          [GITHUB_INSTALLATION_NAME]: context.owner,
          [GITHUB_INSTALLATION_TOKEN_COOKIE]: context.token,
        },
      };

      // Analyze comment with LLM using tool calls
      const analysis = await this.analyzeCommentWithTools(
        commentBody,
        analysisConfig,
      );

      this.logger.info("LLM Comment Analysis", {
        issueNumber: issue?.number,
        repository: repository?.full_name,
        action: analysis.action,
        reasoning: analysis.reasoning,
      });

      // Skip if this is a clarification request without clear intent
      if (!analysis.action) {
        this.logger.debug("No clear action determined from comment, ignoring");
        return;
      }

      this.logger.info("Processing plan comment feedback", {
        issueNumber: issue?.number,
        repository: repository?.full_name,
        commentLength: commentBody.length,
        analysisIntent: analysis.action,
        runId: runMetadata.runId,
        threadId: runMetadata.threadId,
      });

      // Map LLM analysis to planner actions
      let plannerAction: "accept" | "response" | "ignore";
      let args: Record<string, any> = {};

      switch (analysis.action) {
        case "approve":
          plannerAction = "accept";
          // Resume the graph to proceed with the plan
          await this.resumePlannerRun(
            runMetadata.threadId,
            plannerAction,
            context,
            args,
            runMetadata.runId, // Pass the specific run ID
          );
          break;
        case "reject":
          plannerAction = "ignore";
          // Resume the graph to end/close the process
          await this.resumePlannerRun(
            runMetadata.threadId,
            plannerAction,
            context,
            args,
            runMetadata.runId, // Pass the specific run ID
          );
          break;
        case "clarify":
          await this.askForExplicitResponse(context, issue, repository);
          return;
        default:
          this.logger.warn("Unexpected analysis action");
          return;
      }
    } catch (error) {
      this.logger.error("Error handling plan comment:", error);
      throw error;
    }
  }
}

const planInteractionHandler = new PlanInteractionWebhookHandler();

export async function handlePlanComment(payload: any): Promise<void> {
  return planInteractionHandler.handlePlanComment(payload);
}

export async function handlePlanReaction(payload: any): Promise<void> {
  return planInteractionHandler.handlePlanReaction(payload);
}
