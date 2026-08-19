/**
 * Provider-agnostic sandbox types.
 *
 * A "sandbox" gives open-swe an isolated, disposable workspace in which agent
 * tool calls (shell commands, file edits, builds) actually run — instead of
 * the app being a pure proxy to a remote LangGraph Platform.
 *
 * The Docker provider (docker-sandbox.ts) is the local implementation. The
 * Blazing provider (ADAPT-06) plugs in behind the same `Sandbox` interface.
 */

export type SandboxProvider = "docker" | "blazing";

export type WorkspaceStatus = "ready" | "error";

/** Options for a single workspace. All fields optional — provider defaults apply. */
export interface SandboxConfig {
  /** Container image. Default: SANDBOX_IMAGE env, else node:22-alpine. */
  image?: string;
  /** Hard memory cap in MB. Default: SANDBOX_MEMORY_MB env, else 512. */
  memoryLimitMb?: number;
  /** CPU quota as a fraction of host cores (e.g. 0.5). Default: SANDBOX_CPUS, else 1. */
  cpuLimit?: number;
  /** Per-tool-execution wall-clock timeout in ms. Default: SANDBOX_EXEC_TIMEOUT_MS, else 30000. */
  execTimeoutMs?: number;
  /** Extra environment variables exposed inside the workspace. */
  env?: Record<string, string>;
  /** Free-text label for observability (e.g. the run/task it backs). */
  label?: string;
}

/** A live workspace handle. */
export interface SandboxWorkspace {
  /** Stable workspace id minted by the sandbox (uuid). */
  id: string;
  /** Provider-native container/handle id. */
  containerId: string;
  /** Provider-native container name (docker --name). */
  containerName: string;
  provider: SandboxProvider;
  status: WorkspaceStatus;
  image: string;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  label?: string;
  /** Resolved per-tool-execution timeout for this workspace. */
  execTimeoutMs: number;
}

/** Result of running a single tool/command inside a workspace. */
export interface ToolExecutionResult {
  /** Process exit code. Non-zero is a tool failure, not a sandbox failure. */
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Wall-clock duration of the execution in ms. */
  durationMs: number;
  /** True when the execution was killed for exceeding execTimeoutMs. */
  timedOut: boolean;
}

export interface SandboxHealth {
  provider: SandboxProvider;
  available: boolean;
  /** Human-readable detail — server version when up, error text when down. */
  detail: string;
}

export interface SandboxCapacity {
  provider: SandboxProvider;
  /** Workspaces currently held. */
  used: number;
  /** Maximum concurrent workspaces. */
  max: number;
  /** Free slots (max - used, floored at 0). */
  available: number;
}

/**
 * Sandbox failures carry a stable `code` so route handlers can map them to
 * HTTP statuses without string-matching messages.
 *
 *   not_found           — workspace id is unknown
 *   at_capacity         — max concurrent workspaces reached
 *   invalid_command     — executeTool called with an empty/non-string command
 *   docker_unavailable  — the Docker daemon could not be reached
 *   provider_unavailable— a remote provider (Blazing) was unreachable / timed out
 *   create_failed       — workspace creation returned non-zero / an error
 *   exec_failed         — the exec call itself failed (not a non-zero tool exit)
 *   destroy_failed      — workspace teardown returned non-zero / an error
 */
export type SandboxErrorCode =
  | "not_found"
  | "at_capacity"
  | "invalid_command"
  | "docker_unavailable"
  | "provider_unavailable"
  | "create_failed"
  | "exec_failed"
  | "destroy_failed";

export class SandboxError extends Error {
  constructor(public readonly code: SandboxErrorCode, message: string) {
    super(message);
    this.name = "SandboxError";
    Object.setPrototypeOf(this, SandboxError.prototype);
  }
}
