import type { NextRequest } from "next/server";

/**
 * Returns a getToken-compatible function that reads a cookie from NextRequest synchronously.
 *
 * Uses NextRequest.cookies.get() — the synchronous Web API for Route Handlers.
 * Do NOT use the async global cookies() from 'next/headers' here: it is only
 * available in Server Components and throws in Route Handlers.
 *
 * Behavior (fail-open per CONTEXT.md locked decision):
 * - Cookie present:  returns cookie value → handler injects as Bearer token
 * - Cookie absent:   returns undefined → handler sends no Authorization header
 *
 * @param cookieName - The cookie name to read (e.g., 'session', 'auth_token')
 */
export function getCookieToken(
  cookieName: string
): (req: NextRequest) => string | undefined {
  return (req: NextRequest) => {
    return req.cookies.get(cookieName)?.value ?? undefined;
  };
}
