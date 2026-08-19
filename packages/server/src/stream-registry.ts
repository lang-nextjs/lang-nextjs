export type RegisterResult =
  | { ok: true; streamId: string }
  | { ok: false; reason: "active" | "expired_during_call" };

interface StreamRecord {
  streamId: string;
  createdAt: number;
  done: boolean;
  /**
   * Optional stored ReadableStream for content replay on reconnect.
   * Used as a fallback when createResumableStreamContext is not available
   * in the installed ai package version. Set via registerStream optional arg.
   */
  stream?: ReadableStream;
}

const TTL_MS = 5 * 60 * 1000; // 5 minutes

// Stable singleton that survives Next.js HMR — mirrors Prisma client pattern
function getRegistry(): Map<string, StreamRecord> {
  const g = globalThis as unknown as {
    __deepagents_stream_registry?: Map<string, StreamRecord>;
  };
  g.__deepagents_stream_registry ??= new Map();
  return g.__deepagents_stream_registry;
}

export function registerStream(
  resumeId: string,
  streamId: string,
  stream?: ReadableStream
): void {
  getRegistry().set(resumeId, {
    streamId,
    createdAt: Date.now(),
    done: false,
    stream,
  });
}

export function lookupStream(resumeId: string): StreamRecord | undefined {
  const registry = getRegistry();
  const record = registry.get(resumeId);
  if (!record) return undefined;
  if (Date.now() - record.createdAt > TTL_MS) {
    registry.delete(resumeId);
    return undefined;
  }
  return record;
}

export function markStreamDone(resumeId: string): void {
  const record = getRegistry().get(resumeId);
  if (record) record.done = true;
}

export function deleteStream(resumeId: string): void {
  getRegistry().delete(resumeId);
}

export function atomicRegisterIfAbsent(
  resumeId: string,
  streamId: string,
  stream?: ReadableStream
): RegisterResult {
  const registry = getRegistry();
  const existing = registry.get(resumeId);

  if (existing) {
    // Check TTL — if expired, evict and allow re-registration
    if (Date.now() - existing.createdAt > TTL_MS) {
      registry.delete(resumeId);
      // Fall through to register below
    } else if (!existing.done) {
      return { ok: false, reason: "active" };
    }
    // existing is done=true and within TTL — fall through to overwrite
  }

  registry.set(resumeId, {
    streamId,
    createdAt: Date.now(),
    done: false,
    stream,
  });
  return { ok: true, streamId };
}

/**
 * Proactively sweep all entries older than TTL_MS from the registry.
 * Called by setInterval in production; exported so tests can invoke it directly.
 */
export function cleanupExpired(): void {
  const registry = getRegistry();
  const now = Date.now();
  for (const [key, record] of registry) {
    if (now - record.createdAt > TTL_MS) {
      registry.delete(key);
    }
  }
}
