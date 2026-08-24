import { WebhookHandlerBase } from "./webhook-handler-base.js";
import {
  getOpenSWEAutoAcceptLabel,
  getOpenSWELabel,
  getOpenSWEMaxLabel,
  getOpenSWEMaxAutoAcceptLabel,
} from "../../utils/github/label.js";
import { RequestSource } from "../../constants.js";
import { GraphConfig } from "@openswe/shared/open-swe/types";
import { dynamoRunStore, DynamoDBRunStore, RunStatus } from "../../utils/dynamodb.js";
import { MANAGER_GRAPH_ID } from "@openswe/shared/constants";

class IssueWebhookHandler extends WebhookHandlerBase {
  constructor() {
    super("GitHubIssueHandler");
  }

  async handleIssueLabeled(payload: any) {
    if (!process.env.SECRETS_ENCRYPTION_KEY) {
      throw new Error(
        "SECRETS_ENCRYPTION_KEY environment variable is required",
      );
    }

    const validOpenSWELabels = [
      getOpenSWELabel(),
      getOpenSWEAutoAcceptLabel(),
      getOpenSWEMaxLabel(),
      getOpenSWEMaxAutoAcceptLabel(),
    ];

    if (
      !payload.label?.name ||
      !validOpenSWELabels.some((l) => l === payload.label?.name)
    ) {
      return;
    }

    const isAutoAcceptLabel =
      payload.label.name === getOpenSWEAutoAcceptLabel() ||
      payload.label.name === getOpenSWEMaxAutoAcceptLabel();

    const isMaxLabel =
      payload.label.name === getOpenSWEMaxLabel() ||
      payload.label.name === getOpenSWEMaxAutoAcceptLabel();

    this.logger.info(
      `'${payload.label.name}' label added to issue #${payload.issue.number}`,
      {
        isAutoAcceptLabel,
        isMaxLabel,
      },
    );

    let context: any = null;
    let issueKey: string | undefined;
    try {
      context = await this.setupWebhookContext(payload);
      if (!context) {
        return;
      }

      const issueData = {
        issueNumber: payload.issue.number,
        issueTitle: payload.issue.title,
        issueBody: payload.issue.body || "",
      };

      // Create issue key for DynamoDB early
      issueKey = DynamoDBRunStore.createIssueKey(
        context.owner,
        context.repo,
        issueData.issueNumber
      );

      // Check if this issue has already been processed (use DynamoDB as a lock)
      const existingRun = await dynamoRunStore.getRunMetadata(issueKey);
      if (existingRun) {
        this.logger.info("Issue already processed, skipping duplicate processing", {
          issueKey,
          existingRunId: existingRun.runId,
          existingThreadId: existingRun.threadId,
          existingStatus: existingRun.status,
          existingCreatedAt: existingRun.createdAt,
        });
        return;
      }

      const runInput = {
        messages: [
          this.createHumanMessage(
            `**${issueData.issueTitle}**\n\n${issueData.issueBody}`,
            RequestSource.GITHUB_ISSUE_WEBHOOK,
            {
              isOriginalIssue: true,
              githubIssueId: issueData.issueNumber,
            },
          ),
        ],
        githubIssueId: issueData.issueNumber,
        targetRepository: {
          owner: context.owner,
          repo: context.repo,
        },
        autoAcceptPlan: isAutoAcceptLabel,
      };

      // Create config object with Claude Opus 4.1 model configuration for max labels
      const configurable: Partial<GraphConfig["configurable"]> = isMaxLabel
        ? {
            plannerModelName: "anthropic:claude-opus-4-1",
            programmerModelName: "anthropic:claude-opus-4-1",
          }
        : {};

      const { runId, threadId } = await this.createRun(context, {
        runInput,
        configurable,
      });

      // Store run metadata in DynamoDB
      await dynamoRunStore.storeRunMetadata({
        issueKey,
        runId,
        threadId,
        graphId: MANAGER_GRAPH_ID,
        assistantId: "open-swe-manager", // Default assistant for issue processing
        status: RunStatus.CREATED,
        owner: context.owner,
        repo: context.repo,
        issueNumber: issueData.issueNumber,
        issueTitle: issueData.issueTitle,
        autoAcceptPlan: isAutoAcceptLabel,
      });

      this.logger.info("Stored run metadata in DynamoDB", {
        issueKey,
        runId,
        threadId,
        status: RunStatus.CREATED,
      });

      await this.createComment(
        context,
        {
          issueNumber: issueData.issueNumber,
          message:
            "🤖 Open SWE has been triggered for this issue. Processing...",
        },
        runId,
        threadId,
      );
    } catch (error) {
      // If we created run metadata but failed later, update status to failed
      if (context && issueKey) {
        try {
          await dynamoRunStore.updateRunStatus(issueKey, RunStatus.FAILED);
        } catch (dbError) {
          this.logger.error("Failed to update run status to failed", dbError);
        }
      }
      this.handleError(error, "issue webhook");
    }
  }
}

const issueHandler = new IssueWebhookHandler();

export async function handleIssueLabeled(payload: any) {
  return issueHandler.handleIssueLabeled(payload);
}
