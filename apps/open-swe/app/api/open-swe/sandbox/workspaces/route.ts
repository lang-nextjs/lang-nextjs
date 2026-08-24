import { NextRequest } from "next/server";
import {
  getSandbox,
  sandboxErrorToResponse,
  SandboxConfig,
} from "../../../../../lib/sandbox";
import { parseJsonBody } from "../../../../../lib/body-parser";

export const dynamic = "force-dynamic";

/** Reject a body field that is present but the wrong type. */
function badField(field: string): Response {
  return Response.json(
    { error: `Invalid '${field}' field` },
    { status: 422 }
  );
}

/**
 * POST /api/open-swe/sandbox/workspaces
 *
 * Body (all optional): { image?, label?, memoryLimitMb?, cpuLimit?,
 *                        execTimeoutMs?, env? }
 * Returns: 201 SandboxWorkspace
 * Errors:  422 invalid field · 429 at capacity · 502 Docker unavailable
 */
export async function POST(request: NextRequest): Promise<Response> {
  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = (parsed.data ?? {}) as Record<string, unknown>;

  const config: SandboxConfig = {};

  if (body.image !== undefined) {
    if (typeof body.image !== "string" || body.image.trim() === "")
      return badField("image");
    config.image = body.image;
  }
  if (body.label !== undefined) {
    if (typeof body.label !== "string") return badField("label");
    config.label = body.label;
  }
  for (const field of [
    "memoryLimitMb",
    "cpuLimit",
    "execTimeoutMs",
  ] as const) {
    if (body[field] !== undefined) {
      const n = body[field];
      if (typeof n !== "number" || !Number.isFinite(n) || n <= 0)
        return badField(field);
      config[field] = n;
    }
  }
  if (body.env !== undefined) {
    if (
      typeof body.env !== "object" ||
      body.env === null ||
      Array.isArray(body.env) ||
      !Object.values(body.env).every((v) => typeof v === "string")
    )
      return badField("env");
    config.env = body.env as Record<string, string>;
  }

  try {
    const workspace = await getSandbox().create(config);
    return Response.json(workspace, { status: 201 });
  } catch (err) {
    return sandboxErrorToResponse(err);
  }
}

/**
 * GET /api/open-swe/sandbox/workspaces
 *
 * Returns: 200 SandboxWorkspace[] — every workspace the sandbox currently holds.
 *          The body is a plain array; it is unchanged by the header below.
 * Headers: `X-Sandbox-List-Incomplete: <n>` — present ONLY when the provider had to skip
 *          n unparseable records. Its absence means the listing is complete. A consumer
 *          doing anything destructive with this list MUST check it; see the `list()` doc
 *          on the `Sandbox` interface.
 * Errors:  502 listing unreadable · 503 provider unreachable
 *
 * This handler was the only sandbox route without a try/catch — a throw escaped as an
 * unhandled 500 with no `code` field, unlike its three siblings (POST above,
 * capacity/route.ts, health/route.ts) which all map through sandboxErrorToResponse.
 */
export async function GET(_request: NextRequest): Promise<Response> {
  try {
    const workspaces = await getSandbox().list();

    // JSON.stringify ignores non-index properties on an array, so droppedCount does not
    // leak into the body — the response shape is exactly what it was before.
    const headers: Record<string, string> = {};
    if (workspaces.droppedCount > 0) {
      headers["X-Sandbox-List-Incomplete"] = String(workspaces.droppedCount);
    }

    return Response.json(workspaces, { status: 200, headers });
  } catch (err) {
    return sandboxErrorToResponse(err);
  }
}
