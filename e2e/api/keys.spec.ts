import { test, expect, type APIRequestContext } from "@playwright/test";

/**
 * API KEY ISSUANCE AND REVOCATION — zero end-to-end coverage before this file.
 *
 * The store is deliberate about things that are easy to get wrong, and says so
 * in its own source:
 *
 *   "SHA-256 for collision resistance — the djb2 variant has an exploitable
 *    32-bit range (~4 billion values) that allows authentication bypass via
 *    crafted collisions."
 *
 * A property with that comment attached and no test attached is the shape this
 * repo keeps finding: the reasoning was done, and nothing holds it in place.
 *
 * THE ONE THAT MATTERS MOST is that the plaintext key is returned exactly once,
 * at creation, and never again. A list endpoint that started returning `key`
 * would break no existing test, change no visible layout, and hand every key to
 * anyone who can read a list.
 */

interface CreatedKey {
  id: string;
  name: string;
  prefix: string;
  key: string;
  createdAt: string;
}

async function createKey(
  request: APIRequestContext,
  name?: string
): Promise<CreatedKey> {
  const res = await request.post("/api/keys", {
    data: name === undefined ? {} : { name },
  });
  expect(res.status()).toBe(201);
  return (await res.json()) as CreatedKey;
}

test.describe("POST /api/keys — issuance", () => {
  test("returns 201 and the plaintext key ONCE", async ({ request }) => {
    const created = await createKey(request, "issuance");
    expect(created.key).toBeTruthy();
    expect(created.id).toBeTruthy();
  });

  test("the key is a `da_` token of the documented shape", async ({
    request,
  }) => {
    // 32 random bytes rendered as hex. Asserting the LENGTH matters: a
    // truncated or short-entropy key is still a plausible-looking string.
    const { key } = await createKey(request, "shape");
    expect(key).toMatch(/^da_[0-9a-f]{64}$/);
  });

  test("two keys issued back to back are DIFFERENT", async ({ request }) => {
    // The check that a constant, a counter, or a broken RNG cannot pass.
    const a = await createKey(request, "one");
    const b = await createKey(request, "two");
    expect(a.key).not.toBe(b.key);
    expect(a.id).not.toBe(b.id);
  });

  test("the prefix is a genuine PREFIX of the key, and far shorter than it", async ({
    request,
  }) => {
    // The prefix exists so a person can recognise a key they cannot see. If it
    // were the whole key, the list endpoint would be leaking it in disguise.
    const { key, prefix } = await createKey(request, "prefixed");
    expect(key.startsWith(prefix)).toBe(true);
    expect(prefix.length).toBeLessThan(key.length / 4);
  });

  test("a missing name becomes `unnamed` rather than empty or null", async ({
    request,
  }) => {
    const created = await createKey(request);
    expect(created.name).toBe("unnamed");
  });

  test("a whitespace-only name becomes `unnamed` too", async ({ request }) => {
    // "   " is not a name. Trimming to empty and storing it would produce a key
    // that is impossible to identify in a list.
    const created = await createKey(request, "   ");
    expect(created.name).toBe("unnamed");
  });

  test("a malformed body does not 500 — it falls back to `unnamed`", async ({
    request,
  }) => {
    const res = await request.post("/api/keys", {
      headers: { "content-type": "application/json" },
      data: "this is not json",
    });
    expect(res.status()).toBe(201);
    expect((await res.json()).name).toBe("unnamed");
  });
});

test.describe("GET /api/keys — the listing must not leak", () => {
  test("THE SECRET NEVER COMES BACK: no listed key carries `key` or a hash", async ({
    request,
  }) => {
    const created = await createKey(request, "leak-check");
    const res = await request.get("/api/keys");
    expect(res.status()).toBe(200);
    const body = await res.json();

    const mine = body.keys.find((k: { id: string }) => k.id === created.id);
    expect(mine, "the key just created should be listed").toBeTruthy();
    expect(mine).not.toHaveProperty("key");
    expect(mine).not.toHaveProperty("hashedKey");

    // And the plaintext must not appear ANYWHERE in the response — a leak via a
    // differently-named field is the same leak.
    expect(JSON.stringify(body)).not.toContain(created.key);
  });

  test("the listing carries what a person needs to identify a key", async ({
    request,
  }) => {
    const created = await createKey(request, "identifiable");
    const body = await (await request.get("/api/keys")).json();
    const mine = body.keys.find((k: { id: string }) => k.id === created.id);
    expect(mine.name).toBe("identifiable");
    expect(mine.prefix).toBe(created.prefix);
    expect(mine.createdAt).toBeTruthy();
  });
});

test.describe("DELETE /api/keys/[id] — revocation", () => {
  test("revoking returns the key with a revokedAt timestamp", async ({
    request,
  }) => {
    const created = await createKey(request, "to-revoke");
    const res = await request.delete(`/api/keys/${created.id}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(created.id);
    expect(body.revokedAt).toBeTruthy();
  });

  test("a revoked key STAYS in the listing, marked — it is not deleted", async ({
    request,
  }) => {
    // Revocation is a fact about a key, not the absence of one. Dropping the
    // row would erase the record that the key ever existed, which is exactly
    // what someone auditing a leak needs to see.
    const created = await createKey(request, "still-listed");
    await request.delete(`/api/keys/${created.id}`);
    const body = await (await request.get("/api/keys")).json();
    const mine = body.keys.find((k: { id: string }) => k.id === created.id);
    expect(mine, "a revoked key must still be listed").toBeTruthy();
    expect(mine.revokedAt).toBeTruthy();
  });

  test("revoking an unknown id is 404, not a silent success", async ({
    request,
  }) => {
    const res = await request.delete(
      "/api/keys/00000000-0000-0000-0000-000000000000"
    );
    expect(res.status()).toBe(404);
  });

  test("revoking TWICE preserves the ORIGINAL revocation time", async ({
    request,
  }) => {
    // The store calls this out as an idempotency guard. It matters because the
    // revocation timestamp is the answer to "when did this key stop working" —
    // a second call must not move that answer forward.
    const created = await createKey(request, "double-revoke");
    const first = await (
      await request.delete(`/api/keys/${created.id}`)
    ).json();
    const second = await (
      await request.delete(`/api/keys/${created.id}`)
    ).json();
    expect(second.revokedAt).toBe(first.revokedAt);
  });

  test("revoking one key does NOT revoke another", async ({ request }) => {
    // The control. Revoking everything on any delete satisfies every case above.
    const doomed = await createKey(request, "doomed");
    const spared = await createKey(request, "spared");
    await request.delete(`/api/keys/${doomed.id}`);
    const body = await (await request.get("/api/keys")).json();
    const other = body.keys.find((k: { id: string }) => k.id === spared.id);
    expect(other.revokedAt ?? null).toBeNull();
  });
});

test.describe("GET /api/keys — the listing is live, not cached", () => {
  test("a key created AFTER a listing appears in the next listing", async ({
    request,
  }) => {
    // The route is `force-dynamic` for this reason. A cached listing is the
    // failure that looks exactly like success: the page renders, the keys you
    // already had are all there, and the one you just made is simply missing —
    // so you make another, and another.
    const before = await (await request.get("/api/keys")).json();
    const created = await createKey(request, "after-listing");
    const after = await (await request.get("/api/keys")).json();

    const ids = after.keys.map((k: { id: string }) => k.id);
    expect(ids).toContain(created.id);
    expect(after.keys.length).toBe(before.keys.length + 1);
  });

  test("issuing a key does not disturb the keys already issued", async ({
    request,
  }) => {
    // Isolation. Every other case here reads one key; this one asserts that
    // writing a new record leaves the previous ones exactly as they were,
    // which no single-key assertion can see.
    const first = await createKey(request, "incumbent");
    const snapshot = await (await request.get("/api/keys")).json();
    const mineBefore = snapshot.keys.find(
      (k: { id: string }) => k.id === first.id
    );

    await createKey(request, "newcomer");

    const after = await (await request.get("/api/keys")).json();
    const mineAfter = after.keys.find((k: { id: string }) => k.id === first.id);
    expect(mineAfter).toEqual(mineBefore);
  });

  test("every listed key has a DISTINCT id and prefix", async ({ request }) => {
    // Two keys sharing a prefix would make the listing's only human-readable
    // identifier ambiguous — you would revoke by eye and hit the wrong one.
    await createKey(request, "distinct-a");
    await createKey(request, "distinct-b");
    const body = await (await request.get("/api/keys")).json();
    const ids = body.keys.map((k: { id: string }) => k.id);
    const prefixes = body.keys.map((k: { prefix: string }) => k.prefix);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});
