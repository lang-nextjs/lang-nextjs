import {
  asPythonBackend,
  backendHealthBase,
  type PythonBackend,
} from "../../../lib/frameworks";

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
async function llmFromBackend(runtime: PythonBackend): Promise<{
  configured: boolean;
  provider: string | null;
} | null> {
  // TAKES THE RUNTIME, does not name one (#333). This read FASTAPI_URL
  // unconditionally, so a user on django was told about fastapi's model.
  const base = backendHealthBase(runtime);
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

/** The shape the backend reports per integration. `tracing` is the only observation. */
export interface ObservabilityIntegration {
  supported: boolean;
  configured: boolean;
  /** true = a span was accepted · false = attempted and failed · null = never probed. */
  tracing: boolean | null;
  /** The backend's own explanation. Richer than anything inferable from the booleans. */
  detail?: string | null;
  /**
   * WHERE THE BACKEND SENDS SPANS — not necessarily where a person can look.
   *
   * Carried because this route DROPPED it, and dropping it made the settings
   * panel say something false. `consoleFor` declines to link an unreachable
   * address and explains which case it hit; with the host missing it took the
   * wrong branch and reported "no host was reported" while the backend had
   * reported one all along:
   *
   *   backend /health  ->  host: "http://langfuse:3000"
   *   /api/config      ->  (dropped)
   *   settings panel   ->  "no host was reported"
   *
   * The refusal was correct — a container alias is not browser-reachable — and
   * the REASON was wrong, which is the part a person acts on. Knowing the
   * backend traces to `http://langfuse:3000` is what tells them to set
   * LANGFUSE_CONSOLE_URL; "no host was reported" tells them to go looking for
   * a configuration problem that does not exist.
   *
   * This is a URL, not a secret: it is the address of a console someone is
   * meant to open. The "booleans, never values" rule at the top of this file
   * is about CREDENTIALS.
   */
  host?: string | null;
}

/**
 * OBSERVABILITY IS THE BACKEND'S FACT, FOR THE SAME REASON THE MODEL IS.
 *
 * Spans are emitted by the process that builds the model, so this process's environment is
 * the wrong subject — a LANGCHAIN_API_KEY set only here would read as "configured" while
 * nothing ever traced. The local env is a FALLBACK for when the backend cannot be reached,
 * and the response says which source answered so a wrong reading is traceable.
 *
 * THE FALLBACK CAN ONLY EVER ANSWER `configured`. `tracing` is an observation the backend
 * makes, so from here it is `null` — never probed — which is deliberately not `false`.
 * Reporting `false` would claim a send was attempted and failed, which this process cannot
 * know and did not do. Absent claims nothing; false claims a failure.
 */
async function observabilityFromBackend(
  runtime: PythonBackend
): Promise<Record<string, ObservabilityIntegration> | null> {
  // THE SAME RUNTIME THE MODEL WAS READ FROM. These are two functions that each
  // derived their own base, so they could answer about different processes —
  // django's model beside fastapi's tracing is two true facts making one false
  // picture.
  const base = backendHealthBase(runtime);
  try {
    const res = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(2000),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      observability?: Record<string, Partial<ObservabilityIntegration>>;
    };
    if (!body.observability || typeof body.observability !== "object")
      return null;
    const out: Record<string, ObservabilityIntegration> = {};
    for (const [name, v] of Object.entries(body.observability)) {
      out[name] = {
        supported: v?.supported === true,
        configured: v?.configured === true,
        // A backend that OMITS `tracing` has not told us it failed — it has told us
        // nothing. `null`, never `false`.
        tracing: typeof v?.tracing === "boolean" ? v.tracing : null,
        detail: typeof v?.detail === "string" ? v.detail : null,
        host: typeof v?.host === "string" ? v.host : null,
      };
    }
    return out;
  } catch {
    return null; // unreachable is not "untraced" — the caller distinguishes
  }
}

/**
 * `request` IS OPTIONAL, and that is not laziness.
 *
 * Next always passes one, so the optionality is invisible in production. It exists so the
 * absent case has a DEFINED answer — fastapi, exactly what this route did before #333 — rather
 * than a TypeError. A config endpoint that throws is worse than one that answers narrowly:
 * the chat surface treats a failed probe as "unknown", so a 500 here would blank the readiness
 * indicator instead of reporting anything.
 */
export async function GET(request?: Request): Promise<Response> {
  // `asPythonBackend` already narrows junk to fastapi, so `?runtime=flask` and a missing
  // parameter converge on the same defined answer rather than on an exception.
  const runtime = asPythonBackend(
    request ? new URL(request.url).searchParams.get("runtime") : undefined
  );

  const llm = {
    nvidia: !!process.env.NVIDIA_API_KEY,
    openrouter: !!process.env.OPENROUTER_API_KEY,
    anthropic: !!process.env.ANTHROPIC_API_KEY,
  };

  const backendLlm = await llmFromBackend(runtime);

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

  const backendObs = await observabilityFromBackend(runtime);

  // Local inference answers `configured` only, and says so by leaving `tracing` null.
  // `supported: true` because whether the BACKEND wires an integration is not something
  // this process can see — showing a row we cannot evaluate is honest; claiming
  // "not wired" would be a fact about a build we did not inspect.
  const localObs: Record<string, ObservabilityIntegration> = {
    langsmith: {
      supported: true,
      configured:
        (process.env.LANGCHAIN_TRACING_V2 ?? "").toLowerCase() === "true" &&
        !!process.env.LANGCHAIN_API_KEY,
      tracing: null,
      // No host: LangSmith is hosted, and `consoleFor` knows its address
      // without being told. Reading LANGFUSE_HOST here would attribute one
      // integration's address to the other.
    },
    langfuse: {
      supported: true,
      configured:
        !!process.env.LANGFUSE_PUBLIC_KEY && !!process.env.LANGFUSE_SECRET_KEY,
      tracing: null,
      // The fallback reads THIS process's env, which knows where it would send
      // spans but has observed nothing. A host without a `tracing` observation
      // is still worth carrying: it is what makes the console link offerable.
      host: process.env.LANGFUSE_HOST ?? null,
    },
  };

  return new Response(
    JSON.stringify({
      /**
       * WHICH RUNTIME THIS ANSWER IS ABOUT (#333).
       *
       * Same discipline as `llmSource`: name the subject, so a reading that turns out wrong
       * is traceable rather than mysterious. It is also what lets the client tell a fresh
       * answer from the previous runtime's — without it, a probe that is still in flight and
       * one that has returned about the wrong process look identical, which is how a stale
       * green survives a switch.
       */
      runtime,
      backends: {
        django: !!process.env.DJANGO_URL,
        fastapi: !!process.env.FASTAPI_URL,
      },
      llm,
      activeLlm,
      llmSource,
      observability: backendObs ?? localObs,
      observabilitySource: backendObs ? "backend" : "local-env",
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
