import type { SseAdapter, SseTransform } from "@deepagents-nextjs/server";
import { RUNGS } from "@deepagents-nextjs/rungs";
import type { ChatRungEntry } from "./registry";
import * as registry from "./registry";

/**
 * Public face of the chat rung registry.
 *
 * `import * as` is the point: it names no rung. A named import would be pruned out from
 * under this file the moment its rung was ejected, which is the failure this whole
 * arrangement exists to remove. Whatever the barrel still exports after eject is what a fork
 * can serve — no list here to fall out of step with it.
 */
const entries: readonly ChatRungEntry[] = Object.values(
  registry as Record<string, unknown>
).filter(
  (v): v is ChatRungEntry =>
    typeof v === "object" && v !== null && "id" in v && "adapter" in v
);

/** Rung ids this build can actually talk to, derived from what survived eject. */
export function chatRungIds(): readonly string[] {
  return entries.map((e) => e.id);
}

/** Whether this build serves the named rung on /chat. */
export function servesChatRung(id: string): boolean {
  return entries.some((e) => e.id === id);
}

/**
 * Resolve a rung id to its adapter.
 *
 * THROWS rather than returning undefined. `createSseProxyHandler` treats a missing adapter as
 * "run the pipeline with no adapter transforms", which streams the backend's raw wire format
 * through unchanged — a plausible-looking response that is silently the wrong shape. A fork
 * that dropped a rung should fail loudly on a stale request for it, not answer badly.
 *
 * Callers normalise an untrusted id with `servesChatRung` / `defaultChatId` first, so this
 * throwing is a contract about programmer error, not a user-facing 500 on a bad query param.
 */
export function resolveChatAdapter(id: string): SseAdapter {
  const found = entries.find((e) => e.id === id);
  if (!found) {
    throw new Error(
      `Unknown chat rung "${id}". This build serves: ${
        chatRungIds().join(", ") || "(none)"
      }.`
    );
  }
  return found.adapter;
}

/** The rung's own stream transforms, built fresh. Empty for a rung that contributes none. */
export function chatTransformsFor(id: string): SseTransform[] {
  const found = entries.find((e) => e.id === id);
  if (!found) {
    throw new Error(
      `Unknown chat rung "${id}". This build serves: ${
        chatRungIds().join(", ") || "(none)"
      }.`
    );
  }
  return found.transforms?.() ?? [];
}

/**
 * The rung a chat request lands on when it selects none.
 *
 * DERIVED, not a constant. The route hardcoded `"deepagents"`, and that literal survives
 * `pnpm eject langchain` untouched: the fork builds, then defaults every unlabelled request
 * to a rung it does not contain. Highest ordinal present, intersected with what the barrel
 * actually holds, means a rung-1 fork defaults to langchain — the only thing it can serve —
 * while a full ladder still defaults to deepagents, exactly as before.
 *
 * Two sources have to agree here (the manifest and the barrel), so this fails loudly if they
 * ever do not, rather than returning something plausible.
 */
export function defaultChatId(): string {
  const present = new Set(chatRungIds());
  const candidates = RUNGS.filter(
    (r) =>
      r.shape === "conversation" &&
      r.state === "implemented" &&
      present.has(r.id)
  );
  if (candidates.length === 0) {
    throw new Error(
      "No conversation rung is both declared in rungs.json and present in the chat " +
        `registry. Manifest declares: ${RUNGS.map((r) => r.id).join(", ")}. ` +
        `Registry holds: ${chatRungIds().join(", ") || "(none)"}.`
    );
  }
  return candidates.reduce((a, b) => (b.ordinal > a.ordinal ? b : a)).id;
}

export type { ChatRungEntry };
