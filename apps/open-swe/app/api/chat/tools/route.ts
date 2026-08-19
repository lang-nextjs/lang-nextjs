import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/chat/tools?aiBackend=&topology=
 *
 * Proxies the FastAPI backend's tools introspection (/api/tools/{ai_backend})
 * so the chat can show the agent's live tools + configured MCP servers.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const baseUrl = process.env.FASTAPI_URL;
  if (!baseUrl) {
    return Response.json({ tools: [], mcps: [] }, { status: 200 });
  }
  // FASTAPI_URL is the chat-stream base (…/api/chat/stream); the tools endpoint
  // is a sibling under the same host root.
  const root = baseUrl.replace(/\/api\/chat\/stream\/?$/, "");
  const aiBackend = request.nextUrl.searchParams.get("aiBackend") ?? "deepagents";
  const topology = request.nextUrl.searchParams.get("topology") ?? "react";

  try {
    const resp = await fetch(
      `${root}/api/tools/${encodeURIComponent(aiBackend)}?topology=${encodeURIComponent(topology)}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!resp.ok) return Response.json({ tools: [], mcps: [] }, { status: 200 });
    return Response.json(await resp.json());
  } catch {
    return Response.json({ tools: [], mcps: [] }, { status: 200 });
  }
}
