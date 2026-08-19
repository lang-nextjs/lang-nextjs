import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { middleware } from "./middleware";

const ENV = { ...process.env };

// getLimiter() is a process-wide singleton with no reset hook, so its bucket
// persists across tests. Each test uses a distinct IP rather than sharing one —
// otherwise earlier requests would poison later assertions.
let ipCounter = 0;
function req(path: string, init?: { auth?: string; method?: string; ip?: string }) {
  const headers = new Headers({
    "x-forwarded-for": init?.ip ?? `203.0.113.${(ipCounter++ % 250) + 1}`,
  });
  if (init?.auth) headers.set("authorization", init.auth);
  return new Request(`https://example.com${path}`, {
    method: init?.method ?? "GET",
    headers,
  }) as unknown as Parameters<typeof middleware>[0];
}

beforeEach(() => {
  delete process.env.OPEN_SWE_SANDBOX_TOKEN;
  vi.stubEnv("NODE_ENV", "development");
});
afterEach(() => {
  process.env = { ...ENV };
  vi.unstubAllEnvs();
});

describe("middleware — sandbox auth", () => {
  // The whole point of the guard: an unconfigured production deploy must not
  // serve an unauthenticated exec surface.
  it("404s sandbox routes in production when no token is configured", () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = middleware(req("/api/open-swe/sandbox/health"));
    expect(res.status).toBe(404);
  });

  it("stays open in development when no token is configured (local dev + CI)", () => {
    const res = middleware(req("/api/open-swe/sandbox/health"));
    expect(res.status).toBe(200);
  });

  it("401s a missing Authorization header once a token is configured", () => {
    process.env.OPEN_SWE_SANDBOX_TOKEN = "s3cret-token";
    const res = middleware(req("/api/open-swe/sandbox/health"));
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
  });

  it("401s a wrong token", () => {
    process.env.OPEN_SWE_SANDBOX_TOKEN = "s3cret-token";
    const res = middleware(
      req("/api/open-swe/sandbox/health", { auth: "Bearer wrong-token" })
    );
    expect(res.status).toBe(401);
  });

  it("401s a correct token sent without the Bearer scheme", () => {
    process.env.OPEN_SWE_SANDBOX_TOKEN = "s3cret-token";
    const res = middleware(
      req("/api/open-swe/sandbox/health", { auth: "s3cret-token" })
    );
    expect(res.status).toBe(401);
  });

  it("allows a correct Bearer token", () => {
    process.env.OPEN_SWE_SANDBOX_TOKEN = "s3cret-token";
    const res = middleware(
      req("/api/open-swe/sandbox/health", { auth: "Bearer s3cret-token" })
    );
    expect(res.status).toBe(200);
  });

  it("enforces auth in development too, once a token is configured", () => {
    // The dev bypass is for UNCONFIGURED installs only. Configuring a token and
    // then having it ignored locally would be worse than no token at all.
    process.env.OPEN_SWE_SANDBOX_TOKEN = "s3cret-token";
    const res = middleware(req("/api/open-swe/sandbox/exec"));
    expect(res.status).toBe(401);
  });

  it("guards every sandbox route, not just health", () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const p of [
      "/api/open-swe/sandbox/health",
      "/api/open-swe/sandbox/capacity",
      "/api/open-swe/sandbox/workspaces",
      "/api/open-swe/sandbox/workspaces/ws-1",
      "/api/open-swe/sandbox/workspaces/ws-1/exec",
    ]) {
      expect(middleware(req(p, { method: "POST" })).status, p).toBe(404);
    }
  });

  it("treats a whitespace-only token as unconfigured (fail closed in prod)", () => {
    // A blank env var from a bad ConfigMap must not silently disable auth.
    vi.stubEnv("NODE_ENV", "production");
    process.env.OPEN_SWE_SANDBOX_TOKEN = "   ";
    expect(middleware(req("/api/open-swe/sandbox/health")).status).toBe(404);
  });
});

describe("middleware — non-sandbox routes keep rate limiting", () => {
  it("does not require the sandbox token on /runs", () => {
    process.env.OPEN_SWE_SANDBOX_TOKEN = "s3cret-token";
    const res = middleware(req("/api/open-swe/runs"));
    expect(res.status).toBe(200);
  });

  it("still rate-limits /runs POST past the strict cap", () => {
    // One fixed IP so the STRICT bucket (10/min) actually fills.
    const ip = "198.51.100.42";
    const statuses = Array.from(
      { length: 12 },
      () => middleware(req("/api/open-swe/runs", { method: "POST", ip })).status
    );
    expect(statuses).toContain(429);
  });
});
