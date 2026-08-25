export const dynamic = "force-dynamic";

/**
 * What is configured on the server — as BOOLEANS, never as values.
 *
 * The settings page needs to tell a user whether an LLM key is present so it
 * can say "you have no key, here is where to get a free one" instead of
 * leaving them to discover it from a 401 mid-conversation. It does NOT need
 * the key, and this endpoint is unauthenticated, so it returns presence only.
 *
 * `!!` is doing real work here, not tidying: returning the value would publish
 * every secret this app holds to anyone who can reach the port.
 *
 * The provider order mirrors make_llm()'s fallback chain in BOTH Python
 * backends — NVIDIA NIM, then OpenRouter, then Anthropic. If that chain
 * changes there, `activeLlm` here becomes a confident wrong answer, which is
 * why the order is stated rather than implied.
 */
/**
 * THE MODEL IS BUILT IN THE PYTHON BACKEND, SO THAT IS WHO GETS ASKED.
 *
 * This route used to answer from `process.env` — this process's environment.
 * That is the wrong subject: `make_llm()` runs in the backend container, so a
 * key present there read as "not configured" here (which is exactly what the
 * readiness indicator got wrong), and a key present only here would have read
 * as configured while every send failed.
 *
 * The local env is kept only as a FALLBACK for when the backend cannot be
 * reached, and the response says which source answered so a wrong reading is
 * traceable instead of mysterious.
 */
async function llmFromBackend(): Promise<{
  configured: boolean;
  provider: string | null;
} | null> {
  const base = (
    process.env.FASTAPI_URL ??
    process.env.BACKEND_URL ??
    "http://localhost:8001"
  ).replace(/\/api\/chat\/stream\/?$/, "");
  try {
    const res = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(2000),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      llm?: { configured?: boolean; provider?: string | null };
    };
    if (!body.llm || typeof body.llm.configured !== "boolean") return null;
    return {
      configured: body.llm.configured,
      provider: body.llm.provider ?? null,
    };
  } catch {
    return null; // unreachable is not "unconfigured" — the caller distinguishes
  }
}

export async function GET(): Promise<Response> {
  const llm = {
    nvidia: !!process.env.NVIDIA_API_KEY,
    openrouter: !!process.env.OPENROUTER_API_KEY,
    anthropic: !!process.env.ANTHROPIC_API_KEY,
  };

  const backendLlm = await llmFromBackend();

  // First match wins locally, same order as make_llm().
  const localActive = llm.nvidia
    ? "nvidia"
    : llm.openrouter
    ? "openrouter"
    : llm.anthropic
    ? "anthropic"
    : null;

  const activeLlm = backendLlm
    ? backendLlm.configured
      ? backendLlm.provider ?? "configured"
      : null
    : localActive;

  const llmSource = backendLlm ? "backend" : "local-env";

  return new Response(
    JSON.stringify({
      backends: {
        django: !!process.env.DJANGO_URL,
        fastapi: !!process.env.FASTAPI_URL,
      },
      llm,
      activeLlm,
      llmSource,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
