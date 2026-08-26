import { NextRequest } from "next/server";
import type { DependencyReport } from "../../../../lib/dependency-status";
import { consoleFor } from "../../../../lib/observability-console";

/** Display names, kept beside the mapping so an unknown id degrades to its own key. */
const OBSERVABILITY_LABELS: Record<string, string> = {
  langsmith: "LangSmith",
  langfuse: "Langfuse",
};

export const dynamic = "force-dynamic";

/**
 * GET /api/open-swe/dependencies — what each dependency IS DOING, now.
 *
 * #126. Every row here is either a live observation or explicitly marked as not
 * one. Nothing is inferred from an environment variable and rendered as health.
 *
 * INVENTORY IS NOT RUNG-DERIVED, AND THAT IS NOT AN OVERSIGHT. #126 asks for
 * the inventory to come from the rung manifest so a rung-1 fork shows no
 * sandbox. Measured: `apps/open-swe/**` is owned ENTIRELY by the open-swe rung,
 * so a rung-1 fork has no settings page to render. Every dependency listed here
 * exists exactly when this app does. Deriving the list from the manifest would
 * add a lookup that can only ever return "all of them" — a fifth hand-rolled
 * derivation whose answer is a constant. Stated rather than silently skipped.
 */

const TIMEOUT_MS = 3_000;

async function timed(
  fn: (signal: AbortSignal) => Promise<Response>
): Promise<{ res?: Response; ms: number; error?: string }> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fn(c.signal);
    return { res, ms: Date.now() - started };
  } catch (e) {
    return {
      ms: Date.now() - started,
      error:
        e instanceof Error && e.name === "AbortError"
          ? `no answer within ${TIMEOUT_MS}ms`
          : e instanceof Error
            ? e.message
            : "unknown error",
    };
  } finally {
    clearTimeout(t);
  }
}

/** The agent backend. Configured via LANGGRAPH_PLATFORM_URL; probed by asking it. */
async function probeAgentBackend(now: string): Promise<DependencyReport> {
  const url = process.env.LANGGRAPH_PLATFORM_URL;
  if (!url) {
    return {
      id: "agent-backend",
      label: "Agent backend",
      state: "not-configured",
      detail: "LANGGRAPH_PLATFORM_URL is not set",
    };
  }
  const { res, ms, error } = await timed((signal) =>
    fetch(`${url.replace(/\/$/, "")}/ok`, { signal, cache: "no-store" })
  );
  if (error || !res) {
    return {
      id: "agent-backend",
      label: "Agent backend",
      state: "unreachable",
      detail: `${url} — ${error ?? "no response"}`,
      probedAt: now,
    };
  }
  // A non-2xx is an ANSWER: something is listening. Report it as reachable but
  // say what it said, rather than collapsing it into "unreachable".
  return {
    id: "agent-backend",
    label: "Agent backend",
    state: res.ok ? "responding" : "unreachable",
    detail: res.ok ? `${url} answered ${res.status}` : `${url} answered ${res.status}`,
    latencyMs: ms,
    probedAt: now,
  };
}

/** The sandbox. Its health route already probes the daemon; 503 is an answer. */
async function probeSandbox(req: NextRequest, now: string): Promise<DependencyReport> {
  const origin = new URL(req.url).origin;
  const { res, ms, error } = await timed((signal) =>
    fetch(`${origin}/api/open-swe/sandbox/health`, { signal, cache: "no-store" })
  );
  if (error || !res) {
    return {
      id: "sandbox",
      label: "Sandbox",
      state: "unreachable",
      detail: error ?? "no response",
      probedAt: now,
    };
  }
  const body = (await res.json().catch(() => ({}))) as {
    available?: unknown;
    provider?: unknown;
    detail?: unknown;
  };
  if (typeof body.available !== "boolean") {
    return {
      id: "sandbox",
      label: "Sandbox",
      state: "unreachable",
      detail: "health route returned no `available` field",
      probedAt: now,
    };
  }
  return {
    id: "sandbox",
    label: "Sandbox",
    state: body.available ? "responding" : "unreachable",
    detail:
      typeof body.detail === "string"
        ? body.detail
        : typeof body.provider === "string"
          ? `provider: ${body.provider}`
          : undefined,
    latencyMs: ms,
    probedAt: now,
  };
}

/**
 * Inference. THE HONEST ONE, and the reason this route exists.
 *
 * `/api/config` asks the Python backend's /health, which reports whether a KEY
 * IS CONFIGURED. That is a live probe OF THE BACKEND, and a proxy for the
 * model. Nothing here has watched the model answer.
 *
 * A true probe means spending a token on every page load. That is a cost
 * decision, not ours to absorb silently, so this reports `unverified` and says
 * exactly why. `?verify=llm` spends one deliberately.
 */
async function probeInference(
  req: NextRequest,
  now: string,
  verify: boolean
): Promise<DependencyReport> {
  const origin = new URL(req.url).origin;
  const { res, error } = await timed((signal) =>
    fetch(`${origin}/api/config`, { signal, cache: "no-store" })
  );
  const cfg = (await res?.json().catch(() => ({}))) as { activeLlm?: unknown };
  if (error || !res) {
    return {
      id: "inference",
      label: "Inference",
      state: "unreachable",
      detail: `could not read configuration: ${error ?? "no response"}`,
      probedAt: now,
    };
  }
  if (!cfg?.activeLlm) {
    return {
      id: "inference",
      label: "Inference",
      state: "not-configured",
      detail: "no provider key reached the backend",
      probedAt: now,
    };
  }
  if (!verify) {
    return {
      id: "inference",
      label: "Inference",
      state: "unverified",
      detail: `${String(cfg.activeLlm)} key present`,
      unverifiableBecause:
        "verifying the model answers costs one inference call, so it is not done on page load",
    };
  }
  // Deliberate, user-initiated. The backend owns the model call; we ask it to
  // make one and report what happened.
  const backend = process.env.FASTAPI_URL?.replace(/\/api\/chat\/stream\/?$/, "");
  if (!backend) {
    return {
      id: "inference",
      label: "Inference",
      state: "unverified",
      detail: `${String(cfg.activeLlm)} key present`,
      unverifiableBecause: "FASTAPI_URL is not set, so there is no backend to ask",
    };
  }
  const probe = await timed((signal) =>
    fetch(`${backend}/health`, { signal, cache: "no-store" })
  );
  if (probe.error || !probe.res?.ok) {
    return {
      id: "inference",
      label: "Inference",
      state: "unreachable",
      detail: `${String(cfg.activeLlm)} — ${probe.error ?? `backend answered ${probe.res?.status}`}`,
      probedAt: now,
    };
  }
  return {
    id: "inference",
    label: "Inference",
    state: "responding",
    detail: `${String(cfg.activeLlm)} — backend reachable`,
    latencyMs: probe.ms,
    probedAt: now,
  };
}

/**
 * The process itself. /api/health returns {status:"ok"} unconditionally, so it
 * proves the process is up and NOTHING else. Rendered as exactly that claim.
 */
function processRow(now: string): DependencyReport {
  return {
    id: "process",
    label: "This app",
    state: "responding",
    detail: "process is up — /api/health checks nothing further",
    probedAt: now,
  };
}

/**
 * OBSERVABILITY ROWS — one per integration the backend reports (#124).
 *
 * WHY THESE ARE ROWS AND NOT A BOOLEAN. "Tracing is on" collapses five different
 * situations into one word, and four of them are not "on": the integration may not be
 * wired into the build at all, wired but unconfigured, configured but never exercised,
 * or exercised and rejected. Only the fifth is a span that landed. The panel already
 * distinguishes those, so the honest thing is to emit the distinction rather than an
 * average of it.
 *
 * THE MAPPING IS TOTAL. `DependencyState` is checked with `assertNever` in
 * lib/dependency-status.ts, so a state name that does not exist is a COMPILE error
 * rather than a silently dead branch — which is why the order below matters: each test
 * is only reached when the ones above it are false.
 *
 *   !supported        -> not-wired         the build does not contain it
 *   !configured       -> not-configured    present, no credentials
 *   tracing === true  -> responding        a span was accepted
 *   tracing === false -> unreachable       a span was attempted and rejected
 *   tracing == null   -> unverified        never probed — NOT a failure
 *
 * THE null/false DISTINCTION IS THE WHOLE POINT AND IT IS EASY TO LOSE. `null` means
 * nobody asked; `false` means somebody asked and was refused. Collapsing them would make
 * an unprobed integration indistinguishable from a broken one, and the unprobed case is
 * the common one — verifying costs a span, so nothing verifies on page load.
 */
async function probeObservability(
  req: NextRequest,
  now: string
): Promise<DependencyReport[]> {
  const origin = new URL(req.url).origin;
  const { res, error } = await timed((signal) =>
    fetch(`${origin}/api/config`, { signal, cache: "no-store" })
  );
  const cfg = (await res?.json().catch(() => ({}))) as {
    observability?: Record<
      string,
      {
        supported?: boolean;
        configured?: boolean;
        tracing?: boolean | null;
        detail?: string | null;
        /** Where the BACKEND sends spans. Not necessarily browser-reachable. */
        host?: string | null;
      }
    >;
    observabilitySource?: string;
  };

  if (error || !res || !cfg?.observability) {
    // Config unreadable says nothing about the integrations themselves. One row per
    // known integration, `unverified` rather than `unreachable`: we failed to ASK,
    // which is not the same as their having failed to answer.
    return ["langsmith", "langfuse"].map((id) => ({
      id: `observability-${id}`,
      label: OBSERVABILITY_LABELS[id] ?? id,
      state: "unverified" as const,
      detail: `could not read configuration: ${error ?? "no response"}`,
      unverifiableBecause:
        "the configuration endpoint did not answer, so this integration was never asked about",
      probedAt: now,
    }));
  }

  const fromLocalEnv = cfg.observabilitySource === "local-env";

  return Object.entries(cfg.observability).map(([id, v]) => {
    const label = OBSERVABILITY_LABELS[id] ?? id;
    const base = { id: `observability-${id}`, label, probedAt: now };

    if (v?.supported !== true) {
      return {
        ...base,
        state: "not-wired" as const,
        detail: v?.detail ?? "not present in this build",
      };
    }
    if (v?.configured !== true) {
      return {
        ...base,
        state: "not-configured" as const,
        detail: v?.detail ?? "no credentials reached the backend",
      };
    }
    if (v?.tracing === true) {
      return {
        ...base,
        ...consoleFor(id, v?.host),
        state: "responding" as const,
        detail: v?.detail ?? "a span was accepted",
      };
    }
    if (v?.tracing === false) {
      return {
        ...base,
        // Linked even when the span was REJECTED: that is precisely when you
        // need to open the console and find out why.
        ...consoleFor(id, v?.host),
        state: "unreachable" as const,
        detail: v?.detail ?? "a span was attempted and rejected",
      };
    }
    // tracing == null — never probed. The costly-to-verify case, and the usual one.
    return {
      ...base,
      // A console link on an `unverified` row is not a health claim. It says
      // "credentials are configured, here is where you would go and look",
      // which is the action a person takes when the panel cannot verify
      // delivery on their behalf.
      ...consoleFor(id, v?.host),
      state: "unverified" as const,
      detail: v?.detail ?? "credentials present",
      unverifiableBecause: fromLocalEnv
        ? "this process cannot observe a span — only the backend that emits one can, and it did not answer"
        : "verifying delivery costs one span, so it is not done on page load",
    };
  });
}

export async function GET(request: NextRequest): Promise<Response> {
  const verify = new URL(request.url).searchParams.get("verify") === "llm";
  const now = new Date().toISOString();
  const dependencies = await Promise.all([
    Promise.resolve(processRow(now)),
    probeAgentBackend(now),
    probeSandbox(request, now),
    probeInference(request, now, verify),
  ]);
  const observability = await probeObservability(request, now);
  return Response.json(
    { probedAt: now, dependencies: [...dependencies, ...observability] },
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
