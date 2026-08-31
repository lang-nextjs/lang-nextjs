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

/**
 * Hex characters of entropy in the prefix, after the `da_` marker.
 *
 * Was 4 — 16 bits — which made a collision a 1-in-350 event at 20 keys and a
 * coin flip at 302. Eight is 32 bits and still short enough to recognise a key
 * by eye, which is the whole reason the prefix exists. See generateApiKey.
 */
const PREFIX_HEX_CHARS = 8;
const PREFIX_LENGTH = "da_".length + PREFIX_HEX_CHARS;

/** Bound on the uniqueness retry. See generateApiKey for why it cannot bite. */
const MAX_PREFIX_ATTEMPTS = 32;

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

  /*
   * THE PREFIX MUST BE UNIQUE, AND BOTH HALVES OF THIS ARE LOAD-BEARING (#414).
   *
   * It is the listing's only human-readable identifier, and revocation is
   * destructive — two keys showing the same prefix and the operator revokes by
   * eye and hits the wrong one. `e2e/api/keys.spec.ts` asserts distinctness as
   * an INVARIANT, and it caught this on main: 19 unique prefixes out of 20.
   *
   * WIDENING ALONE WOULD NOT HAVE BEEN ENOUGH, and this is the measurement the
   * next person has to beat rather than re-derive. The prefix was `da_` plus
   * FOUR hex characters — 16 bits, 65,536 values — with nothing enforcing
   * uniqueness, so it is the birthday problem:
   *
   *       keys      4 hex (16 bits)      8 hex (32 bits)
   *         20              0.290%           0.0000044%
   *        100              7.278%           0.0001153%
   *        302             50.072%           0.0010582%
   *       1000             99.953%           0.0116292%
   *
   *   50% is reached at ~301 keys on 16 bits and ~77,162 on 32.
   *
   * Eight hex characters make a collision rare. RARE IS NOT AN INVARIANT, and a
   * rarer failure is a worse one here: it would fire perhaps once in ten
   * thousand runs, by which time nobody would believe it was real. That is the
   * reflex #400 and #411 are about — a red that is usually spurious teaches
   * people to re-run, and this red was correct every time it appeared.
   *
   * So the width buys a cheap loop and the loop buys the guarantee. At 1000
   * stored keys the probability a fresh prefix collides is 2.3e-7, so the retry
   * below effectively never runs; on 16 bits it would have run 1.5% of the time.
   *
   * CHECKED AGAINST `store`, NOT A SEPARATE INDEX. Revoked keys stay in the
   * store and stay listed — `revokeKey` sets `revokedAt` and leaves the entry —
   * so a released prefix could be reissued and the listing would show two rows
   * with the same one, which is the ambiguity this exists to prevent. Reading
   * the store cannot drift from the listing the way a parallel Set could.
   */
  let plainKey = "";
  let prefix = "";
  for (let attempt = 0; ; attempt++) {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    plainKey = `da_${Array.from(raw, (b) =>
      b.toString(16).padStart(2, "0")
    ).join("")}`;
    prefix = plainKey.slice(0, PREFIX_LENGTH);
    let taken = false;
    for (const existing of store.values()) {
      if (existing.prefix === prefix) {
        taken = true;
        break;
      }
    }
    if (!taken) break;
    /*
     * A BOUND, SO EXHAUSTION IS AN ERROR RATHER THAN A HANG. Unreachable in
     * practice — it needs the 32-bit space to be saturated — but an unbounded
     * loop over a full space is a hang with no message, and a caller that
     * cannot be told why is a caller that reports something else.
     */
    if (attempt >= MAX_PREFIX_ATTEMPTS) {
      throw new Error(
        `could not allocate a unique ${PREFIX_HEX_CHARS}-hex key prefix after ` +
          `${MAX_PREFIX_ATTEMPTS} attempts with ${store.size} keys stored — ` +
          `the prefix space is saturated and must be widened`
      );
    }
  }
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
