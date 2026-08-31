# @deepagents-nextjs/mcp

MCP (Model Context Protocol) server exposing the DeepAgents chat, API-key and open-swe run tools to any MCP client.

## Installation

Workspace-internal — it is not published to npm. Depend on it as a workspace link:

```bash
pnpm add '@deepagents-nextjs/mcp@workspace:*' --filter <your-package>
```

## Quick Start

```typescript
import { createDeepAgentsMcpServer } from "@deepagents-nextjs/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = createDeepAgentsMcpServer({
  apiUrl: process.env.DEEPAGENTS_API_URL!,
  apiKey: process.env.DEEPAGENTS_API_KEY!,
});

await server.connect(new StdioServerTransport());
```

**The factory returns an UNCONNECTED server.** It registers the tools and hands the server back; choosing and attaching a transport is the caller's job, because the same tool set is served over stdio by a desktop client and over HTTP by a hosted one. A Quick Start that omitted the `connect` call would look complete and do nothing.

## API Reference

### `createDeepAgentsMcpServer(options)`

| Option   | Type     | Default      | Description                                                                                                                                                                                                     |
| -------- | -------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiUrl` | `string` | **required** | Base URL of the DeepAgents backend. A trailing slash is normalised away, so `http://host/` and `http://host` behave identically.                                                                                |
| `apiKey` | `string` | **required** | Sent as `Authorization: Bearer <key>`. **An empty string sends no header at all** — `Bearer ` is trimmed by the Headers API to a token-less `Bearer`, which is a guaranteed 401 that reads like a server fault. |

Returns an `McpServer` (re-exported from this package for convenience) with the tools below registered.

### Tools

| Tool               | Arguments | What it does                                                                                                 |
| ------------------ | --------- | ------------------------------------------------------------------------------------------------------------ |
| `chat`             | `message` | POSTs to `/api/chat/stream` and returns the SSE `data:` lines, JSON-parsed where possible                    |
| `health`           | —         | Confirms the backend is reachable **and** the API key is accepted, by calling `/api/keys`                    |
| `list_api_keys`    | —         | `GET /api/keys`                                                                                              |
| `generate_api_key` | `name?`   | `POST /api/keys`, defaulting the name to `mcp-generated`                                                     |
| `revoke_api_key`   | `keyId`   | `DELETE /api/keys/{keyId}`                                                                                   |
| `trigger_task`     | `task`    | `POST /api/open-swe/runs`. **Returns immediately with the run id — it does not wait for the run to finish.** |
| `list_runs`        | —         | `GET /api/open-swe/runs`                                                                                     |
| `get_run_status`   | `runId`   | Current status and latest output for one run, so a client can check progress without a polling loop          |
| `cancel_run`       | `runId`   | Requests cancellation and returns the updated run                                                            |

Backend responses that are not `2xx` raise `backend <status>: <body>` rather than returning an empty result, so a failure is not mistaken for an empty list.

## Compatibility

- `@modelcontextprotocol/sdk` 1.29+
- Node.js 18+ (the tools use global `fetch`)
