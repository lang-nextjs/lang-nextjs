import { NextRequest, NextResponse } from "next/server";
import { getLimiter, extractIp, STRICT, STANDARD } from "./lib/rate-limit";

export const config = {
  matcher: "/api/open-swe/:path*",
};

/**
 * Constant-time string compare.
 *
 * `===` on a secret short-circuits at the first differing byte, which leaks the
 * token a character at a time to anyone who can measure response latency. Edge
 * middleware has no `crypto.timingSafeEqual` (Node-only), so this compares every
 * byte unconditionally. Length is still observable — unavoidable, and harmless
 * for a fixed-length token.
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function middleware(request: NextRequest): Response {
  const ip = extractIp(request);
  const pathname = new URL(request.url).pathname;

  // Sandbox endpoints (/api/open-swe/sandbox/*) run arbitrary shell commands in
  // a workspace. They are rate-limit-exempt because the same 60/min bucket as
  // the run routes makes the E2E sandbox suite flake (CI repro: SANDBOX-07's
  // capacity GET 429'd after earlier tests filled the bucket) — but an exec
  // surface needs auth, not rate limiting, and it had neither.
  //
  // OPEN_SWE_SANDBOX_TOKEN set  -> require `Authorization: Bearer <token>`.
  // unset, and NOT production   -> open. Local dev and CI keep working.
  // unset, and production       -> 404. The routes do not exist.
  //
  // The unset+production branch is the point: this is fail-closed. An
  // unconfigured deploy serves nothing rather than serving an unauthenticated
  // shell. Defaulting to open would make "not configured" indistinguishable
  // from "working", which is exactly how a deploy ends up handing out exec.
  if (pathname.startsWith("/api/open-swe/sandbox/")) {
    const token = process.env.OPEN_SWE_SANDBOX_TOKEN?.trim();

    if (!token) {
      if (process.env.NODE_ENV === "production") {
        // 404, not 401: an unconfigured deploy should not advertise that a
        // sandbox surface is here and merely locked.
        return new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      return NextResponse.next();
    }

    const header = request.headers.get("authorization") ?? "";
    const prefix = "Bearer ";
    const presented = header.startsWith(prefix)
      ? header.slice(prefix.length)
      : "";
    if (!safeEqual(presented, token)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "WWW-Authenticate": "Bearer",
        },
      });
    }
    return NextResponse.next();
  }

  const isStrict =
    request.method === "POST" && pathname === "/api/open-swe/runs";
  const config = isStrict ? STRICT : STANDARD;
  const limiter = getLimiter();

  const result = limiter.check(ip, config);
  if (!result.allowed) {
    const retryAfterSec = Math.ceil(result.retryAfterMs / 1000);
    return new Response(
      JSON.stringify({
        error: "Too many requests",
        retryAfter: retryAfterSec,
      }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(retryAfterSec),
        },
      }
    );
  }

  return NextResponse.next();
}
