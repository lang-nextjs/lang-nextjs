import type { SseAdapter, SseTransform } from "@deepagents-nextjs/server";
import type { ChatRungEntry } from "./registry";
import { RUNGS } from "@deepagents-nextjs/rungs";
import * as registry from "./registry";

/**
 * Public face of the chat-adapter registry.
 *
 * `import * as` is the point: it names no rung. A named import would be pruned out from
 * under this file the moment its rung was ejected, which is the failure this arrangement
 * exists to remove. Whatever the barrel still exports after eject is what a fork can serve.
 */
const entries: readonly ChatRungEntry[] = Object.values(
  registry as Record<string, unknown>
).filter(
  (v): v is ChatRungEntry =>
    typeof v === "object" && v !== null && "id" in v && "adapter" in v
);

/** Framework ids this build can actually proxy, derived from what survived eject. */
export function chatAdapterIds(): readonly string[] {
  return entries.map((e) => e.id);
}

/**
 * Resolve a framework id to its adapter.
 *
 * THROWS rather than returning undefined. The proxy handler treats a missing adapter as
 * "no transforms", which streams the backend's raw wire format through unchanged — a
 * plausible-looking response that is silently the wrong shape for the client. A fork that
 * dropped a rung should refuse a stale request for it, not answer badly.
 */
export function resolveChatAdapter(id: string): SseAdapter {
  const found = entries.find((e) => e.id === id);
  if (!found) {
    throw new Error(
      `Unknown framework "${id}". This build serves: ${
        chatAdapterIds().join(", ") || "(none)"
      }.`
    );
  }
  return found.adapter;
}

/**
 * Every transform contributed by a rung this build still has.
 *
 * Collected across ALL present rungs rather than only the selected one, because that is
 * what the route did before this registry existed — deepagents' enrich transform ran on
 * every request. Preserved deliberately; see ./deepagents.ts.
 */
export function chatTransforms(): SseTransform[] {
  return entries.flatMap((e) => e.transforms?.() ?? []);
}

/**
 * The framework a request falls back to when it names none, or names one this build lacks.
 *
 * DERIVED — highest ordinal present, intersected with what the registry actually holds. The
 * route hardcoded `"deepagents"`, which survives `eject langchain` unchanged: the fork then
 * builds and defaults every unlabelled request to a rung it does not contain. Two sources
 * have to agree here, so this throws rather than returning something plausible.
 */
export function defaultChatId(): string {
  const present = new Set(chatAdapterIds());
  const candidates = RUNGS.filter(
    (r) => r.shape === "conversation" && present.has(r.id)
  );
  if (candidates.length === 0) {
    throw new Error(
      "No conversation rung is both declared in rungs.json and present in the chat " +
        `registry. Manifest declares: ${RUNGS.map((r) => r.id).join(", ")}. ` +
        `Registry holds: ${chatAdapterIds().join(", ") || "(none)"}.`
    );
  }
  return candidates.reduce((a, b) => (b.ordinal > a.ordinal ? b : a)).id;
}

export type { ChatRungEntry };
