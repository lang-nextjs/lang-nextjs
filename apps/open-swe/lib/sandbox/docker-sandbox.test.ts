import { describe, it, expect, vi } from "vitest";
import {
  DockerSandbox,
  DockerExecFn,
  DockerExecResult,
} from "./docker-sandbox";
import { SandboxError } from "./types";

/** A successful `docker` invocation. */
function ok(
  stdout = "",
  over: Partial<DockerExecResult> = {}
): DockerExecResult {
  return { stdout, stderr: "", exitCode: 0, timedOut: false, ...over };
}
/** A failed `docker` invocation. */
function fail(
  stderr = "boom",
  exitCode = 1,
  over: Partial<DockerExecResult> = {}
): DockerExecResult {
  return { stdout: "", stderr, exitCode, timedOut: false, ...over };
}

type Verb = "run" | "exec" | "rm" | "version";

/**
 * Build a branching `docker` mock. Each verb has a sensible default; pass a
 * handler to override a specific verb for a test.
 */
function execMock(
  handlers: Partial<Record<Verb, () => DockerExecResult>> = {}
): DockerExecFn {
  let runCount = 0;
  return vi.fn<DockerExecFn>(async (args) => {
    const verb = args[0] as Verb;
    if (handlers[verb]) return handlers[verb]!();
    switch (verb) {
      case "run":
        return ok(`container-${++runCount}`);
      case "version":
        return ok("28.0.0");
      default:
        return ok("");
    }
  });
}

/** The args array of the first `docker` call that started with `verb`. */
function argsOf(exec: DockerExecFn, verb: Verb): string[] {
  const calls = (exec as ReturnType<typeof vi.fn>).mock.calls;
  const hit = calls.find((c: unknown[]) => (c[0] as string[])[0] === verb);
  if (!hit) throw new Error(`no docker call started with '${verb}'`);
  return hit[0] as string[];
}

const DEFAULTS = {
  image: "test-img",
  memoryLimitMb: 256,
  cpuLimit: 0.5,
  execTimeoutMs: 5_000,
};

describe("DockerSandbox.create", () => {
  it("runs `docker run` with resource limits and returns a ready workspace", async () => {
    const exec = execMock();
    const sandbox = new DockerSandbox({ exec, defaults: DEFAULTS });

    const ws = await sandbox.create();

    expect(ws.status).toBe("ready");
    expect(ws.provider).toBe("docker");
    expect(ws.containerId).toBe("container-1");
    expect(ws.image).toBe("test-img");
    expect(ws.containerName).toBe(`open-swe-ws-${ws.id}`);

    const runArgs = argsOf(exec, "run");
    expect(runArgs).toEqual(expect.arrayContaining(["run", "-d", "--rm"]));
    expect(runArgs).toEqual(
      expect.arrayContaining(["--memory", "256m", "--cpus", "0.5"])
    );
    expect(runArgs).toEqual(
      expect.arrayContaining(["--name", `open-swe-ws-${ws.id}`])
    );
    // Image followed by the keep-alive command, in order.
    expect(runArgs.slice(-4)).toEqual(["test-img", "tail", "-f", "/dev/null"]);
  });

  it("passes config.env entries as --env flags", async () => {
    const exec = execMock();
    const sandbox = new DockerSandbox({ exec, defaults: DEFAULTS });

    await sandbox.create({ env: { FOO: "bar", TOKEN: "xyz" } });

    const runArgs = argsOf(exec, "run");
    expect(runArgs).toEqual(
      expect.arrayContaining(["--env", "FOO=bar", "--env", "TOKEN=xyz"])
    );
  });

  it("rejects with at_capacity once max workspaces are held", async () => {
    const exec = execMock();
    const sandbox = new DockerSandbox({
      exec,
      defaults: DEFAULTS,
      maxWorkspaces: 1,
    });

    await sandbox.create();
    await expect(sandbox.create()).rejects.toMatchObject({
      name: "SandboxError",
      code: "at_capacity",
    });
  });

  it("throws create_failed when `docker run` exits non-zero", async () => {
    const exec = execMock({ run: () => fail("no such image", 125) });
    const sandbox = new DockerSandbox({ exec, defaults: DEFAULTS });

    await expect(sandbox.create()).rejects.toBeInstanceOf(SandboxError);
    await expect(sandbox.create()).rejects.toMatchObject({
      code: "create_failed",
    });
  });

  it("maps ENOENT (no docker binary on PATH) on create() to a clean create_failed error rather than a raw spawn error", async () => {
    // Adversarial: when `docker` is not installed, child_process surfaces a
    // non-zero exit with an ENOENT-tagged stderr. The adapter must surface
    // this through the SandboxError contract (create_failed, message ≤ 500
    // chars) — NOT throw the raw NodeJS errno error, which would leak
    // internal stack frames and miss the error-code mapping in routes.
    const exec = execMock({
      run: () => fail("ENOENT: spawn docker ENOENT", 127),
    });
    const sandbox = new DockerSandbox({ exec, defaults: DEFAULTS });

    let caught: unknown;
    try {
      await sandbox.create();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SandboxError);
    expect((caught as SandboxError).code).toBe("create_failed");
    // The trimmed message must include the cause so logs are actionable.
    expect((caught as SandboxError).message.toLowerCase()).toContain("enoent");
    // And the workspace must NOT have been half-tracked — get() returns null.
    expect(await sandbox.list()).toEqual([]);
  });
});

describe("DockerSandbox.executeTool", () => {
  it("runs `docker exec` in the workspace container and returns the result", async () => {
    const exec = execMock({ exec: () => ok("hello\n") });
    const sandbox = new DockerSandbox({ exec, defaults: DEFAULTS });
    const ws = await sandbox.create();

    const result = await sandbox.executeTool(ws.id, "echo", ["hello"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello\n");
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(argsOf(exec, "exec")).toEqual([
      "exec",
      ws.containerName,
      "echo",
      "hello",
    ]);
  });

  it("surfaces a non-zero tool exit as a result, not a thrown error", async () => {
    const exec = execMock({ exec: () => fail("not found", 127) });
    const sandbox = new DockerSandbox({ exec, defaults: DEFAULTS });
    const ws = await sandbox.create();

    const result = await sandbox.executeTool(ws.id, "missing-cmd");
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toBe("not found");
  });

  it("reports timedOut when the execution is killed", async () => {
    const exec = execMock({
      exec: () => ok("", { timedOut: true, exitCode: 124 }),
    });
    const sandbox = new DockerSandbox({ exec, defaults: DEFAULTS });
    const ws = await sandbox.create();

    const result = await sandbox.executeTool(ws.id, "sleep", ["999"]);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
  });

  it("throws not_found for an unknown workspace", async () => {
    const sandbox = new DockerSandbox({ exec: execMock(), defaults: DEFAULTS });
    await expect(sandbox.executeTool("ghost", "echo")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("throws invalid_command for an empty command", async () => {
    const sandbox = new DockerSandbox({ exec: execMock(), defaults: DEFAULTS });
    const ws = await sandbox.create();
    await expect(sandbox.executeTool(ws.id, "   ")).rejects.toMatchObject({
      code: "invalid_command",
    });
  });

  it("passes empty-string args through to `docker exec` as separate positional arguments", async () => {
    // Adversarial: agent code may build argv as `["", arg1, ""]` when
    // interleaving optional flags. The adapter must NOT silently filter
    // these out (which would surprise the caller), NOR throw — docker
    // itself will reject the empty positional. The exec() call must reach
    // the docker CLI with all four positional tokens, in order, so the
    // underlying error is actionable.
    const exec = execMock({ exec: () => ok("ran\n") });
    const sandbox = new DockerSandbox({ exec, defaults: DEFAULTS });
    const ws = await sandbox.create();

    await sandbox.executeTool(ws.id, "echo", ["", "hello", ""]);

    const execArgs = argsOf(exec, "exec");
    // ["exec", containerName, command, ...args] — verify all 6 tokens.
    expect(execArgs).toEqual([
      "exec",
      ws.containerName,
      "echo",
      "",
      "hello",
      "",
    ]);
  });
});

describe("DockerSandbox.destroy", () => {
  it("runs `docker rm -f` and forgets the workspace", async () => {
    const exec = execMock();
    const sandbox = new DockerSandbox({ exec, defaults: DEFAULTS });
    const ws = await sandbox.create();

    await sandbox.destroy(ws.id);

    expect(argsOf(exec, "rm")).toEqual(["rm", "-f", ws.containerName]);
    expect(await sandbox.get(ws.id)).toBeNull();
  });

  it("throws not_found for an unknown workspace", async () => {
    const sandbox = new DockerSandbox({ exec: execMock(), defaults: DEFAULTS });
    await expect(sandbox.destroy("ghost")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("throws destroy_failed but still forgets the workspace when rm fails", async () => {
    const exec = execMock({ rm: () => fail("rm error", 1) });
    const sandbox = new DockerSandbox({ exec, defaults: DEFAULTS });
    const ws = await sandbox.create();

    await expect(sandbox.destroy(ws.id)).rejects.toMatchObject({
      code: "destroy_failed",
    });
    expect(await sandbox.get(ws.id)).toBeNull();
  });
});

describe("DockerSandbox.health", () => {
  it("reports available when `docker version` succeeds", async () => {
    const exec = execMock({ version: () => ok("28.1.0") });
    const sandbox = new DockerSandbox({ exec, defaults: DEFAULTS });

    const health = await sandbox.health();
    expect(health.available).toBe(true);
    expect(health.detail).toContain("28.1.0");
  });

  it("reports unavailable when the daemon cannot be reached", async () => {
    const exec = execMock({
      version: () => fail("Cannot connect to the Docker daemon", 1),
    });
    const sandbox = new DockerSandbox({ exec, defaults: DEFAULTS });

    const health = await sandbox.health();
    expect(health.available).toBe(false);
    expect(health.detail).toContain("Cannot connect");
  });

  it("reports unavailable (not throws) when the `docker` binary itself is missing (ENOENT)", async () => {
    // Adversarial: on a fresh CI box or a minimal container, the docker CLI
    // is absent. node:child_process surfaces ENOENT as a numeric exit 127 +
    // an stderr like "ENOENT: spawn docker ENOENT". health() must fold that
    // into a clean SandboxHealth, NOT throw — a throw here would crash the
    // /api/sandbox/health route before the server can report the condition.
    const exec = execMock({
      version: () => fail("ENOENT: spawn docker ENOENT", 127),
    });
    const sandbox = new DockerSandbox({ exec, defaults: DEFAULTS });

    const health = await sandbox.health();
    expect(health.available).toBe(false);
    expect(health.provider).toBe("docker");
    // The detail must surface the cause (ENOENT) so an operator can act on it.
    expect(health.detail.toLowerCase()).toContain("enoent");
  });
});

describe("DockerSandbox.capacity / get / list", () => {
  it("capacity reflects used and available slots", async () => {
    const sandbox = new DockerSandbox({
      exec: execMock(),
      defaults: DEFAULTS,
      maxWorkspaces: 3,
    });
    await sandbox.create();
    await sandbox.create();

    const cap = await sandbox.capacity();
    expect(cap).toMatchObject({
      provider: "docker",
      used: 2,
      max: 3,
      available: 1,
    });
  });

  it("get and list return tracked workspaces", async () => {
    const sandbox = new DockerSandbox({ exec: execMock(), defaults: DEFAULTS });
    const a = await sandbox.create({ label: "first" });
    const b = await sandbox.create({ label: "second" });

    expect((await sandbox.get(a.id))?.label).toBe("first");
    const all = await sandbox.list();
    expect(all.map((w) => w.id).sort()).toEqual([a.id, b.id].sort());
  });
});

describe("DockerSandbox.create — duplicate label", () => {
  it("creates two distinct workspaces when create() is called twice with the same label (no silent dedup)", async () => {
    // Adversarial: an agent that retries after a transient `docker run`
    // failure might call create() with the same human-readable label
    // twice (e.g. "smoke-test-run-42"). The implementation MUST NOT
    // dedupe by label — labels are observability metadata, not a unique
    // key. Each call should mint a fresh workspace id (UUID), reach the
    // docker CLI with a distinct `--name`, and surface in list() as two
    // separate entries that both carry the duplicate label. A regression
    // that keyed the in-memory map by label (and reused the prior
    // handle) would surface here as a single workspace, or as
    // `at_capacity` on the second call when maxWorkspaces=1.
    const exec = execMock();
    const sandbox = new DockerSandbox({
      exec,
      defaults: DEFAULTS,
      maxWorkspaces: 2,
    });

    const a = await sandbox.create({ label: "smoke-test-run-42" });
    const b = await sandbox.create({ label: "smoke-test-run-42" });

    // Distinct workspace ids (UUIDs) — labels are not a dedup key.
    expect(a.id).not.toBe(b.id);

    // Both still tracked in memory.
    const all = await sandbox.list();
    expect(all).toHaveLength(2);
    expect(all.every((w) => w.label === "smoke-test-run-42")).toBe(true);

    // Both `docker run` calls reached the CLI with the open-swe.sandbox=1
    // daemon-label flag and distinct container names.
    const runCalls = (exec as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => (c[0] as string[])[0] === "run"
    );
    expect(runCalls).toHaveLength(2);
    const names = runCalls.map((c: unknown[]) => {
      const argv = c[0] as string[];
      return argv[argv.indexOf("--name") + 1];
    });
    expect(names[0]).not.toBe(names[1]);
    for (const args of runCalls) {
      expect(args[0]).toEqual(
        expect.arrayContaining(["--label", "open-swe.sandbox=1"])
      );
    }
  });
});

// ── Iteration 4: list() / destroy-during-exec race ────────────────────

describe("DockerSandbox — list() without a reachable daemon", () => {
  it("returns the in-memory tracked workspaces from list() without ever shelling out to the docker binary", async () => {
    // Adversarial: a host without docker should not have list() throw or
    // hang. list() is purely an in-memory operation over the Map of
    // tracked workspaces — it MUST NOT shell out to `docker ps`. If a
    // regression made list() consult the daemon (e.g. `docker ps -q
    // --filter label=open-swe.sandbox=1`), this test would hang the test
    // suite or surface a non-empty exec call list.
    const exec = execMock({
      // If the adapter hits the docker CLI for any reason, return ENOENT.
      // Any such call is the bug we want to catch.
      run: () => fail("ENOENT: spawn docker ENOENT", 127),
      version: () => fail("ENOENT: spawn docker ENOENT", 127),
      exec: () => fail("ENOENT: spawn docker ENOENT", 127),
      rm: () => fail("ENOENT: spawn docker ENOENT", 127),
    });
    const sandbox = new DockerSandbox({ exec, defaults: DEFAULTS });

    // list() on a fresh sandbox with no daemon → empty array, no docker call.
    const before = await sandbox.list();
    expect(before).toEqual([]);

    // After a (failed) create attempt, list() is still empty and still
    // does NOT shell out — create() rejects cleanly with create_failed.
    await expect(sandbox.create()).rejects.toMatchObject({
      code: "create_failed",
    });
    const after = await sandbox.list();
    expect(after).toEqual([]);

    // The docker binary must NOT have been invoked by either list() call.
    // Only `run` (from the failed create) and `version` (never invoked)
    // would be acceptable — `exec` and `rm` must remain at zero.
    const calls = (exec as ReturnType<typeof vi.fn>).mock.calls;
    const verbs = calls.map((c: unknown[]) => (c[0] as string[])[0]);
    expect(verbs).not.toContain("exec");
    expect(verbs).not.toContain("rm");
    expect(verbs).not.toContain("ps");
  });
});

describe("DockerSandbox.destroy — concurrent in-flight executeTool", () => {
  it("forgets the workspace immediately on destroy() even if an executeTool is still pending against the same handle", async () => {
    // Adversarial: a long-running exec is in flight (e.g. a multi-minute
    // `npm install`). The cron sweeper calls destroy() concurrently — the
    // workspace must be forgotten from the in-memory map AT THE destroy()
    // CALL SITE, not deferred until the exec resolves. A subsequent
    // executeTool on the same id must reject with not_found rather than
    // reaching the docker CLI on a workspace the sandbox no longer knows
    // about.
    let resolveExec!: (
      value: import("./docker-sandbox").DockerExecResult
    ) => void;
    const inFlight = new Promise<import("./docker-sandbox").DockerExecResult>(
      (r) => {
        resolveExec = r;
      }
    );

    const exec = vi.fn<DockerExecFn>(async (args) => {
      if (args[0] === "exec") {
        return inFlight; // hang until the test resolves it
      }
      // Default for run / rm / version — succeed quickly.
      const verb = args[0] as Verb;
      switch (verb) {
        case "run":
          return ok("container-1");
        case "version":
          return ok("28.0.0");
        default:
          return ok("");
      }
    });
    const sandbox = new DockerSandbox({ exec, defaults: DEFAULTS });
    const ws = await sandbox.create();

    // Kick off exec() but DO NOT await it — it's parked on `inFlight`.
    const execPromise = sandbox.executeTool(ws.id, "sleep", ["999"]);
    // Give the microtask queue a chance to start the docker call.
    await Promise.resolve();

    // Now destroy() — this MUST run rm -f and delete the workspace from
    // the map synchronously, before the in-flight exec resolves.
    await sandbox.destroy(ws.id);

    // The in-memory map must already be empty — get() returns null.
    expect(await sandbox.get(ws.id)).toBeNull();

    // A subsequent executeTool on the same id MUST reject with not_found,
    // not silently re-attach to the still-running exec.
    await expect(
      sandbox.executeTool(ws.id, "echo", ["late"])
    ).rejects.toMatchObject({
      code: "not_found",
    });

    // Now unblock the original in-flight exec. It resolves, but the caller
    // has long since given up on the handle — the promise resolves to a
    // result that we can ignore. Critically, this MUST NOT throw, and the
    // destroy must have removed the workspace BEFORE the exec returned.
    resolveExec({
      stdout: "ignored",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });
    await execPromise.catch(() => {
      /* may reject if the adapter surfaces the race; either is acceptable */
    });
  });
});

// ── Iteration 3: stale-handle rejection + no shell wrapping ────────

describe("DockerSandbox.executeTool — stale handles and shell safety", () => {
  it("rejects executeTool with not_found after the workspace has been destroyed (stale handle)", async () => {
    // Adversarial: a long-running agent might hold a workspace id from a
    // previous request. After the user kills the workspace (or the cron
    // sweeper tears it down), the next tool call must NOT silently re-run
    // — it must reject with not_found. A regression that lazily
    // re-creates the workspace, or worse, hits `docker exec` on a
    // container the sandbox no longer knows about, would surface here.
    const exec = execMock();
    const sandbox = new DockerSandbox({ exec, defaults: DEFAULTS });
    const ws = await sandbox.create();

    await sandbox.destroy(ws.id);

    let caught: unknown;
    try {
      await sandbox.executeTool(ws.id, "echo", ["still-there?"]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SandboxError);
    expect((caught as SandboxError).code).toBe("not_found");
  });

  it("passes shell-metacharacter args through to `docker exec` as a single token (no shell wrapping by the adapter)", async () => {
    // Adversarial: an agent might build args that include shell
    // metacharacters like `;`, `&&`, `|`, backticks, etc. If the adapter
    // ever decided to "helpfully" pass the command through a shell, a
    // user-supplied argument like `hello; rm -rf /` would execute as two
    // commands. The contract is that the adapter is argv-style — every
    // arg must be passed as its own token to `docker exec`, which itself
    // does not invoke a shell. A regression that joined args with spaces,
    // quoted them, or wrapped the call in `sh -c` would surface here
    // because the recorded args would contain the joined/quoted string.
    const exec = execMock({ exec: () => ok("ran\n") });
    const sandbox = new DockerSandbox({ exec, defaults: DEFAULTS });
    const ws = await sandbox.create();

    await sandbox.executeTool(ws.id, "echo", [
      "hello; rm -rf /",
      "$(touch /tmp/x)",
      "a|b",
    ]);

    const execArgs = argsOf(exec, "exec");
    // The three arg tokens must arrive intact — not split, joined, or
    // wrapped in `sh -c "..."`.
    expect(execArgs).toEqual([
      "exec",
      ws.containerName,
      "echo",
      "hello; rm -rf /",
      "$(touch /tmp/x)",
      "a|b",
    ]);
    // And `docker exec` must have been invoked exactly once with no shell.
    expect(execArgs.some((a) => a === "sh" || a === "-c")).toBe(false);
  });
});
