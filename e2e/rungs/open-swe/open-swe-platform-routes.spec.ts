import { test, expect } from "@playwright/test";

/**
 * The platform routes: /api/ready, /api/health, /api/counter.
 *
 * ALL THREE HAD ZERO E2E COVERAGE. Measured before writing this — every other
 * route in apps/open-swe/app/api appears in the suite at least once; these three
 * appeared not at all.
 *
 * /api/ready is the one that matters most. It is the ROLLOUT HEALTH GATE: the
 * staging smoke-test workflow gates promotion on a 200 from it (see the route's
 * own header and docs/DEPLOYMENT-RUNBOOK.md "Health-Gated Rollout"). A gate that
 * decides whether a deploy proceeds, with nothing asserting it answers at all,
 * is the shape this repo has spent a week removing.
 */

test.describe("open-swe platform routes — the probes nothing was checking", () => {
  test("/api/ready answers 200 with ready:true on a healthy instance", async ({
    request,
  }) => {
    const res = await request.get("/api/ready");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ready).toBe(true);
  });

  test("/api/ready's STATUS CODE and BODY agree", async ({ request }) => {
    // The two could disagree, and a naive gate reads only one of them. A 200
    // carrying ready:false would promote a deploy that says it is not ready;
    // a 503 carrying ready:true would block one that is. Assert the pair, not
    // either half — this is the same null-vs-false distinction the readiness
    // model makes elsewhere, at the transport layer.
    const res = await request.get("/api/ready");
    const body = await res.json();
    expect(res.status()).toBe(body.ready ? 200 : 503);
  });

  test("/api/ready reports a status string, not just a boolean", async ({
    request,
  }) => {
    // `ready` is the gate; `status` is what a human reads in a rollout log.
    // "ok" and "draining" are different facts and a bare boolean loses that.
    const body = await (await request.get("/api/ready")).json();
    expect(typeof body.status).toBe("string");
    expect(body.status.length).toBeGreaterThan(0);
  });

  test("/api/health answers 200 with status ok", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.status()).toBe(200);
    expect((await res.json()).status).toBe("ok");
  });

  test("/api/health is LIVENESS ONLY — it must not claim readiness", async ({
    request,
  }) => {
    // The dependency panel renders this route as "process is up — /api/health
    // checks nothing further", which is only honest if the route does not in
    // fact carry a readiness verdict. If it grew one, the panel's wording would
    // become an understatement nobody updated — the "code got better, record did
    // not" failure in reverse.
    const body = await (await request.get("/api/health")).json();
    expect(body).not.toHaveProperty("ready");
  });

  test("/api/counter round-trips: GET, POST, GET", async ({ request }) => {
    const before = (await (await request.get("/api/counter")).json()).counter;
    expect(typeof before).toBe("number");
    await request.post("/api/counter");
    const after = (await (await request.get("/api/counter")).json()).counter;
    expect(after).toBeGreaterThan(before);
  });

  test("/api/counter POST increments by EXACTLY one", async ({ request }) => {
    // Not "increases". A double-increment and a correct increment both satisfy
    // `after > before`, and the demo tools' whole point is that the number the
    // model reports matches the number of times it acted.
    const before = (await (await request.get("/api/counter")).json()).counter;
    await request.post("/api/counter");
    const after = (await (await request.get("/api/counter")).json()).counter;
    expect(after).toBe(before + 1);
  });

  test("/api/counter POST returns the value it just wrote", async ({
    request,
  }) => {
    // The POST response and a following GET must agree. If POST returned a
    // stale read, a caller trusting the response would be one behind and only
    // notice much later.
    const posted = (await (await request.post("/api/counter")).json()).counter;
    const fetched = (await (await request.get("/api/counter")).json()).counter;
    expect(fetched).toBe(posted);
  });
});
