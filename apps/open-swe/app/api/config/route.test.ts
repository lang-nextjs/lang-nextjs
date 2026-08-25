import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GET } from "./route";

/**
 * `fetch` IS STUBBED FOR EVERY CASE, INCLUDING THE FALLBACK ONES.
 *
 * These tests originally passed and then started failing the moment a real
 * backend happened to be running on :8001 — the route reached it and reported
 * `nvidia` no matter what the test set in `process.env`. A unit test that
 * silently changes its answer depending on what is listening on a port is not
 * testing the route, it is testing the developer's machine.
 *
 * So the transport is controlled in every case. `unreachableBackend()` is the
 * default because most cases are about the local-env fallback; the cases that
 * are about the backend say so by stubbing a response.
 */
function unreachableBackend() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("connection refused");
    })
  );
}

function backendSays(llm: { configured: boolean; provider: string | null }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ llm }), { status: 200 }))
  );
}

function backendObservability(observability: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            llm: { configured: true, provider: "nvidia" },
            observability,
          }),
          { status: 200 }
        )
    )
  );
}

const KEYS = [
  "NVIDIA_API_KEY",
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "DJANGO_URL",
  "FASTAPI_URL",
  // Observability vars are cleaned up here too. Left out, a case that sets
  // LANGCHAIN_API_KEY leaks into every later case and they pass for its reason, not theirs.
  "LANGCHAIN_TRACING_V2",
  "LANGCHAIN_API_KEY",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  unreachableBackend(); // default: exercise the local-env fallback
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function body() {
  return (await (await GET()).json()) as {
    llm: Record<string, boolean>;
    activeLlm: string | null;
    backends: Record<string, boolean>;
  };
}

describe("/api/config — never leaks a value", () => {
  it("reports presence as a boolean, not the key", async () => {
    process.env.NVIDIA_API_KEY = "nvapi-SECRET-VALUE-DO-NOT-LEAK";
    const json = await body();
    expect(json.llm.nvidia).toBe(true);
    // The whole response, serialised, must not contain the secret anywhere.
    expect(JSON.stringify(json)).not.toContain("SECRET");
    expect(JSON.stringify(json)).not.toContain("nvapi-");
  });

  it("does not leak a backend URL either", async () => {
    process.env.DJANGO_URL = "https://internal.example.invalid/secret-path";
    const json = await body();
    expect(json.backends.django).toBe(true);
    expect(JSON.stringify(json)).not.toContain("internal.example.invalid");
  });

  it("an empty string counts as absent, not present", async () => {
    // A key set to "" is a common half-configured state; reporting it as
    // configured would send someone hunting for a bug that is a blank env var.
    process.env.NVIDIA_API_KEY = "";
    const json = await body();
    expect(json.llm.nvidia).toBe(false);
    expect(json.activeLlm).toBeNull();
  });
});

describe("/api/config — activeLlm mirrors make_llm()'s fallback chain", () => {
  it("is null when nothing is configured", async () => {
    expect((await body()).activeLlm).toBeNull();
  });

  it("picks nvidia first", async () => {
    process.env.NVIDIA_API_KEY = "a";
    process.env.OPENROUTER_API_KEY = "b";
    process.env.ANTHROPIC_API_KEY = "c";
    expect((await body()).activeLlm).toBe("nvidia");
  });

  it("falls back to openrouter when nvidia is absent", async () => {
    process.env.OPENROUTER_API_KEY = "b";
    process.env.ANTHROPIC_API_KEY = "c";
    expect((await body()).activeLlm).toBe("openrouter");
  });

  it("falls back to anthropic last", async () => {
    process.env.ANTHROPIC_API_KEY = "c";
    expect((await body()).activeLlm).toBe("anthropic");
  });

  it("reports every provider it knows about, even when unset", async () => {
    const json = await body();
    expect(Object.keys(json.llm).sort()).toEqual([
      "anthropic",
      "nvidia",
      "openrouter",
    ]);
  });
});

describe("/api/config — the backend is the authority on the model", () => {
  it("prefers the backend's answer over this process's env", async () => {
    // The bug this covers: the model is built in the Python backend, so a key
    // present THERE and absent here must read as configured, and the readiness
    // indicator must not call it blocked.
    process.env.NVIDIA_API_KEY = undefined as unknown as string;
    delete process.env.NVIDIA_API_KEY;
    backendSays({ configured: true, provider: "nvidia" });
    const json = await body();
    expect(json.activeLlm).toBe("nvidia");
    expect((json as unknown as { llmSource: string }).llmSource).toBe("backend");
  });

  it("reports NOT configured when the backend says so, even if this process has a key", async () => {
    // The inverse, and the more dangerous direction: a key here would have
    // shown green while every send failed in the backend.
    process.env.OPENROUTER_API_KEY = "local-only";
    backendSays({ configured: false, provider: null });
    const json = await body();
    expect(json.activeLlm).toBeNull();
  });

  it("falls back to local env — and SAYS so — when the backend is unreachable", async () => {
    unreachableBackend();
    process.env.ANTHROPIC_API_KEY = "c";
    const json = await body();
    expect(json.activeLlm).toBe("anthropic");
    expect((json as unknown as { llmSource: string }).llmSource).toBe("local-env");
  });

  it("treats a malformed backend payload as unreachable rather than trusting it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    process.env.NVIDIA_API_KEY = "local";
    const json = await body();
    expect((json as unknown as { llmSource: string }).llmSource).toBe("local-env");
    expect(json.activeLlm).toBe("nvidia");
  });
});

describe("observability", () => {
  it("proxies the backend's block and says the backend answered", async () => {
    backendObservability({
      langsmith: { supported: true, configured: true, tracing: true },
      langfuse: { supported: false, configured: false, tracing: false },
    });
    const body = await (await GET()).json();
    expect(body.observabilitySource).toBe("backend");
    expect(body.observability.langsmith.tracing).toBe(true);
    expect(body.observability.langfuse.supported).toBe(false);
  });

  it("a backend that OMITS tracing yields null, not false", async () => {
    // The distinction the whole four-state model rests on. `false` claims a send was
    // attempted and failed; an absent field claims nothing. Defaulting it to false would
    // manufacture a failure the backend never reported.
    backendObservability({ langsmith: { supported: true, configured: true } });
    const body = await (await GET()).json();
    expect(body.observability.langsmith.tracing).toBeNull();
  });

  it("falls back to local env when the backend is unreachable, and says so", async () => {
    unreachableBackend();
    process.env.LANGCHAIN_TRACING_V2 = "true";
    process.env.LANGCHAIN_API_KEY = "ls-key";
    const body = await (await GET()).json();
    expect(body.observabilitySource).toBe("local-env");
    expect(body.observability.langsmith.configured).toBe(true);
  });

  it("NEVER reports tracing from local env — this process cannot observe a span", async () => {
    // The defect this whole task exists to prevent, at the source rather than in the UI:
    // keys present here would otherwise read as "tracing", which is inference dressed as
    // observation. Local inference can only answer `configured`.
    unreachableBackend();
    process.env.LANGCHAIN_TRACING_V2 = "true";
    process.env.LANGCHAIN_API_KEY = "ls-key";
    process.env.LANGFUSE_PUBLIC_KEY = "pk";
    process.env.LANGFUSE_SECRET_KEY = "sk";
    const body = await (await GET()).json();
    expect(body.observability.langsmith.tracing).toBeNull();
    expect(body.observability.langfuse.tracing).toBeNull();
  });

  it("does not leak observability key values", async () => {
    unreachableBackend();
    process.env.LANGCHAIN_API_KEY = "ls-secret-value";
    process.env.LANGFUSE_SECRET_KEY = "lf-secret-value";
    const raw = await (await GET()).text();
    expect(raw).not.toContain("ls-secret-value");
    expect(raw).not.toContain("lf-secret-value");
  });
});
