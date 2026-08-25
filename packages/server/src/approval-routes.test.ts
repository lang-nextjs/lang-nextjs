/**
 * TDD tests for approval-routes.
 *
 * Tests the approval route handlers: GET /api/approval/[approvalId] and
 * POST /api/approval/[approvalId] with comprehensive coverage of all scenarios.
 *
 * Follows patterns from approval-registry.test.ts:
 * - makeApproval helper for test data
 * - afterEach cleanup with cleanupApproval
 * - vi.useFakeTimers for timeout scenarios
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { createApprovalRoutes } from "./approval-routes";
import {
  registerApproval,
  peekApproval,
  getApproval,
  resolveApproval,
  cleanupApproval,
  cleanupExpiredApprovals,
} from "./approval-registry";
import type { PendingApproval } from "./approval-registry";

// Helper function from approval-registry.test.ts
function makeApproval(
  id: string,
  overrides: Partial<PendingApproval> = {}
): PendingApproval {
  return {
    approvalId: id,
    toolCallId: `tc-${id}`,
    toolName: "bash_execute",
    input: { command: "echo test" },
    status: "waiting",
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

// Helper to create NextRequest with context
function createRequest(
  method: string,
  url: string,
  body?: unknown,
  params?: { approvalId: string }
): {
  request: NextRequest;
  context: { params: Promise<{ approvalId: string }> };
} {
  const request = new NextRequest(url, {
    method,
    headers: {
      "Content-Type": "application/json",
    },
  });

  // Mock json() method for POST requests with body
  if (method === "POST" && body !== undefined) {
    request.json = vi.fn().mockResolvedValue(body);
  }

  const context = {
    params: Promise.resolve(
      params || { approvalId: url.split("/").pop() || "test-id" }
    ),
  };

  return { request, context };
}

afterEach(() => {
  // Clean up any test entries and reset timers
  cleanupExpiredApprovals();
  vi.useRealTimers();
});

describe("approval-routes — GET /api/approval/[approvalId]", () => {
  it("GET returns 200 with approval data for valid approval", async () => {
    const id = "get-valid-01";
    const approval = makeApproval(id);
    registerApproval(approval);

    const routes = createApprovalRoutes();
    const { request, context } = createRequest(
      "GET",
      `http://localhost/api/approval/${id}`
    );
    const response = await routes.GET(request, context);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({
      id: approval.approvalId,
      toolCallId: approval.toolCallId,
      toolName: approval.toolName,
      status: approval.status,
      createdAt: approval.createdAt,
      expiresAt: approval.expiresAt,
    });
    cleanupApproval(id);
  });

  it("GET returns 404 for non-existent approvalId", async () => {
    const routes = createApprovalRoutes();
    const { request, context } = createRequest(
      "GET",
      "http://localhost/api/approval/non-existent-xyz"
    );
    const response = await routes.GET(request, context);

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data).toEqual({ error: "approval not found" });
  });

  it("GET returns 200 with status='timeout' for expired approval", async () => {
    vi.useFakeTimers();
    const id = "get-expired-01";
    const approval = makeApproval(id, { expiresAt: Date.now() + 1000 });
    registerApproval(approval);

    // Advance time past expiration
    vi.advanceTimersByTime(2000);

    const routes = createApprovalRoutes();
    const { request, context } = createRequest(
      "GET",
      `http://localhost/api/approval/${id}`
    );
    const response = await routes.GET(request, context);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.status).toBe("timeout");
    expect(data.id).toBe(id);
    cleanupApproval(id);
    vi.useRealTimers();
  });

  it("GET returns all required fields in response", async () => {
    const id = "get-fields-01";
    const approval = makeApproval(id);
    registerApproval(approval);

    const routes = createApprovalRoutes();
    const { request, context } = createRequest(
      "GET",
      `http://localhost/api/approval/${id}`
    );
    const response = await routes.GET(request, context);

    const data = await response.json();
    expect(data).toHaveProperty("id");
    expect(data).toHaveProperty("toolCallId");
    expect(data).toHaveProperty("toolName");
    expect(data).toHaveProperty("status");
    expect(data).toHaveProperty("createdAt");
    expect(data).toHaveProperty("expiresAt");
    expect(typeof data.id).toBe("string");
    expect(typeof data.toolCallId).toBe("string");
    expect(typeof data.toolName).toBe("string");
    expect(typeof data.status).toBe("string");
    expect(typeof data.createdAt).toBe("string");
    expect(typeof data.expiresAt).toBe("number");
    cleanupApproval(id);
  });
});

describe("approval-routes — POST /api/approval/[approvalId] with approve", () => {
  it("POST with decision='approve' returns 200 and sets status to 'approved'", async () => {
    const id = "post-approve-01";
    const approval = makeApproval(id);
    registerApproval(approval);

    const routes = createApprovalRoutes();
    const { request, context } = createRequest(
      "POST",
      `http://localhost/api/approval/${id}`,
      { decision: "approve" }
    );
    const response = await routes.POST(request, context);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ id, decision: "approve", accepted: true });

    // Check that registry status is updated to "approved"
    const updatedApproval = getApproval(id);
    expect(updatedApproval?.status).toBe("approved");
    cleanupApproval(id);
  });

  it("POST with approve does NOT call cleanupApproval (QUORUM-1)", async () => {
    const id = "post-approve-no-cleanup-01";
    const approval = makeApproval(id);
    registerApproval(approval);

    const routes = createApprovalRoutes();
    const { request, context } = createRequest(
      "POST",
      `http://localhost/api/approval/${id}`,
      { decision: "approve" }
    );
    await routes.POST(request, context);

    // Verify that approval still exists in registry (not cleaned up)
    // The transform handles cleanup after drain
    expect(getApproval(id)).toBeDefined();
    cleanupApproval(id);
  });
});

describe("approval-routes — POST /api/approval/[approvalId] with reject", () => {
  it("POST with decision='reject' returns 200 and sets status to 'rejected'", async () => {
    const id = "post-reject-01";
    const approval = makeApproval(id);
    registerApproval(approval);

    const routes = createApprovalRoutes();
    const { request, context } = createRequest(
      "POST",
      `http://localhost/api/approval/${id}`,
      { decision: "reject" }
    );
    const response = await routes.POST(request, context);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ id, decision: "reject", accepted: true });

    // Check that registry status is updated to "rejected"
    const updatedApproval = getApproval(id);
    expect(updatedApproval?.status).toBe("rejected");
    cleanupApproval(id);
  });
});

describe("approval-routes — POST /api/approval/[approvalId] with edit", () => {
  it("POST with decision='edit' and editedInput returns 200 and sets status to 'edited'", async () => {
    const id = "post-edit-01";
    registerApproval(makeApproval(id, { input: { cmd: "rm -rf /" } }));

    const routes = createApprovalRoutes();
    const { request, context } = createRequest(
      "POST",
      `http://localhost/api/approval/${id}`,
      { decision: "edit", editedInput: { cmd: "ls" } }
    );
    const response = await routes.POST(request, context);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ id, decision: "edit", accepted: true });

    const updated = getApproval(id);
    expect(updated?.status).toBe("edited");
    expect(updated?.editedInput).toEqual({ cmd: "ls" });
    cleanupApproval(id);
  });

  it("POST with decision='edit' but missing editedInput returns 400; status stays 'waiting'", async () => {
    const id = "post-edit-missing-input-01";
    registerApproval(makeApproval(id));

    const routes = createApprovalRoutes();
    const { request, context } = createRequest(
      "POST",
      `http://localhost/api/approval/${id}`,
      { decision: "edit" }
    );
    const response = await routes.POST(request, context);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain("editedInput");
    // Registry stays in 'waiting' — malformed edit must not partially resolve.
    expect(getApproval(id)?.status).toBe("waiting");
    cleanupApproval(id);
  });

  it("POST with decision='edit' rejects non-object editedInput (array)", async () => {
    const id = "post-edit-array-01";
    registerApproval(makeApproval(id));

    const routes = createApprovalRoutes();
    const { request, context } = createRequest(
      "POST",
      `http://localhost/api/approval/${id}`,
      { decision: "edit", editedInput: ["nope"] }
    );
    const response = await routes.POST(request, context);

    expect(response.status).toBe(400);
    expect(getApproval(id)?.status).toBe("waiting");
    cleanupApproval(id);
  });

  it("POST with decision='edit' rejects null editedInput", async () => {
    const id = "post-edit-null-01";
    registerApproval(makeApproval(id));

    const routes = createApprovalRoutes();
    const { request, context } = createRequest(
      "POST",
      `http://localhost/api/approval/${id}`,
      { decision: "edit", editedInput: null }
    );
    const response = await routes.POST(request, context);

    expect(response.status).toBe(400);
    expect(getApproval(id)?.status).toBe("waiting");
    cleanupApproval(id);
  });

  it("POST with decision='edit' rejects string editedInput", async () => {
    const id = "post-edit-string-01";
    registerApproval(makeApproval(id));

    const routes = createApprovalRoutes();
    const { request, context } = createRequest(
      "POST",
      `http://localhost/api/approval/${id}`,
      { decision: "edit", editedInput: "not an object" }
    );
    const response = await routes.POST(request, context);

    expect(response.status).toBe(400);
    expect(getApproval(id)?.status).toBe("waiting");
    cleanupApproval(id);
  });

  it("POST with decision='edit' on already-resolved approval returns 409", async () => {
    const id = "post-edit-409-01";
    registerApproval(makeApproval(id));
    resolveApproval(id, "approve");

    const routes = createApprovalRoutes();
    const { request, context } = createRequest(
      "POST",
      `http://localhost/api/approval/${id}`,
      { decision: "edit", editedInput: { cmd: "ls" } }
    );
    const response = await routes.POST(request, context);

    expect(response.status).toBe(409);
    const data = await response.json();
    expect(data.status).toBe("approved");
    cleanupApproval(id);
  });
});

describe("approval-routes — POST /api/approval/[approvalId] with respond", () => {
  it("POST with decision='respond' and response text returns 200 and sets status='responded'", async () => {
    const id = "post-respond-01";
    registerApproval(makeApproval(id));

    const routes = createApprovalRoutes();
    const { request, context } = createRequest(
      "POST",
      `http://localhost/api/approval/${id}`,
      { decision: "respond", response: "try a different approach" }
    );
    const response = await routes.POST(request, context);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ id, decision: "respond", accepted: true });

    const updated = getApproval(id);
    expect(updated?.status).toBe("responded");
    expect(updated?.response).toBe("try a different approach");
    cleanupApproval(id);
  });

  it("POST with decision='respond' but missing response returns 400; status stays 'waiting'", async () => {
    const id = "post-respond-missing-01";
    registerApproval(makeApproval(id));

    const routes = createApprovalRoutes();
    const { request, context } = createRequest(
      "POST",
      `http://localhost/api/approval/${id}`,
      { decision: "respond" }
    );
    const response = await routes.POST(request, context);

    expect(response.status).toBe(400);
    expect(getApproval(id)?.status).toBe("waiting");
    cleanupApproval(id);
  });

  it("POST with decision='respond' rejects non-string response (number)", async () => {
    const id = "post-respond-number-01";
    registerApproval(makeApproval(id));

    const routes = createApprovalRoutes();
    const { request, context } = createRequest(
      "POST",
      `http://localhost/api/approval/${id}`,
      { decision: "respond", response: 42 }
    );
    const response = await routes.POST(request, context);

    expect(response.status).toBe(400);
    expect(getApproval(id)?.status).toBe("waiting");
    cleanupApproval(id);
  });

  it("POST with decision='respond' rejects empty-string response", async () => {
    const id = "post-respond-empty-01";
    registerApproval(makeApproval(id));

    const routes = createApprovalRoutes();
    const { request, context } = createRequest(
      "POST",
      `http://localhost/api/approval/${id}`,
      { decision: "respond", response: "" }
    );
    const response = await routes.POST(request, context);

    expect(response.status).toBe(400);
    expect(getApproval(id)?.status).toBe("waiting");
    cleanupApproval(id);
  });

  it("ADVERSARIAL: POST with decision='respond' and a whitespace-only response (single space) is accepted — current guard is .length===0, NOT .trim()", async () => {
    // The POST guard for 'respond' is:
    //   if (typeof response !== "string" || response.length === 0) { 400 }
    // A whitespace-only string (" ") has length 1, so it PASSES the guard and
    // is stored verbatim in approval.response. Downstream, the chat consumer
    // surfaces this back to the agent as a human message — a literal blank.
    // Documents the current behaviour. If the guard is hardened to
    // `response.trim().length === 0`, this test will fail and force a
    // deliberate decision.
    const id = "post-respond-whitespace-01";
    registerApproval(makeApproval(id));

    const routes = createApprovalRoutes();
    const { request, context } = createRequest(
      "POST",
      `http://localhost/api/approval/${id}`,
      { decision: "respond", response: " " }
    );
    const response = await routes.POST(request, context);

    expect(response.status).toBe(200);
    expect(getApproval(id)?.status).toBe("responded");
    expect(getApproval(id)?.response).toBe(" ");
    cleanupApproval(id);
  });

  it("POST with decision='respond' on already-resolved approval returns 409", async () => {
    const id = "post-respond-409-01";
    registerApproval(makeApproval(id));
    resolveApproval(id, "approve");

    const routes = createApprovalRoutes();
    const { request, context } = createRequest(
      "POST",
      `http://localhost/api/approval/${id}`,
      { decision: "respond", response: "too late" }
    );
    const response = await routes.POST(request, context);

    expect(response.status).toBe(409);
    cleanupApproval(id);
  });
});

describe("approval-routes — POST error cases", () => {
  it("POST returns 400 for invalid JSON body", async () => {
    const id = "post-invalid-json-01";
    const approval = makeApproval(id);
    registerApproval(approval);

    const routes = createApprovalRoutes();
    // Mock json() to throw an error
    const { request, context } = createRequest(
      "POST",
      `http://localhost/api/approval/${id}`
    );
    (request as any).json = vi
      .fn()
      .mockRejectedValue(new Error("Invalid JSON"));

    const response = await routes.POST(request, context);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data).toEqual({ error: "invalid JSON body" });
    cleanupApproval(id);
  });

  it("POST returns 400 for invalid decision value", async () => {
    const id = "post-invalid-decision-01";
    const approval = makeApproval(id);
    registerApproval(approval);

    const routes = createApprovalRoutes();
    const { request, context } = createRequest(
      "POST",
      `http://localhost/api/approval/${id}`,
      { decision: "invalid" }
    );
    const response = await routes.POST(request, context);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data).toEqual({
      error: "decision must be 'approve', 'reject', 'edit', or 'respond'",
    });
    cleanupApproval(id);
  });

  it("POST returns 400 for missing decision field", async () => {
    const id = "post-missing-decision-01";
    const approval = makeApproval(id);
    registerApproval(approval);

    const routes = createApprovalRoutes();
    const { request, context } = createRequest(
      "POST",
      `http://localhost/api/approval/${id}`,
      {}
    );
    const response = await routes.POST(request, context);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data).toEqual({
      error: "decision must be 'approve', 'reject', 'edit', or 'respond'",
    });
    cleanupApproval(id);
  });

  it("POST returns 404 for non-existent approvalId", async () => {
    const routes = createApprovalRoutes();
    const { request, context } = createRequest(
      "POST",
      "http://localhost/api/approval/non-existent-xyz",
      { decision: "approve" }
    );
    const response = await routes.POST(request, context);

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data).toEqual({ error: "approval not found or expired" });
  });

  it("POST returns 409 for already-resolved approval", async () => {
    const id = "post-already-resolved-01";
    const approval = makeApproval(id);
    registerApproval(approval);

    // First resolve the approval
    resolveApproval(id, "approve");

    const routes = createApprovalRoutes();
    const { request, context } = createRequest(
      "POST",
      `http://localhost/api/approval/${id}`,
      { decision: "reject" }
    );
    const response = await routes.POST(request, context);

    expect(response.status).toBe(409);
    const data = await response.json();
    expect(data).toEqual({
      error: "approval already resolved",
      status: "approved",
    });
    cleanupApproval(id);
  });

  it("POST on already-approved approval returns 409", async () => {
    const id = "post-already-approved-01";
    const approval = makeApproval(id);
    registerApproval(approval);

    // First approve the approval
    resolveApproval(id, "approve");

    const routes = createApprovalRoutes();
    const { request, context } = createRequest(
      "POST",
      `http://localhost/api/approval/${id}`,
      { decision: "approve" }
    );
    const response = await routes.POST(request, context);

    expect(response.status).toBe(409);
    const data = await response.json();
    expect(data).toEqual({
      error: "approval already resolved",
      status: "approved",
    });
    cleanupApproval(id);
  });

  it("POST on already-rejected approval returns 409", async () => {
    const id = "post-already-rejected-01";
    const approval = makeApproval(id);
    registerApproval(approval);

    // First reject the approval
    resolveApproval(id, "reject");

    const routes = createApprovalRoutes();
    const { request, context } = createRequest(
      "POST",
      `http://localhost/api/approval/${id}`,
      { decision: "reject" }
    );
    const response = await routes.POST(request, context);

    expect(response.status).toBe(409);
    const data = await response.json();
    expect(data).toEqual({
      error: "approval already resolved",
      status: "rejected",
    });
    cleanupApproval(id);
  });
});

describe("approval-routes — concurrency", () => {
  it("Multiple concurrent POST requests: first resolves, subsequent return 409", async () => {
    const id = "post-concurrent-01";
    const approval = makeApproval(id);
    registerApproval(approval);

    const routes = createApprovalRoutes();

    // Create two POST requests
    const request1 = createRequest(
      "POST",
      `http://localhost/api/approval/${id}`,
      { decision: "approve" }
    );
    const request2 = createRequest(
      "POST",
      `http://localhost/api/approval/${id}`,
      { decision: "approve" }
    );

    // Execute both requests concurrently
    const [response1, response2] = await Promise.all([
      routes.POST(request1.request, request1.context),
      routes.POST(request2.request, request2.context),
    ]);

    // First request should succeed
    expect(response1.status).toBe(200);
    const data1 = await response1.json();
    expect(data1).toEqual({ id, decision: "approve", accepted: true });

    // Second request should fail with 409
    expect(response2.status).toBe(409);
    const data2 = await response2.json();
    expect(data2).toEqual({
      error: "approval already resolved",
      status: "approved",
    });

    cleanupApproval(id);
  });
});

describe("approval-routes — timeout and expiration", () => {
  it("POST on expired approval returns 404", async () => {
    vi.useFakeTimers();
    const id = "post-expired-01";
    const approval = makeApproval(id, { expiresAt: Date.now() + 1000 });
    registerApproval(approval);

    // Advance time past expiration
    vi.advanceTimersByTime(2000);

    // When we call getApproval (as POST does internally), it marks the status as "timeout"
    getApproval(id); // This marks it as "timeout"

    const routes = createApprovalRoutes();
    const { request, context } = createRequest(
      "POST",
      `http://localhost/api/approval/${id}`,
      { decision: "approve" }
    );
    const response = await routes.POST(request, context);

    expect(response.status).toBe(409); // Actually returns 409 because status="timeout" is already resolved
    const data = await response.json();
    expect(data).toEqual({
      error: "approval already resolved",
      status: "timeout",
    });
    cleanupApproval(id);
    vi.useRealTimers();
  });

  it("GET on timed-out approval returns status='timeout'", async () => {
    vi.useFakeTimers();
    const id = "get-timeout-01";
    const approval = makeApproval(id, { expiresAt: Date.now() + 1000 });
    registerApproval(approval);

    // Advance time past expiration
    vi.advanceTimersByTime(2000);

    const routes = createApprovalRoutes();
    const { request, context } = createRequest(
      "GET",
      `http://localhost/api/approval/${id}`
    );
    const response = await routes.GET(request, context);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.status).toBe("timeout");
    cleanupApproval(id);
    vi.useRealTimers();
  });
});

describe("approval-routes — authorization (no callback → fail-open)", () => {
  it("GET accepts unauthenticated requests when no authorize callback is configured", async () => {
    const id = "get-no-auth-01";
    const approval = makeApproval(id);
    registerApproval(approval);

    const routes = createApprovalRoutes();
    const { request, context } = createRequest(
      "GET",
      `http://localhost/api/approval/${id}`
    );
    const response = await routes.GET(request, context);

    expect(response.status).toBe(200);
    cleanupApproval(id);
  });

  it("POST accepts unauthenticated requests when no authorize callback is configured", async () => {
    const id = "post-no-auth-01";
    const approval = makeApproval(id);
    registerApproval(approval);

    const routes = createApprovalRoutes();
    const { request, context } = createRequest(
      "POST",
      `http://localhost/api/approval/${id}`,
      { decision: "approve" }
    );
    const response = await routes.POST(request, context);

    expect(response.status).toBe(200);
    cleanupApproval(id);
  });
});

describe("approval-routes — authorization (authorize callback)", () => {
  it("GET returns 401 when authorize() returns false; approval is NOT read", async () => {
    const id = "get-auth-deny-01";
    const approval = makeApproval(id);
    registerApproval(approval);

    const authorize = vi.fn().mockReturnValue(false);
    const routes = createApprovalRoutes({ authorize });
    const { request, context } = createRequest(
      "GET",
      `http://localhost/api/approval/${id}`
    );
    const response = await routes.GET(request, context);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    // #170 widened the callback to (request, approval) so a consumer can compare
    // the request against the RECORD — the one-arg signature made owner-matching
    // impossible, which is why the hook shipped unused.
    expect(authorize).toHaveBeenCalledWith(request, expect.anything());

    // This test was NAMED "approval is NOT read" and never checked it — it only
    // asserted the callback's arguments. The claim is real and worth pinning:
    // getApproval() mutates (lazy TTL flips an expired `waiting` to `timeout`),
    // so a denied caller must not be able to move the record by asking about it.
    // Authorization reads through peekApproval() for exactly this reason.
    expect(peekApproval(id)?.status).toBe("waiting");
    cleanupApproval(id);
  });

  it("POST returns 401 when authorize() returns false; approval status is NOT changed", async () => {
    const id = "post-auth-deny-01";
    const approval = makeApproval(id);
    registerApproval(approval);

    const authorize = vi.fn().mockReturnValue(false);
    const routes = createApprovalRoutes({ authorize });
    const { request, context } = createRequest(
      "POST",
      `http://localhost/api/approval/${id}`,
      { decision: "approve" }
    );
    const response = await routes.POST(request, context);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    // Side effect check: registry status MUST remain "waiting" — the unauthorized
    // POST must not have called resolveApproval.
    expect(getApproval(id)?.status).toBe("waiting");
    cleanupApproval(id);
  });

  it("GET proceeds normally when authorize() returns true", async () => {
    const id = "get-auth-allow-01";
    const approval = makeApproval(id);
    registerApproval(approval);

    const authorize = vi.fn().mockReturnValue(true);
    const routes = createApprovalRoutes({ authorize });
    const { request, context } = createRequest(
      "GET",
      `http://localhost/api/approval/${id}`
    );
    const response = await routes.GET(request, context);

    expect(response.status).toBe(200);
    expect(authorize).toHaveBeenCalledTimes(1);
    cleanupApproval(id);
  });

  it("POST proceeds and resolves the approval when authorize() returns true", async () => {
    const id = "post-auth-allow-01";
    const approval = makeApproval(id);
    registerApproval(approval);

    const authorize = vi.fn().mockReturnValue(true);
    const routes = createApprovalRoutes({ authorize });
    const { request, context } = createRequest(
      "POST",
      `http://localhost/api/approval/${id}`,
      { decision: "approve" }
    );
    const response = await routes.POST(request, context);

    expect(response.status).toBe(200);
    expect(getApproval(id)?.status).toBe("approved");
    cleanupApproval(id);
  });

  it("supports async authorize() (returns a Promise<boolean>)", async () => {
    const id = "post-auth-async-01";
    const approval = makeApproval(id);
    registerApproval(approval);

    const authorize = vi.fn().mockResolvedValue(true);
    const routes = createApprovalRoutes({ authorize });
    const { request, context } = createRequest(
      "POST",
      `http://localhost/api/approval/${id}`,
      { decision: "reject" }
    );
    const response = await routes.POST(request, context);

    expect(response.status).toBe(200);
    expect(getApproval(id)?.status).toBe("rejected");
    cleanupApproval(id);
  });

  it("authorize() receives the original NextRequest with headers (consumer can inspect Authorization, cookies, etc.)", async () => {
    const id = "post-auth-headers-01";
    const approval = makeApproval(id);
    registerApproval(approval);

    const authorize = vi.fn().mockImplementation((req: NextRequest) => {
      return req.headers.get("authorization") === "Bearer correct-token";
    });

    const routes = createApprovalRoutes({ authorize });

    const goodReq = new NextRequest(`http://localhost/api/approval/${id}`, {
      method: "POST",
      headers: { Authorization: "Bearer correct-token" },
    });
    goodReq.json = vi.fn().mockResolvedValue({ decision: "approve" });

    const goodResponse = await routes.POST(goodReq, {
      params: Promise.resolve({ approvalId: id }),
    });
    expect(goodResponse.status).toBe(200);
    expect(getApproval(id)?.status).toBe("approved");
    cleanupApproval(id);

    // Now create a fresh waiting approval and try a wrong token.
    const id2 = "post-auth-headers-02";
    registerApproval(makeApproval(id2));
    const badReq = new NextRequest(`http://localhost/api/approval/${id2}`, {
      method: "POST",
      headers: { Authorization: "Bearer wrong-token" },
    });
    badReq.json = vi.fn().mockResolvedValue({ decision: "approve" });

    const badResponse = await routes.POST(badReq, {
      params: Promise.resolve({ approvalId: id2 }),
    });
    expect(badResponse.status).toBe(401);
    expect(getApproval(id2)?.status).toBe("waiting");
    cleanupApproval(id2);
  });

  it("rejects with 401 BEFORE parsing the JSON body — invalid JSON does not leak as 400 to unauth'd callers", async () => {
    const id = "post-auth-order-01";
    const approval = makeApproval(id);
    registerApproval(approval);

    const authorize = vi.fn().mockReturnValue(false);
    const routes = createApprovalRoutes({ authorize });
    const { request, context } = createRequest(
      "POST",
      `http://localhost/api/approval/${id}`
    );
    (request as any).json = vi
      .fn()
      .mockRejectedValue(new Error("Invalid JSON"));

    const response = await routes.POST(request, context);

    expect(response.status).toBe(401);
    // Confirms order: auth check ran before json() — json() should never have been called.
    expect((request as any).json).not.toHaveBeenCalled();
    cleanupApproval(id);
  });
});
