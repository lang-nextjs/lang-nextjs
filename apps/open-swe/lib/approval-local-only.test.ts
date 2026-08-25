import { describe, it, expect } from "vitest";
import { isLocalOnlyRequest } from "./approval-local-only";
import type { NextRequest } from "next/server";

/**
 * The approval endpoint's guard.
 *
 * These assertions are deliberately about a NARROW guarantee. The mechanism
 * refuses non-loopback hosts and cross-origin requests; it is not
 * authentication and does not separate two people on one machine. The tests say
 * so where it matters, because a test suite that reads broader than the
 * mechanism is how a security claim outgrows what backs it.
 */

function req(headers: Record<string, string>): NextRequest {
  return { headers: new Headers(headers) } as unknown as NextRequest;
}

describe("isLocalOnlyRequest — an explicit refusal, not an inherited fail-open", () => {
  it("allows a same-origin request from loopback", () => {
    expect(
      isLocalOnlyRequest(
        req({ host: "localhost:3001", origin: "http://localhost:3001" })
      )
    ).toBe(true);
    expect(
      isLocalOnlyRequest(
        req({ host: "127.0.0.1:3001", origin: "http://127.0.0.1:3001" })
      )
    ).toBe(true);
  });

  it("allows a loopback request with NO Origin header", () => {
    // Same-origin non-CORS requests and server-side callers legitimately omit
    // Origin. Rejecting them would break the app's own fetch while stopping
    // nothing a browser would send cross-site anyway.
    expect(isLocalOnlyRequest(req({ host: "localhost:3001" }))).toBe(true);
  });

  it("REFUSES a non-loopback host", () => {
    // The endpoint must not be reachable as a service from elsewhere.
    expect(isLocalOnlyRequest(req({ host: "open-swe.example.com" }))).toBe(false);
    expect(isLocalOnlyRequest(req({ host: "10.0.0.5:3001" }))).toBe(false);
  });

  it("REFUSES a cross-origin request even from loopback", () => {
    // A page on the internet must not drive the gate on the user's behalf.
    expect(
      isLocalOnlyRequest(
        req({ host: "localhost:3001", origin: "https://evil.example.com" })
      )
    ).toBe(false);
  });

  it("REFUSES when the Host header is missing entirely", () => {
    // Absence of evidence about where a request came from is not permission —
    // the same three-state discipline applied to a boolean gate.
    expect(isLocalOnlyRequest(req({}))).toBe(false);
  });

  it("is not fooled by a hostname that merely contains a loopback name", () => {
    // `localhost.evil.com` resolves wherever the attacker likes.
    expect(isLocalOnlyRequest(req({ host: "localhost.evil.com" }))).toBe(false);
    expect(isLocalOnlyRequest(req({ host: "notlocalhost" }))).toBe(false);
    expect(
      isLocalOnlyRequest(
        req({ host: "localhost:3001", origin: "http://localhost.evil.com" })
      )
    ).toBe(false);
  });

  it("handles IPv6 loopback with its brackets and port", () => {
    expect(
      isLocalOnlyRequest(req({ host: "[::1]:3001", origin: "http://[::1]:3001" }))
    ).toBe(true);
  });

  it("does NOT claim to separate two users on the same machine", () => {
    // Documenting the limit as a test so it cannot be quietly forgotten: two
    // requests from the same loopback host are indistinguishable here, by
    // design. If this ever needs to be false, the fix is an owner on
    // PendingApproval (#170), not a tighter host check.
    const a = req({ host: "localhost:3001", origin: "http://localhost:3001" });
    const b = req({ host: "localhost:3001", origin: "http://localhost:3001" });
    expect(isLocalOnlyRequest(a)).toBe(isLocalOnlyRequest(b));
  });
});
