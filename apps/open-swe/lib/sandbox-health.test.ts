import { describe, it, expect } from "vitest";
import { readSandboxHealth, sandboxUnreachable } from "./sandbox-health";

/**
 * #337. The panel discarded `r.ok`, and an ACCIDENT hid it: Next serves a
 * missing route as HTML, so `r.json()` threw and the catch produced something
 * that looked like handling.
 *
 * The tests are therefore paired by STATUS, not by body. Every status is
 * asserted with both an HTML body and a JSON body, because the original bug
 * was precisely that those two disagreed about the same fact — and a suite
 * that only ever sends HTML reproduces the accident instead of testing it.
 */

const res = (status: number, body: string, type = "application/json") =>
  new Response(body, { status, headers: { "content-type": type } });

const HTML = "<!DOCTYPE html><html><body>404</body></html>";

describe("readSandboxHealth — 404 means ABSENT, whatever the body looks like", () => {
  it("a 404 carrying HTML is absent", async () => {
    expect(await readSandboxHealth(res(404, HTML, "text/html"))).toEqual({
      kind: "absent",
    });
  });

  it("A 404 CARRYING VALID JSON IS ALSO ABSENT — the case the accident missed", async () => {
    // The decisive one. This body parses, so nothing throws, so the original
    // code stored it as the health object and rendered it as a provider.
    expect(
      await readSandboxHealth(res(404, JSON.stringify({ error: "nope" })))
    ).toEqual({ kind: "absent" });
  });

  it("reaches the same verdict for both, which is the property that was broken", async () => {
    // Stated as its own assertion rather than left implicit in two passing
    // cases above: the defect was not "404 handled wrongly", it was "two 404s
    // handled DIFFERENTLY". Equality between them is the actual invariant.
    const fromHtml = await readSandboxHealth(res(404, HTML, "text/html"));
    const fromJson = await readSandboxHealth(
      res(404, JSON.stringify({ error: "nope" }))
    );
    expect(fromHtml).toEqual(fromJson);
  });
});

describe("readSandboxHealth — a route that IS there and failed is not absent", () => {
  it("a 500 with a JSON error names the status and the reason", async () => {
    const p = await readSandboxHealth(
      res(500, JSON.stringify({ error: "docker daemon down" }))
    );
    expect(p.kind).toBe("failed");
    expect(p.kind === "failed" && p.message).toContain("500");
    expect(p.kind === "failed" && p.message).toContain("docker daemon down");
  });

  it("a 503 with an HTML body still names the status", async () => {
    const p = await readSandboxHealth(res(503, HTML, "text/html"));
    expect(p.kind).toBe("failed");
    expect(p.kind === "failed" && p.message).toContain("503");
  });

  it("does NOT report a 500 as absent — the two call for opposite responses", async () => {
    // Absent is "this fork has no sandbox, nothing to do". Failed is "a
    // sandbox that should be here is not answering". Collapsing them would
    // make every real outage look like a deliberate build choice.
    const p = await readSandboxHealth(res(500, JSON.stringify({ error: "x" })));
    expect(p.kind).not.toBe("absent");
  });
});

describe("readSandboxHealth — a 200 is only healthy if we can read it", () => {
  it("reports provider, availability and detail", async () => {
    expect(
      await readSandboxHealth(
        res(
          200,
          JSON.stringify({
            provider: "docker",
            available: true,
            detail: "ready",
          })
        )
      )
    ).toEqual({
      kind: "ok",
      provider: "docker",
      available: true,
      detail: "ready",
    });
  });

  it("a 200 that is not JSON is FAILED, not an unavailable sandbox", async () => {
    // Defaulting to available:false here would state a fact about the sandbox
    // that we have no evidence for. "We could not read the answer" and "the
    // answer was no" are different, and #237 is the panel next door that
    // learned it the expensive way.
    const p = await readSandboxHealth(res(200, HTML, "text/html"));
    expect(p.kind).toBe("failed");
    expect(p.kind === "failed" && p.message).toContain("not JSON");
  });

  it("a missing `available` reads as false, not as true", async () => {
    const p = await readSandboxHealth(
      res(200, JSON.stringify({ provider: "docker" }))
    );
    expect(p).toEqual({
      kind: "ok",
      provider: "docker",
      available: false,
      detail: undefined,
    });
  });

  it("a non-boolean `available` is not coerced into a yes", async () => {
    // `available: "false"` is truthy in JS. A `!!` here would report a stopped
    // sandbox as running.
    const p = await readSandboxHealth(
      res(200, JSON.stringify({ available: "false" }))
    );
    expect(p.kind === "ok" && p.available).toBe(false);
  });
});

describe("sandboxUnreachable", () => {
  it("a rejected fetch is FAILED, never absent", async () => {
    // We never reached the route, so we learned nothing about whether it
    // exists. Calling that "absent" would tell a fork it has no sandbox
    // because its network blipped.
    const p = sandboxUnreachable(new Error("ECONNREFUSED"));
    expect(p.kind).toBe("failed");
    expect(p.kind === "failed" && p.message).toContain("ECONNREFUSED");
  });
});
