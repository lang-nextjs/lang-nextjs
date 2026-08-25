/**
 * The runtime axis for open-swe's /chat surface.
 *
 * /chat proxies rungs 1-3 (langchain / langgraph / deepagents), each of which
 * is hosted by a Python runtime — django or fastapi. Which topologies a given
 * (rung, runtime) pair can actually serve is declared in rungs.json and
 * generated into @deepagents-nextjs/rungs, so this module derives rather than
 * restates it.
 *
 * WHY DERIVE. The pairs are NOT uniform. At the time of writing:
 *
 *   langchain  x django   react, plan-execute
 *   langchain  x fastapi  react, plan-execute
 *   langgraph  x django   react, plan-execute
 *   langgraph  x fastapi  react, plan-execute
 *   deepagents x django   react, plan-execute          <- no deep-research
 *   deepagents x fastapi  react, plan-execute, deep-research
 *
 * `deep-research` exists in exactly one cell. A hardcoded topology list — which
 * is what /chat had — offers it in all six, so the moment the runtime becomes a
 * user choice, a user on django is offered a topology django cannot serve and
 * gets a backend error for a button the UI told them was available.
 *
 * This mirrors `topologiesFor` in apps/example's ConversationSurface, which is
 * the reference implementation. It is deliberately the same shape rather than a
 * second one.
 */
import { RUNG_BY_ID } from "@deepagents-nextjs/rungs";

/** The Python runtimes /chat can proxy to. */
export const PYTHON_BACKENDS = ["django", "fastapi"] as const;
export type PythonBackend = (typeof PYTHON_BACKENDS)[number];

export type Topology = "react" | "plan-execute" | "deep-research";

/** Narrow an untrusted value to a PythonBackend, defaulting to fastapi. */
export function asPythonBackend(value: unknown): PythonBackend {
  return value === "django" || value === "fastapi" ? value : "fastapi";
}

/**
 * Topologies a (rung, runtime) pair declares.
 *
 * Falls back to ["react"] rather than [] so the axis is never empty: a pair with
 * no declared topologies would render zero buttons and strand the surface with
 * no way to send. Same rule as the reference implementation.
 */
export function topologiesFor(
  rungId: string,
  runtime: PythonBackend
): readonly Topology[] {
  const declared = RUNG_BY_ID[rungId as keyof typeof RUNG_BY_ID]?.runtimes?.[
    runtime
  ]?.topologies as readonly Topology[] | undefined;
  return declared && declared.length > 0 ? declared : ["react"];
}

/** The env var carrying a runtime's base URL. Named so errors can name it. */
export function envVarFor(runtime: PythonBackend): string {
  return runtime === "django" ? "DJANGO_URL" : "FASTAPI_URL";
}

/** The env var carrying a runtime's auth token, if any. */
export function authEnvVarFor(runtime: PythonBackend): string {
  return runtime === "django" ? "DJANGO_AUTH_TOKEN" : "FASTAPI_AUTH_TOKEN";
}

/**
 * Resolve a runtime's base URL and token from the environment.
 *
 * Takes `env` so this is testable without mutating the real process env.
 */
export function resolveBackendBase(
  runtime: PythonBackend,
  env: Record<string, string | undefined> = process.env
): { url: string | undefined; token: string | undefined } {
  return {
    url: env[envVarFor(runtime)],
    token: env[authEnvVarFor(runtime)],
  };
}

/**
 * Build the upstream URL for a (runtime, rung) pair.
 *
 * Django's URLconf requires the trailing slash and 404s without it; FastAPI
 * does not want one. apps/example handles this and open-swe's route did not,
 * because it only ever spoke to fastapi.
 */
export function buildBackendUrl(
  runtime: PythonBackend,
  baseUrl: string,
  aiBackend: string
): string {
  const root = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const trailing = runtime === "django" ? "/" : "";
  return `${root}/${aiBackend}${trailing}`;
}
