import { test, expect } from "@playwright/test";

/**
 * THE APPROVAL ROUTE CONTRACT — the rejection paths, which nothing covered.
 *
 * `hitl.spec.ts` covers the happy paths thoroughly: approve, reject, edit,
 * respond, timeout, cross-tab. What it does not cover is what happens when the
 * request is WRONG, and that is where an approval endpoint does its real work.
 * This is the surface that decides whether a tool call runs. Every path here
 * ends in "the tool does not execute", so a path that silently succeeds is a
 * tool call nobody approved.
 *
 * THE ORDERING IS ITSELF A CONTRACT. The route validates the body BEFORE
 * consulting the registry, and its source says why:
 *
 *   "Validate payload before touching the registry so a malformed decision
 *    doesn't leave the approval in a half-resolved state."
 *
 * That ordering is observable: a malformed decision against an approval id that
 * does not exist returns 400, not 404. Both are rejections, so a route that
 * checked existence first would still refuse the request — and would still look
 * correct to anyone testing only that bad input is refused. The status code is
 * the only evidence of which check ran first.
 */

const UNKNOWN = "00000000-0000-0000-0000-000000000000";
const OPEN = `/api/approval/${UNKNOWN}`;
const PROTECTED = `/api/approval-protected/${UNKNOWN}`;

test.describe("approval route — body validation", () => {
  test("a non-JSON body is 400, not a 500", async ({ request }) => {
    // The route parses defensively; a parse failure is the caller's error.
    // `data:` would SERIALISE this string as JSON and send a valid document
    // containing it — the route would parse it happily and fall through to the
    // decision check, so the test would pass on the wrong error. `body:` sends
    // the bytes as given, which is the only way to actually malform the request.
    const res = await request.post(OPEN, {
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toContain("JSON");
  });

  test("a missing decision is 400 and NAMES the four it accepts", async ({
    request,
  }) => {
    // An error that says only "invalid" makes the caller guess. The route
    // spells out the accepted values, and that is worth holding in place.
    const res = await request.post(OPEN, { data: {} });
    expect(res.status()).toBe(400);
    const { error } = await res.json();
    for (const d of ["approve", "reject", "edit", "respond"]) {
      expect(error).toContain(d);
    }
  });

  test("an unrecognised decision is 400", async ({ request }) => {
    const res = await request.post(OPEN, { data: { decision: "maybe" } });
    expect(res.status()).toBe(400);
  });

  test("a decision of the RIGHT shape but wrong type is 400", async ({
    request,
  }) => {
    // `true` is not one of the four strings. A loose check that only tested for
    // absence would let this through to the registry.
    const res = await request.post(OPEN, { data: { decision: true } });
    expect(res.status()).toBe(400);
  });

  test("ORDERING: a bad decision on a NONEXISTENT approval is 400, not 404", async ({
    request,
  }) => {
    // The evidence that validation runs before the registry lookup. Both codes
    // are refusals, so only the code distinguishes the two orderings.
    const res = await request.post(OPEN, { data: { decision: "nonsense" } });
    expect(res.status()).toBe(400);
  });

  test("ORDERING, the other half: a GOOD decision on a nonexistent approval is 404", async ({
    request,
  }) => {
    // The control. Without this, "always 400" would satisfy the case above.
    const res = await request.post(OPEN, { data: { decision: "approve" } });
    expect(res.status()).toBe(404);
  });
});

test.describe("approval route — `edit` requires a real object", () => {
  test("edit with no editedInput is 400", async ({ request }) => {
    const res = await request.post(OPEN, { data: { decision: "edit" } });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toContain("editedInput");
  });

  test("edit with editedInput: null is 400", async ({ request }) => {
    // `typeof null === "object"`, so this is the case a naive typeof check
    // lets through — and it would rewrite a tool's input to nothing.
    const res = await request.post(OPEN, {
      data: { decision: "edit", editedInput: null },
    });
    expect(res.status()).toBe(400);
  });

  test("edit with an ARRAY editedInput is 400", async ({ request }) => {
    // Arrays are objects too. Same naive check, same hole.
    const res = await request.post(OPEN, {
      data: { decision: "edit", editedInput: [1, 2, 3] },
    });
    expect(res.status()).toBe(400);
  });

  test("edit with a STRING editedInput is 400", async ({ request }) => {
    const res = await request.post(OPEN, {
      data: { decision: "edit", editedInput: "not an object" },
    });
    expect(res.status()).toBe(400);
  });

  test("edit WITH a valid object gets past validation — reaching the 404", async ({
    request,
  }) => {
    // The control for all four above: it proves they are failing on the payload
    // rather than on something incidental to the request. A route that rejected
    // every `edit` would satisfy the four rejections and be broken.
    const res = await request.post(OPEN, {
      data: { decision: "edit", editedInput: { path: "/tmp/x" } },
    });
    expect(res.status()).toBe(404);
  });
});

test.describe("approval route — `respond` requires a non-empty string", () => {
  test("respond with no response is 400", async ({ request }) => {
    const res = await request.post(OPEN, { data: { decision: "respond" } });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toContain("response");
  });

  test("respond with an EMPTY string is 400", async ({ request }) => {
    // Present but empty. A truthiness check and a length check agree here, but
    // a `typeof === "string"` check alone does not — and an empty answer to a
    // question the agent asked is not an answer.
    const res = await request.post(OPEN, {
      data: { decision: "respond", response: "" },
    });
    expect(res.status()).toBe(400);
  });

  test("respond WITH text gets past validation — reaching the 404", async ({
    request,
  }) => {
    const res = await request.post(OPEN, {
      data: { decision: "respond", response: "go ahead" },
    });
    expect(res.status()).toBe(404);
  });
});

test.describe("approval route — the authorize hook", () => {
  test("the protected route refuses a request with NO credential", async ({
    request,
  }) => {
    const res = await request.post(PROTECTED, { data: { decision: "approve" } });
    expect(res.status()).toBe(401);
  });

  test("AUTH COMES FIRST: a bad credential is 401 even when the body is malformed", async ({
    request,
  }) => {
    // The ordering that matters for a security boundary. If body validation ran
    // first, a caller with no credential could probe the route's behaviour by
    // reading which 400 it returns — and would learn the shape of the API it is
    // not allowed to use. 401 for everything is the correct answer.
    const res = await request.post(PROTECTED, {
      headers: { authorization: "Bearer wrong-token" },
      data: { decision: "nonsense" },
    });
    expect(res.status()).toBe(401);
  });
});
