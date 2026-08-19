import { describe, it, expect, vi } from "vitest";
import { BlazingSandbox } from "./blazing-sandbox";
import { SandboxError } from "./types";

const BASE = "http://blazing.test";
const TOKEN = "test-bearer-token";

/** Build a JSON Response with the given status. */
function res(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A fetch mock whose queued responses are returned in order. */
function fetchMock(...responses: Response[]): typeof fetch {
  const fn = vi.fn();
  for (const r of responses) fn.mockResolvedValueOnce(r);
  return fn as unknown as typeof fetch;
}

// ── Real API contract DTOs (snake_case) from blazing PR #81 ────────────

const WORKSPACE_RECORD = {
  sandbox_id: "ws_abc123",
  container_id: "ctr-abc123",
  state: "ready",
  image: "python:3.12-slim",
  created_at: "2026-06-08T21:00:00Z",
  label: "smoke test",
  host: "worker-1",
};

// ── Create ─────────────────────────────────────────────────────────────

describe("BlazingSandbox.create", () => {
  it("POSTs /v1/workspace and maps the snake_case record to a workspace", async () => {
    const fetchFn = fetchMock(res(200, WORKSPACE_RECORD));
    const sandbox = new BlazingSandbox({
      baseUrl: BASE,
      apiToken: TOKEN,
      fetchFn,
    });

    const ws = await sandbox.create({
      image: "python:3.12-slim",
      label: "smoke test",
      memoryLimitMb: 512,
    });

    expect(ws).toMatchObject({
      id: "ws_abc123",
      containerId: "ctr-abc123",
      provider: "blazing",
      status: "ready",
      label: "smoke test",
    });

    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE}/v1/workspace`);
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.image).toBe("python:3.12-slim");
    expect(body.label).toBe("smoke test");
    expect(body.resource_limits.memory_mb).toBe(512);
  });

  it("forwards env and exec_timeout_ms in the create body only when set", async () => {
    const fetchFn = fetchMock(
      res(200, WORKSPACE_RECORD),
      res(200, WORKSPACE_RECORD)
    );
    const sandbox = new BlazingSandbox({ baseUrl: BASE, fetchFn });

    // Set → forwarded (Blazing 422s these today; see the create_failed test).
    await sandbox.create({ env: { FOO: "bar" }, execTimeoutMs: 5000 });
    const withOpts = JSON.parse(
      (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string
    );
    expect(withOpts.env).toEqual({ FOO: "bar" });
    expect(withOpts.exec_timeout_ms).toBe(5000);

    // Unset (and empty env) → omitted, so a plain create still succeeds today.
    await sandbox.create({ env: {} });
    const without = JSON.parse(
      (fetchFn as ReturnType<typeof vi.fn>).mock.calls[1][1].body as string
    );
    expect(without).not.toHaveProperty("env");
    expect(without).not.toHaveProperty("exec_timeout_ms");
  });

  it("sends Authorization: Bearer header when apiToken is configured", async () => {
    const fetchFn = fetchMock(res(200, WORKSPACE_RECORD));
    const sandbox = new BlazingSandbox({
      baseUrl: BASE,
      apiToken: "my-secret",
      fetchFn,
    });
    await sandbox.create();
    const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers["Authorization"]).toBe("Bearer my-secret");
  });

  it("throws at_capacity on a 429 response", async () => {
    const sandbox = new BlazingSandbox({
      baseUrl: BASE,
      fetchFn: fetchMock(res(429, { error: "workspace capacity exhausted" })),
    });
    await expect(sandbox.create()).rejects.toMatchObject({
      name: "SandboxError",
      code: "at_capacity",
    });
  });

  it("throws create_failed on a 409 (already creating)", async () => {
    const sandbox = new BlazingSandbox({
      baseUrl: BASE,
      fetchFn: fetchMock(
        res(409, { error: "Sandbox already creating: ws_dup" })
      ),
    });
    await expect(sandbox.create()).rejects.toMatchObject({
      code: "create_failed",
    });
  });

  it("maps Blazing's 422 rejection of env/exec_timeout_ms to create_failed", async () => {
    // The real Blazing create handler 422-rejects these fields (blazing#48).
    const sandbox = new BlazingSandbox({
      baseUrl: BASE,
      fetchFn: fetchMock(
        res(422, {
          error: "env not yet supported by the Blazing workspace provider",
        })
      ),
    });
    await expect(sandbox.create({ env: { FOO: "bar" } })).rejects.toMatchObject(
      {
        code: "create_failed",
      }
    );
  });

  it("throws provider_unavailable on a 5xx response", async () => {
    const sandbox = new BlazingSandbox({
      baseUrl: BASE,
      fetchFn: fetchMock(res(503, { error: "service unavailable" })),
    });
    await expect(sandbox.create()).rejects.toMatchObject({
      code: "provider_unavailable",
    });
  });

  it("rejects create() when the response record is missing sandbox_id (garbage-vs-throw boundary)", async () => {
    // Adversarial: API returns 200 but no sandbox_id field. Today the adapter
    // happily builds a workspace with id=undefined, and the caller can then
    // use it as if it were valid. A well-behaved adapter should reject this
    // rather than mint a workspace with id === undefined.
    const sandbox = new BlazingSandbox({
      baseUrl: BASE,
      fetchFn: fetchMock(
        res(200, {
          container_id: "ctr-orphan",
          state: "ready",
          image: "python:3.12-slim",
          // NOTE: no sandbox_id — the field that maps to workspace.id.
        })
      ),
    });

    let createdId: unknown;
    let threw: unknown;
    try {
      const ws = await sandbox.create();
      createdId = ws.id;
    } catch (e) {
      threw = e;
    }

    // The adapter MUST reject this — it must not return a workspace with an
    // undefined id, since every downstream call (get / exec / destroy) keys
    // off that id and a "successful" workspace with id=undefined is a silent
    // data loss bug.
    if (threw === undefined) {
      expect(createdId).not.toBeUndefined();
    } else {
      expect(threw).toBeInstanceOf(SandboxError);
    }
  });

  it("does not send Authorization header when apiToken is omitted", async () => {
    const fetchFn = fetchMock(res(200, WORKSPACE_RECORD));
    const sandbox = new BlazingSandbox({ baseUrl: BASE, fetchFn });
    await sandbox.create();
    const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers["Authorization"]).toBeUndefined();
  });
});

// ── Execute ────────────────────────────────────────────────────────────

describe("BlazingSandbox.executeTool", () => {
  it("POSTs /v1/workspace/{id}/exec with argv-style {command, args}", async () => {
    const fetchFn = fetchMock(
      res(200, {
        exit_code: 0,
        stdout: "hello\n",
        stderr: "",
        duration_ms: 42,
        timed_out: false,
      })
    );
    const sandbox = new BlazingSandbox({ baseUrl: BASE, fetchFn });

    const result = await sandbox.executeTool("ws_abc", "echo", ["hello"]);
    expect(result).toEqual({
      exitCode: 0,
      stdout: "hello\n",
      stderr: "",
      durationMs: 42,
      timedOut: false,
    });

    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE}/v1/workspace/ws_abc/exec`);
    expect(JSON.parse(init.body as string)).toEqual({
      command: "echo",
      args: ["hello"],
    });
  });

  it("maps a timed-out exec result correctly", async () => {
    const fetchFn = fetchMock(
      res(200, {
        exit_code: 137,
        stdout: "",
        stderr: "command timed out",
        duration_ms: 30000,
        timed_out: true,
      })
    );
    const sandbox = new BlazingSandbox({ baseUrl: BASE, fetchFn });
    const result = await sandbox.executeTool("ws_abc", "sleep", ["60"]);
    expect(result.exitCode).toBe(137);
    expect(result.timedOut).toBe(true);
  });

  it("throws invalid_command for an empty command without calling the API", async () => {
    const fetchFn = fetchMock();
    const sandbox = new BlazingSandbox({ baseUrl: BASE, fetchFn });
    await expect(sandbox.executeTool("ws_abc", "  ")).rejects.toMatchObject({
      code: "invalid_command",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("throws invalid_command for a literal empty-string command (no whitespace at all) without calling the API", async () => {
    // Adversarial: distinct from the existing "  " (whitespace) probe. A
    // regression that switched the guard from `command.trim() === ""` to
    // `command === ""` would let `""` slip through to the API as
    // `{command: "", args: []}` and the Blazing upstream would respond
    // with its own opaque error. The contract is that the empty-string
    // branch is also caught — fetch must NOT be called.
    const fetchFn = fetchMock();
    const sandbox = new BlazingSandbox({ baseUrl: BASE, fetchFn });
    await expect(sandbox.executeTool("ws_abc", "")).rejects.toMatchObject({
      code: "invalid_command",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("throws invalid_command for tabs-and-newlines whitespace (not just spaces) without calling the API", async () => {
    // Adversarial: the guard uses `command.trim()` which catches every
    // ASCII whitespace (space, tab, CR, LF, VT, FF, NBSP-ish). A regression
    // that used a narrower check like `/^ +$/.test(command)` (spaces only)
    // would let `"\t\n"` slip through to the API. Probe with the
    // non-space whitespace mix to lock in the trim()-based contract.
    const fetchFn = fetchMock();
    const sandbox = new BlazingSandbox({ baseUrl: BASE, fetchFn });
    await expect(
      sandbox.executeTool("ws_abc", "\t\n  \t")
    ).rejects.toMatchObject({
      code: "invalid_command",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("throws not_found on a 404 response", async () => {
    const sandbox = new BlazingSandbox({
      baseUrl: BASE,
      fetchFn: fetchMock(res(404, { error: "Sandbox not found: ghost" })),
    });
    await expect(sandbox.executeTool("ghost", "echo")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("throws provider_unavailable on a 503 response", async () => {
    const sandbox = new BlazingSandbox({
      baseUrl: BASE,
      fetchFn: fetchMock(res(503, { error: "service unavailable" })),
    });
    await expect(sandbox.executeTool("ws_abc", "echo")).rejects.toMatchObject({
      code: "provider_unavailable",
    });
  });
});

// ── Destroy ────────────────────────────────────────────────────────────

describe("BlazingSandbox.destroy", () => {
  it("DELETEs /v1/workspace/{id} and resolves on 204", async () => {
    const fetchFn = fetchMock(res(204));
    const sandbox = new BlazingSandbox({ baseUrl: BASE, fetchFn });
    await expect(sandbox.destroy("ws_abc")).resolves.toBeUndefined();
    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE}/v1/workspace/ws_abc`);
    expect(init.method).toBe("DELETE");
  });

  it("destroy is idempotent — 204 even for unknown workspace (API contract)", async () => {
    // The real API returns 204 for unknown IDs (idempotent destroy).
    const fetchFn = fetchMock(res(204));
    const sandbox = new BlazingSandbox({ baseUrl: BASE, fetchFn });
    await expect(sandbox.destroy("nonexistent")).resolves.toBeUndefined();
  });

  it("throws provider_unavailable on a 503", async () => {
    const sandbox = new BlazingSandbox({
      baseUrl: BASE,
      fetchFn: fetchMock(res(503)),
    });
    await expect(sandbox.destroy("ws_abc")).rejects.toMatchObject({
      code: "provider_unavailable",
    });
  });

  it("survives two concurrent destroy() calls on the same workspace — both resolve, both hit the network (API is idempotent)", async () => {
    // Adversarial: in-flight teardown can race with itself (e.g. two cron
    // sweeps for the same run). The Blazing API returns 204 for an
    // already-destroyed id, but the adapter must not throw on the second
    // invocation (e.g. map the "no longer exists" case to a misleading
    // not_found error).
    const fetchFn = fetchMock(res(204), res(204));
    const sandbox = new BlazingSandbox({ baseUrl: BASE, fetchFn });

    const results = await Promise.allSettled([
      sandbox.destroy("ws_abc"),
      sandbox.destroy("ws_abc"),
    ]);

    // Both calls must resolve — neither may reject. A flaky adapter that
    // throws on the second call would surface as a rejected promise here,
    // which is the bug we want to catch.
    for (const r of results) {
      expect(r.status).toBe("fulfilled");
    }
    // And both calls hit the network (the API is the source of truth for
    // idempotency; the adapter does not cache workspace state).
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });
});

// ── Get ────────────────────────────────────────────────────────────────

describe("BlazingSandbox.get", () => {
  it("GETs /v1/workspace/{id} and maps the record on 200", async () => {
    const sandbox = new BlazingSandbox({
      baseUrl: BASE,
      fetchFn: fetchMock(res(200, WORKSPACE_RECORD)),
    });
    const ws = await sandbox.get("ws_abc123");
    expect(ws).not.toBeNull();
    expect(ws?.id).toBe("ws_abc123");
    expect(ws?.status).toBe("ready");
  });

  it("returns null on a 404 instead of throwing", async () => {
    const sandbox = new BlazingSandbox({
      baseUrl: BASE,
      fetchFn: fetchMock(res(404)),
    });
    expect(await sandbox.get("ghost")).toBeNull();
  });
});

// ── List ───────────────────────────────────────────────────────────────

describe("BlazingSandbox.list", () => {
  it("GETs /v1/workspaces and unwraps the {workspaces: [...]} envelope", async () => {
    const sandbox = new BlazingSandbox({
      baseUrl: BASE,
      fetchFn: fetchMock(
        res(200, {
          workspaces: [
            WORKSPACE_RECORD,
            { ...WORKSPACE_RECORD, sandbox_id: "ws_def456" },
          ],
        })
      ),
    });
    const all = await sandbox.list();
    expect(all.map((w) => w.id)).toEqual(["ws_abc123", "ws_def456"]);
    expect(all.every((w) => w.provider === "blazing")).toBe(true);
  });

  it("returns an empty array when the response has no workspaces", async () => {
    const sandbox = new BlazingSandbox({
      baseUrl: BASE,
      fetchFn: fetchMock(res(200, { workspaces: [] })),
    });
    expect(await sandbox.list()).toEqual([]);
  });

  it("does not crash when the list response carries a malformed pagination token alongside workspaces", async () => {
    // Adversarial: real APIs sometimes append pagination metadata to the list
    // envelope. If a future Blazing release adds `next_token: "garbage"` or
    // a non-string `cursor` field, the adapter must not throw — it must
    // return the workspaces it can map and ignore (or warn about) the rest.
    const sandbox = new BlazingSandbox({
      baseUrl: BASE,
      fetchFn: fetchMock(
        res(200, {
          workspaces: [WORKSPACE_RECORD],
          next_token: { not: "a string" }, // wrong shape on purpose
          pagination: { cursor: null, has_more: "yes" }, // also wrong types
        })
      ),
    });

    // Either the call resolves with the workspaces it could map, or it
    // throws a clean SandboxError. It must NOT throw a raw TypeError from
    // a JSON-access path or an unhandled promise rejection.
    try {
      const all = await sandbox.list();
      expect(all.map((w) => w.id)).toEqual(["ws_abc123"]);
    } catch (e) {
      expect(e).toBeInstanceOf(SandboxError);
    }
  });
});

// ── Health ─────────────────────────────────────────────────────────────

describe("BlazingSandbox.health", () => {
  it("GETs /v1/health and reports available from a healthy response", async () => {
    const sandbox = new BlazingSandbox({
      baseUrl: BASE,
      fetchFn: fetchMock(res(200, { available: true, version: "2.4.0" })),
    });
    const health = await sandbox.health();
    expect(health.available).toBe(true);
    expect(health.provider).toBe("blazing");
    expect(health.detail).toBe("2.4.0");
  });

  it("reports available from the real {status: 'healthy', ...} shape Blazing returns", async () => {
    // The live /v1/health payload — verified against a running Blazing stack.
    const sandbox = new BlazingSandbox({
      baseUrl: BASE,
      fetchFn: fetchMock(
        res(200, {
          status: "healthy",
          redis: "connected",
          timestamp: "2026-06-09T06:26:06Z",
          capacity: { queue_depth: 0, bottleneck: "IDLE" },
        })
      ),
    });
    const health = await sandbox.health();
    expect(health.available).toBe(true);
    expect(health.detail).toBe("healthy");
  });

  it("reports available from the legacy {status: 'ok'} shape", async () => {
    const sandbox = new BlazingSandbox({
      baseUrl: BASE,
      fetchFn: fetchMock(res(200, { status: "ok" })),
    });
    const health = await sandbox.health();
    expect(health.available).toBe(true);
  });

  it("reports unavailable when status is neither healthy nor ok", async () => {
    const sandbox = new BlazingSandbox({
      baseUrl: BASE,
      fetchFn: fetchMock(res(200, { status: "degraded" })),
    });
    const health = await sandbox.health();
    expect(health.available).toBe(false);
  });

  it("reports unavailable (never throws) when the provider is unreachable", async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;
    const sandbox = new BlazingSandbox({ baseUrl: BASE, fetchFn });
    const health = await sandbox.health();
    expect(health.available).toBe(false);
    expect(health.detail).toContain("ECONNREFUSED");
  });
});

// ── Capacity ──────────────────────────────────────────────────────────

describe("BlazingSandbox.capacity", () => {
  it("GETs /v1/workspaces/capacity and maps the response", async () => {
    const sandbox = new BlazingSandbox({
      baseUrl: BASE,
      fetchFn: fetchMock(res(200, { used: 3, max: 10, available: 7 })),
    });
    expect(await sandbox.capacity()).toEqual({
      provider: "blazing",
      used: 3,
      max: 10,
      available: 7,
    });
  });

  it("derives available from max - used when available is omitted", async () => {
    const sandbox = new BlazingSandbox({
      baseUrl: BASE,
      fetchFn: fetchMock(res(200, { used: 5, max: 10 })),
    });
    expect((await sandbox.capacity()).available).toBe(5);
  });
});

// ── Circuit breaker ────────────────────────────────────────────────────

describe("BlazingSandbox circuit breaker", () => {
  it("opens the circuit after repeated 5xx failures and stops calling the API", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        res(503, { error: "down" })
      ) as unknown as typeof fetch;
    const sandbox = new BlazingSandbox({ baseUrl: BASE, fetchFn });

    for (let i = 0; i < 5; i++) {
      await expect(sandbox.create()).rejects.toMatchObject({
        code: "provider_unavailable",
      });
    }
    // 6th call: the breaker is open — it rejects without hitting the network.
    await expect(sandbox.create()).rejects.toMatchObject({
      code: "provider_unavailable",
    });
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(5);
  });

  it("maps an AbortError (timeout) to provider_unavailable", async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("aborted"), { name: "AbortError" })
      ) as unknown as typeof fetch;
    const sandbox = new BlazingSandbox({ baseUrl: BASE, fetchFn });
    await expect(sandbox.create()).rejects.toMatchObject({
      code: "provider_unavailable",
    });
  });

  it("half-opens after the 30s reset window and CLOSES again on a successful probe (recovery, not stuck-open)", async () => {
    // Adversarial: the existing test only confirms the breaker OPENS. A
    // regression that makes the breaker one-way (e.g. fails to reset on a
    // successful probe, or never transitions to HALF_OPEN) would surface
    // here as the sandbox being permanently short-circuited — every call
    // after the recovery window would reject without hitting the network,
    // even when the upstream is healthy again. We trip the breaker, advance
    // the clock past the 30s reset window, send a successful probe, and
    // then verify the next failure is a fresh failure (network was hit,
    // breaker is CLOSED again) rather than an immediate open-circuit reject.
    vi.useFakeTimers();
    try {
      const fetchFn = vi.fn();
      // First 5 calls → 503 (trip the breaker).
      for (let i = 0; i < 5; i++) {
        fetchFn.mockResolvedValueOnce(res(503, { error: "down" }));
      }
      // 6th call (HALF_OPEN probe) → 200 success.
      fetchFn.mockResolvedValueOnce(res(200, WORKSPACE_RECORD));
      // 7th call (CLOSED state — should hit network) → 200 success.
      fetchFn.mockResolvedValueOnce(res(200, WORKSPACE_RECORD));
      const sandbox = new BlazingSandbox({ baseUrl: BASE, fetchFn });

      // Trip the breaker.
      for (let i = 0; i < 5; i++) {
        await expect(sandbox.create()).rejects.toMatchObject({
          code: "provider_unavailable",
        });
      }
      // 6th call: breaker is OPEN — short-circuits without hitting network.
      await expect(sandbox.create()).rejects.toMatchObject({
        code: "provider_unavailable",
      });
      expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(5);

      // Advance past the 30s reset window — breaker should transition to
      // HALF_OPEN on the next call.
      vi.advanceTimersByTime(31_000);

      // 7th call: HALF_OPEN probe — the breaker DOES hit the network this
      // time, and the success should CLOSE the breaker.
      const recovered = await sandbox.create();
      expect(recovered.id).toBe("ws_abc123");
      expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(6);

      // 8th call: breaker is now CLOSED — must hit the network normally.
      const next = await sandbox.create();
      expect(next.id).toBe("ws_abc123");
      expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(7);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── Iteration 2: exec() response-shape adversarial probes ──────────────

describe("BlazingSandbox.executeTool — response shape edge cases", () => {
  it("wraps a malformed-JSON exec response in a SandboxError rather than leaking a raw SyntaxError", async () => {
    // Adversarial: the Blazing API is supposed to return a JSON object for
    // exec. If the body is corrupted mid-stream (proxy truncation, an
    // upstream bug, a load balancer injecting HTML), `res.json()` throws a
    // raw SyntaxError that the SandboxError contract cannot map — routes
    // would surface "Unexpected token" to clients. The adapter should
    // convert this into a clean `exec_failed` (or provider_unavailable)
    // SandboxError instead.
    const truncatedBody = '{"exit_code": 0, "stdout": "hel'; // cut mid-string
    const fetchFn = fetchMock(
      new Response(truncatedBody, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const sandbox = new BlazingSandbox({ baseUrl: BASE, fetchFn });

    let caught: unknown;
    try {
      await sandbox.executeTool("ws_abc", "echo");
    } catch (e) {
      caught = e;
    }

    // Must be a SandboxError so callers can map it via sandboxErrorToResponse.
    // A raw SyntaxError / TypeError is the bug we want to catch.
    expect(caught).toBeInstanceOf(SandboxError);
    expect((caught as SandboxError).code).toMatch(
      /exec_failed|provider_unavailable/
    );
  });

  it("preserves the full stdout payload even when it exceeds 1MB (no silent truncation)", async () => {
    // Adversarial: a runaway command (e.g. `cat /var/log/syslog`) can emit
    // multi-MB stdout. The adapter must round-trip the entire payload to
    // the caller — silently truncating would let bugs in agents hide
    // because the model only ever sees the first N bytes of logs.
    const bigStdout = "x".repeat(1_100_000); // ~1.05 MB
    const fetchFn = fetchMock(
      res(200, {
        exit_code: 0,
        stdout: bigStdout,
        stderr: "",
        duration_ms: 1000,
        timed_out: false,
      })
    );
    const sandbox = new BlazingSandbox({ baseUrl: BASE, fetchFn });

    const result = await sandbox.executeTool("ws_abc", "cat", ["/big/log"]);

    expect(result.stdout.length).toBe(bigStdout.length);
    // Sanity: no truncation in the middle.
    expect(result.stdout.startsWith("x")).toBe(true);
    expect(result.stdout.endsWith("x")).toBe(true);
  });
});

// ── Iteration 4: 4xx response-body mapping ────────────────────────────

describe("BlazingSandbox — 4xx response body mapping", () => {
  it("includes the body's `error` field in the SandboxError message for a 400 response (not just the generic status)", async () => {
    // Adversarial: when the Blazing API returns 400 with a JSON body like
    // `{"error":"invalid image"}`, the SandboxError surfaced to callers
    // must carry that detail — a route handler that catches the error and
    // includes `err.message` in the JSON response needs to tell the agent
    // WHY the call was rejected, not just "Blazing API 400". The 4xx path
    // goes through errorText() (which reads the body), but the actual
    // thrown message must include the parsed `error` field rather than
    // discarding it for the fallback string.
    const fetchFn = fetchMock(res(400, { error: "invalid image: bad digest" }));
    const sandbox = new BlazingSandbox({ baseUrl: BASE, fetchFn });

    let caught: unknown;
    try {
      await sandbox.create({ image: "garbage:latest" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SandboxError);
    // The message must surface "invalid image" from the upstream body, not
    // just the generic "Blazing API 400" / "workspace not found" fallback.
    expect((caught as SandboxError).message.toLowerCase()).toContain(
      "invalid image"
    );
  });
});

// ── Iteration 3: 5xx response-body mapping ────────────────────────────

describe("BlazingSandbox — 5xx response body mapping", () => {
  it("includes the body's `error` field in the SandboxError message when a 5xx response carries a JSON body", async () => {
    // Adversarial: when the Blazing API returns 500 with a JSON body like
    // `{"error":"db connection lost"}`, the message we throw to callers
    // must surface that detail — operators triaging a route failure need to
    // see WHY the provider failed, not just "Blazing API 500". Today the
    // adapter discards the 5xx body in guardedFetch (it throws as soon as
    // status >= 500) and only carries the generic status into the
    // SandboxError message. A regression that reads the body before
    // throwing would expose the underlying cause.
    const fetchFn = fetchMock(res(500, { error: "db connection lost" }));
    const sandbox = new BlazingSandbox({ baseUrl: BASE, fetchFn });

    let caught: unknown;
    try {
      await sandbox.create();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SandboxError);
    // The message must include the upstream error text, not just "Blazing API 500".
    expect((caught as SandboxError).message).toContain("db connection lost");
  });

  it("falls back to a useful message when a 5xx response has an empty body", async () => {
    // Adversarial: a bare 500 with no body must NOT produce a message of just
    // "Blazing API 500" with trailing whitespace — operators need a
    // non-empty, trimmed reason. The message should at minimum mention the
    // status and ideally include some fallback like "no body" or "internal".
    const fetchFn = fetchMock(res(500));
    const sandbox = new BlazingSandbox({ baseUrl: BASE, fetchFn });

    let caught: unknown;
    try {
      await sandbox.create();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SandboxError);
    const msg = (caught as SandboxError).message;
    expect(msg.length).toBeGreaterThan(0);
    expect(msg).toBe(msg.trim());
    expect(msg).toMatch(/500/);
  });
});
