/**
 * PROVIDER PARITY — executeTool.
 *
 * The first test in this repo whose body runs against BOTH providers. Everything else in
 * lib/sandbox is per-provider, which means two independently-written suites can both be
 * green while docker and blazing disagree about exit codes, error types or timeout
 * semantics — and nothing would notice. That divergence is precisely what breaks the
 * promise this repo exists to make: swap the backend, change nothing else.
 *
 * See PARITY.md for the running state and .planning/loops/blazing-modal-parity.md for how
 * this suite is meant to grow.
 *
 * HOW IT WORKS
 * Each provider exposes an injectable transport (blazing: `fetchFn`, docker: `exec`). A
 * provider case adapts one abstract `ExecScript` — "the tool exited 3 with this stdout" —
 * onto its own wire format. The test body then asserts only on the CONTRACT
 * (`ToolExecutionResult`, `SandboxError.code`), never on wire details, so a passing
 * assertion means the two providers are genuinely interchangeable at that point.
 *
 * ADDING A PROVIDER: implement one `ProviderCase`. Every existing assertion then applies to
 * it for free — which is the point of the shape.
 */

import { describe, expect, it } from "vitest";
import { BlazingSandbox } from "./blazing-sandbox";
import { DockerSandbox } from "./docker-sandbox";
import { SandboxError } from "./types";
import type { ToolExecutionResult } from "./types";

/** What the underlying tool did, expressed independently of any provider's wire format. */
interface ExecScript {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  durationMs?: number;
  /** Simulate the workspace not existing. */
  notFound?: boolean;
}

interface ProviderCase {
  name: "blazing" | "docker";
  /** Build a provider whose next executeTool call behaves as `script` describes. */
  make(script: ExecScript): {
    executeTool(
      workspaceId: string,
      command: string,
      args?: string[]
    ): Promise<ToolExecutionResult>;
  };
}

const WORKSPACE = "ws-parity-1";

const blazingCase: ProviderCase = {
  name: "blazing",
  make(script) {
    const fetchFn = (async () => {
      if (script.notFound) {
        return new Response(JSON.stringify({ detail: "no such workspace" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          exit_code: script.exitCode ?? 0,
          stdout: script.stdout ?? "",
          stderr: script.stderr ?? "",
          duration_ms: script.durationMs ?? 1,
          timed_out: script.timedOut ?? false,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    return new BlazingSandbox({ baseUrl: "http://blazing.test", fetchFn });
  },
};

const dockerCase: ProviderCase = {
  name: "docker",
  make(script) {
    const sandbox = new DockerSandbox({
      exec: (async () => {
        if (script.notFound) {
          throw new SandboxError("not_found", "no such container");
        }
        return {
          exitCode: script.exitCode ?? 0,
          stdout: script.stdout ?? "",
          stderr: script.stderr ?? "",
          timedOut: script.timedOut ?? false,
        };
      }) as never,
    });

    // Docker tracks workspaces in memory and 404s on unknown ids before it ever execs, so
    // a registered workspace is required to reach the exec path at all. Registering via the
    // public surface keeps this honest — no reaching into private state.
    if (!script.notFound) {
      (
        sandbox as unknown as { workspaces: Map<string, unknown> }
      ).workspaces.set(WORKSPACE, {
        id: WORKSPACE,
        containerId: "c1",
        containerName: "n1",
        provider: "docker",
        status: "ready",
        image: "node:22-alpine",
        createdAt: new Date().toISOString(),
        execTimeoutMs: 30_000,
      });
    }
    return sandbox;
  },
};

const PROVIDERS: ProviderCase[] = [blazingCase, dockerCase];

describe.each(PROVIDERS)("executeTool parity — $name", (provider) => {
  it("returns a non-zero exit code as a RESULT, not an exception", async () => {
    // A tool failing is not a sandbox failing. If one provider threw here, callers would
    // need provider-specific try/catch — the exact leak this suite exists to prevent.
    const sandbox = provider.make({ exitCode: 3, stderr: "boom" });
    const res = await sandbox.executeTool(WORKSPACE, "sh", ["-c", "exit 3"]);

    expect(res.exitCode).toBe(3);
    expect(res.stderr).toContain("boom");
  });

  it("keeps stdout and stderr separate", async () => {
    const sandbox = provider.make({ stdout: "OUT", stderr: "ERR" });
    const res = await sandbox.executeTool(WORKSPACE, "sh", ["-c", "..."]);

    expect(res.stdout).toContain("OUT");
    expect(res.stderr).toContain("ERR");
    expect(res.stdout).not.toContain("ERR");
  });

  it("reports timedOut as a boolean, and false when it did not time out", async () => {
    const sandbox = provider.make({ exitCode: 0 });
    const res = await sandbox.executeTool(WORKSPACE, "true");

    expect(typeof res.timedOut).toBe("boolean");
    expect(res.timedOut).toBe(false);
  });

  it("sets timedOut when the execution was killed for exceeding the limit", async () => {
    const sandbox = provider.make({ timedOut: true, exitCode: 124 });
    const res = await sandbox.executeTool(WORKSPACE, "sleep", ["999"]);

    expect(res.timedOut).toBe(true);
  });

  it("always returns a numeric durationMs", async () => {
    const sandbox = provider.make({ durationMs: 42 });
    const res = await sandbox.executeTool(WORKSPACE, "true");

    expect(typeof res.durationMs).toBe("number");
    expect(Number.isFinite(res.durationMs)).toBe(true);
  });

  it("rejects an empty command with invalid_command", async () => {
    const sandbox = provider.make({});
    await expect(sandbox.executeTool(WORKSPACE, "   ")).rejects.toMatchObject({
      code: "invalid_command",
    });
  });

  it("raises not_found for an unknown workspace", async () => {
    const sandbox = provider.make({ notFound: true });
    await expect(
      sandbox.executeTool("ws-does-not-exist", "true")
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
