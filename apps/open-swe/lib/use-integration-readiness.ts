"use client";

import { useEffect, useState } from "react";
import { computeReadiness, type Readiness } from "./readiness";
import {
  computeIntegrationStatus,
  type IntegrationStatus,
} from "./integration-status";

/**
 * Probe `/api/config` and `/api/open-swe/sandbox/health` and hold the answers.
 *
 * EVERY FIELD STARTS null AND null MEANS PROBING. Not `false`, and not an optimistic
 * default. The bug this work exists to fix was a green dot that meant "the UI is not busy" —
 * a status reporting a verdict it never computed — so the one rule here is that an absence of
 * evidence must never render as evidence of health. `computeReadiness` already encodes that:
 * `llmConfigured === null` yields "checking…", deliberately distinct from `false`.
 *
 * A failed probe is NOT reported as unconfigured either. Unreachable is its own fact, and
 * collapsing it into "no key" would send an operator to fix the wrong thing.
 */
export interface IntegrationReadiness {
  readiness: Readiness;
  /** Per-integration status, empty while the config probe is in flight. */
  integrations: { name: string; status: IntegrationStatus }[];
  /** Which process answered for observability — the backend, or local inference. */
  observabilitySource: "backend" | "local-env" | null;
  /** True while either probe is still outstanding. */
  probing: boolean;
  /** Set when a probe could not be reached at all. */
  unreachable: string | null;
}

interface ConfigBody {
  activeLlm?: string | null;
  observability?: Record<
    string,
    {
      supported?: boolean;
      configured?: boolean;
      tracing?: boolean | null;
      detail?: string | null;
    }
  >;
  observabilitySource?: "backend" | "local-env";
}

export function useIntegrationReadiness(opts: {
  /** Does THIS surface run code? The queue does; a read-only view would not. */
  sandboxRequired: boolean;
  streamStatus: string;
}): IntegrationReadiness {
  const { sandboxRequired, streamStatus } = opts;

  const [llmConfigured, setLlmConfigured] = useState<boolean | null>(null);
  const [sandboxAvailable, setSandboxAvailable] = useState<boolean | null>(null);
  const [config, setConfig] = useState<ConfigBody | null>(null);
  const [unreachable, setUnreachable] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/config", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((body: ConfigBody) => {
        if (!live) return;
        setConfig(body);
        setLlmConfigured(!!body.activeLlm);
      })
      .catch((e: Error) => {
        if (!live) return;
        // Left as null on purpose — see the module docstring. An unreachable config endpoint
        // means we do not know whether a model is configured, which is not the same as
        // knowing there isn't one.
        setUnreachable(`config unreachable (${e.message})`);
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!sandboxRequired) {
      // Not required means not probed, and `computeReadiness` ignores availability entirely
      // when `sandboxRequired` is false — so leaving this null cannot block the surface.
      return;
    }
    let live = true;
    fetch("/api/open-swe/sandbox/health", { cache: "no-store" })
      .then(async (r) => {
        const body = (await r.json().catch(() => ({}))) as { available?: boolean };
        if (!live) return;
        // The route answers 503 with `available:false` for a real "no provider", and 503
        // with an `error` for a provider that threw. Both are "not available"; neither is
        // "unknown", so this is the one place a false is honest.
        setSandboxAvailable(body.available === true);
      })
      .catch((e: Error) => {
        if (!live) return;
        setUnreachable((u) => u ?? `sandbox probe unreachable (${e.message})`);
      });
    return () => {
      live = false;
    };
  }, [sandboxRequired]);

  const readiness = computeReadiness({
    llmConfigured,
    sandboxRequired,
    sandboxAvailable,
    streamStatus,
  });

  const integrations = Object.entries(config?.observability ?? {}).map(
    ([name, v]) => ({
      name,
      status: computeIntegrationStatus({
        supported: v?.supported === true,
        configured: v?.configured === true,
        tracing: typeof v?.tracing === "boolean" ? v.tracing : null,
        detail: typeof v?.detail === "string" ? v.detail : null,
      }),
    }),
  );

  return {
    readiness,
    integrations,
    observabilitySource: config?.observabilitySource ?? null,
    probing: llmConfigured === null || (sandboxRequired && sandboxAvailable === null),
    unreachable,
  };
}
