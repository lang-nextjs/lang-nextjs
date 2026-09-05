"use client";

import { useEffect, useState } from "react";
import { computeReadiness, type Readiness } from "../readiness";

/**
 * Readiness for the QUEUE surface (`/`), which runs code and therefore needs a
 * sandbox as well as a model.
 *
 * #124: `/chat` computes readiness from probes; the queue did not compute it at
 * all. Its header rendered the string literal "local · langgraph dev" — a
 * status-shaped element reporting a verdict it never computed, and one that
 * could not go red because it was not derived from anything.
 *
 * THREE STATES, NOT TWO — and `null` is doing the work:
 *
 *   null   probe in flight, or the probe itself failed  -> unknown
 *   false  the dependency ANSWERED and said no          -> blocked
 *   true   the dependency ANSWERED and said yes         -> ready
 *
 * A probe that cannot reach its dependency must not render green, and must not
 * render red either — we do not know, and "unknown" is the honest answer. This
 * reuses the shape `computeReadiness` already encodes rather than inventing a
 * second one, so the two surfaces cannot drift into different answers.
 *
 * WHY THE ERRORS ARE RETURNED SEPARATELY: `computeReadiness` reports `reasons`
 * only for `blocked`. A failed probe is `unknown`, so its reason has nowhere to
 * go inside that contract — and widening the contract would touch a module with
 * 14 tests to serve one caller. The page renders these alongside instead.
 */
export interface QueueReadiness {
  readiness: Readiness;
  /** Why a probe could not answer. Empty when every probe answered. */
  probeErrors: string[];
  /** Raw probe results, exposed so a test can assert null-vs-false directly. */
  llmConfigured: boolean | null;
  llmSource: "backend" | "local-env" | null;
  sandboxAvailable: boolean | null;
}

/**
 * A 503 from the sandbox health route is an ANSWER ("unavailable"), not a
 * failure to answer — it carries `{ available: false }`. Treating `!res.ok` as
 * "could not determine" would turn a definite no into an unknown, which is the
 * mirror of the bug this issue is about.
 */
export async function probeSandbox(
  fetchImpl: typeof fetch = fetch
): Promise<{ available: boolean | null; error?: string }> {
  try {
    const res = await fetchImpl("/api/open-swe/sandbox/health");
    const body = (await res.json()) as { available?: unknown };
    if (typeof body.available === "boolean")
      return { available: body.available };
    return {
      available: null,
      error: "sandbox health returned no `available` field",
    };
  } catch (e) {
    return {
      available: null,
      error: `sandbox health unreachable: ${
        e instanceof Error ? e.message : "unknown"
      }`,
    };
  }
}

export async function probeLlm(fetchImpl: typeof fetch = fetch): Promise<{
  configured: boolean | null;
  /** WHO answered — carried because a `false` means different things. */
  source?: "backend" | "local-env" | null;
  error?: string;
}> {
  try {
    const res = await fetchImpl("/api/config");
    const body = (await res.json()) as {
      activeLlm?: unknown;
      llmSource?: unknown;
    };
    // `llmSource` has always been in this payload and was never read, which is
    // how "No model API key configured" came to be shown for a backend that
    // was simply stopped. Anything but the two known values is treated as
    // unknown rather than assumed.
    const source =
      body.llmSource === "backend" || body.llmSource === "local-env"
        ? body.llmSource
        : null;
    // activeLlm is a provider name or null. Absent field means the endpoint
    // changed shape — that is not the same as "no model", so it is unknown.
    if ("activeLlm" in body) return { configured: !!body.activeLlm, source };
    return {
      configured: null,
      error: "/api/config returned no `activeLlm` field",
    };
  } catch (e) {
    return {
      configured: null,
      error: `/api/config unreachable: ${
        e instanceof Error ? e.message : "unknown"
      }`,
    };
  }
}

export function useQueueReadiness(streamStatus: string): QueueReadiness {
  const [llmConfigured, setLlmConfigured] = useState<boolean | null>(null);
  const [llmSource, setLlmSource] = useState<"backend" | "local-env" | null>(
    null
  );
  const [sandboxAvailable, setSandboxAvailable] = useState<boolean | null>(
    null
  );
  const [probeErrors, setProbeErrors] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [llm, sandbox] = await Promise.all([probeLlm(), probeSandbox()]);
      if (cancelled) return;
      setLlmConfigured(llm.configured);
      setLlmSource(llm.source ?? null);
      setSandboxAvailable(sandbox.available);
      setProbeErrors(
        [llm.error, sandbox.error].filter((e): e is string => !!e)
      );
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return {
    readiness: computeReadiness({
      llmConfigured,
      llmSource,
      // The queue EXECUTES code. This is the field /chat deliberately passes
      // false for, and the reason the queue cannot reuse /chat's call.
      sandboxRequired: true,
      sandboxAvailable,
      streamStatus,
    }),
    probeErrors,
    llmConfigured,
    llmSource,
    sandboxAvailable,
  };
}
