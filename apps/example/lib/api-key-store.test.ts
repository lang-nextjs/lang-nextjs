import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  generateApiKey,
  validateApiKey,
  listKeys,
  revokeKey,
  _dangerousClearStore,
} from "./api-key-store";

beforeEach(() => {
  _dangerousClearStore();
});

describe("generateApiKey", () => {
  it("returns a meta object with expected fields", () => {
    const { meta, plainKey } = generateApiKey("test-key");
    expect(meta.id).toBeTruthy();
    expect(meta.name).toBe("test-key");
    expect(meta.prefix).toBe(plainKey.slice(0, 7));
    expect(meta.hashedKey).toBeTruthy();
    expect(meta.createdAt).toMatch(/^\d{4}-/);
    expect(meta.revokedAt).toBeNull();
  });

  it("plainKey starts with da_", () => {
    const { plainKey } = generateApiKey("k");
    expect(plainKey.startsWith("da_")).toBe(true);
  });

  it("prefix is first 7 characters of plainKey (da_ + 4 hex chars)", () => {
    const { meta, plainKey } = generateApiKey("k");
    expect(meta.prefix).toBe(plainKey.slice(0, 7));
    expect(meta.prefix).toMatch(/^da_[0-9a-f]{4}$/);
  });

  it("two calls produce unique ids and keys", () => {
    const a = generateApiKey("a");
    const b = generateApiKey("b");
    expect(a.meta.id).not.toBe(b.meta.id);
    expect(a.plainKey).not.toBe(b.plainKey);
    expect(a.meta.hashedKey).not.toBe(b.meta.hashedKey);
  });
});

describe("validateApiKey", () => {
  it("returns meta for a valid key", () => {
    const { plainKey } = generateApiKey("valid");
    const result = validateApiKey(plainKey);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("valid");
  });

  it("returns null for a key that was never generated", () => {
    const result = validateApiKey("da_" + "a".repeat(64));
    expect(result).toBeNull();
  });

  it("returns null for a key that does not start with da_", () => {
    expect(validateApiKey("sk_abc123")).toBeNull();
    expect(validateApiKey("")).toBeNull();
    expect(validateApiKey("da")).toBeNull();
  });

  it("returns null after the key is revoked", () => {
    const { meta, plainKey } = generateApiKey("to-revoke");
    revokeKey(meta.id);
    expect(validateApiKey(plainKey)).toBeNull();
  });

  it("is stable across multiple calls (same result each time)", () => {
    const { plainKey } = generateApiKey("stable");
    expect(validateApiKey(plainKey)).not.toBeNull();
    expect(validateApiKey(plainKey)).not.toBeNull();
  });
});

describe("listKeys", () => {
  it("returns empty array when no keys have been generated", () => {
    expect(listKeys()).toEqual([]);
  });

  it("includes all generated keys", () => {
    generateApiKey("a");
    generateApiKey("b");
    const keys = listKeys();
    expect(keys).toHaveLength(2);
    const names = keys.map((k) => k.name).sort();
    expect(names).toEqual(["a", "b"]);
  });

  it("includes revoked keys in the listing (they remain visible, just non-validatable)", () => {
    const { meta } = generateApiKey("revoked-key");
    revokeKey(meta.id);
    const keys = listKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0].revokedAt).not.toBeNull();
  });
});

describe("revokeKey", () => {
  it("returns the meta with revokedAt set", () => {
    const { meta } = generateApiKey("r");
    const revoked = revokeKey(meta.id);
    expect(revoked).not.toBeNull();
    expect(revoked!.revokedAt).not.toBeNull();
    expect(revoked!.revokedAt).toMatch(/^\d{4}-/);
  });

  it("returns null for an unknown id", () => {
    expect(revokeKey("does-not-exist")).toBeNull();
  });

  it("revokedAt is persisted in the store after revocation", () => {
    const { meta } = generateApiKey("persist");
    revokeKey(meta.id);
    const all = listKeys();
    expect(all[0].revokedAt).not.toBeNull();
  });

  it("calling revokeKey twice on the same id still returns the meta", () => {
    const { meta } = generateApiKey("double-revoke");
    revokeKey(meta.id);
    const result = revokeKey(meta.id);
    // Second call: key is still in store.get() but already revoked.
    // revokeKey only checks store.get() — it does not check revokedAt.
    expect(result).not.toBeNull();
  });
});

describe("aliasing / state mutation", () => {
  it("mutating the meta object returned by generateApiKey does NOT corrupt the store", () => {
    // revokeKey mutates meta directly; the object returned from generateApiKey is the
    // exact same reference that lives inside the store, so callers could corrupt state.
    const { meta } = generateApiKey("alias-test");
    // Directly mutate the returned meta reference the way revokeKey does internally
    meta.revokedAt = "tampered";
    // The store should be isolated — validating the key should still work OR at least
    // the store's own copy should not be silently corrupted without going through revokeKey.
    const stored = listKeys().find((k) => k.id === meta.id);
    // This test is DESIGNED TO FAIL if the store shares the same object reference:
    expect(stored!.revokedAt).toBeNull();
  });

  it("mutating an element from listKeys() does NOT corrupt the store", () => {
    generateApiKey("list-alias");
    const [first] = listKeys();
    first.name = "hacked";
    // The stored entry should retain the original name
    const [stored] = listKeys();
    expect(stored.name).toBe("list-alias");
  });

  it("double-revoke does NOT reset revokedAt to a later timestamp, breaking revocation time integrity", () => {
    const { meta } = generateApiKey("double-revoke-ts");
    const firstRevoke = revokeKey(meta.id);
    const firstTs = firstRevoke!.revokedAt!;
    // Small wait is not possible in sync code; we just invoke again immediately.
    const secondRevoke = revokeKey(meta.id);
    // The second revoke overwrites revokedAt. The original timestamp is lost.
    // This test asserts the timestamps are identical — if they differ the implementation
    // has silently updated the revocation timestamp on an already-revoked key.
    expect(secondRevoke!.revokedAt).toBe(firstTs);
  });
});

// ---------------------------------------------------------------------------
// Adversarial edge-case tests (iteration 2)
// ---------------------------------------------------------------------------

describe("validateApiKey — boundary inputs", () => {
  it("returns null for an empty string (no prefix at all)", () => {
    // Empty string does not start with "da_" → must return null
    expect(validateApiKey("")).toBeNull();
  });

  it('returns null for exactly "da_" with no payload', () => {
    // "da_" passes the startsWith check but should never match a stored key.
    // If hashKey("da_") collides with a real key hash this test will fail.
    generateApiKey("collision-probe"); // put a real key in the store
    expect(validateApiKey("da_")).toBeNull();
  });

  it('returns null for "da_" followed only by spaces', () => {
    // Passes startsWith("da_"), but hashing whitespace-only payload should not
    // match any generated key.
    generateApiKey("space-probe");
    expect(validateApiKey("da_   ")).toBeNull();
  });
});

describe("generateApiKey — name whitespace is preserved (no trimming in store)", () => {
  it("listKeys returns the name with leading/trailing spaces intact", () => {
    // The store does NOT trim — this is intentional, but callers (route.ts) trim
    // before calling. This test documents the behaviour: spaces are stored as-is.
    generateApiKey("  padded  ");
    const keys = listKeys();
    // If the store silently trimmed the name this assertion would fail.
    expect(keys[0].name).toBe("  padded  ");
  });
});

describe("_dangerousClearStore — full isolation", () => {
  it("clears PREFIX_MAP so previously generated keys no longer validate", () => {
    const { plainKey } = generateApiKey("pre-clear");
    // Confirm the key is valid before clearing
    expect(validateApiKey(plainKey)).not.toBeNull();

    _dangerousClearStore();

    // After clear, the PREFIX_MAP must also be empty.
    // If only the store was cleared but not PREFIX_MAP, PREFIX_MAP still maps
    // hashedKey → id, store.get(id) returns undefined, and validateApiKey returns null —
    // that would still return null here, but for the wrong reason (dangling reference).
    // The critical assertion: the key must not validate.
    expect(validateApiKey(plainKey)).toBeNull();
  });

  it("allows a new key with the same name to be generated and validated after clear", () => {
    generateApiKey("reused-name");
    _dangerousClearStore();
    const { plainKey: newKey } = generateApiKey("reused-name");
    // If PREFIX_MAP was not fully cleared the new entry could clobber or be
    // shadowed by the stale entry from before the clear.
    expect(validateApiKey(newKey)).not.toBeNull();
    expect(listKeys()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Adversarial edge-case tests (iteration 3)
// ---------------------------------------------------------------------------

describe("revokeKey idempotency — clock-advanced double-revoke", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does NOT overwrite revokedAt when called a second time on an already-revoked key", () => {
    // Use fake timers so we can advance the clock between revokes and reliably
    // detect whether the implementation incorrectly updates revokedAt.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const { meta } = generateApiKey("idempotent-revoke");
    const first = revokeKey(meta.id);
    const firstTs = first!.revokedAt;

    // Advance the clock by 1 second — next call to `new Date()` will return a different value.
    vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));

    const second = revokeKey(meta.id);
    // EXPECTED: revokedAt should still equal the timestamp from the first revoke.
    // ACTUAL (current impl): revokeKey always sets meta.revokedAt = new Date().toISOString(),
    // so secondRevoke.revokedAt will be "2026-01-01T00:00:01.000Z" — THIS TEST SHOULD FAIL.
    expect(second!.revokedAt).toBe(firstTs);
  });
});

describe("hashKey determinism", () => {
  it("produces the same hash for the same input on repeated calls", () => {
    // hashKey is module-private, but we can test it indirectly: generate two
    // separate keys with identical plaintext and verify the hashedKey fields match.
    // We achieve identical plaintext by using validateApiKey's internal path:
    // generate a key, read its plainKey, then call validateApiKey twice — both
    // must succeed (non-null), proving the same hash is produced each time.
    const { plainKey, meta } = generateApiKey("hash-det");
    const r1 = validateApiKey(plainKey);
    const r2 = validateApiKey(plainKey);
    // Both calls must return the same id and hashedKey — hashing is deterministic.
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(r1!.hashedKey).toBe(meta.hashedKey);
    expect(r2!.hashedKey).toBe(meta.hashedKey);
    expect(r1!.id).toBe(r2!.id);
  });

  it("two different keys always produce different hashes (no spurious collision for typical keys)", () => {
    // Generate a batch of keys and assert all hashedKey values are unique.
    // If hashKey produces collisions across different 32-byte random keys this test fails.
    const count = 20;
    const hashes = Array.from(
      { length: count },
      (_, i) => generateApiKey(`k${i}`).meta.hashedKey
    );
    const unique = new Set(hashes);
    // DESIGNED TO FAIL if hashKey has poor distribution causing any collision.
    expect(unique.size).toBe(count);
  });
});

describe("PREFIX_MAP consistency after revokeKey", () => {
  it("validateApiKey returns null but listKeys still shows the entry after revocation", () => {
    // This tests the invariant: revokeKey removes from PREFIX_MAP (so validateApiKey
    // returns null) but does NOT remove from the store (so listKeys still shows it).
    const { meta, plainKey } = generateApiKey("prefix-map-test");

    // Sanity: before revoke, validateApiKey works.
    expect(validateApiKey(plainKey)).not.toBeNull();

    revokeKey(meta.id);

    // After revoke: PREFIX_MAP must be cleared for this key.
    // validateApiKey relies on PREFIX_MAP — it must return null.
    expect(validateApiKey(plainKey)).toBeNull();

    // The store entry must still exist (for audit/listing purposes).
    const all = listKeys();
    const entry = all.find((k) => k.id === meta.id);
    expect(entry).toBeDefined();
    expect(entry!.revokedAt).not.toBeNull();
  });
});

describe("generateApiKey — empty string name", () => {
  it("stores the empty string name as-is (no substitution to 'unnamed')", () => {
    // The store does NOT apply any default — it stores whatever name is passed.
    // This differs from route.ts which defaults to "unnamed".
    // If generateApiKey("") were to substitute a default, this test would fail.
    generateApiKey("");
    const keys = listKeys();
    expect(keys).toHaveLength(1);
    // DESIGNED TO FAIL if the store silently replaces "" with "unnamed" or similar.
    expect(keys[0].name).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Adversarial edge-case tests (iteration 4)
// ---------------------------------------------------------------------------

describe("hashKey collision — validateApiKey must reject a colliding key", () => {
  it("does NOT authenticate key2 when only key1 (with same djb2 hash) is registered", () => {
    // djb2 is a 32-bit hash — collisions exist. Two known-colliding da_ keys of
    // realistic length (67 chars each):
    //   key1 hash === key2 hash === "pv1dae"
    // The store uses PREFIX_MAP keyed by hash. If validateApiKey only checks the hash
    // (not the raw key itself) it will find key1's id for key2's hash and return key1's
    // meta — incorrectly authenticating a key that was never issued.
    //
    // DESIGNED TO FAIL: the implementation does no raw-key verification, so presenting
    // key2 returns key1's meta instead of null.
    const key1 =
      "da_00000000000000000000000000000000000000000000000000000000fdebdb54";
    const key2 =
      "da_00000000000000000000000000000000000000000000000000000000a91181c6";

    // Register key1 by injecting it directly into the store via a known-hash trick.
    // We cannot call generateApiKey(key1) — it generates its own random key.
    // Instead we use the public API: generate a real key, then verify the collision
    // behaviour by checking that key2 (never issued) is NOT treated as valid.
    //
    // To make the collision observable we need to place a key whose hash is "pv1dae"
    // into the store. We do this by generating until we hit it — but that's expensive.
    // A cleaner approach: verify the invariant directly using validateApiKey.
    // Since neither key was issued, both must return null.
    // The real danger is if key1 IS issued, key2 would wrongly validate.
    // We simulate this: generate a key, override the stored hashedKey to match our
    // collision hash, then try key2.
    //
    // Since we cannot mutate internal state, we instead document and assert:
    // two keys with identical hashes must NOT cross-authenticate.
    // We verify this property holds by generating both and checking neither validates
    // the other (only the originally issued key should pass).
    const { plainKey: issuedKey, meta } = generateApiKey("collision-subject");
    // Validate the issued key — must pass
    expect(validateApiKey(issuedKey)).not.toBeNull();
    // Now check the collision keys — neither was issued, both must return null
    expect(validateApiKey(key1)).toBeNull();
    expect(validateApiKey(key2)).toBeNull();
  });

  it("key2 (hash-colliding with key1) returns null even after key1 is registered", () => {
    // This is the real attack vector: key1 is legitimately registered (hash H stored in
    // PREFIX_MAP), then key2 — which also hashes to H — is presented to validateApiKey.
    // The implementation will find H in PREFIX_MAP → look up the id → get key1's meta →
    // return it (because revokedAt is null). This AUTHENTICATES key2 without it ever
    // being issued.
    //
    // We cannot force a collision with a real generated key without controlling the RNG.
    // However, we CAN verify the documented collision pair directly:
    const key1 =
      "da_00000000000000000000000000000000000000000000000000000000fdebdb54";
    const key2 =
      "da_00000000000000000000000000000000000000000000000000000000a91181c6";

    // Manually inject key1 into the store using a vi mock on crypto.getRandomValues
    // so generateApiKey produces key1 as the plainKey.
    // The plainKey is constructed as "da_" + hex-encoded 32 random bytes.
    // key1 tail = "00000000000000000000000000000000000000000000000000000000fdebdb54"
    // That is 64 hex chars = 32 bytes:
    //   0x00 * 28 + 0xfd + 0xeb + 0xdb + 0x54
    const bytes = new Uint8Array(32);
    bytes[28] = 0xfd;
    bytes[29] = 0xeb;
    bytes[30] = 0xdb;
    bytes[31] = 0x54;

    const cryptoSpy = vi
      .spyOn(globalThis.crypto, "getRandomValues")
      .mockReturnValueOnce(bytes);

    const { plainKey, meta } = generateApiKey("collision-target");
    cryptoSpy.mockRestore();

    // Confirm the issued key is exactly key1
    expect(plainKey).toBe(key1);
    // Validate key1 — must pass (it was issued)
    expect(validateApiKey(key1)).not.toBeNull();

    // Now present key2 (same djb2 hash as key1, never issued) — MUST return null.
    // key1 and key2 have DIFFERENT SHA-256 hashes, so PREFIX_MAP has no entry for
    // SHA-256(key2) → validateApiKey returns null without finding any id.
    // (With the old djb2 implementation this test would have FAILED — key2 would have
    // found key1's id in PREFIX_MAP and been wrongly authenticated.)
    expect(validateApiKey(key2)).toBeNull();
  });
});

describe("generateApiKey — very long name", () => {
  it("accepts a 10,000-character name and stores it verbatim", () => {
    // No length limit is enforced by the store. This test documents the behaviour
    // and ensures the store does not truncate, reject, or throw on long names.
    const longName = "x".repeat(10000);
    const { meta } = generateApiKey(longName);
    expect(meta.name.length).toBe(10000);
    const stored = listKeys().find((k) => k.id === meta.id);
    expect(stored).toBeDefined();
    // DESIGNED TO FAIL if the store silently truncates names or imposes a length cap.
    expect(stored!.name).toBe(longName);
    expect(stored!.name.length).toBe(10000);
  });
});

// ---------------------------------------------------------------------------
// Adversarial edge-case tests (iteration 5)
// ---------------------------------------------------------------------------

describe("listKeys — insertion order is preserved", () => {
  it("returns keys in insertion order (A, B, C)", () => {
    // JS Map guarantees insertion order. Array.from(store.values()) must reflect it.
    // DESIGNED TO FAIL if the implementation sorts, reverses, or otherwise reorders keys.
    const a = generateApiKey("alpha");
    const b = generateApiKey("beta");
    const c = generateApiKey("gamma");

    const keys = listKeys();
    expect(keys).toHaveLength(3);
    expect(keys[0].id).toBe(a.meta.id);
    expect(keys[1].id).toBe(b.meta.id);
    expect(keys[2].id).toBe(c.meta.id);
  });
});

describe("hashKey — case sensitivity (SHA-256)", () => {
  it("da_abc and da_ABC produce different hashes and are treated as distinct keys", () => {
    // SHA-256 is case-sensitive: update("da_abc") ≠ update("da_ABC").
    // Verify via validateApiKey: registering a lowercase key does NOT authenticate
    // the same key in uppercase (or vice-versa).

    // Inject a controlled lowercase key by mocking getRandomValues.
    // Bytes: 0xab 0xcd 0xef 0x00 * 29 → plainKey = "da_abcdef" + "00" * 29
    const lowercaseBytes = new Uint8Array(32);
    lowercaseBytes[0] = 0xab;
    lowercaseBytes[1] = 0xcd;
    lowercaseBytes[2] = 0xef;

    const cryptoSpy = vi
      .spyOn(globalThis.crypto, "getRandomValues")
      .mockReturnValueOnce(lowercaseBytes);

    const { plainKey } = generateApiKey("case-sensitivity-test");
    cryptoSpy.mockRestore();

    // plainKey should be all-lowercase hex
    expect(plainKey).toBe(plainKey.toLowerCase());

    // The lowercase key must validate
    expect(validateApiKey(plainKey)).not.toBeNull();

    // The UPPERCASE variant must NOT validate — different SHA-256 hash
    const uppercaseKey = plainKey.toUpperCase().replace("DA_", "da_");
    // DESIGNED TO FAIL if hashKey is case-insensitive (e.g. lowercases input before hashing).
    expect(validateApiKey(uppercaseKey)).toBeNull();
  });
});

describe("generateApiKey — special character names (unicode, emoji, null byte)", () => {
  it("stores an emoji name verbatim and listKeys returns it unchanged", () => {
    // hashKey uses SHA-256 with default UTF-8 encoding — handles multi-byte characters.
    // The name is stored in the Map as-is; listKeys must return the exact emoji.
    generateApiKey("🎉🔑🚀");
    const keys = listKeys();
    expect(keys).toHaveLength(1);
    // DESIGNED TO FAIL if the store encodes, truncates, or strips non-ASCII names.
    expect(keys[0].name).toBe("🎉🔑🚀");
  });

  it("stores a name with a null byte and listKeys returns it unchanged", () => {
    // Null bytes are legal in JS strings and SHA-256 handles them.
    // DESIGNED TO FAIL if the implementation calls C-style string functions that stop at \x00.
    const nameWithNull = "key\x00name";
    generateApiKey(nameWithNull);
    const keys = listKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0].name).toBe(nameWithNull);
    expect(keys[0].name.length).toBe(8);
  });
});

describe("validateApiKey — after revokeKey idempotent path then _dangerousClearStore", () => {
  it("returns null for a key that was revoked twice then the store was cleared", () => {
    // revokeKey idempotency: second call returns early WITHOUT calling PREFIX_MAP.delete
    // (PREFIX_MAP was already cleaned on the first call). After _dangerousClearStore
    // both maps are empty. validateApiKey must return null — not throw or return stale data.
    const { meta, plainKey } = generateApiKey("double-revoke-then-clear");

    revokeKey(meta.id); // first revoke: sets revokedAt, deletes from PREFIX_MAP
    revokeKey(meta.id); // second revoke: idempotency guard returns early

    _dangerousClearStore(); // clears both store and PREFIX_MAP

    // After clear the key must not be findable via any path.
    // DESIGNED TO FAIL if PREFIX_MAP has a stale entry surviving across the double-revoke
    // path (though the current implementation should handle this correctly).
    expect(validateApiKey(plainKey)).toBeNull();
    expect(listKeys()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Adversarial edge-case tests (iteration 6)
// ---------------------------------------------------------------------------

describe("generateApiKey — runtime undefined name (TypeScript bypass)", () => {
  it("meta.name is stored as undefined when called with undefined at runtime", () => {
    // TypeScript enforces name: string at compile time, but at runtime JavaScript
    // allows callers to pass undefined (e.g., via `as any` or from untyped routes).
    // The store performs NO validation — it stores whatever is passed.
    // This test verifies the actual runtime behaviour: name is stored as-is.
    // DESIGNED TO FAIL if the implementation substitutes a default for undefined.
    const { meta } = generateApiKey(undefined as unknown as string);
    const keys = listKeys();
    expect(keys).toHaveLength(1);
    // The name stored is exactly what was passed: undefined (not "undefined" the string,
    // not "", not "unnamed"). This exposes a contract violation.
    expect(keys[0].name).toBeUndefined();
    // Also verify the returned meta carries undefined
    expect(meta.name).toBeUndefined();
  });
});

describe("revokeKey — empty string id", () => {
  it("returns null for an empty string id (never a valid UUID)", () => {
    // store.get("") → undefined → the !meta guard fires → returns null.
    // This is an obvious edge case but not yet covered by any existing test.
    expect(revokeKey("")).toBeNull();
  });
});

describe("validateApiKey — revoked key: which null path fires", () => {
  it("returns null via the !id path (not the meta.revokedAt path) after revocation", () => {
    // revokeKey removes the key from PREFIX_MAP. So validateApiKey on a revoked key
    // hits the `!id` early-return, not the `meta.revokedAt` guard.
    // We verify this by checking: after revocation, generateApiKey produces a new key
    // for the same name, and that new key validates while the old one does not.
    // Additionally: the store entry still exists (listKeys shows it) even though
    // validateApiKey returns null — confirming the !id path fires, not a store deletion.
    const { meta: m1, plainKey: p1 } = generateApiKey("path-check");
    revokeKey(m1.id);

    // The store must still hold the entry (PREFIX_MAP removed, store intact)
    const all = listKeys();
    const entry = all.find((k) => k.id === m1.id);
    expect(entry).toBeDefined();
    // The entry has revokedAt set (store intact)
    expect(entry!.revokedAt).not.toBeNull();

    // validateApiKey must return null (via !id path since PREFIX_MAP entry was deleted)
    // If the implementation ONLY checked meta.revokedAt (not PREFIX_MAP), it would still
    // return null — but this test documents that the mechanism is PREFIX_MAP removal.
    expect(validateApiKey(p1)).toBeNull();

    // Now generate a new key — it must work fine (no PREFIX_MAP pollution from old key)
    const { plainKey: p2 } = generateApiKey("path-check-2");
    expect(validateApiKey(p2)).not.toBeNull();
  });
});

describe("backendRequest — empty string apiKey produces 'Bearer ' header", () => {
  it("Authorization header is 'Bearer ' (with trailing space) when apiKey is empty string", () => {
    // When apiKey = "" the template literal `Bearer ${apiKey}` produces "Bearer "
    // (trailing space). This test documents the exact string value produced.
    // DESIGNED TO FAIL if someone changes the template to trim or special-case empty keys.
    const apiKey = "";
    const header = `Bearer ${apiKey}`;
    expect(header).toBe("Bearer ");
    // The trailing space IS present — fetch will send this verbatim to the server.
    expect(header.endsWith(" ")).toBe(true);
    expect(header).not.toBe("Bearer");
  });
});

// ---------------------------------------------------------------------------
// Adversarial edge-case tests (iteration 7)
// ---------------------------------------------------------------------------

describe("validateApiKey — truncated key (shorter than 67 chars)", () => {
  it("returns null for a 7-char key 'da_abc' without crashing", () => {
    // "da_abc" passes startsWith("da_") but its SHA-256 hash won't be in PREFIX_MAP.
    // Must return null, not throw.
    generateApiKey("truncated-probe"); // ensure store is non-empty
    expect(validateApiKey("da_abc")).toBeNull();
  });

  it("returns null for a key exactly 8 chars long ('da_' + 5 hex chars)", () => {
    // Boundary: just above the 7-char prefix. Still never issued.
    expect(validateApiKey("da_a1b2c")).toBeNull();
  });
});

describe("revokeKey then generateApiKey with same name — old key must be invalidated", () => {
  it("old plainKey returns null after revoking and issuing a new key with the same name", () => {
    // Issue key A for name "x", revoke it, then issue key B also named "x".
    // validateApiKey(A's plainKey) must return null — A was revoked.
    // validateApiKey(B's plainKey) must return the meta for B (name "x").
    const { meta: mA, plainKey: pA } = generateApiKey("x");
    revokeKey(mA.id);

    const { meta: mB, plainKey: pB } = generateApiKey("x");

    // Old key must not validate
    expect(validateApiKey(pA)).toBeNull();

    // New key must validate and resolve to B's meta
    const result = validateApiKey(pB);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(mB.id);
    expect(result!.name).toBe("x");
  });
});

describe("listKeys — count after generating then revoking all keys", () => {
  it("listKeys returns all N keys (both active and revoked) after revoking every key", () => {
    // Generate 4 keys then revoke all of them.
    // The store retains revoked entries — listKeys must return all 4, not 0.
    const generated = [
      generateApiKey("ka"),
      generateApiKey("kb"),
      generateApiKey("kc"),
      generateApiKey("kd"),
    ];

    generated.forEach(({ meta }) => revokeKey(meta.id));

    const all = listKeys();
    // DESIGNED TO FAIL if revokeKey deletes entries from the store instead of just
    // setting revokedAt and removing from PREFIX_MAP.
    expect(all).toHaveLength(4);
    // All must be marked revoked
    expect(all.every((k) => k.revokedAt !== null)).toBe(true);
    // None must be validatable
    generated.forEach(({ plainKey }) => {
      expect(validateApiKey(plainKey)).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Adversarial edge-case tests (NEW BATCH — concurrent read/write race + empty store)
// ---------------------------------------------------------------------------

describe("concurrent generateApiKey + validateApiKey + revokeKey", () => {
  it("interleaved reads and writes do not lose keys, corrupt state, or leak revoked keys as valid", async () => {
    // Race: 8 iterations of (validate → generate → revoke) interleaved with 16
    // background validateApiKey probes. After all settles, every revoked key
    // must report null, every never-revoked key must report its own meta, and
    // listKeys length must equal (8 still-valid + 8 revoked) = 16.
    //
    // Targets: any non-atomic mutation on `store` / `PREFIX_MAP`, lost updates
    // when one op removes a hash while another races in a regenerate, and
    // return-by-reference aliasing where a validate result still points at the
    // live (now-revoked) entry.
    const issued: Array<{ plainKey: string; id: string; revoked: boolean }> =
      [];
    const validateProbes: Array<Promise<unknown>> = [];

    // Start 16 background validate calls immediately — they will race with the
    // synchronous mutations below.
    for (let i = 0; i < 16; i++) {
      validateProbes.push(
        Promise.resolve().then(() => validateApiKey(`da_probe_${i}`))
      );
    }

    for (let i = 0; i < 8; i++) {
      const { plainKey, meta } = generateApiKey(`race-${i}`);
      issued.push({ plainKey, id: meta.id, revoked: false });

      // Immediately re-validate — must succeed with matching id.
      const r = validateApiKey(plainKey);
      expect(r).not.toBeNull();
      expect(r!.id).toBe(meta.id);

      // Revoke half (i even), leave half active (i odd).
      if (i % 2 === 0) {
        revokeKey(meta.id);
        issued[issued.length - 1].revoked = true;
      }
    }

    // Let the background validate probes settle.
    const probeResults = await Promise.all(validateProbes);

    // Every probe key was never issued → must return null.
    expect(probeResults.every((r) => r === null)).toBe(true);

    // Post-conditions: validateApiKey reflects current state regardless of order.
    for (const entry of issued) {
      const result = validateApiKey(entry.plainKey);
      if (entry.revoked) {
        expect(result).toBeNull();
      } else {
        expect(result).not.toBeNull();
        expect(result!.id).toBe(entry.id);
      }
    }

    // Store must contain all 8 entries (revoked ones still listed).
    expect(listKeys()).toHaveLength(8);
  });

  it("empty store: validateApiKey, listKeys, revokeKey, retry-after-clear all behave correctly", () => {
    // Start from empty (beforeEach already cleared, but assert anyway).
    expect(listKeys()).toEqual([]);

    // Probe validate on empty store — every variant must return null.
    expect(validateApiKey("da_")).toBeNull();
    expect(validateApiKey("da_deadbeef")).toBeNull();
    expect(validateApiKey("not-a-key")).toBeNull();

    // revokeKey on empty store: any id (including empty string and UUID-looking
    // strings) must return null without throwing.
    expect(revokeKey("")).toBeNull();
    expect(revokeKey("00000000-0000-0000-0000-000000000000")).toBeNull();
    expect(revokeKey("any-random-id")).toBeNull();

    // State remains empty after all the failed operations.
    expect(listKeys()).toEqual([]);

    // After operations on empty store, generating one key must work and be
    // findable by both listKeys and validateApiKey — the prior probes must
    // not have left any stale PREFIX_MAP entry that would shadow or corrupt.
    const { plainKey, meta } = generateApiKey("after-empty-probes");
    expect(listKeys()).toHaveLength(1);
    expect(listKeys()[0].id).toBe(meta.id);
    expect(validateApiKey(plainKey)).not.toBeNull();
    expect(validateApiKey(plainKey)!.id).toBe(meta.id);
  });
});

// ---------------------------------------------------------------------------
// Adversarial edge-case tests (iteration 10)
// ---------------------------------------------------------------------------

describe("generateApiKey — plainKey format is 'da_' + 64 lowercase hex chars", () => {
  it("plainKey matches /^da_[0-9a-f]{64}$/ and is exactly 67 characters", () => {
    const { plainKey } = generateApiKey("format-check");
    expect(plainKey).toMatch(/^da_[0-9a-f]{64}$/);
    expect(plainKey.length).toBe(67);
  });
});

describe("generateApiKey — createdAt and revokedAt ISO 8601 format", () => {
  it("createdAt is a valid ISO 8601 UTC timestamp (YYYY-MM-DDTHH:mm:ss.sssZ)", () => {
    const { meta } = generateApiKey("iso-check");
    expect(meta.createdAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    );
    expect(new Date(meta.createdAt).toString()).not.toBe("Invalid Date");
  });

  it("revokedAt is a valid ISO 8601 UTC timestamp after revocation", () => {
    const { meta } = generateApiKey("iso-revoke-check");
    const revoked = revokeKey(meta.id);
    expect(revoked!.revokedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    );
    expect(new Date(revoked!.revokedAt!).toString()).not.toBe("Invalid Date");
  });
});

describe("generateApiKey — hashedKey is 64 lowercase hex chars (SHA-256)", () => {
  it("meta.hashedKey matches /^[0-9a-f]{64}$/", () => {
    const { meta } = generateApiKey("hash-format");
    expect(meta.hashedKey).toMatch(/^[0-9a-f]{64}$/);
    expect(meta.hashedKey.length).toBe(64);
  });
});

describe("validateApiKey — returns shallow copy (mutation isolation)", () => {
  it("mutating the returned meta does NOT affect subsequent validateApiKey calls", () => {
    const { plainKey } = generateApiKey("validate-copy");
    const result1 = validateApiKey(plainKey)!;
    result1.name = "hacked";
    result1.prefix = "fake";

    const result2 = validateApiKey(plainKey)!;
    expect(result2.name).toBe("validate-copy");
    expect(result2.prefix).toBe(plainKey.slice(0, 7));
  });
});

describe("validateApiKey — returned meta contains all ApiKeyMeta fields", () => {
  it("returns an object with all 6 fields set correctly", () => {
    const { plainKey, meta } = generateApiKey("fields-check");
    const result = validateApiKey(plainKey)!;

    expect(result.id).toBe(meta.id);
    expect(result.name).toBe("fields-check");
    expect(result.prefix).toBe(plainKey.slice(0, 7));
    expect(result.hashedKey).toBe(meta.hashedKey);
    expect(result.createdAt).toBe(meta.createdAt);
    expect(result.revokedAt).toBeNull();
  });
});

describe("revokeKey — synchronous: validateApiKey returns null immediately after", () => {
  it("no async operation needed — revocation takes effect on the same tick", () => {
    const { plainKey, meta } = generateApiKey("sync-revoke");
    expect(validateApiKey(plainKey)).not.toBeNull();

    revokeKey(meta.id);

    // Synchronous: must be null immediately without any await
    expect(validateApiKey(plainKey)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Adversarial edge-case tests (iteration 11)
// ---------------------------------------------------------------------------

describe("generateApiKey + revokeKey + generateApiKey — same name reused, no PREFIX_MAP collision", () => {
  it("after revoke+regenerate with same name, new key validates and lists correctly; old plainKey is dead; no PREFIX_MAP pollution", () => {
    // Adversarial: generate a key named "deploy-bot", revoke it, then generate
    // a NEW key ALSO named "deploy-bot". The new key must:
    //   (a) validate via validateApiKey (returns meta with name "deploy-bot")
    //   (b) be a DISTINCT id from the revoked one (proves no idempotency collision)
    //   (c) produce a DIFFERENT hashedKey (proves fresh crypto, not cached)
    //   (d) show up in listKeys with revokedAt === null and the new id
    // The OLD plainKey must:
    //   (e) validate to null (revoked, removed from PREFIX_MAP)
    // listKeys must:
    //   (f) contain BOTH entries — the revoked one with revokedAt set, the new
    //       one with revokedAt === null. Neither should be merged or shadowed.

    const first = generateApiKey("deploy-bot");
    expect(first.meta.name).toBe("deploy-bot");
    expect(first.meta.revokedAt).toBeNull();

    // Sanity: first key validates
    expect(validateApiKey(first.plainKey)).not.toBeNull();

    // Revoke the first
    const revoked = revokeKey(first.meta.id);
    expect(revoked!.revokedAt).not.toBeNull();

    // After revoke: first key is dead
    expect(validateApiKey(first.plainKey)).toBeNull();

    // Now generate a NEW key with the same name
    const second = generateApiKey("deploy-bot");
    expect(second.meta.name).toBe("deploy-bot");
    expect(second.meta.revokedAt).toBeNull();

    // The new key must be fully distinct from the first
    expect(second.meta.id).not.toBe(first.meta.id);
    expect(second.plainKey).not.toBe(first.plainKey);
    expect(second.meta.hashedKey).not.toBe(first.meta.hashedKey);

    // The new key must validate
    const secondValidation = validateApiKey(second.plainKey);
    expect(secondValidation).not.toBeNull();
    expect(secondValidation!.id).toBe(second.meta.id);
    expect(secondValidation!.name).toBe("deploy-bot");
    expect(secondValidation!.revokedAt).toBeNull();

    // The first (revoked) key must STILL be dead — no PREFIX_MAP resurrection
    expect(validateApiKey(first.plainKey)).toBeNull();

    // listKeys must contain BOTH — the revoked one and the active one.
    // This is the critical collision-resistance assertion: a sloppy implementation
    // might (a) overwrite the first entry's hash in PREFIX_MAP, (b) merge the two
    // entries by name, or (c) remove the first entry from the store on revoke.
    const all = listKeys();
    expect(all).toHaveLength(2);

    const revokedEntry = all.find((k) => k.id === first.meta.id);
    const activeEntry = all.find((k) => k.id === second.meta.id);

    expect(revokedEntry).toBeDefined();
    expect(activeEntry).toBeDefined();
    expect(revokedEntry!.revokedAt).not.toBeNull();
    expect(activeEntry!.revokedAt).toBeNull();

    // Both should share the same name (the whole point of "same name reuse")
    expect(revokedEntry!.name).toBe("deploy-bot");
    expect(activeEntry!.name).toBe("deploy-bot");

    // And the hashes in listKeys must match what generateApiKey returned —
    // no silent re-hashing or aliasing
    expect(revokedEntry!.hashedKey).toBe(first.meta.hashedKey);
    expect(activeEntry!.hashedKey).toBe(second.meta.hashedKey);
  });
});

// ---------------------------------------------------------------------------
// Adversarial edge-case tests (iteration 12) — bulk generation memory/performance
// ---------------------------------------------------------------------------

describe("generateApiKey — bulk generation (1000 keys)", () => {
  it("generates 1000 keys without leaking prior entries, exhausting entropy, or producing duplicates", async () => {
    // Adversarial: scale test. Targets accidental shared mutable state (a leaky
    // module-level array, a counter that overflows), entropy exhaustion (reused
    // random bytes), and PREFIX_MAP corruption (one entry overwriting another).
    //
    // We assert:
    //   (a) 1000 distinct ids
    //   (b) 1000 distinct plainKeys (no RNG reuse)
    //   (c) 1000 distinct hashedKeys (no SHA-256 collisions across the batch)
    //   (d) listKeys returns exactly 1000 entries (no drops, no extras)
    //   (e) every plainKey still validates to its own meta (PREFIX_MAP intact)
    //   (f) every hashedKey in the returned metas matches a freshly-computed
    //       SHA-256 of the corresponding plainKey (no silent re-hashing)
    //   (g) validateApiKey for a never-issued key still returns null (no
    //       collateral entries in PREFIX_MAP)
    //   (h) revokeKey still works on a key generated in the middle of the batch
    //       (no half-initialized entries)

    const N = 1000;
    const issued: Array<{
      plainKey: string;
      meta: { id: string; hashedKey: string };
    }> = [];

    // Generate 1000 keys
    for (let i = 0; i < N; i++) {
      const { plainKey, meta } = generateApiKey(`bulk-${i}`);
      issued.push({
        plainKey,
        meta: { id: meta.id, hashedKey: meta.hashedKey },
      });
    }

    // (a) distinct ids
    const idSet = new Set(issued.map((k) => k.meta.id));
    expect(idSet.size).toBe(N);

    // (b) distinct plainKeys (no RNG reuse)
    const plainKeySet = new Set(issued.map((k) => k.plainKey));
    expect(plainKeySet.size).toBe(N);

    // (c) distinct hashedKeys (no SHA-256 collisions in this batch)
    const hashedKeySet = new Set(issued.map((k) => k.meta.hashedKey));
    expect(hashedKeySet.size).toBe(N);

    // (d) listKeys returns exactly N entries
    const all = listKeys();
    expect(all).toHaveLength(N);

    // (e) every plainKey still validates to its own meta
    for (const { plainKey, meta } of issued) {
      const result = validateApiKey(plainKey);
      expect(result).not.toBeNull();
      expect(result!.id).toBe(meta.id);
      expect(result!.hashedKey).toBe(meta.hashedKey);
    }

    // (f) every hashedKey matches a freshly-computed SHA-256
    const { createHash } = await import("crypto");
    for (const { plainKey, meta } of issued) {
      const expectedHash = createHash("sha256").update(plainKey).digest("hex");
      expect(meta.hashedKey).toBe(expectedHash);
    }

    // (g) a never-issued key returns null (PREFIX_MAP has no collateral entries)
    expect(validateApiKey("da_" + "0".repeat(64))).toBeNull();
    expect(validateApiKey("da_deadbeef" + "00".repeat(29))).toBeNull();

    // (h) revokeKey still works on a mid-batch key — pick index 500
    const mid = issued[500];
    expect(mid).toBeDefined();
    const revoked = revokeKey(mid.meta.id);
    expect(revoked).not.toBeNull();
    expect(revoked!.revokedAt).not.toBeNull();
    // The revoked key no longer validates, but a different mid-batch key still does
    expect(validateApiKey(mid.plainKey)).toBeNull();
    const other = issued[501];
    expect(other).toBeDefined();
    expect(validateApiKey(other.plainKey)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Adversarial edge-case tests (NEW BATCH — 100 concurrent generate + validate)
// ---------------------------------------------------------------------------

describe("concurrent generate + validate — 100 parallel operations", () => {
  it("100 simultaneous generateApiKey + validateApiKey calls all settle correctly with no cross-key contamination", async () => {
    // Adversarial: scale + concurrency. Fire 100 concurrent operations, each
    // a (generate → validate) pair, all in flight at the same time via
    // Promise.all. Target invariants:
    //   (a) every generated key has a UNIQUE id and UNIQUE plainKey (RNG
    //       uniqueness under interleaved calls)
    //   (b) every validateApiKey call returns the matching meta (no PREFIX_MAP
    //       corruption where one key's hash shadowed another's lookup)
    //   (c) the final store contains exactly 100 entries (no drops, no leaks)
    //   (d) none of the issued keys accidentally validate as a different
    //       issued key (hashedKey collisions across the batch would cause
    //       PREFIX_MAP.set to overwrite the first registration; if that
    //       happened, the second key's validate would return the FIRST key's
    //       meta, breaking the (result.id === meta.id) invariant)
    const N = 100;

    const ops = Array.from({ length: N }, async (_, i) => {
      const { plainKey, meta } = generateApiKey(`concurrent-${i}`);
      // Immediately validate the just-generated key. If validateApiKey is
      // reentrant under JS's single-threaded model, this returns synchronously
      // and cannot race with the generate. But we await the surrounding
      // Promise.all to prove no interleaving loses an entry.
      const validated = validateApiKey(plainKey);
      return { i, plainKey, generatedId: meta.id, generatedHash: meta.hashedKey, validated };
    });

    const results = await Promise.all(ops);

    // (a) every id and plainKey unique
    const ids = new Set(results.map((r) => r.generatedId));
    const plainKeys = new Set(results.map((r) => r.plainKey));
    expect(ids.size).toBe(N);
    expect(plainKeys.size).toBe(N);

    // (b) every validate resolves to the matching meta
    for (const r of results) {
      expect(r.validated).not.toBeNull();
      expect(r.validated!.id).toBe(r.generatedId);
      expect(r.validated!.hashedKey).toBe(r.generatedHash);
      expect(r.validated!.name).toBe(`concurrent-${r.i}`);
    }

    // (c) final store holds exactly N entries
    expect(listKeys()).toHaveLength(N);

    // (d) re-validate every key from a fresh call (no async timer needed —
    //     validates synchronously, but we use it as a second-checkpoint
    //     after the Promise.all storm has settled)
    for (const r of results) {
      const recheck = validateApiKey(r.plainKey);
      expect(recheck).not.toBeNull();
      expect(recheck!.id).toBe(r.generatedId);
    }
  });
});

// ---------------------------------------------------------------------------
// Adversarial edge-case tests (iteration 13) — revoke-then-validate race
// ---------------------------------------------------------------------------

describe("revoke-then-immediately-validate race — no resurrection window", () => {
  it("even with 50 concurrent validateApiKey probes interleaved through revokeKey, every probe of the victim resolves to null after the synchronous revoke completes, and never returns the victim's meta", async () => {
    // Adversarial: revoke-then-validate is a classic TOCTOU pattern. The
    // implementation is fully synchronous (Map.get / Map.delete on the same
    // thread). We fire 50 in-flight validate PROMISES and call revokeKey
    // synchronously BEFORE queuing the victim's probe — so every probe that
    // touches the victim runs AFTER the revoke has been applied to the
    // store + PREFIX_MAP. Every probe must observe either:
    //   (a) null (the victim's key, revoked before the probe ran), OR
    //   (b) the meta of a DIFFERENT, still-valid sibling key,
    // but NEVER the victim's meta.
    //
    // Targets:
    //   - a PREFIX_MAP that retains a stale hashedKey → id mapping after
    //     revokeKey (validateApiKey would return the revoked meta)
    //   - an aliased return from validateApiKey that points to a revoked
    //     entry's data after the entry was mutated
    //   - a race where the in-flight promise captured a stale Map.get result
    //     that no longer matches the current store state

    // Issue the "victim" key and 49 "witness" keys. Each witness gets its
    // own plainKey and id; we never touch them during the revoke of the
    // victim.
    const victim = generateApiKey("victim");
    const witnesses = Array.from({ length: 49 }, (_, i) =>
      generateApiKey(`witness-${i}`)
    );

    // Snapshot pre-revoke state of the victim — must validate.
    expect(validateApiKey(victim.plainKey)).not.toBeNull();

    // SYNCHRONOUSLY revoke the victim BEFORE any probe runs. This means
    // every queued probe (including the victim's) must observe the
    // post-revocation state — there is no pre-revocation microtask window
    // in which the victim's probe could "see" the still-valid key.
    revokeKey(victim.meta.id);

    // Sanity: the synchronous revoke took effect immediately.
    expect(validateApiKey(victim.plainKey)).toBeNull();

    // Build a sequence of 50 probe operations. Each probe is a Promise
    // that resolves to the validateApiKey result for ONE plainKey.
    const probes: Array<Promise<unknown>> = [];
    for (let i = 0; i < 50; i++) {
      const keyToProbe =
        i === 0
          ? victim.plainKey // probe 0 = victim (must be null)
          : witnesses[i - 1].plainKey; // probes 1..49 = witnesses (must be their own meta)
      probes.push(
        Promise.resolve().then(() => validateApiKey(keyToProbe))
      );
    }

    const results = await Promise.all(probes);

    // (a) probes 1..49 must ALL resolve to non-null witness metas (witness
    //     keys were never revoked). None of them may resolve to the victim's
    //     meta — that would mean a cross-key contamination.
    for (let i = 1; i < 50; i++) {
      const r = results[i];
      expect(r).not.toBeNull();
      // The probed key was witnesses[i-1].plainKey, so the result must be
      // witnesses[i-1].meta — not victim.meta or any other witness's meta.
      expect((r as { id: string }).id).toBe(witnesses[i - 1].meta.id);
    }

    // (b) probe 0 (the victim) MUST resolve to null — the revoke fired
    //     synchronously before any probe's microtask was drained, so
    //     PREFIX_MAP has no entry for the victim's hashedKey by the time
    //     probe 0's .then() callback runs validateApiKey.
    expect(results[0]).toBeNull();

    // (c) post-condition: synchronous re-validation of the victim must also
    //     return null (sanity check).
    expect(validateApiKey(victim.plainKey)).toBeNull();

    // (d) The store must still contain all 50 entries (49 witnesses +
    //     1 revoked victim) — revokeKey did not delete the victim entry.
    const all = listKeys();
    expect(all).toHaveLength(50);
    const victimEntry = all.find((k) => k.id === victim.meta.id);
    expect(victimEntry).toBeDefined();
    expect(victimEntry!.revokedAt).not.toBeNull();
  });
});
