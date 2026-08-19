import { NextRequest } from "next/server";
import {
  getSandbox,
  sandboxErrorToResponse,
} from "../../../../../../lib/sandbox";

export const dynamic = "force-dynamic";

/**
 * GET /api/open-swe/sandbox/workspaces/[workspaceId]
 *
 * Returns: 200 SandboxWorkspace · 404 when the id is unknown.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
): Promise<Response> {
  const { workspaceId } = await params;
  const workspace = await getSandbox().get(workspaceId);
  if (!workspace) {
    return Response.json(
      { error: `workspace ${workspaceId} not found` },
      { status: 404 }
    );
  }
  return Response.json(workspace, { status: 200 });
}

/**
 * DELETE /api/open-swe/sandbox/workspaces/[workspaceId]
 *
 * Tears the workspace container down.
 * Returns: 204 on success · 404 unknown id · 502 when `docker rm` fails.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
): Promise<Response> {
  const { workspaceId } = await params;
  try {
    await getSandbox().destroy(workspaceId);
    return new Response(null, { status: 204 });
  } catch (err) {
    return sandboxErrorToResponse(err);
  }
}
