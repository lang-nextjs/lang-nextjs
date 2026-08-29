/**
 * Which tracing integrations are configured, and which actually TRACE.
 *
 * THE TWO ARE NOT THE SAME, and conflating them is the failure this reports
 * around — the same reasoning as the Python `observability_status()`.
 *
 * LANGSMITH needs no code here: `langsmith` ships inside @langchain/core and
 * reads its own environment, and this backend names its agent, so traces arrive
 * labelled. Setting the vars genuinely turns tracing on.
 *
 * LANGFUSE IS REPORTED AS UNSUPPORTED BY THIS RUNTIME, and that is the honest
 * answer rather than a gap to paper over. The Python planes report
 * `supported: true` because they pass a CallbackHandler at every invocation
 * site; this one passes none, so claiming support would make `tracing`
 * unfalsifiable exactly the way a no-op handler would — every call site would
 * look wired and nothing would arrive. `supported: false` with a `detail` that
 * says which issue would change it is a fact a reader can act on. Wiring it is
 * part of the TypeScript plane's parity work, not of this scaffold.
 *
 * BOTH LANGSMITH SPELLINGS are read. The SDK accepts LANGSMITH_* as well as the
 * older LANGCHAIN_*, and reading only the old names produced a FALSE NEGATIVE
 * ON EGRESS in the Python plane: a backend that was POSTing run batches
 * reported `configured: false` and told the operator to set different vars.
 * Over-claiming tracing is embarrassing; under-claiming egress is the one that
 * gets acted on.
 */

function envFlag(env: NodeJS.ProcessEnv, name: string): boolean {
  return ["1", "true", "yes"].includes((env[name] ?? "").toLowerCase());
}

export interface ObservabilityIntegration {
  supported: boolean;
  configured: boolean;
  /** true = a span was accepted · false = attempted and failed · null = never probed. */
  tracing: boolean | null;
  detail: string | null;
  project?: string | null;
}

export function observabilityStatus(
  env: NodeJS.ProcessEnv = process.env
): Record<string, ObservabilityIntegration> {
  const langsmithOn =
    envFlag(env, "LANGSMITH_TRACING") || envFlag(env, "LANGCHAIN_TRACING_V2");
  const langsmithKey = Boolean(
    env.LANGSMITH_API_KEY ?? env.LANGCHAIN_API_KEY
  );
  return {
    langsmith: {
      supported: true,
      configured: langsmithOn && langsmithKey,
      // NEVER PROBED, NOT "NOT TRACING". This process makes no call to
      // LangSmith to find out, and `false` would claim an attempt that failed.
      tracing: null,
      detail:
        langsmithOn && langsmithKey
          ? null
          : "set LANGSMITH_TRACING=true and LANGSMITH_API_KEY (LANGCHAIN_* also accepted)",
      project: env.LANGSMITH_PROJECT ?? env.LANGCHAIN_PROJECT ?? null,
    },
    langfuse: {
      // FALSE, AND SAYING SO. This runtime attaches no Langfuse handler, so no
      // span can arrive however the keys are set. Reporting `supported: true`
      // here would be a claim about code that does not exist.
      supported: false,
      configured: false,
      tracing: null,
      detail:
        "the node runtime attaches no Langfuse callback handler yet; keys in the environment change nothing here. The Python runtimes do support it.",
    },
  };
}
