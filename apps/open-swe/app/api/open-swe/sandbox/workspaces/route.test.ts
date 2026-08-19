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
import { POST, GET } from "./route";

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

function postReq(body: unknown): NextRequest {
  return new NextRequest(
    "http://localhost:3001/api/open-swe/sandbox/workspaces",
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }
  );
}

const WORKSPACE = {
  id: "ws-1",
  containerId: "container-1",
  containerName: "open-swe-ws-ws-1",
  provider: "docker" as const,
  status: "ready" as const,
  image: "node:22-alpine",
  createdAt: "2026-05-19T00:00:00Z",
  execTimeoutMs: 30_000,
};

describe("POST /api/open-swe/sandbox/workspaces", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 201 with the created workspace", async () => {
    const create = vi.fn().mockResolvedValue(WORKSPACE);
    vi.mocked(sandboxModule.getSandbox).mockReturnValue(
      fakeSandbox({ create })
    );

    const res = await POST(postReq({ label: "build task" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe("ws-1");
    expect(create).toHaveBeenCalledWith({ label: "build task" });
  });

  it("returns 422 when image is the wrong type", async () => {
    vi.mocked(sandboxModule.getSandbox).mockReturnValue(fakeSandbox({}));
    const res = await POST(postReq({ image: 123 }));
    expect(res.status).toBe(422);
  });

  it("returns 422 when memoryLimitMb is not a positive number", async () => {
    vi.mocked(sandboxModule.getSandbox).mockReturnValue(fakeSandbox({}));
    const res = await POST(postReq({ memoryLimitMb: -5 }));
    expect(res.status).toBe(422);
  });

  it("returns 429 when the sandbox is at capacity", async () => {
    vi.mocked(sandboxModule.getSandbox).mockReturnValue(
      fakeSandbox({
        create: vi
          .fn()
          .mockRejectedValue(
            new SandboxError("at_capacity", "sandbox at capacity")
          ),
      })
    );
    const res = await POST(postReq({}));
    expect(res.status).toBe(429);
  });

  it("returns 502 when Docker fails to create the container", async () => {
    vi.mocked(sandboxModule.getSandbox).mockReturnValue(
      fakeSandbox({
        create: vi
          .fn()
          .mockRejectedValue(
            new SandboxError("create_failed", "no such image")
          ),
      })
    );
    const res = await POST(postReq({}));
    expect(res.status).toBe(502);
  });

  it("POST with no body and no Content-Type returns 415 (NOT a 500 or silent 201)", async () => {
    // Adversarial: client sends POST with no body AND no Content-Type header.
    // parseJsonBody's contract: any missing/non-matching Content-Type is 415.
    // A malformed request like this MUST NOT silently succeed (returning an
    // empty 201 workspace) — that would create a workspace with no provenance
    // about what image/label/config the caller intended. Equally it MUST NOT
    // 500: a 415 tells the client "fix your request shape".
    const create = vi.fn();
    vi.mocked(sandboxModule.getSandbox).mockReturnValue(
      fakeSandbox({ create })
    );

    const req = new NextRequest(
      "http://localhost:3001/api/open-swe/sandbox/workspaces",
      {
        method: "POST",
        // explicitly NO body, NO Content-Type header
      }
    );

    const res = await POST(req);
    // 415 = unsupported media type. Must not be 500 (crash) or 201 (silent success).
    expect(res.status).toBe(415);
    // create() must NOT have been invoked — a 415 short-circuits before any
    // sandbox side-effect.
    expect(create).not.toHaveBeenCalled();
  });
});

describe("GET /api/open-swe/sandbox/workspaces", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 with the list of workspaces", async () => {
    vi.mocked(sandboxModule.getSandbox).mockReturnValue(
      fakeSandbox({ list: vi.fn().mockResolvedValue([WORKSPACE]) })
    );

    const res = await GET(
      new NextRequest("http://localhost:3001/api/open-swe/sandbox/workspaces")
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].id).toBe("ws-1");
  });
});
