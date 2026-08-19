import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("../../../../../lib/sandbox", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../../../lib/sandbox")
  >();
  return { ...actual, getSandbox: vi.fn() };
});

import * as sandboxModule from "../../../../../lib/sandbox";
import { SandboxError } from "../../../../../lib/sandbox";
import { GET } from "./route";

function fakeSandbox(
  over: Partial<sandboxModule.Sandbox>
): sandboxModule.Sandbox {
  return {
    provider: "docker",
    create: vi.fn(),
    executeTool: vi.fn(),
    destroy: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    health: vi.fn(),
    capacity: vi.fn(),
    ...over,
  } as sandboxModule.Sandbox;
}

const req = () =>
  new NextRequest("http://localhost:3001/api/open-swe/sandbox/health");

describe("GET /api/open-swe/sandbox/health", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 when the daemon is available", async () => {
    vi.mocked(sandboxModule.getSandbox).mockReturnValue(
      fakeSandbox({
        health: vi.fn().mockResolvedValue({
          provider: "docker",
          available: true,
          detail: "Docker server 28.0.0",
        }),
      })
    );

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.available).toBe(true);
    expect(body.detail).toContain("28.0.0");
  });

  it("returns 503 when the daemon is unreachable", async () => {
    vi.mocked(sandboxModule.getSandbox).mockReturnValue(
      fakeSandbox({
        health: vi.fn().mockResolvedValue({
          provider: "docker",
          available: false,
          detail: "Docker daemon not reachable",
        }),
      })
    );

    const res = await GET(req());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.available).toBe(false);
  });

  it("returns 503 (not 500) when the Blazing provider's health() throws", async () => {
    // Adversarial: route handler does NOT try/catch around getSandbox().health().
    // When BLAZING_API_URL is set and the remote API is down (fetch throws,
    // DNS resolution fails, token rejected, etc.), the unhandled rejection bubbles
    // up to Next.js which renders a generic 500. The contract documented for
    // clients says: 503 = "sandbox not available". A 500 leaks the distinction
    // between "upstream transient" and "code bug" — and bypasses any LB rule
    // that routes 503 to a fallback pool.
    vi.mocked(sandboxModule.getSandbox).mockReturnValue(
      fakeSandbox({
        provider: "blazing",
        health: vi
          .fn()
          .mockRejectedValue(
            new SandboxError("provider_unavailable", "Blazing API timeout")
          ),
      })
    );

    // The handler must NOT throw — it must convert the rejection into a
    // 503 Response. If GET throws here (unhandled rejection), the request
    // bubbles up to Next.js which returns a generic 500.
    let res: Response | undefined;
    let threw: unknown;
    try {
      res = await GET(req());
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeUndefined();
    expect(res).toBeDefined();
    expect(res!.status).toBe(503);
  });
});
