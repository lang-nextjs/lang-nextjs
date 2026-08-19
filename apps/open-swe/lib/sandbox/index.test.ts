import { describe, it, expect, vi, afterEach } from "vitest";
import {
  getSandbox,
  __resetSandbox,
  __setSandbox,
  DockerSandbox,
  SandboxError,
  SandboxErrorCode,
  sandboxErrorToResponse,
  type Sandbox,
} from "./index";

describe("getSandbox", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    __resetSandbox();
  });

  it("returns a Docker sandbox by default", () => {
    __resetSandbox();
    const sandbox = getSandbox();
    expect(sandbox.provider).toBe("docker");
    expect(sandbox).toBeInstanceOf(DockerSandbox);
  });

  it("returns BlazingSandbox when BLAZING_API_URL is set", () => {
    __resetSandbox();
    vi.stubEnv("BLAZING_API_URL", "http://blazing.test");
    vi.stubEnv("BLAZING_API_TOKEN", "test-token");
    const sandbox = getSandbox();
    expect(sandbox.provider).toBe("blazing");
    __resetSandbox();
  });

  it("returns the same singleton across calls", () => {
    __resetSandbox();
    expect(getSandbox()).toBe(getSandbox());
  });

  it("__setSandbox installs a custom sandbox (the ADAPT-06 seam)", () => {
    const fake = { provider: "blazing" } as unknown as Sandbox;
    __setSandbox(fake);
    expect(getSandbox()).toBe(fake);
    __resetSandbox();
  });
});

// ---------------------------------------------------------------------------
// Adversarial concurrency probes (iteration 2)
// ---------------------------------------------------------------------------

describe("getSandbox — concurrent construction race", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    __resetSandbox();
  });

  it("returns the SAME singleton instance across 100 parallel getSandbox() calls (no double-construction race)", async () => {
    // Adversarial: a hot route handler that fans out 100 sub-tasks each
    // calling getSandbox() in the same tick would race against the
    // singleton-check if the construction path were async. Because the
    // factory is synchronous and the singleton is a module-scoped `let`,
    // every call must observe the same instance — never two distinct
    // DockerSandboxes with separate workspace maps. A regression that
    // removed the early-return (e.g. `async function getSandbox()` with
    // an `await` before the singleton check) would surface here.
    __resetSandbox();

    const instances = await Promise.all(
      Array.from({ length: 100 }, () => Promise.resolve(getSandbox()))
    );

    const first = instances[0];
    // All 100 must be reference-equal to the first.
    for (const inst of instances) {
      expect(inst).toBe(first);
    }
    // And it must be exactly one logical container of state.
    expect(instances).toHaveLength(100);
  });
});

// ---------------------------------------------------------------------------
// Adversarial edge-case tests (iteration 5)
// ---------------------------------------------------------------------------

describe("getSandbox — BLAZING_API_URL whitespace boundary", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    __resetSandbox();
  });

  it("treats whitespace-only BLAZING_API_URL as UNSET and falls back to Docker", () => {
    // Provider selection uses `process.env.BLAZING_API_URL?.trim()` — a value
    // like "   " should be treated as unset (falls back to Docker). If a
    // future change drops the .trim() call, this test surfaces it: a
    // BlazingSandbox would be constructed with baseUrl="   ", which silently
    // sends every request to a relative URL.
    __resetSandbox();
    vi.stubEnv("BLAZING_API_URL", "   ");
    vi.stubEnv("BLAZING_API_TOKEN", "   ");

    const sandbox = getSandbox();

    // DESIGNED TO FAIL if trim() is removed — BlazingSandbox would be returned
    // with a whitespace baseUrl, which is incorrect.
    expect(sandbox.provider).toBe("docker");
    expect(sandbox).toBeInstanceOf(DockerSandbox);
    __resetSandbox();
  });
});

describe("sandboxErrorToResponse", () => {
  const cases: [SandboxErrorCode, number][] = [
    ["not_found", 404],
    ["at_capacity", 429],
    ["invalid_command", 422],
    ["docker_unavailable", 502],
    ["create_failed", 502],
    ["exec_failed", 502],
    ["destroy_failed", 502],
  ];

  it.each(cases)(
    "maps SandboxError code %s to HTTP %d",
    async (code, status) => {
      const res = sandboxErrorToResponse(new SandboxError(code, "detail"));
      expect(res.status).toBe(status);
      const body = await res.json();
      expect(body.code).toBe(code);
      expect(body.error).toBe("detail");
    }
  );

  it("maps unknown errors to 500", async () => {
    const res = sandboxErrorToResponse(new Error("unexpected"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/internal/i);
  });
});

// ---------------------------------------------------------------------------
// Adversarial provider-precedence probe (iteration 4)
// ---------------------------------------------------------------------------

describe("getSandbox — provider precedence when both Blazing and Docker are configured", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    __resetSandbox();
  });

  it("prefers BlazingSandbox over DockerSandbox when BLAZING_API_URL is set (regardless of Docker env vars being present)", () => {
    // Adversarial: an operator who has both docker installed locally AND
    // a remote Blazing cluster pointed at via BLAZING_API_URL might expect
    // the factory to "auto-detect" Docker when the URL is malformed.
    // The contract is that BLAZING_API_URL is the BOOT-TIME switch: any
    // non-whitespace value routes through Blazing. A regression that
    // also inspected SANDBOX_PROVIDER/DOCKER_HOST and silently fell
    // through to Docker when those were set would surface here — we'd
    // get Docker instead of Blazing even though BLAZING_API_URL was
    // explicitly set.
    __resetSandbox();
    vi.stubEnv("BLAZING_API_URL", "http://blazing.test");
    vi.stubEnv("BLAZING_API_TOKEN", "tok");
    // Also set Docker env vars to a value that, if checked, would resolve
    // to a different provider. The factory must IGNORE these.
    vi.stubEnv("SANDBOX_PROVIDER", "docker");
    vi.stubEnv("DOCKER_HOST", "unix:///var/run/docker.sock");

    const sandbox = getSandbox();

    expect(sandbox.provider).toBe("blazing");
    expect(sandbox).not.toBeInstanceOf(DockerSandbox);
    __resetSandbox();
  });
});

// ---------------------------------------------------------------------------
// Adversarial singleton-stability probes (iteration 3)
// ---------------------------------------------------------------------------

describe("getSandbox — singleton survives env var changes between calls", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    __resetSandbox();
  });

  it("does not rebuild the singleton when BLAZING_API_URL is set/unset between calls (no late-binding of provider)", () => {
    // Adversarial: a test runner that flips BLAZING_API_URL between calls
    // must NOT trigger a second construction. The factory reads env once
    // on first use, caches the resulting sandbox, and reuses it for the
    // process lifetime — the env var is a boot-time decision, not a
    // hot-swap trigger. A regression that re-read env on every call would
    // surface here as a provider flip from docker → blazing (or vice
    // versa) after the env was changed.
    __resetSandbox();
    vi.stubEnv("BLAZING_API_URL", "");
    const first = getSandbox();
    expect(first.provider).toBe("docker");

    // Now flip the env to "enable Blazing". A naive factory would rebuild.
    vi.stubEnv("BLAZING_API_URL", "http://blazing.test");
    vi.stubEnv("BLAZING_API_TOKEN", "tok");

    const second = getSandbox();
    expect(second).toBe(first); // SAME instance — env changes are NOT hot-reloaded
    expect(second.provider).toBe("docker");

    __resetSandbox();
  });
});
