/**
 * Sandbox factory and the provider-agnostic `Sandbox` interface.
 *
 * Routes call `getSandbox()` and never name a concrete provider. Today the
 * only working provider is DockerSandbox (local Docker daemon).
 *
 * A Blazing-backed provider is wired via BLAZING_API_URL + BLAZING_API_TOKEN —
 * see blazing-sandbox.ts for the real `/v1/workspace` REST API contract.
 *
 * The instance is a process-wide singleton so workspace state (the id → handle
 * map) survives across requests within one server process.
 */
import { BlazingSandbox } from "./blazing-sandbox";
import { DockerSandbox } from "./docker-sandbox";
import {
  SandboxCapacity,
  SandboxConfig,
  SandboxError,
  SandboxHealth,
  SandboxProvider,
  SandboxWorkspace,
  ToolExecutionResult,
} from "./types";

export * from "./types";
export { BlazingSandbox } from "./blazing-sandbox";
export type { BlazingSandboxOptions } from "./blazing-sandbox";
export { DockerSandbox } from "./docker-sandbox";
export type { DockerExecFn, DockerExecResult } from "./docker-sandbox";

/** The contract every sandbox provider satisfies. */
export interface Sandbox {
  readonly provider: SandboxProvider;
  create(config?: SandboxConfig): Promise<SandboxWorkspace>;
  executeTool(
    workspaceId: string,
    command: string,
    args?: string[]
  ): Promise<ToolExecutionResult>;
  destroy(workspaceId: string): Promise<void>;
  get(workspaceId: string): Promise<SandboxWorkspace | null>;
  list(): Promise<SandboxWorkspace[]>;
  health(): Promise<SandboxHealth>;
  capacity(): Promise<SandboxCapacity>;
}

let singleton: Sandbox | null = null;

/**
 * Return the process-wide sandbox, constructing it on first use.
 *
 * Provider selection:
 *   BLAZING_API_URL set   → BlazingSandbox (remote Blazing workspace API).
 *                           Requires BLAZING_API_TOKEN for auth.
 *   BLAZING_API_URL unset → DockerSandbox (local Docker daemon).
 */
export function getSandbox(): Sandbox {
  if (singleton) return singleton;
  const blazingUrl = process.env.BLAZING_API_URL?.trim();
  if (blazingUrl) {
    const token = process.env.BLAZING_API_TOKEN?.trim();
    singleton = new BlazingSandbox({ baseUrl: blazingUrl, apiToken: token });
    return singleton;
  }
  singleton = new DockerSandbox();
  return singleton;
}

/** Test hook — drops the cached singleton so the next getSandbox() rebuilds it. */
export function __resetSandbox(): void {
  singleton = null;
}

/** Test/Phase-4 hook — install a specific Sandbox as the singleton. */
export function __setSandbox(sandbox: Sandbox): void {
  singleton = sandbox;
}

const STATUS_BY_CODE: Record<string, number> = {
  not_found: 404,
  at_capacity: 429,
  invalid_command: 422,
  docker_unavailable: 502,
  provider_unavailable: 503,
  create_failed: 502,
  exec_failed: 502,
  destroy_failed: 502,
};

/** Map a thrown sandbox error to a JSON Response with the right HTTP status. */
export function sandboxErrorToResponse(err: unknown): Response {
  if (err instanceof SandboxError) {
    const status = STATUS_BY_CODE[err.code] ?? 500;
    return Response.json({ error: err.message, code: err.code }, { status });
  }
  console.error("[sandbox] unexpected error:", err);
  return Response.json({ error: "Internal sandbox error" }, { status: 500 });
}
