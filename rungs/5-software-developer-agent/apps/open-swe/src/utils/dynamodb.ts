import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { createLogger, LogLevel } from "./logger.js";

const logger = createLogger(LogLevel.INFO, "DynamoDBUtil");

export interface RunMetadata {
  /** Composite key: owner/repo/issueNumber (e.g., "iliazlobin/backstage-app/12") */
  issueKey: string;
  /** LangGraph run ID */
  runId: string;
  /** LangGraph thread ID */
  threadId: string;
  /** Graph ID (manager, planner, programmer) */
  graphId: string;
  /** Parent thread ID (for planner/programmer graphs linking to manager) */
  parentThreadId?: string;
  /** Assistant ID used for the run */
  assistantId: string;
  /** Current status of the run */
  status: RunStatus;
  /** ISO timestamp when the run was created */
  createdAt: string;
  /** ISO timestamp when the run was last updated */
  updatedAt: string;
  /** GitHub repository owner */
  owner: string;
  /** GitHub repository name */
  repo: string;
  /** GitHub issue number */
  issueNumber: number;
  /** Optional: GitHub issue title */
  issueTitle?: string;
  /** Optional: Whether the plan was auto-accepted */
  autoAcceptPlan?: boolean;
}

export enum RunStatus {
  CREATED = "created",
  PLANNING = "planning",
  PLAN_READY = "plan_ready",
  APPROVED = "approved",
  IMPLEMENTING = "implementing",
  COMPLETED = "completed",
  FAILED = "failed",
  INTERRUPTED = "interrupted",
}

export class DynamoDBRunStore {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(tableName: string = "openswe-run-metadata") {
    // Configure DynamoDB client for local development
    const dynamoClient = new DynamoDBClient({
      region: "us-east-1", // Region doesn't matter for local DynamoDB
      endpoint: process.env.DYNAMODB_ENDPOINT || "http://localhost:8000",
      credentials: {
        accessKeyId: "dummy",
        secretAccessKey: "dummy",
      },
    });

    this.client = DynamoDBDocumentClient.from(dynamoClient);
    this.tableName = tableName;
  }

  /**
   * Create composite key from GitHub issue information
   */
  static createIssueKey(owner: string, repo: string, issueNumber: number): string {
    return `${owner}/${repo}/${issueNumber}`;
  }

  /**
   * Parse composite key back into components
   */
  static parseIssueKey(issueKey: string): { owner: string; repo: string; issueNumber: number } {
    const [owner, repo, issueNumberStr] = issueKey.split("/");
    return {
      owner,
      repo,
      issueNumber: parseInt(issueNumberStr, 10),
    };
  }

  /**
   * Store run metadata for a GitHub issue
   */
  async storeRunMetadata(metadata: Omit<RunMetadata, "createdAt" | "updatedAt">): Promise<void> {
    try {
      const now = new Date().toISOString();
      const item: RunMetadata = {
        ...metadata,
        createdAt: now,
        updatedAt: now,
      };

      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: item,
        }),
      );

      logger.info("Stored run metadata", {
        issueKey: item.issueKey,
        runId: item.runId,
        threadId: item.threadId,
        status: item.status,
      });
    } catch (error) {
      logger.error("Failed to store run metadata", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        issueKey: metadata.issueKey,
        tableName: this.tableName,
      });
      throw error;
    }
  }

  /**
   * Retrieve run metadata for a GitHub issue
   */
  async getRunMetadata(issueKey: string): Promise<RunMetadata | null> {
    try {
      const result = await this.client.send(
        new GetCommand({
          TableName: this.tableName,
          Key: { issueKey },
        }),
      );

      if (!result.Item) {
        logger.debug("No run metadata found", { issueKey });
        return null;
      }

      return result.Item as RunMetadata;
    } catch (error) {
      logger.error("Failed to retrieve run metadata", {
        error: error instanceof Error ? error.message : String(error),
        issueKey,
      });
      throw error;
    }
  }

  /**
   * Update run status
   */
  async updateRunStatus(issueKey: string, status: RunStatus): Promise<void> {
    try {
      const now = new Date().toISOString();

      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { issueKey },
          UpdateExpression: "SET #status = :status, updatedAt = :updatedAt",
          ExpressionAttributeNames: {
            "#status": "status",
          },
          ExpressionAttributeValues: {
            ":status": status,
            ":updatedAt": now,
          },
        }),
      );

      logger.info("Updated run status", { issueKey, status });
    } catch (error) {
      logger.error("Failed to update run status", {
        error: error instanceof Error ? error.message : String(error),
        issueKey,
        status,
      });
      throw error;
    }
  }

  /**
   * Get run metadata by repository (useful for listing all runs in a repo)
   */
  async getRunsByRepository(owner: string, repo: string): Promise<RunMetadata[]> {
    try {
      // Since we're using a simple key structure, we'll need to scan and filter
      // In production, you might want to add a GSI for efficient querying by repo
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          FilterExpression: "#owner = :owner AND repo = :repo",
          ExpressionAttributeNames: {
            "#owner": "owner",
          },
          ExpressionAttributeValues: {
            ":owner": owner,
            ":repo": repo,
          },
        }),
      );

      return (result.Items || []) as RunMetadata[];
    } catch (error) {
      logger.error("Failed to query runs by repository", {
        error: error instanceof Error ? error.message : String(error),
        owner,
        repo,
      });
      throw error;
    }
  }

  /**
   * Get the most recent run metadata for a GitHub issue
   * This handles cases where there might be multiple runs for the same issue
   */
  async getLatestRunMetadata(owner: string, repo: string, issueNumber: number): Promise<RunMetadata | null> {
    const issueKey = DynamoDBRunStore.createIssueKey(owner, repo, issueNumber);
    return this.getRunMetadata(issueKey);
  }

  /**
   * Get run metadata by graph ID for a specific issue
   * Useful for finding specific graph metadata (manager, planner, programmer)
   */
  async getRunMetadataByGraphId(owner: string, repo: string, issueNumber: number, graphId: string): Promise<RunMetadata | null> {
    const baseIssueKey = DynamoDBRunStore.createIssueKey(owner, repo, issueNumber);
    
    // For manager graph, use the base issue key
    if (graphId === "manager") {
      return this.getRunMetadata(baseIssueKey);
    }
    
    // For other graphs, try the suffixed key format
    const graphIssueKey = `${baseIssueKey}-${graphId}`;
    return this.getRunMetadata(graphIssueKey);
  }

  /**
   * Get planner metadata for a specific issue
   */
  async getPlannerMetadata(owner: string, repo: string, issueNumber: number): Promise<RunMetadata | null> {
    return this.getRunMetadataByGraphId(owner, repo, issueNumber, "planner");
  }

  /**
   * Get manager metadata for a specific issue  
   */
  async getManagerMetadata(owner: string, repo: string, issueNumber: number): Promise<RunMetadata | null> {
    return this.getRunMetadataByGraphId(owner, repo, issueNumber, "manager");
  }
}

// Export singleton instance
export const dynamoRunStore = new DynamoDBRunStore();
