/**
 * TDD RED tests for approval-registry.
 *
 * Tests the in-memory approval registry: register, get, TTL, resolve, cleanup,
 * stale-approved GC, and concurrent access.
 *
 * This test file is intentionally RED — approval-registry.ts does not exist yet.
 * Plan 02 (GREEN) will create the implementation to make these tests pass.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  registerApproval,
  getApproval,
  resolveApproval,
  cleanupApproval,
  cleanupExpiredApprovals,
} from "./approval-registry";
import type { PendingApproval } from "./approval-registry";

// Helpers
function makeApproval(
  id: string,
  overrides: Partial<PendingApproval> = {}
): PendingApproval {
  return {
    approvalId: id,
    toolCallId: `tc-${id}`,
    toolName: "bash_execute",
    input: { command: "echo hi" },
    status: "waiting",
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

afterEach(() => {
  // Clean up any test entries to isolate tests
  // (We clean by known IDs since we cannot reset the module singleton easily)
  vi.useRealTimers();
});

describe("approval-registry — registerApproval / getApproval", () => {
  it("registerApproval then getApproval returns the same object", () => {
    const id = "reg-get-01";
    const approval = makeApproval(id);
    registerApproval(approval);
    const result = getApproval(id);
    expect(result).toBeDefined();
    expect(result!.approvalId).toBe(id);
    expect(result!.toolName).toBe("bash_execute");
    cleanupApproval(id);
  });

  it("getApproval returns undefined for a non-existent id", () => {
    expect(getApproval("does-not-exist-xyz")).toBeUndefined();
  });

  it("getApproval when expiresAt < Date.now() marks status as 'timeout' and still returns record", () => {
    vi.useFakeTimers();
    const id = "ttl-test-01";
    registerApproval(makeApproval(id, { expiresAt: Date.now() + 1000 }));
    vi.advanceTimersByTime(2000); // expiresAt is now in the past
    const result = getApproval(id);
    expect(result).toBeDefined();
    expect(result!.status).toBe("timeout");
    cleanupApproval(id);
    vi.useRealTimers();
  });
});

describe("approval-registry — resolveApproval", () => {
  it("resolveApproval with 'approve' sets status to 'approved'", () => {
    const id = "resolve-approve-01";
    registerApproval(makeApproval(id));
    resolveApproval(id, "approve");
    const result = getApproval(id);
    expect(result).toBeDefined();
    expect(result!.status).toBe("approved");
    cleanupApproval(id);
  });

  it("resolveApproval with 'reject' sets status to 'rejected'", () => {
    const id = "resolve-reject-01";
    registerApproval(makeApproval(id));
    resolveApproval(id, "reject");
    const result = getApproval(id);
    expect(result).toBeDefined();
    expect(result!.status).toBe("rejected");
    cleanupApproval(id);
  });

  it("resolveApproval on non-existent id is a no-op (does not throw)", () => {
    expect(() => resolveApproval("non-existent-999", "approve")).not.toThrow();
  });

  it("resolveApproval with 'edit' sets status to 'edited' and stores editedInput", () => {
    const id = "resolve-edit-01";
    registerApproval(makeApproval(id, { input: { cmd: "rm -rf /" } }));
    resolveApproval(id, "edit", { editedInput: { cmd: "ls" } });
    const result = getApproval(id);
    expect(result).toBeDefined();
    expect(result!.status).toBe("edited");
    expect(result!.editedInput).toEqual({ cmd: "ls" });
    // Original input is preserved — the transform substitutes editedInput on drain.
    expect(result!.input).toEqual({ cmd: "rm -rf /" });
    cleanupApproval(id);
  });

  it("resolveApproval is idempotent: second call with different decision does not change status", () => {
    const id = "resolve-idempotent-01";
    registerApproval(makeApproval(id));
    resolveApproval(id, "approve");
    resolveApproval(id, "reject");
    expect(getApproval(id)!.status).toBe("approved");
    cleanupApproval(id);
  });

  it("resolveApproval('edit') is also idempotent after a prior approve/reject (no overwrite)", () => {
    const id = "resolve-idempotent-edit-01";
    registerApproval(makeApproval(id));
    resolveApproval(id, "approve");
    resolveApproval(id, "edit", { editedInput: { override: true } });
    const result = getApproval(id)!;
    expect(result.status).toBe("approved");
    expect(result.editedInput).toBeUndefined();
    cleanupApproval(id);
  });

  it("resolveApproval with 'respond' sets status to 'responded' and stores response text", () => {
    const id = "resolve-respond-01";
    registerApproval(makeApproval(id));
    resolveApproval(id, "respond", { response: "use grep instead" });
    const result = getApproval(id)!;
    expect(result.status).toBe("responded");
    expect(result.response).toBe("use grep instead");
    // Tool input is preserved (the action did not execute).
    expect(result.input).toEqual({ command: "echo hi" });
    cleanupApproval(id);
  });

  it("resolveApproval('respond') is idempotent after a prior decision", () => {
    const id = "resolve-respond-idem-01";
    registerApproval(makeApproval(id));
    resolveApproval(id, "reject");
    resolveApproval(id, "respond", { response: "too late" });
    const result = getApproval(id)!;
    expect(result.status).toBe("rejected");
    expect(result.response).toBeUndefined();
    cleanupApproval(id);
  });
});

describe("approval-registry — cleanupApproval", () => {
  it("cleanupApproval makes getApproval return undefined", () => {
    const id = "cleanup-01";
    registerApproval(makeApproval(id));
    expect(getApproval(id)).toBeDefined();
    cleanupApproval(id);
    expect(getApproval(id)).toBeUndefined();
  });
});

describe("approval-registry — cleanupExpiredApprovals", () => {
  it("cleanupExpiredApprovals removes 'waiting' entries past expiresAt + grace", () => {
    vi.useFakeTimers();
    const id = "gc-waiting-01";
    registerApproval(makeApproval(id, { expiresAt: Date.now() + 1000 }));
    vi.advanceTimersByTime(2000);
    // 0 grace: skip the default 30s race-protection window so the test
    // verifies the deletion logic itself, not the grace gating.
    const count = cleanupExpiredApprovals(0);
    expect(count).toBeGreaterThanOrEqual(1);
    expect(getApproval(id)).toBeUndefined();
    vi.useRealTimers();
  });

  it("cleanupExpiredApprovals returns count of removed entries", () => {
    vi.useFakeTimers();
    const id1 = "gc-count-01";
    const id2 = "gc-count-02";
    registerApproval(makeApproval(id1, { expiresAt: Date.now() + 500 }));
    registerApproval(makeApproval(id2, { expiresAt: Date.now() + 500 }));
    vi.advanceTimersByTime(1000);
    const count = cleanupExpiredApprovals(0);
    expect(count).toBeGreaterThanOrEqual(2);
    vi.useRealTimers();
  });

  it("cleanupExpiredApprovals respects the grace period for 'waiting' entries (race protection)", () => {
    // Verifies the bug-fix: a just-expired waiting entry must survive a GC
    // pass run by an unrelated handler within graceMs of expiresAt. This
    // is what was racing the hitl-timeout E2E — a concurrent finally-block
    // cleanup was deleting the in-flight approval before its own handler
    // got to drainRejectOrTimeout.
    vi.useFakeTimers();
    const id = "gc-grace-waiting-01";
    registerApproval(makeApproval(id, { expiresAt: Date.now() + 1000 }));
    vi.advanceTimersByTime(2000); // 1s past expiresAt — inside grace
    const countInsideGrace = cleanupExpiredApprovals(30_000);
    expect(countInsideGrace).toBe(0);
    expect(getApproval(id)).toBeDefined();

    // Advance past the grace; eviction should now fire.
    vi.advanceTimersByTime(31_000);
    const countPastGrace = cleanupExpiredApprovals(30_000);
    expect(countPastGrace).toBeGreaterThanOrEqual(1);
    expect(getApproval(id)).toBeUndefined();
    vi.useRealTimers();
  });

  it("[QUORUM-4] cleanupExpiredApprovals removes stale 'approved' entries (expiresAt < now and status=approved)", () => {
    vi.useFakeTimers();
    const id = "stale-approved-id";
    registerApproval(makeApproval(id, { expiresAt: Date.now() + 1000 }));
    resolveApproval(id, "approve"); // sets status to "approved"
    vi.advanceTimersByTime(2000); // expiresAt is now in the past
    const count = cleanupExpiredApprovals();
    expect(count).toBeGreaterThanOrEqual(1);
    expect(getApproval(id)).toBeUndefined();
    vi.useRealTimers();
  });

  it("cleanupExpiredApprovals removes stale 'edited' entries (the transform may have crashed mid-drain)", () => {
    vi.useFakeTimers();
    const id = "stale-edited-id";
    registerApproval(makeApproval(id, { expiresAt: Date.now() + 1000 }));
    resolveApproval(id, "edit", { editedInput: { cmd: "safe" } });
    vi.advanceTimersByTime(2000);
    const count = cleanupExpiredApprovals();
    expect(count).toBeGreaterThanOrEqual(1);
    expect(getApproval(id)).toBeUndefined();
    vi.useRealTimers();
  });

  it("cleanupExpiredApprovals removes stale 'responded' entries", () => {
    vi.useFakeTimers();
    const id = "stale-responded-id";
    registerApproval(makeApproval(id, { expiresAt: Date.now() + 1000 }));
    resolveApproval(id, "respond", { response: "stop" });
    vi.advanceTimersByTime(2000);
    const count = cleanupExpiredApprovals();
    expect(count).toBeGreaterThanOrEqual(1);
    expect(getApproval(id)).toBeUndefined();
    vi.useRealTimers();
  });

  it("cleanupExpiredApprovals does NOT remove still-fresh entries regardless of status", () => {
    const idWaiting = "fresh-waiting-01";
    const idEdited = "fresh-edited-01";
    const idResponded = "fresh-responded-01";
    registerApproval(
      makeApproval(idWaiting, { expiresAt: Date.now() + 60_000 })
    );
    registerApproval(
      makeApproval(idEdited, { expiresAt: Date.now() + 60_000 })
    );
    registerApproval(
      makeApproval(idResponded, { expiresAt: Date.now() + 60_000 })
    );
    resolveApproval(idEdited, "edit", { editedInput: { ok: true } });
    resolveApproval(idResponded, "respond", { response: "later" });

    cleanupExpiredApprovals();

    expect(getApproval(idWaiting)).toBeDefined();
    expect(getApproval(idEdited)).toBeDefined();
    expect(getApproval(idResponded)).toBeDefined();
    cleanupApproval(idWaiting);
    cleanupApproval(idEdited);
    cleanupApproval(idResponded);
  });
});

describe("approval-registry — concurrent access", () => {
  it("getApproval with expiresAt === Date.now() (boundary) — expired, and does not throw", () => {
    /*
     * THIS ASSERTION WAS REVERSED, DELIBERATELY, AND IT IS THE THIRD OPINION ABOUT THIS
     * INSTANT (#417).
     *
     * It used to require `waiting` at the boundary, and its own comment said why that is not
     * a requirement: "Documenting the implementation's boundary behaviour... If the guard
     * were ever changed to `<=`, this test would catch the regression (the approval would be
     * marked timeout one millisecond too early)." That is a characterization test — it
     * pinned whatever the code did, and its only argument against `<=` was "one millisecond
     * too early", which is a preference rather than a reason.
     *
     * Meanwhile `drainOnClose` read the SAME instant the other way (`remaining <= 0` -> give
     * up), so at exactly `expiresAt` the registry said the operator still had a window and
     * the drain said it did not. Measured with a frozen clock: `approval_pending_at_close`
     * at `expiresAt`, `approval_timeout` at `expiresAt + 1`.
     *
     * INCLUSIVE IS THE CORRECT READING. `expiresAt` is the instant the window CLOSES, not the
     * last instant it is open — the same convention as JWT `exp`, where a token is valid only
     * while the current time is strictly BEFORE it. `approval_pending_at_close` claims the
     * operator still had a decision to make; at `expiresAt` they did not.
     *
     * The guard is now `hasExpired()`, one exported predicate that `drainOnClose` also calls,
     * so the two cannot drift back apart into a strict-versus-inclusive pair.
     */
    vi.useFakeTimers();
    const id = "ttl-boundary-01";
    registerApproval(makeApproval(id, { expiresAt: Date.now() }));
    const result = getApproval(id);
    expect(result).toBeDefined();
    expect(result!.status).toBe("timeout");
    cleanupApproval(id);
    vi.useRealTimers();
  });

  it("getApproval one millisecond BEFORE expiresAt is still waiting", () => {
    // The companion. Without it, "expired at the boundary" is satisfied by a predicate that
    // calls everything expired — and the whole defect was a predicate being wrong by one
    // millisecond in a direction nobody measured.
    vi.useFakeTimers();
    const id = "ttl-boundary-02";
    registerApproval(makeApproval(id, { expiresAt: Date.now() + 1 }));
    expect(getApproval(id)!.status).toBe("waiting");
    cleanupApproval(id);
    vi.useRealTimers();
  });

  it("two registerApproval calls with different IDs are both retrievable independently", () => {
    const idA = "concurrent-a-01";
    const idB = "concurrent-b-01";
    registerApproval(makeApproval(idA, { toolName: "bash_execute" }));
    registerApproval(makeApproval(idB, { toolName: "file_read" }));
    const a = getApproval(idA);
    const b = getApproval(idB);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.toolName).toBe("bash_execute");
    expect(b!.toolName).toBe("file_read");
    cleanupApproval(idA);
    cleanupApproval(idB);
  });
});
