import { NextRequest, NextResponse } from "next/server";
import { getLimiter, extractIp, STRICT, STANDARD } from "./lib/rate-limit";

export const config = {
  matcher: "/api/open-swe/:path*",
};

export function middleware(request: NextRequest): Response {
  const ip = extractIp(request);
  const pathname = new URL(request.url).pathname;

  // Sandbox endpoints (/api/open-swe/sandbox/*) are workspace management
  // for the local dev dashboard — never exposed to end users in
  // production. Applying the same 60/min limit as the run-creation
  // routes makes the E2E sandbox suite flake reliably on the last few
  // tests (CI repro: SANDBOX-07 capacity GET returned 429 after the
  // earlier sandbox tests filled the bucket). Skip rate-limiting for
  // them. If sandbox endpoints ever get exposed to untrusted users,
  // they need a different protection layer (auth) anyway, not rate-
  // limiting alone.
  if (pathname.startsWith("/api/open-swe/sandbox/")) {
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
