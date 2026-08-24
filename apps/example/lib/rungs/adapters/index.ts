import type { SseAdapter } from "@deepagents-nextjs/server";
import { RUNGS } from "@deepagents-nextjs/rungs";
import type { AdapterEntry } from "./registry";
import * as registry from "./registry";

/**
 * Public face of the adapter registry.
 *
 * `import * as` is the point: it names no rung. A named import would be pruned out from
 * under this file the moment its rung was ejected, which is the failure this whole
 * arrangement exists to remove. Whatever the barrel still exports after eject is what a fork
 * offers — no list here to fall out of step with it.
 */
const entries: readonly AdapterEntry[] = Object.values(
  registry as Record<string, unknown>,
).filter(
  (v): v is AdapterEntry =>
    typeof v === "object" && v !== null && "id" in v && "adapter" in v,
);

/** Rung ids this build can actually talk to, derived from what survived eject. */
export function adapterIds(): readonly string[] {
  return entries.map((e) => e.id);
}

/**
 * Resolve a rung id to its adapter.
 *
 * Throws rather than returning undefined. `createSseProxyHandler` treats a missing adapter
 * as "run the pipeline with no adapter transforms", which streams the backend's raw wire
 * format through unchanged — a plausible-looking response that is silently wrong. A fork
 * that dropped a rung should fail loudly on a stale request for it, not answer badly.
 */
export function resolveAdapter(id: string): SseAdapter {
  const found = entries.find((e) => e.id === id);
  if (!found) {
    throw new Error(
      `Unknown rung "${id}". This build serves: ${adapterIds().join(", ") || "(none)"}.`,
    );
  }
  return found.adapter;
}

/**
 * The rung a surface opens on when nothing selects one.
 *
 * Highest ordinal present, INTERSECTED with what the registry actually holds — not a
 * constant. `"deepagents"` was hardcoded, and it would survive `eject langchain` unchanged:
 * the fork builds, then opens on a rung it does not contain. Deriving it means a rung-1 fork
 * opens on langchain, which is both correct and the only thing it can serve.
 *
 * Two sources have to agree here (the manifest and the barrel), so this fails loudly if they
 * ever do not, rather than returning something plausible.
 */
export function defaultRungId(): string {
  const present = new Set(adapterIds());
  const candidates = RUNGS.filter(
    (r) =>
      r.shape === "conversation" &&
      r.state === "implemented" &&
      present.has(r.id),
  );
  if (candidates.length === 0) {
    throw new Error(
      "No conversation rung is both declared in rungs.json and present in the adapter " +
        `registry. Manifest declares: ${RUNGS.map((r) => r.id).join(", ")}. ` +
        `Registry holds: ${adapterIds().join(", ") || "(none)"}.`,
    );
  }
  return candidates.reduce((a, b) => (b.ordinal > a.ordinal ? b : a)).id;
}

export type { AdapterEntry };
