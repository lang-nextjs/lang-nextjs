/**
 * Docker-backed sandbox provider.
 *
 * Each workspace is an ephemeral detached container kept alive with
 * `tail -f /dev/null`. Tool calls run via `docker exec`; workspaces are torn
 * down with `docker rm -f`. Resource limits (--memory, --cpus, --pids-limit)
 * isolate one workspace from another and from the host.
 *
 * The Docker daemon is reached through the `docker` CLI rather than a client
 * library: the CLI is the daemon's own interface, needs no npm dependency,
 * and is trivially injectable for tests via the `DockerExecFn` seam.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  SandboxCapacity,
  SandboxConfig,
  SandboxError,
  SandboxHealth,
  SandboxWorkspace,
  ToolExecutionResult,
} from "./types";

/** Outcome of one `docker` CLI invocation. */
export interface DockerExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** True when the call was killed for exceeding its timeout. */
  timedOut: boolean;
}

/** Injectable `docker` CLI runner — the test seam for DockerSandbox. */
export type DockerExecFn = (
  args: string[],
  opts?: { timeoutMs?: number }
) => Promise<DockerExecResult>;

/** Default runner: shells out to the real `docker` binary. */
export const defaultDockerExec: DockerExecFn = (args, opts = {}) =>
  new Promise<DockerExecResult>((resolve) => {
    execFile(
      "docker",
      args,
      {
        timeout: opts.timeoutMs ?? 0,
        killSignal: "SIGKILL",
        maxBuffer: 16 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, stderr, exitCode: 0, timedOut: false });
          return;
        }
        const e = error as NodeJS.ErrnoException & {
          killed?: boolean;
          code?: number | string;
        };
        const timedOut = e.killed === true && !!opts.timeoutMs;
        // Numeric code → process exit code. String code (ENOENT, etc.) → the
        // docker binary itself failed; surface 127 and put the cause in stderr.
        const exitCode =
          typeof e.code === "number" ? e.code : timedOut ? 124 : 127;
        const errText =
          typeof e.code === "string"
            ? `${e.code}: ${e.message}`
            : stderr || e.message;
        resolve({
          stdout: stdout ?? "",
          stderr: errText ?? "",
          exitCode,
          timedOut,
        });
      }
    );
  });

interface DockerSandboxOptions {
  /** Override the docker runner — tests pass a mock here. */
  exec?: DockerExecFn;
  /** Override resolved defaults (otherwise read from env). */
  defaults?: Partial<Required<SandboxConfig>>;
  /** Max concurrent workspaces. Default: SANDBOX_MAX_WORKSPACES env, else 8. */
  maxWorkspaces?: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const CREATE_TIMEOUT_MS = 180_000; // generous — first run may pull the image
const DESTROY_TIMEOUT_MS = 30_000;
const HEALTH_TIMEOUT_MS = 10_000;

export class DockerSandbox {
  readonly provider = "docker" as const;

  private readonly exec: DockerExecFn;
  private readonly maxWorkspaces: number;
  private readonly defaults: {
    image: string;
    memoryLimitMb: number;
    cpuLimit: number;
    execTimeoutMs: number;
  };
  private readonly workspaces = new Map<string, SandboxWorkspace>();

  constructor(opts: DockerSandboxOptions = {}) {
    this.exec = opts.exec ?? defaultDockerExec;
    this.maxWorkspaces =
      opts.maxWorkspaces ?? envInt("SANDBOX_MAX_WORKSPACES", 8);
    this.defaults = {
      image:
        opts.defaults?.image ?? process.env.SANDBOX_IMAGE ?? "node:22-alpine",
      memoryLimitMb:
        opts.defaults?.memoryLimitMb ?? envInt("SANDBOX_MEMORY_MB", 512),
      cpuLimit: opts.defaults?.cpuLimit ?? envInt("SANDBOX_CPUS", 1),
      execTimeoutMs:
        opts.defaults?.execTimeoutMs ??
        envInt("SANDBOX_EXEC_TIMEOUT_MS", 30_000),
    };
  }

  /** Spin up a fresh workspace container. */
  async create(config: SandboxConfig = {}): Promise<SandboxWorkspace> {
    if (this.workspaces.size >= this.maxWorkspaces) {
      throw new SandboxError(
        "at_capacity",
        `sandbox at capacity (${this.maxWorkspaces} workspaces)`
      );
    }

    const id = randomUUID();
    const containerName = `open-swe-ws-${id}`;
    const image = config.image ?? this.defaults.image;
    const memoryLimitMb = config.memoryLimitMb ?? this.defaults.memoryLimitMb;
    const cpuLimit = config.cpuLimit ?? this.defaults.cpuLimit;
    const execTimeoutMs = config.execTimeoutMs ?? this.defaults.execTimeoutMs;

    const args = [
      "run",
      "-d",
      "--rm",
      "--label",
      "open-swe.sandbox=1",
      "--name",
      containerName,
      "--memory",
      `${memoryLimitMb}m`,
      "--cpus",
      String(cpuLimit),
      "--pids-limit",
      "256",
      "--workdir",
      "/workspace",
    ];
    for (const [k, v] of Object.entries(config.env ?? {})) {
      args.push("--env", `${k}=${v}`);
    }
    // Keep the container alive with no foreground process of its own.
    args.push(image, "tail", "-f", "/dev/null");

    const res = await this.exec(args, { timeoutMs: CREATE_TIMEOUT_MS });
    if (res.exitCode !== 0) {
      throw new SandboxError(
        "create_failed",
        (res.stderr || "docker run failed").trim().slice(0, 500)
      );
    }

    const workspace: SandboxWorkspace = {
      id,
      containerId: res.stdout.trim(),
      containerName,
      provider: "docker",
      status: "ready",
      image,
      createdAt: new Date().toISOString(),
      label: config.label,
      execTimeoutMs,
    };
    this.workspaces.set(id, workspace);
    return workspace;
  }

  /** Run a command inside a workspace. A non-zero exit is a tool failure, not an error. */
  async executeTool(
    workspaceId: string,
    command: string,
    args: string[] = []
  ): Promise<ToolExecutionResult> {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) {
      throw new SandboxError("not_found", `workspace ${workspaceId} not found`);
    }
    if (typeof command !== "string" || command.trim() === "") {
      throw new SandboxError(
        "invalid_command",
        "command must be a non-empty string"
      );
    }

    const started = Date.now();
    const res = await this.exec(["exec", ws.containerName, command, ...args], {
      timeoutMs: ws.execTimeoutMs,
    });
    return {
      exitCode: res.exitCode,
      stdout: res.stdout,
      stderr: res.stderr,
      durationMs: Date.now() - started,
      timedOut: res.timedOut,
    };
  }

  /** Tear down a workspace. The map entry is dropped even if `docker rm` fails. */
  async destroy(workspaceId: string): Promise<void> {
    const ws = this.workspaces.get(workspaceId);
    if (!ws) {
      // IDEMPOTENT (quorum Q1=A). destroy() asserts an end state — "this workspace does
      // not exist" — so if it already does not exist, that state is satisfied. Throwing
      // forced every correct caller to catch-and-swallow, and made the providers behave
      // differently for identical input: blazing's API returns 204 for unknown ids, so a
      // caller written against blazing broke when swapped to docker — exactly the promise
      // this adapter exists to keep.
      //
      // Note blazing physically CANNOT distinguish "existed and was deleted" from "never
      // existed" (both are 204), so `not_found` here — or a boolean return — could never be
      // honoured there without a racy pre-GET. Resolving is the only behaviour BOTH
      // providers can implement.
      //
      // executeTool() deliberately still throws not_found for an unknown workspace: acting
      // on a workspace that is not there is a real error, whereas removing one that is
      // already gone is success.
      return;
    }
    const res = await this.exec(["rm", "-f", ws.containerName], {
      timeoutMs: DESTROY_TIMEOUT_MS,
    });
    this.workspaces.delete(workspaceId);
    if (res.exitCode !== 0) {
      throw new SandboxError(
        "destroy_failed",
        (res.stderr || "docker rm failed").trim().slice(0, 300)
      );
    }
  }

  async get(workspaceId: string): Promise<SandboxWorkspace | null> {
    return this.workspaces.get(workspaceId) ?? null;
  }

  async list(): Promise<SandboxWorkspace[]> {
    return [...this.workspaces.values()];
  }

  /** Probe the Docker daemon. */
  async health(): Promise<SandboxHealth> {
    const res = await this.exec(
      ["version", "--format", "{{.Server.Version}}"],
      { timeoutMs: HEALTH_TIMEOUT_MS }
    );
    if (res.exitCode === 0 && res.stdout.trim()) {
      return {
        provider: "docker",
        available: true,
        detail: `Docker server ${res.stdout.trim()}`,
      };
    }
    return {
      provider: "docker",
      available: false,
      detail: (res.stderr || "Docker daemon not reachable")
        .trim()
        .slice(0, 300),
    };
  }

  async capacity(): Promise<SandboxCapacity> {
    const used = this.workspaces.size;
    return {
      provider: "docker",
      used,
      max: this.maxWorkspaces,
      available: Math.max(0, this.maxWorkspaces - used),
    };
  }
}
