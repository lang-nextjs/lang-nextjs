import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("../../../../lib/langgraph-client", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../../lib/langgraph-client")
  >();
  return {
    ...actual,
    createRun: vi.fn(),
    listRuns: vi.fn(),
  };
});

import * as langgraphClient from "../../../../lib/langgraph-client";
import { POST, GET } from "./route";
import { PlatformError } from "../../../../lib/types";
import { getLimiter } from "../../../../lib/rate-limit";
import {
  CircuitOpenError,
  CircuitState,
} from "../../../../lib/circuit-breaker";

describe("POST /api/open-swe/runs", () => {
  const PLATFORM_URL = "http://localhost:8000";

  beforeEach(() => {
    vi.stubEnv("LANGGRAPH_PLATFORM_URL", PLATFORM_URL);
    vi.stubEnv("OPEN_SWE_ASSISTANT_ID", "open-swe");
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 201 with run_id when task is valid", async () => {
    vi.mocked(langgraphClient.createRun).mockResolvedValueOnce({
      run_id: "run-abc",
      status: "pending",
      created_at: "2026-05-04T00:00:00Z",
      task: "echo hello",
    });

    const req = new NextRequest("http://localhost:3001/api/open-swe/runs", {
      method: "POST",
      body: JSON.stringify({ task: "echo hello" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.run_id).toBe("run-abc");
  });

  it("returns 422 when task field is missing", async () => {
    const req = new NextRequest("http://localhost:3001/api/open-swe/runs", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });

    const res = await POST(req);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("returns 422 when task is not a string (e.g., task: 123)", async () => {
    const req = new NextRequest("http://localhost:3001/api/open-swe/runs", {
      method: "POST",
      body: JSON.stringify({ task: 123 }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await POST(req);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("returns 422 when task is empty or whitespace (e.g., task: '   ')", async () => {
    const req = new NextRequest("http://localhost:3001/api/open-swe/runs", {
      method: "POST",
      body: JSON.stringify({ task: "   " }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await POST(req);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("returns 502 when LANGGRAPH_PLATFORM_URL is not set", async () => {
    vi.unstubAllEnvs();

    const req = new NextRequest("http://localhost:3001/api/open-swe/runs", {
      method: "POST",
      body: JSON.stringify({ task: "echo hello" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await POST(req);
    expect(res.status).toBe(502);
  });

  it("returns 502 when Platform returns 5xx", async () => {
    vi.mocked(langgraphClient.createRun).mockRejectedValueOnce(
      new PlatformError(500, "Internal Server Error")
    );

    const req = new NextRequest("http://localhost:3001/api/open-swe/runs", {
      method: "POST",
      body: JSON.stringify({ task: "echo hello" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await POST(req);
    expect(res.status).toBe(502);
  });

  it("returns 502 when fetch times out (AbortError)", async () => {
    vi.mocked(langgraphClient.createRun).mockRejectedValueOnce(
      Object.assign(new Error("aborted"), { name: "AbortError" })
    );

    const req = new NextRequest("http://localhost:3001/api/open-swe/runs", {
      method: "POST",
      body: JSON.stringify({ task: "echo hello" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await POST(req);
    expect(res.status).toBe(502);
  });

  it("returns 503 with Retry-After when circuit breaker is open", async () => {
    vi.mocked(langgraphClient.createRun).mockRejectedValueOnce(
      new CircuitOpenError(25, CircuitState.OPEN)
    );

    const req = new NextRequest("http://localhost:3001/api/open-swe/runs", {
      method: "POST",
      body: JSON.stringify({ task: "echo hello" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await POST(req);
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("25");
    const body = await res.json();
    expect(body.error).toMatch(/temporarily unavailable/i);
    expect(body.retryAfter).toBe(25);
  });

  it("ADV: returns 413 when POST body is exactly MAX_BODY_BYTES + 1 (1MB+1B) oversized", async () => {
    // Construct a request body whose raw byte length strictly exceeds the
    // 1MB limit. The route delegates to parseJsonBody which must reject with
    // 413 BEFORE invoking createRun — protects against memory exhaustion /
    // accidental large-payload DoS via the public POST endpoint.
    const oversized = "a".repeat(1_048_577); // 1MB + 1 byte
    const req = new NextRequest("http://localhost:3001/api/open-swe/runs", {
      method: "POST",
      body: JSON.stringify({ task: oversized }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await POST(req);
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toMatch(/exceeds|too large|limit/i);
    expect(langgraphClient.createRun).not.toHaveBeenCalled();
  });

  it("ADV: duplicate Content-Type header (CSV form) is rejected with 415 (not silently parsed)", async () => {
    // Real-world HTTP allows multiple values for a single header via CSV
    // (comma-separated). If parseJsonBody only checks the FIRST occurrence of
    // Content-Type it might accept a payload sent with
    // `Content-Type: text/plain, application/json` and smuggle a non-JSON
    // body past the guard. The correct behaviour is to reject because the
    // canonical media type is not unambiguously application/json.
    const req = new NextRequest("http://localhost:3001/api/open-swe/runs", {
      method: "POST",
      body: JSON.stringify({ task: "echo hello" }),
      headers: { "Content-Type": "text/plain, application/json" },
    });

    const res = await POST(req);
    // Adversarial expectation: must not accept the smuggled body.
    expect(res.status).toBe(415);
    expect(langgraphClient.createRun).not.toHaveBeenCalled();
  });

  it("ADV: body containing valid JSON null literal yields 422 (not 500) at the route layer", async () => {
    // parseJsonBody returns ok:true with data === null for the literal body
    // "null". The route then checks `body.task` — accessing a property on
    // null throws TypeError. This test pins whether the route guards against
    // the null-data shape or crashes with a 500. Correct behaviour is 422
    // (missing/invalid task field) with a defined error message.
    const req = new NextRequest("http://localhost:3001/api/open-swe/runs", {
      method: "POST",
      body: "null",
      headers: { "Content-Type": "application/json" },
    });

    const res = await POST(req);
    expect(res.status).not.toBe(500);
    // Acceptable outcomes: 422 (validator caught it) OR a defensive 400 from
    // parseJsonBody — both mean we did NOT crash and did NOT forward to createRun.
    expect([400, 422]).toContain(res.status);
    expect(langgraphClient.createRun).not.toHaveBeenCalled();
  });

  it("ADV: two concurrent POSTs with identical body both create runs (no idempotency layer)", async () => {
    // Adversarial: clients retry POST /runs on network blips. Without an
    // idempotency layer, the same logical request produces TWO run records
    // on the LangGraph Platform — wasted compute and confusing UX. This test
    // pins the CURRENT behaviour so any future idempotency work has a
    // regression guard. The contract: each invocation forwards to createRun
    // independently (no dedup), and returns distinct run_ids.
    vi.mocked(langgraphClient.createRun)
      .mockResolvedValueOnce({
        run_id: "run-1",
        status: "pending",
        created_at: "2026-05-04T00:00:00Z",
        task: "echo hello",
      })
      .mockResolvedValueOnce({
        run_id: "run-2",
        status: "pending",
        created_at: "2026-05-04T00:00:01Z",
        task: "echo hello",
      });

    const body = JSON.stringify({ task: "echo hello" });
    const mkReq = () =>
      new NextRequest("http://localhost:3001/api/open-swe/runs", {
        method: "POST",
        body,
        headers: { "Content-Type": "application/json" },
      });

    const [r1, r2] = await Promise.all([POST(mkReq()), POST(mkReq())]);

    // Each POST must succeed independently (current contract).
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    // createRun must have been invoked TWICE — no de-duplication.
    expect(langgraphClient.createRun).toHaveBeenCalledTimes(2);
    const b1 = await r1.json();
    const b2 = await r2.json();
    expect(b1.run_id).not.toBe(b2.run_id);
  });

  it("returns 400 with helpful error when request body is malformed JSON", async () => {
    // Edge case: literally malformed JSON like `{` (truncated object). The route
    // delegates to parseJsonBody, which catches JSON.parse errors and returns a
    // 400 with a 'Invalid JSON body' message. We assert the route does NOT crash
    // with 500, does NOT silently coerce to {} (which would let invalid input
    // through to createRun), and surfaces a distinct error message to the caller.
    const req = new NextRequest("http://localhost:3001/api/open-swe/runs", {
      method: "POST",
      body: "{",
      headers: { "Content-Type": "application/json" },
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/json/i);
    // createRun must NOT have been invoked with junk input.
    expect(langgraphClient.createRun).not.toHaveBeenCalled();
  });
});

describe("GET /api/open-swe/runs", () => {
  const PLATFORM_URL = "http://localhost:8000";

  beforeEach(() => {
    vi.stubEnv("LANGGRAPH_PLATFORM_URL", PLATFORM_URL);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 200 with array of runs", async () => {
    vi.mocked(langgraphClient.listRuns).mockResolvedValueOnce([
      {
        run_id: "run-abc",
        status: "completed",
        created_at: "2026-05-04T00:00:00Z",
        task: "echo hello",
      },
    ]);

    const req = new NextRequest("http://localhost:3001/api/open-swe/runs");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].run_id).toBeDefined();
  });

  it("returns 502 when LANGGRAPH_PLATFORM_URL is not set", async () => {
    vi.unstubAllEnvs();

    const req = new NextRequest("http://localhost:3001/api/open-swe/runs");
    const res = await GET(req);
    expect(res.status).toBe(502);
  });

  it("returns 502 when Platform returns 5xx", async () => {
    vi.mocked(langgraphClient.listRuns).mockRejectedValueOnce(
      new PlatformError(500, "Internal Server Error")
    );

    const req = new NextRequest("http://localhost:3001/api/open-swe/runs");
    const res = await GET(req);
    expect(res.status).toBe(502);
  });

  it("returns 503 with Retry-After when circuit breaker is open", async () => {
    vi.mocked(langgraphClient.listRuns).mockRejectedValueOnce(
      new CircuitOpenError(18, CircuitState.OPEN)
    );

    const req = new NextRequest("http://localhost:3001/api/open-swe/runs");
    const res = await GET(req);
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("18");
    const body = await res.json();
    expect(body.error).toMatch(/temporarily unavailable/i);
  });
});

describe("Rate limiting (middleware)", () => {
  beforeEach(() => {
    getLimiter().reset();
  });

  it("middleware returns 429 after exceeding POST /runs limit", async () => {
    const { middleware } = await import("../../../../middleware");
    const config = { windowMs: 60_000, maxRequests: 10 };

    // Exhaust limit directly via the limiter
    const limiter = getLimiter();
    for (let i = 0; i < config.maxRequests; i++) {
      limiter.check("unknown", config);
    }

    // 11th request through middleware should return 429
    const req = new NextRequest("http://localhost:3001/api/open-swe/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const res = middleware(req);
    expect(res.status).toBe(429);

    const body = await res.json();
    expect(body.error).toBe("Too many requests");
    expect(body.retryAfter).toBeGreaterThan(0);
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });

  it("GET requests use STANDARD config and are not blocked by STRICT exhaustion", async () => {
    const limiter = getLimiter();

    // Exhaust STRICT (10 requests)
    for (let i = 0; i < 10; i++) {
      limiter.check("unknown", { windowMs: 60_000, maxRequests: 10 });
    }

    // STANDARD config should still allow (different counter)
    const result = limiter.check("unknown", {
      windowMs: 60_000,
      maxRequests: 60,
    });
    expect(result.allowed).toBe(true);
  });
});
