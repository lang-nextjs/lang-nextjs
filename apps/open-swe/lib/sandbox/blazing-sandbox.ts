/**
 * Blazing workspace sandbox provider.
 *
 * Consumes the real `/v1/workspace` REST API from blazing PR #81
 * (Borduas-Holdings/blazing#81). The API exposes 6 workspace-specific
 * endpoints under two routers:
 *
 *   Singular `/v1/workspace`:
 *     POST   /v1/workspace                    → WorkspaceRecord   (201)
 *     GET    /v1/workspace/{sandbox_id}       → WorkspaceRecord   (200 / 404)
 *     DELETE /v1/workspace/{sandbox_id}       → 204 / 404 (idempotent — 204 even for unknown)
 *     POST   /v1/workspace/{sandbox_id}/exec  → ExecResponse      (200)
 *
 *   Plural `/v1/workspaces`:
 *     GET    /v1/workspaces                   → WorkspaceListResponse (200)
 *     GET    /v1/workspaces/capacity          → CapacityResponse     (200)
 *
 *   Provider reachability reuses the existing GET /v1/health endpoint.
 *
 * Auth: Bearer token via `Authorization` header (Blazing verify_token).
 * Kill switch: WORKSPACE_API_ENABLED env var on the Blazing server.
 */
import { CircuitBreaker, CircuitOpenError } from "../circuit-breaker";
import {
  SandboxCapacity,
  SandboxConfig,
  SandboxError,
  SandboxHealth,
  SandboxWorkspace,
  SandboxWorkspaceList,
  asWorkspaceList,
  ToolExecutionResult,
} from "./types";

const DEFAULT_TIMEOUT_MS = 15_000;

// ── Wire DTOs — the Blazing API speaks snake_case ──────────────────────────

interface BlazingWorkspaceRecord {
  sandbox_id: string;
  container_id: string | null;
  state: string;
  image: string | null;
  created_at: string | null;
  label: string | null;
  host: string | null;
}

interface BlazingExecResponse {
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
  timed_out: boolean;
}

interface BlazingWorkspaceListResponse {
  workspaces: BlazingWorkspaceRecord[];
}

interface BlazingCapacityResponse {
  used: number;
  max: number;
  available: number;
}

interface BlazingHealthDto {
  available?: boolean;
  status?: string;
  detail?: string;
  version?: string;
}

export interface BlazingSandboxOptions {
  /** Base URL of the Blazing API, e.g. http://localhost:8005. */
  baseUrl: string;
  /** Bearer token — sent as the Authorization header. */
  apiToken?: string;
  /** Injectable fetch implementation — the test seam. Defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** Per-request timeout in ms. Default 15000. */
  timeoutMs?: number;
}

export class BlazingSandbox {
  readonly provider = "blazing" as const;

  private readonly baseUrl: string;
  private readonly apiToken?: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly breaker = new CircuitBreaker();

  constructor(opts: BlazingSandboxOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiToken = opts.apiToken;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async create(config: SandboxConfig = {}): Promise<SandboxWorkspace> {
    const dto = await this.request<BlazingWorkspaceRecord>(
      "POST",
      "/v1/workspace",
      {
        image: config.image,
        label: config.label,
        resource_limits:
          config.memoryLimitMb || config.cpuLimit
            ? {
                memory_mb: config.memoryLimitMb,
                cpu_cores: config.cpuLimit,
              }
            : undefined,
        // Forward env / exec_timeout_ms when the caller sets them. Blazing
        // currently rejects both with 422 (blazing#48 — the workspace runtime
        // does not apply them yet), which the adapter maps to a clear
        // `create_failed`. We forward rather than silently drop a requested
        // env/timeout, and this begins working the moment Blazing wires them
        // through — no adapter change required.
        env:
          config.env && Object.keys(config.env).length > 0
            ? config.env
            : undefined,
        exec_timeout_ms: config.execTimeoutMs,
      }
    );
    return this.toWorkspace(dto);
  }

  async executeTool(
    workspaceId: string,
    command: string,
    args: string[] = []
  ): Promise<ToolExecutionResult> {
    if (typeof command !== "string" || command.trim() === "") {
      throw new SandboxError(
        "invalid_command",
        "command must be a non-empty string"
      );
    }
    // API uses argv-style {command, args} — no shell wrapping.
    const dto = await this.request<BlazingExecResponse>(
      "POST",
      `/v1/workspace/${encodeURIComponent(workspaceId)}/exec`,
      { command, args }
    );
    return {
      exitCode: dto.exit_code,
      stdout: dto.stdout ?? "",
      stderr: dto.stderr ?? "",
      durationMs: dto.duration_ms ?? 0,
      timedOut: dto.timed_out ?? false,
    };
  }

  async destroy(workspaceId: string): Promise<void> {
    let failure: SandboxError;
    try {
      await this.request<void>(
        "DELETE",
        `/v1/workspace/${encodeURIComponent(workspaceId)}`
      );
      return;
    } catch (err) {
      if (!(err instanceof SandboxError)) throw err;
      failure = err;
    }

    // CONFIRMATORY PROBE — load-bearing, do not remove as a "redundant call".
    //
    // guardedFetch collapses every 5xx into provider_unavailable before request() sees a
    // status, so destroy_failed was previously UNREACHABLE here even though docker emits it
    // and STATUS_BY_CODE maps it to 502 (vs 503 for provider_unavailable). Those mean
    // different things to an operator: "this one workspace leaked, page someone" vs
    // "Blazing is down, back off".
    //
    // Rather than infer that from an HTTP status — which a proxy can set, and which is
    // discarded upstream anyway — ask the question the error code actually asks: did the
    // workspace survive? Existence is ground truth; the status is a proxy for it.
    let still: SandboxWorkspace | null;
    try {
      still = await this.get(workspaceId);
    } catch {
      // Both the DELETE and the probe failed: the provider really is down. Surface the
      // ORIGINAL DELETE error — it is the causal signal for triage, not this symptom.
      throw failure;
    }

    if (still) {
      throw new SandboxError(
        "destroy_failed",
        `Workspace ${workspaceId} still exists after failed DELETE: ${failure.message}`
      );
    }
    // Gone despite the error — the caller's goal is met, so resolve (idempotent destroy).
  }

  async get(workspaceId: string): Promise<SandboxWorkspace | null> {
    try {
      const dto = await this.request<BlazingWorkspaceRecord>(
        "GET",
        `/v1/workspace/${encodeURIComponent(workspaceId)}`
      );
      return this.toWorkspace(dto, "get");
    } catch (err) {
      if (err instanceof SandboxError && err.code === "not_found") {
        return null;
      }
      throw err;
    }
  }

  /**
   * Every workspace Blazing currently holds.
   *
   * SKIP-AND-LOG: a record this adapter cannot parse costs the caller THAT RECORD, not the
   * whole listing. Before 2026-08-24 one malformed entry threw out of the `.map()` and
   * failed the entire call, so a caller with 49 healthy workspaces got an exception instead
   * of 49 workspaces and a gap. The sole caller is the operator dashboard, and a malformed
   * record means something is already wrong — blanking the console at exactly that moment
   * is the worse failure.
   *
   * The skipping is NOT silent: dropped records are counted onto the returned array and
   * logged. See PARITY.md § "RESOLVED — `list` partial-failure semantics".
   */
  async list(): Promise<SandboxWorkspaceList> {
    const dto = await this.request<BlazingWorkspaceListResponse>(
      "GET",
      "/v1/workspaces"
    );

    const workspaces: SandboxWorkspace[] = [];
    const dropped: string[] = [];
    for (const record of dto.workspaces ?? []) {
      try {
        workspaces.push(this.toWorkspace(record, "list"));
      } catch (err) {
        // Deliberately swallowed PER RECORD — this is the decision, not an oversight. The
        // loss is surfaced on droppedCount and in the log line below, never dropped on the
        // floor.
        dropped.push(
          record?.container_id ??
            (err instanceof Error ? err.message : "unknown")
        );
      }
    }

    if (dropped.length > 0) {
      console.error(
        `[sandbox:blazing] list() skipped ${dropped.length} unparseable record(s) ` +
          `of ${(dto.workspaces ?? []).length}; returning ${
            workspaces.length
          }. ` +
          `Offending records (container_id or reason): ${dropped.join(", ")}`
      );
    }

    return asWorkspaceList(workspaces, dropped.length);
  }

  /** Probe the Blazing service. Never throws — an unreachable provider is reported, not raised. */
  async health(): Promise<SandboxHealth> {
    try {
      const dto = await this.request<BlazingHealthDto>("GET", "/v1/health");
      // Blazing's shared GET /v1/health reports {status: "healthy", ...}.
      // Accept that, the legacy {status: "ok"}, and an explicit {available}.
      const status = dto.status?.toLowerCase();
      const available =
        typeof dto.available === "boolean"
          ? dto.available
          : status === "healthy" || status === "ok";
      return {
        provider: "blazing",
        available,
        detail:
          dto.detail ??
          dto.version ??
          dto.status ??
          (available ? "Blazing API reachable" : "Blazing API unhealthy"),
      };
    } catch (err) {
      return {
        provider: "blazing",
        available: false,
        detail: err instanceof Error ? err.message : "Blazing API unreachable",
      };
    }
  }

  async capacity(): Promise<SandboxCapacity> {
    const dto = await this.request<BlazingCapacityResponse>(
      "GET",
      "/v1/workspaces/capacity"
    );
    // `available` is COMPUTED, never passed through. SandboxCapacity documents it as
    // "max - used, floored at 0" — an invariant a scheduler relies on when it checks
    // `available > 0` before dispatching. Trusting dto.available meant a malformed or
    // stale API response could hand callers a negative number, or one that contradicts
    // the used/max in the same payload, and docker (which computes it) would disagree
    // with blazing for identical state. See parity.telemetry.test.ts.
    return {
      provider: "blazing",
      used: dto.used,
      max: dto.max,
      available: Math.max(0, dto.max - dto.used),
    };
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * Map one Blazing record onto the provider-agnostic shape.
   *
   * `context` decides which error code a bad record raises. It is not cosmetic: the code is
   * what `sandboxErrorToResponse` maps to an HTTP status and what callers switch on. Before
   * 2026-08-24 this always threw `create_failed`, so a malformed record in a LISTING
   * reported that a creation had failed — nothing was being created.
   */
  private toWorkspace(
    dto: BlazingWorkspaceRecord,
    context: "create" | "get" | "list" = "create"
  ): SandboxWorkspace {
    // The Blazing API is supposed to return a `sandbox_id` on every workspace
    // record. If it doesn't (malformed body, schema drift, a future field
    // rename), refuse to mint a workspace with `id: undefined` — every
    // downstream call keys off that id and a "successful" workspace with an
    // undefined id is a silent data-loss bug.
    if (!dto.sandbox_id || typeof dto.sandbox_id !== "string") {
      throw new SandboxError(
        context === "list" ? "list_failed" : "create_failed",
        "Blazing API response missing sandbox_id"
      );
    }
    return {
      id: dto.sandbox_id,
      containerId: dto.container_id ?? dto.sandbox_id,
      containerName: dto.sandbox_id,
      provider: "blazing",
      status: dto.state === "error" ? "error" : "ready",
      image: dto.image ?? "",
      createdAt: dto.created_at ?? new Date().toISOString(),
      label: dto.label ?? undefined,
      execTimeoutMs: 30_000,
    };
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiToken) headers["Authorization"] = `Bearer ${this.apiToken}`;
    return headers;
  }

  /**
   * Breaker-guarded fetch. A 5xx response or a network/timeout failure throws
   * (and counts as a circuit failure); 2xx/3xx/4xx responses are returned as-is
   * so callers can map 4xx to a precise SandboxError without tripping the breaker.
   */
  private guardedFetch(
    method: string,
    path: string,
    body?: unknown
  ): Promise<Response> {
    return this.breaker.execute(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchFn(`${this.baseUrl}${path}`, {
          method,
          headers: this.headers(),
          signal: controller.signal,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        if (res.status >= 500) {
          // Read the body for diagnostic info before throwing. The 5xx body
          // usually carries `{"error": "db connection lost"}` or similar
          // — surfacing that detail lets operators triage route failures
          // without re-running the request. Always fall back to a clean,
          // trimmed message (no trailing space from empty `statusText`).
          let detail = "";
          try {
            const text = await res.text();
            const trimmed = text.trim();
            if (trimmed.length > 0) {
              try {
                const parsed = JSON.parse(trimmed) as { error?: unknown };
                if (
                  parsed &&
                  typeof parsed === "object" &&
                  typeof parsed.error === "string" &&
                  parsed.error.trim().length > 0
                ) {
                  detail = parsed.error.trim();
                } else {
                  detail = trimmed;
                }
              } catch {
                detail = trimmed;
              }
            }
          } catch {
            // Body read failed (network blip, aborted stream); fall through
            // to the statusText / status-only fallback below.
          }

          const statusText = (res.statusText ?? "").trim();
          const baseMsg =
            statusText.length > 0
              ? `Blazing API ${res.status} ${statusText}`
              : `Blazing API ${res.status}`;
          const message = detail.length > 0 ? `${baseMsg}: ${detail}` : baseMsg;
          throw new SandboxError("provider_unavailable", message);
        }
        return res;
      } finally {
        clearTimeout(timer);
      }
    });
  }

  /** guardedFetch + HTTP-status → SandboxError mapping + JSON parse. */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    let res: Response;
    try {
      res = await this.guardedFetch(method, path, body);
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        throw new SandboxError(
          "provider_unavailable",
          `Blazing API circuit open — retry in ${err.retryAfterSeconds}s`
        );
      }
      if (err instanceof Error && err.name === "AbortError") {
        throw new SandboxError(
          "provider_unavailable",
          "Blazing API request timed out"
        );
      }
      throw new SandboxError(
        "provider_unavailable",
        err instanceof Error ? err.message : "Blazing API unreachable"
      );
    }

    if (res.status === 404) {
      throw new SandboxError(
        "not_found",
        await this.errorText(res, "workspace not found")
      );
    }
    if (res.status === 409) {
      throw new SandboxError(
        "create_failed",
        await this.errorText(res, "workspace already being created")
      );
    }
    if (res.status === 422) {
      throw new SandboxError(
        "create_failed",
        await this.errorText(res, "unsupported create option")
      );
    }
    if (res.status === 429) {
      throw new SandboxError(
        "at_capacity",
        await this.errorText(res, "Blazing sandbox at capacity")
      );
    }
    if (!res.ok) {
      throw new SandboxError(
        "provider_unavailable",
        await this.errorText(res, `Blazing API ${res.status}`)
      );
    }
    if (res.status === 204) return undefined as T;
    // The upstream may return 200 OK with a non-JSON body (proxy error page,
    // truncated payload, load balancer injecting HTML). `res.json()` would
    // throw a raw `SyntaxError`/`TypeError` that escapes the SandboxError
    // contract — wrap it so callers always see a typed `provider_unavailable`.
    try {
      return (await res.json()) as T;
    } catch (err) {
      throw new SandboxError(
        "provider_unavailable",
        `Blazing API returned non-JSON response: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  private async errorText(res: Response, fallback: string): Promise<string> {
    const text = await res.text().catch(() => "");
    return (text || fallback).trim().slice(0, 300);
  }
}
