export interface ApiKeyMeta {
  id: string;
  name: string;
  prefix: string;
  hashedKey: string;
  createdAt: string;
  revokedAt: string | null;
}

const store = new Map<string, ApiKeyMeta>();

const PREFIX_MAP = new Map<string, string>();

import { createHash } from "crypto";

function hashKey(key: string): string {
  // SHA-256 for collision resistance — the djb2 variant has an exploitable 32-bit
  // range (~4 billion values) that allows authentication bypass via crafted collisions.
  return createHash("sha256").update(key).digest("hex");
}

export function generateApiKey(name: string): {
  meta: ApiKeyMeta;
  plainKey: string;
} {
  const id = crypto.randomUUID();
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const plainKey = `da_${Array.from(raw, (b) =>
    b.toString(16).padStart(2, "0")
  ).join("")}`;
  const prefix = plainKey.slice(0, 7);
  const hashedKey = hashKey(plainKey);

  const meta: ApiKeyMeta = {
    id,
    name,
    prefix,
    hashedKey,
    createdAt: new Date().toISOString(),
    revokedAt: null,
  };

  store.set(id, meta);
  PREFIX_MAP.set(hashedKey, id);

  // Return a shallow copy so callers cannot mutate the internal store reference.
  return { meta: { ...meta }, plainKey };
}

export function validateApiKey(key: string): ApiKeyMeta | null {
  if (!key.startsWith("da_")) return null;
  const hashedKey = hashKey(key);
  const id = PREFIX_MAP.get(hashedKey);
  if (!id) return null;
  const meta = store.get(id);
  if (!meta || meta.revokedAt) return null;
  // Return a shallow copy so callers cannot mutate the internal store reference.
  return { ...meta };
}

export function listKeys(): ApiKeyMeta[] {
  // Return shallow copies so callers cannot mutate the internal store entries.
  return Array.from(store.values(), (m) => ({ ...m }));
}

export function revokeKey(id: string): ApiKeyMeta | null {
  const meta = store.get(id);
  if (!meta) return null;
  // Idempotency guard: if already revoked, preserve the original revocation timestamp.
  if (meta.revokedAt) return { ...meta };
  meta.revokedAt = new Date().toISOString();
  PREFIX_MAP.delete(meta.hashedKey);
  // Return a shallow copy so callers cannot mutate the internal store reference.
  return { ...meta };
}

export function _dangerousClearStore(): void {
  store.clear();
  PREFIX_MAP.clear();
}
