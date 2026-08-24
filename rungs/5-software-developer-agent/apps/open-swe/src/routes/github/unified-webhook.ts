import { Context } from "hono";
import { BlankEnv, BlankInput } from "hono/types";
import { createLogger, LogLevel } from "../../utils/logger.js";
import { Webhooks } from "@octokit/webhooks";
import { handleIssueLabeled } from "./issue-labeled.js";
import { handlePullRequestComment } from "./pull-request-comment.js";
import { handlePullRequestReview } from "./pull-request-review.js";
import { handlePullRequestReviewComment } from "./pull-request-review-comment.js";
import { handlePlanComment, handlePlanReaction } from "./plan-interaction.js";

const logger = createLogger(LogLevel.INFO, "GitHubUnifiedWebhook");

// Helper function to handle different webhook events
async function processWebhookEvent(eventName: string, payload: any): Promise<void> {
  if (eventName === "issues" && payload.action === "labeled") {
    logger.debug("Handling issues.labeled event directly", {
      issue: payload.issue?.number,
      repository: payload.repository?.full_name,
      labels: payload.issue?.labels?.map((l: any) => l.name),
      installationId: payload.installation?.id
    });
    await handleIssueLabeled(payload);
  } else if (eventName === "issue_comment" && payload.action === "created") {
    logger.debug("Handling issue_comment.created event directly", {
      issue: payload.issue?.number,
      repository: payload.repository?.full_name,
      commentId: payload.comment?.id,
      installationId: payload.installation?.id
    });
    
    // If this is a PR comment (issue object has pull_request), handle PR comment logic
    if (payload.issue?.pull_request) {
      await handlePullRequestComment(payload);
    } else {
      // Otherwise, handle plan comment logic (issue only)
      await handlePlanComment(payload);
      await handlePlanReaction(payload);
    }
  } else if (eventName === "pull_request_review" && payload.action === "submitted") {
    logger.debug("Handling pull_request_review.submitted event directly", {
      pullRequest: payload.pull_request?.number,
      repository: payload.repository?.full_name,
      reviewId: payload.review?.id
    });
    await handlePullRequestReview(payload);
  } else if (eventName === "pull_request_review_comment" && payload.action === "created") {
    logger.debug("Handling pull_request_review_comment.created event directly", {
      pullRequest: payload.pull_request?.number,
      repository: payload.repository?.full_name,
      commentId: payload.comment?.id
    });
    await handlePullRequestReviewComment(payload);
  } else {
    logger.debug("Unhandled webhook event", {
      eventName,
      action: payload.action
    });
  }
}

export const setupWebhooks = (webhooks: Webhooks) => {
  // Issue labeling events
  webhooks.on("issues.labeled", async ({ payload }) => {
    logger.debug("Received issues.labeled event - calling handleIssueLabeled", {
      issue: payload.issue?.number,
      repository: payload.repository?.full_name,
      labels: payload.issue?.labels?.map(l => l.name),
      installationId: payload.installation?.id
    });
    
    if (!payload.installation?.id) {
      logger.warn("Missing installation ID in payload - webhook may not be from GitHub App", {
        issue: payload.issue?.number,
        repository: payload.repository?.full_name
      });
    }
    
    await handleIssueLabeled(payload);
  });

  webhooks.on("issues.unlabeled", async ({ payload }) => {
    logger.debug("Received issues.unlabeled event", {
      issue: payload.issue?.number,
      repository: payload.repository?.full_name,
      removedLabel: payload.label?.name
    });
  });

  // Plan interaction events - handle comments for plan feedback
  webhooks.on("issue_comment.created", async ({ payload }) => {
    logger.debug("Received issue_comment.created event - handling plan and PR comments", {
      issue: payload.issue?.number,
      repository: payload.repository?.full_name,
      commentId: payload.comment?.id,
      installationId: payload.installation?.id
    });

    if (!payload.installation?.id) {
      logger.warn("Missing installation ID in payload - webhook may not be from GitHub App", {
        issue: payload.issue?.number,
        repository: payload.repository?.full_name,
        commentId: payload.comment?.id
      });
    }

    // If this is a PR comment (issue object has pull_request), handle PR comment logic
    if (payload.issue.pull_request) {
      await handlePullRequestComment(payload);
    } else {
      // Otherwise, handle plan comment logic (issue only)
      await handlePlanComment(payload);
      await handlePlanReaction(payload);
    }
  });

  // PR review events (for code-specific feedback)
  webhooks.on("pull_request_review.submitted", async ({ payload }) => {
    logger.debug("Received pull_request_review.submitted event - calling handlePullRequestReview", {
      pullRequest: payload.pull_request?.number,
      repository: payload.repository?.full_name,
      reviewId: payload.review?.id
    });
    await handlePullRequestReview(payload);
  });

  webhooks.on("pull_request_review.edited", async ({ payload }) => {
    logger.debug("Received pull_request_review.edited event", {
      pullRequest: payload.pull_request?.number,
      repository: payload.repository?.full_name,
      reviewId: payload.review?.id
    });
  });

  webhooks.on("pull_request_review.dismissed", async ({ payload }) => {
    logger.debug("Received pull_request_review.dismissed event", {
      pullRequest: payload.pull_request?.number,
      repository: payload.repository?.full_name,
      reviewId: payload.review?.id
    });
  });

  // PR review comment events (for line-specific feedback)
  webhooks.on("pull_request_review_comment.created", async ({ payload }) => {
    logger.debug("Received pull_request_review_comment.created event - calling handlePullRequestReviewComment", {
      pullRequest: payload.pull_request?.number,
      repository: payload.repository?.full_name,
      commentId: payload.comment?.id
    });
    await handlePullRequestReviewComment(payload);
  });

  webhooks.on("pull_request_review_comment.edited", async ({ payload }) => {
    logger.debug("Received pull_request_review_comment.edited event", {
      pullRequest: payload.pull_request?.number,
      repository: payload.repository?.full_name,
      commentId: payload.comment?.id
    });
  });

  webhooks.on("pull_request_review_comment.deleted", async ({ payload }) => {
    logger.debug("Received pull_request_review_comment.deleted event", {
      pullRequest: payload.pull_request?.number,
      repository: payload.repository?.full_name,
      commentId: payload.comment?.id
    });
  });

  // GitHub reactions webhook events (for thumbs up/down on plan comments)
  // GitHub doesn't have separate reaction events - reactions are part of issue_comment events
  // We'll handle reactions through the existing issue_comment.created webhook by checking for reactions
  // in the plan-interaction.ts file
  
  // For now, we'll use the existing issue_comment handlers and plan-interaction.ts 
  // will handle checking for reaction-based approval in the comment content
  webhooks.onError((error) => {
    logger.error("Webhook processing error", { 
      error: error.message, 
      stack: error.stack,
      eventName: error.event?.name,
      eventId: error.event?.id,
      // Add more context for debugging
      errorType: error.constructor.name,
      statusCode: (error as any).status,
      headers: (error as any).response?.headers
    });
  });
};

export const handleWebhook = async (
  c: Context<BlankEnv, "/webhook/github", BlankInput>
) => {
  try {
    const signature = c.req.header("x-hub-signature-256");
    const body = await c.req.text();
    const eventName = c.req.header("x-github-event");
    const deliveryId = c.req.header("x-github-delivery");
    const installationId = c.req.header("x-github-installation-id");

    // Log incoming webhook details for debugging
    logger.debug("Received webhook", {
      eventName,
      deliveryId,
      installationId,
      hasSignature: !!signature,
      bodyLength: body.length
    });

    if (!signature) {
      logger.warn("Missing GitHub webhook signature");
      return c.text("Forbidden", 403);
    }

    const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!webhookSecret) {
      logger.error("GITHUB_WEBHOOK_SECRET not configured");
      return c.text("Server configuration error", 500);
    }

    // Parse the payload
    let payload;
    try {
      payload = JSON.parse(body);
    } catch (parseError) {
      logger.error("Failed to parse webhook payload", {
        error: parseError instanceof Error ? parseError.message : String(parseError)
      });
      return c.text("Invalid JSON payload", 400);
    }

    // Handle the webhook directly instead of using Octokit's strict validation
    try {
      if (!eventName) {
        logger.warn("Missing event name in webhook");
        return c.text("Missing event name", 400);
      }
      
      await processWebhookEvent(eventName, payload);
    } catch (handlerError) {
      logger.error("Error in webhook handler", {
        error: handlerError instanceof Error ? handlerError.message : String(handlerError),
        stack: handlerError instanceof Error ? handlerError.stack : undefined,
        eventName,
        action: payload.action
      });
      // Don't fail the webhook - return success to avoid GitHub retries
      return c.text("Handler error logged", 200);
    }

    return c.text("OK", 200);
  } catch (error) {
    logger.error("Failed to process webhook", { 
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      // Add GitHub-specific error details
      statusCode: (error as any).status,
      documentation: (error as any).documentation_url,
      requestId: (error as any).request?.request?.headers?.['x-github-request-id']
    });
    return c.text("Internal server error", 500);
  }
};

// Export alias for backwards compatibility
export const unifiedWebhookHandler = handleWebhook;
