import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

export interface DeepAgentsMcpOptions {
  apiUrl: string;
  apiKey: string;
}


export function createDeepAgentsMcpServer(options: DeepAgentsMcpOptions) {
  const { apiUrl, apiKey } = options;

  const server = new McpServer({
    name: "deepagents",
    version: "0.1.0",
  });

  // Normalize once so callers don't produce double-slash URLs when apiUrl has a trailing slash.
  const normalizedApiUrl = apiUrl.replace(/\/+$/, "");

  async function backendRequest(path: string, init?: RequestInit) {
    const url = `${normalizedApiUrl}${path}`;
    // Only add Authorization when apiKey is non-empty — an empty apiKey produces
    // `Bearer ` which the Web Headers API trims to `Bearer` (no token), guaranteed 401.
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    if (init?.headers) {
      // Caller-supplied headers (Record<string, string>) override our
      // defaults so consumers can swap content-type if needed.
      Object.assign(headers, init.headers as Record<string, string>);
    }
    const res = await fetch(url, {
      ...init,
      headers,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`backend ${res.status}: ${body}`);
    }
    return res;
  }

  server.tool(
    "chat",
    "Send a chat message to the DeepAgents backend and receive the streaming SSE response as text",
    { message: z.string().describe("The user message to send") },
    async ({ message }) => {
      const res = await backendRequest("/api/chat/stream", {
        method: "POST",
        body: JSON.stringify({ message }),
      });

      const text = await res.text();

      const lines = text
        .split("\n")
        .filter((l: string) => l.startsWith("data:"))
        .map((l: string) => {
          try {
            return JSON.parse(l.slice(5).trim());
          } catch {
            return l.slice(5).trim();
          }
        });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(lines, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "list_api_keys",
    "List all API keys in the system",
    {},
    async () => {
      const res = await backendRequest("/api/keys");
      const data = (await res.json()) as {
        keys: Array<Record<string, unknown>>;
      };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(data.keys, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "generate_api_key",
    "Generate a new API key",
    { name: z.string().optional().describe("Human-readable name for the key") },
    async ({ name }) => {
      const res = await backendRequest("/api/keys", {
        method: "POST",
        body: JSON.stringify({ name: name ?? "mcp-generated" }),
      });
      const data = (await res.json()) as Record<string, unknown>;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "revoke_api_key",
    "Revoke an API key by its ID",
    { keyId: z.string().describe("The key ID to revoke") },
    async ({ keyId }) => {
      if (!keyId?.trim()) {
        throw new Error("keyId is required");
      }
      const res = await backendRequest(`/api/keys/${keyId}`, {
        method: "DELETE",
      });
      const data = (await res.json()) as Record<string, unknown>;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "health",
    "Check if the DeepAgents backend is reachable and the API key is valid",
    {},
    async () => {
      try {
        const res = await backendRequest("/api/keys");
        return {
          content: [
            {
              type: "text" as const,
              text: `OK — backend reachable, API key valid (status ${res.status})`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `ERROR — ${
                err instanceof Error ? err.message : String(err)
              }`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "trigger_task",
    "Trigger a new open-swe coding task. Returns immediately with the run_id — does not wait for the run to complete.",
    {
      task: z
        .string()
        .describe(
          "The coding task description (e.g., 'Fix the login button width on mobile')"
        ),
    },
    async ({ task }) => {
      if (!task?.trim()) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Task is required and cannot be empty or whitespace",
            },
          ],
          isError: true,
        };
      }

      try {
        const res = await backendRequest("/api/open-swe/runs", {
          method: "POST",
          body: JSON.stringify({ task: task.trim() }),
        });
        const run = (await res.json()) as {
          run_id: string;
          status: string;
          created_at: string;
          task: string;
        };
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(run, null, 2) },
          ],
        };
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          return {
            content: [{ type: "text" as const, text: "timeout" }],
            isError: true,
          };
        }
        throw err;
      }
    }
  );

  server.tool(
    "list_runs",
    "List all open-swe runs with their current status, creation time, and task description.",
    {},
    async () => {
      try {
        const res = await backendRequest("/api/open-swe/runs", {
          method: "GET",
        });
        const runs = (await res.json()) as Array<{
          run_id: string;
          status: string;
          created_at: string;
          task: string;
        }>;
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(runs, null, 2) },
          ],
        };
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          return {
            content: [{ type: "text" as const, text: "Request timed out" }],
            isError: true,
          };
        }
        throw err;
      }
    }
  );

  server.tool(
    "get_run_status",
    "Retrieve the current status and latest output snapshot of a specific run. Use this to check run progress without a polling loop.",
    {
      runId: z.string().describe("The run ID to inspect"),
    },
    async ({ runId }) => {
      if (!runId?.trim()) {
        return {
          content: [
            {
              type: "text" as const,
              text: "runId is required and cannot be empty or whitespace",
            },
          ],
          isError: true,
        };
      }

      try {
        const res = await backendRequest(
          `/api/open-swe/runs/${encodeURIComponent(runId.trim())}`,
          { method: "GET" }
        );
        const run = (await res.json()) as {
          run_id: string;
          status: string;
          created_at: string;
          task: string;
        };
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(run, null, 2) },
          ],
        };
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          return {
            content: [{ type: "text" as const, text: "timeout" }],
            isError: true,
          };
        }
        throw err;
      }
    }
  );

  server.tool(
    "cancel_run",
    "Request cancellation of an active run. Returns the updated run status after the cancellation request.",
    {
      runId: z.string().describe("The run ID to cancel"),
    },
    async ({ runId }) => {
      if (!runId?.trim()) {
        return {
          content: [
            {
              type: "text" as const,
              text: "runId is required and cannot be empty or whitespace",
            },
          ],
          isError: true,
        };
      }

      try {
        const res = await backendRequest(
          `/api/open-swe/runs/${encodeURIComponent(runId.trim())}/cancel`,
          { method: "POST" }
        );
        const run = (await res.json()) as {
          run_id: string;
          status: string;
          created_at: string;
          task: string;
        };
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(run, null, 2) },
          ],
        };
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          return {
            content: [{ type: "text" as const, text: "timeout" }],
            isError: true,
          };
        }
        throw err;
      }
    }
  );

  return server;
}

export { McpServer };
