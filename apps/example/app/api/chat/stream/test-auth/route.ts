import { getCookieToken } from "@deepagents-nextjs/server";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/**
 * TEST-ONLY: Echoes the Authorization token getCookieToken would inject.
 * Not a real proxy — used by E2E tests to verify cookie → Bearer token flow.
 *
 * Usage: POST /api/chat/stream/test-auth with a 'session' cookie set.
 * Returns: { authorization: 'Bearer <token>' } or { authorization: null }
 */
export async function POST(request: NextRequest): Promise<Response> {
  const getToken = getCookieToken("session");
  const token = getToken(request);
  return Response.json({ authorization: token ? `Bearer ${token}` : null });
}
