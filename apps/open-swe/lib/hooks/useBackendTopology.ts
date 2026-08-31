"use client";

import { useEffect, useState } from "react";
import type { BackendTopology } from "../backend-topology";

/**
 * Ask the server which topology the connected backend has (#423).
 *
 * `undefined` while outstanding — NOT `{ known: false }`. "Not answered yet" and
 * "answered, and the answer is that we don't know" render differently and must:
 * the first is silent for as long as a request takes, the second is a standing
 * statement that this view cannot vouch for its own completeness.
 *
 * A failed fetch resolves to `known: false` rather than staying undefined, so a
 * network error cannot leave the view permanently silent — silence is the
 * single-run rendering, and defaulting to it on failure is the collapse this
 * whole issue is about.
 */
export function useBackendTopology(): BackendTopology | undefined {
  const [topology, setTopology] = useState<BackendTopology | undefined>();

  useEffect(() => {
    let cancelled = false;
    fetch("/api/open-swe/topology")
      .then((r) => r.json() as Promise<BackendTopology>)
      .catch((err: unknown) => ({
        known: false as const,
        reason: err instanceof Error ? err.message : "the probe failed",
      }))
      .then((t) => {
        if (!cancelled) setTopology(t);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return topology;
}
