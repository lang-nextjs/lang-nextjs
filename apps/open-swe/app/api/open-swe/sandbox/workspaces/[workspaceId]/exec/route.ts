import { NextRequest } from "next/server";
import {
  getSandbox,
  sandboxErrorToResponse,
} from "../../../../../../../lib/sandbox";
import { parseJsonBody } from "../../../../../../../lib/body-parser";

export const dynamic = "force-dynamic";

/**
 * POST /api/open-swe/sandbox/workspaces/[workspaceId]/exec
 *
 * Body: { command: string, args?: string[] }
 * Runs the command inside the workspace container.
 *
 * Returns: 200 ToolExecutionResult — note a non-zero `exitCode` is a *tool*
 *          failure and still returns 200; the request itself succeeded.
 * Errors:  422 missing command · 404 unknown workspace · 502 exec failed
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
): Promise<Response> {
  const { workspaceId } = await params;

  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = (parsed.data ?? {}) as { command?: unknown; args?: unknown };

  if (typeof body.command !== "string" || body.command.trim() === "") {
    return Response.json(
      { error: "Missing or invalid 'command' field" },
      { status: 422 }
    );
  }
  if (
    body.args !== undefined &&
    (!Array.isArray(body.args) ||
      !body.args.every((a) => typeof a === "string"))
  ) {
    return Response.json(
      { error: "'args' must be an array of strings" },
      { status: 422 }
    );
  }
  const args = (body.args as string[] | undefined) ?? [];

  try {
    const result = await getSandbox().executeTool(
      workspaceId,
      body.command,
      args
    );
    return Response.json(result, { status: 200 });
  } catch (err) {
    return sandboxErrorToResponse(err);
  }
}
