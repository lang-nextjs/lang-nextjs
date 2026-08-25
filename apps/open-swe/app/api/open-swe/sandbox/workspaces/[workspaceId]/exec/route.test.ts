import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("../../../../../../../lib/sandbox", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../../../../../lib/sandbox")
  >();
  return { ...actual, getSandbox: vi.fn() };
});

import * as sandboxModule from "../../../../../../../lib/sandbox";
import { SandboxError } from "../../../../../../../lib/sandbox";
import { POST } from "./route";

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

function execReq(body: unknown): NextRequest {
  return new NextRequest(
    "http://localhost:3001/api/open-swe/sandbox/workspaces/ws-1/exec",
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }
  );
}

const params = Promise.resolve({ workspaceId: "ws-1" });

describe("POST /api/open-swe/sandbox/workspaces/[workspaceId]/exec", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 with the tool execution result", async () => {
    const executeTool = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: "hello\n",
      stderr: "",
      durationMs: 12,
      timedOut: false,
    });
    vi.mocked(sandboxModule.getSandbox).mockReturnValue(
      fakeSandbox({ executeTool })
    );

    const res = await POST(execReq({ command: "echo", args: ["hello"] }), {
      params,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stdout).toBe("hello\n");
    expect(executeTool).toHaveBeenCalledWith("ws-1", "echo", ["hello"]);
  });

  it("returns 200 for a non-zero tool exit (the request still succeeded)", async () => {
    vi.mocked(sandboxModule.getSandbox).mockReturnValue(
      fakeSandbox({
        executeTool: vi.fn().mockResolvedValue({
          exitCode: 1,
          stdout: "",
          stderr: "failure",
          durationMs: 5,
          timedOut: false,
        }),
      })
    );

    const res = await POST(execReq({ command: "false" }), { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.exitCode).toBe(1);
  });

  it("returns 422 when command is missing", async () => {
    vi.mocked(sandboxModule.getSandbox).mockReturnValue(fakeSandbox({}));
    const res = await POST(execReq({ args: ["x"] }), { params });
    expect(res.status).toBe(422);
  });

  it("returns 422 when args is not an array of strings", async () => {
    vi.mocked(sandboxModule.getSandbox).mockReturnValue(fakeSandbox({}));
    const res = await POST(execReq({ command: "echo", args: [1, 2] }), {
      params,
    });
    expect(res.status).toBe(422);
  });

  it("returns 404 when the workspace is unknown", async () => {
    vi.mocked(sandboxModule.getSandbox).mockReturnValue(
      fakeSandbox({
        executeTool: vi
          .fn()
          .mockRejectedValue(
            new SandboxError("not_found", "workspace ws-1 not found")
          ),
      })
    );

    const res = await POST(execReq({ command: "echo" }), { params });
    expect(res.status).toBe(404);
  });
});
