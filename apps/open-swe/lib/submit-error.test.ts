import { describe, it, expect } from "vitest";
import { classifySubmitFailure, readErrorDetail } from "./submit-error";

/**
 * #131. These assert the POSITIVE claim — that each failure class produces
 * copy naming THAT class — rather than the negative "no success message".
 * A crashed classifier and a correct one both satisfy a negative assertion;
 * only a positive one distinguishes them.
 */
describe("classifySubmitFailure — every class names itself", () => {
  it("429 names the rate limit and says to wait", () => {
    const f = classifySubmitFailure(429);
    expect(f.status).toBe(429);
    expect(f.title).toMatch(/rate limit/i);
    expect(f.hint).toMatch(/wait/i);
  });

  it("429 with Retry-After names the actual number of seconds", () => {
    expect(classifySubmitFailure(429, undefined, 30).hint).toContain("30s");
  });

  it("502 names the BACKEND as unreachable, not the dashboard", () => {
    const f = classifySubmitFailure(502);
    expect(f.title).toMatch(/backend is unreachable/i);
    // The distinction that sends someone to the right place: this app was
    // reached; what it talks to was not.
    expect(f.hint).toMatch(/could not reach the agent/i);
  });

  it("502 surfaces the server's own sentence, which is the actionable part", () => {
    const f = classifySubmitFailure(
      502,
      "LANGGRAPH_PLATFORM_URL is not configured"
    );
    expect(f.detail).toBe("LANGGRAPH_PLATFORM_URL is not configured");
  });

  it("null status says the request never left — distinct from a refusal", () => {
    const f = classifySubmitFailure(null);
    expect(f.status).toBeNull();
    expect(f.title).toMatch(/reach the server/i);
    expect(f.hint).toMatch(/never left/i);
    // Must NOT claim the server refused anything; it was never asked.
    expect(f.hint).not.toMatch(/refus/i);
  });

  it("422 blames the task, not the infrastructure", () => {
    const f = classifySubmitFailure(422);
    expect(f.title).toMatch(/task was rejected/i);
    expect(f.hint).toMatch(/edit it/i);
  });

  it("401 names authorisation", () => {
    expect(classifySubmitFailure(401).title).toMatch(/not authorised/i);
  });

  it("500 names the status and says it is not the user's task", () => {
    const f = classifySubmitFailure(500);
    expect(f.title).toContain("500");
    expect(f.hint).toMatch(/not in your task/i);
  });

  it("an unmapped status still carries the number rather than going generic", () => {
    expect(classifySubmitFailure(418).title).toContain("418");
  });

  it("NO class produces a generic message — the whole point of #131", () => {
    for (const status of [
      null,
      400,
      401,
      403,
      422,
      429,
      500,
      502,
      503,
      504,
      418,
    ]) {
      const f = classifySubmitFailure(status as number | null);
      expect(f.title).not.toMatch(/something went wrong/i);
      expect(f.title.length).toBeGreaterThan(8);
      expect(f.hint.length).toBeGreaterThan(20);
    }
  });

  it("429, 502 and offline are three DIFFERENT messages", () => {
    const titles = [
      classifySubmitFailure(429).title,
      classifySubmitFailure(502).title,
      classifySubmitFailure(null).title,
    ];
    expect(new Set(titles).size).toBe(3);
  });
});

describe("readErrorDetail", () => {
  it("extracts { error } from a JSON body", async () => {
    const res = new Response(JSON.stringify({ error: "nope" }), {
      status: 502,
    });
    expect(await readErrorDetail(res)).toBe("nope");
  });

  it("returns a short plain-text body as-is", async () => {
    expect(
      await readErrorDetail(new Response("plain failure", { status: 500 }))
    ).toBe("plain failure");
  });

  it("drops a long body rather than pasting an HTML error page at the user", async () => {
    const res = new Response("x".repeat(5000), { status: 500 });
    expect(await readErrorDetail(res)).toBeUndefined();
  });

  it("a BROKEN-JSON fragment is dropped, not pasted at the user", async () => {
    // Distinct from plain text above: this opened with { and failed to parse,
    // so it is the wreckage of a failed serialisation rather than a message.
    const res = new Response("{not json", { status: 500 });
    await expect(readErrorDetail(res)).resolves.toBeUndefined();
  });

  it("never throws, whatever the body", async () => {
    for (const body of [
      "{broken",
      "[also broken",
      "",
      "x".repeat(5000),
      "fine",
    ]) {
      await expect(readErrorDetail(new Response(body, { status: 500 })))
        .resolves.not.toThrow;
    }
  });

  it("an empty body yields undefined", async () => {
    expect(
      await readErrorDetail(new Response("", { status: 502 }))
    ).toBeUndefined();
  });
});
