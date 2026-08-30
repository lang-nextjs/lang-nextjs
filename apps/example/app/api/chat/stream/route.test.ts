import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

/**
 * THE SESSION SURVIVES THIS ROUTE TOO (#171).
 *
 * #171 removed a two-part defect from apps/open-swe: the client sent a constant
 * and the route stripped it anyway. BOTH HALVES SURVIVED HERE, in the app the
 * audit did not look at —
 *
 *   ConversationSurface   sessionId: "example-session"   a constant
 *   this route            const { sessionId: _sid, … }   dropped
 *
 * — so the same Python backend grouped open-swe's turns into a conversation and
 * this app's into unrelated singletons, for no reason a reader could see.
 *
 * WHAT THIS FILE WATCHES IS THE SEAM, because the seam is where the value was
 * lost. Asserting that the surface computes an id proves nothing if the route
 * drops it one function later, which is what happened for the field's whole
 * life.
 */

const capture: { body: Record<string, unknown> | null } = { body: null };

vi.mock("@deepagents-nextjs/server", () => ({
  // Capture at the handoff: the route rebuilds the request with `forwardBody`
  // and hands it to the handler, so this reads exactly what leaves the route.
  createSseProxyHandler: () => async (req: Request) => {
    capture.body = JSON.parse(await req.text());
    return new Response("data: {}\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  },
  // The route reaches the adapters through @/lib/rungs/adapters, which imports
  // these from the same package — so the mock has to carry them even though
  // this file asserts nothing about them.
  deepagentsAdapter: { name: "deepagents" },
  langGraphAdapter: { name: "langgraph" },
  langchainAdapter: { name: "langchain" },
  createApprovalGatingTransform: () => ({ name: "approval" }),
  createDeepAgentsEnrichTransform: () => ({ name: "enrich" }),
}));

const originalFetch = globalThis.fetch;

beforeEach(() => {
  capture.body = null;
  process.env.FASTAPI_URL = "http://backend.test";
  globalThis.fetch = vi.fn(
    async () =>
      new Response("data: {}\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })
  ) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function post(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/chat/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const base = {
  messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
  runtime: "fastapi",
  aiBackend: "deepagents",
  topology: "react",
};

describe("the playground route forwards the session it is given (#171)", () => {
  it("sessionId reaches the backend body", async () => {
    const { POST } = await import("./route");
    await POST(post({ ...base, sessionId: "example-abc123" }));
    expect(capture.body, "the route never called the backend").not.toBeNull();
    expect(capture.body!.sessionId).toBe("example-abc123");
  });

  it("a DIFFERENT session forwards differently — not a constant echoed back", async () => {
    // The original defect would satisfy any single-value assertion if the
    // expected string happened to be the hardcoded one. Two distinct values are
    // what separate "forwarded" from "always says the same thing".
    const { POST } = await import("./route");
    await POST(post({ ...base, sessionId: "example-one" }));
    const first = capture.body!.sessionId;
    await POST(post({ ...base, sessionId: "example-two" }));
    expect([first, capture.body!.sessionId]).toEqual([
      "example-one",
      "example-two",
    ]);
  });

  it("no sessionId means none forwarded — not an empty string", async () => {
    // An absent session and one whose value is "" are different facts, and only
    // one is true. The Python side drops falsey axes for the same reason: a
    // trace grouped under "" is worse than an ungrouped one.
    const { POST } = await import("./route");
    await POST(post(base));
    expect(capture.body!.sessionId).toBeUndefined();
  });

  it("adapter-selection fields are STILL stripped — the fix did not widen", async () => {
    const { POST } = await import("./route");
    await POST(post({ ...base, sessionId: "example-abc" }));
    expect(capture.body!.pythonBackend).toBeUndefined();
    expect(capture.body!.aiBackend).toBeUndefined();
    // ...while `topology` is deliberately forwarded: the backend reads it to
    // pick ReAct vs plan-execute.
    expect(capture.body!.topology).toBe("react");
  });
});

/**
 * #377 — THIS PLANE'S HALF OF THE SAME DECLARED CONTRACT.
 *
 * apps/open-swe consumes scripts/fixtures/runtime-parse-cases.json by calling
 * its exported `parseRuntime`. This copy is PRIVATE to the route, so the cases
 * are driven through the route itself — which is the honest surface anyway:
 * what a client can observe is the response, not the function.
 *
 * The two planes share `@deepagents-nextjs/server` and nothing else; the
 * parsers are independent copies. So a divergence planted in one turns exactly
 * one plane red, and that independence is asserted by mutation rather than
 * assumed — a fixture both planes pass because they share the code path under
 * test is not a witness.
 *
 * A RUNTIME REFUSAL IS THE ONLY RESPONSE CARRYING `reason`. An accepted runtime
 * this deployment has no URL for falls through to the in-process mock, so
 * "accepted" is asserted as "not refused as a runtime" rather than as a status
 * code — otherwise the accept rows would be measuring which env vars the
 * harness happens to set.
 */
describe("#377 — the playground reads a runtime the way the contract says", () => {
  const FIXTURE = join(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "..",
    "..",
    "scripts",
    "fixtures",
    "runtime-parse-cases.json"
  );

  type Case = {
    why: string;
    input?: unknown;
    expect: { ok: boolean; runtime?: string; reason?: string };
  };

  const cases: Case[] = (
    JSON.parse(readFileSync(FIXTURE, "utf8")) as { cases: Case[] }
  ).cases;

  it("the fixture was found and carries BOTH outcomes", () => {
    // Same guard as open-swe's half, and it earns its place twice: the two
    // planes resolve this path differently, so one finding the file is no
    // evidence the other does.
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.some((c) => c.expect.ok)).toBe(true);
    expect(cases.some((c) => !c.expect.ok)).toBe(true);
  });

  it.each(cases.map((c) => [c.why, c] as const))("%s", async (_why, c) => {
    const { POST } = await import("./route");
    const body: Record<string, unknown> = { ...base };
    if ("input" in c) body.runtime = c.input;
    else delete body.runtime;

    const res = await POST(post(body));
    const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;

    if (c.expect.ok) {
      expect(
        payload.reason,
        "an accepted runtime must not be refused AS A RUNTIME — a `reason` here is that refusal"
      ).toBeUndefined();
    } else {
      expect(res.status).toBe(400);
      expect(payload.reason).toBe(c.expect.reason);
    }
  });
});
