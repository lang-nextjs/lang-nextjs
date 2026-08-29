import { expect, test } from "@playwright/test";

/**
 * THE ONE THING THAT CANNOT BE CHECKED AGAINST `next dev` (#339).
 *
 * `apps/open-swe/middleware.ts` guards the sandbox surface, which runs arbitrary shell
 * commands in a workspace. With `OPEN_SWE_SANDBOX_TOKEN` unset it branches on the build mode:
 *
 *   unset, NOT production  ->  NextResponse.next()   open, so local dev and CI keep working
 *   unset, production      ->  404                   the routes do not exist
 *
 * The production branch is the security property — fail closed, so an unconfigured deploy
 * serves nothing rather than serving an unauthenticated shell. Its own comment calls that "the
 * point". And until this file, NOTHING EXERCISED IT, because `next dev` takes the other branch
 * by construction: every open-swe project runs against a dev server, so the 404 branch had
 * never once executed under test.
 *
 * MEASURED, not assumed. Same tree, same environment, `OPEN_SWE_SANDBOX_TOKEN` unset:
 *
 *   next start   GET /api/open-swe/sandbox/health  ->  404  {"error":"Not found"}
 *   next dev     GET /api/open-swe/sandbox/health  ->  200  {"provider":"docker","available":true,…}
 *
 * WHY THIS FILE IS THE ANCHOR OF THE PRODUCTION JOB. #339 asks for a production run that is
 * able to fail, on the reasoning that a job which boots a build and runs a suite passing
 * everywhere is a job whose green means "it started". A spec that passes in both modes cannot
 * supply that. This one CANNOT PASS IN DEV — run it against a dev server and it fails on the
 * first assertion — so the job it anchors is verifying something no other job can.
 *
 * The first mutation I tried for that role did not work, and the record is worth keeping:
 * deleting `export const dynamic = "force-dynamic"` from a route handler. The expectation was
 * static prerendering in production and a frozen counter. Next 16 keeps the handler dynamic
 * either way — the route table prints `ƒ /api/counter` with and without the directive — so the
 * mutation is invisible in BOTH modes and would have justified a job that could not fail.
 *
 * IT IS IN ITS OWN PROJECT, not in `open-swe`. Adding it there would make it run against the
 * dev server in e2e-mocked and fail every time, which is the correct behaviour for the
 * assertion and useless as a check.
 */
test.describe("open-swe, production build: the sandbox surface fails closed", () => {
  /*
   * NO TOKEN IS SET BY THE JOB, and that is the precondition, not an oversight. If
   * OPEN_SWE_SANDBOX_TOKEN were present the middleware would take the Bearer branch and every
   * assertion below would be about authentication instead of about build mode — passing for a
   * reason that has nothing to do with what this file is for.
   *
   * So the first case proves the app is up and unguarded routes answer normally. Without it, a
   * server that failed to start would give 404s for every path and this whole describe would
   * go green on a dead process — the exact vacuity #339 is written against.
   */
  test("the app is actually serving — an unguarded route answers 200", async ({
    request,
  }) => {
    const res = await request.get("/api/health");
    expect(
      res.status(),
      "if this is not 200 the server is not up, and the 404s below mean nothing"
    ).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok" });
  });

  test("an unconfigured sandbox surface is 404, not an open exec endpoint", async ({
    request,
  }) => {
    const res = await request.get("/api/open-swe/sandbox/health");
    expect(
      res.status(),
      "a production build with no OPEN_SWE_SANDBOX_TOKEN must not serve the sandbox surface"
    ).toBe(404);
    expect(await res.json()).toMatchObject({ error: "Not found" });
  });

  test("404, NOT 401 — an unconfigured deploy does not advertise the surface", async ({
    request,
  }) => {
    // The middleware's own reasoning: 401 would tell an unauthenticated caller that a sandbox
    // exists here and is merely locked. Asserting the status alone would be satisfied by 401,
    // so the distinction is asserted directly.
    const res = await request.get("/api/open-swe/sandbox/health");
    expect(res.status()).not.toBe(401);
    expect(res.headers()["www-authenticate"]).toBeUndefined();
  });

  test("the exec route — the one that runs shell — is closed BY THE MIDDLEWARE", async ({
    request,
  }) => {
    /*
     * THE BODY IS ASSERTED, NOT JUST THE STATUS, AND THAT IS THE WHOLE CASE.
     *
     * The health route is the cheapest probe; exec is the one that matters, so the dangerous
     * route is named explicitly rather than trusted to share health's fate.
     *
     * The first version of this case asserted `status === 404` alone, and it PASSED AGAINST A
     * DEV SERVER — for entirely the wrong reason. Measured on the same tree:
     *
     *   next dev    404  {"error":"workspace ws-does-not-exist not found","code":"not_found"}
     *   next start  404  {"error":"Not found"}
     *
     * Dev reached the route, which refused a workspace that does not exist. Production never
     * reached the route at all. Same status, opposite meanings — and a case that looked like
     * it distinguished the two modes while being satisfied by either. Found by running this
     * file against dev, which is the one thing that could have told me.
     *
     * The middleware's envelope is the discriminator, so it is what gets asserted.
     */
    const res = await request.post(
      "/api/open-swe/sandbox/workspaces/ws-does-not-exist/exec",
      { data: { command: "echo hello" } }
    );
    expect(res.status()).toBe(404);
    expect(
      await res.json(),
      "a 404 from the exec route itself is NOT the middleware refusing to serve the surface"
    ).toEqual({ error: "Not found" });
  });

  test("the guard is scoped to the sandbox, not to every open-swe route", async ({
    request,
  }) => {
    // The control. A middleware that 404'd everything under /api/open-swe would satisfy every
    // case above and would have broken the product. The runs route answers for its own
    // reasons — 200, or 502 when LANGGRAPH_PLATFORM_URL is unset, which is the CI condition —
    // and either way it is NOT the middleware's 404.
    const res = await request.get("/api/open-swe/runs");
    expect(
      res.status(),
      "the sandbox guard must not swallow the rest of the open-swe API"
    ).not.toBe(404);
  });
});
