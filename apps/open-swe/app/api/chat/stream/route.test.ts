import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * THE SESSION SURVIVES THE ROUTE (#171).
 *
 * The defect was not a missing feature. It was a field that exists at EVERY
 * layer — typed in the conversation record, accepted in the request body, named
 * in this route's destructure — and carried nothing end to end. Each piece
 * looked correct in isolation:
 *
 *   client   sessionId: "lang-nextjs-chat"      a constant, for every user,
 *                                               browser and conversation
 *   route    const { sessionId: _sid, ... }     destructured out, never
 *                                               forwarded
 *
 * So the backend received no session identity, and would have received a
 * useless one if it had. #160 proposed binding approvals to the creating
 * session; against a constant that is a check which passes for everybody.
 *
 * WHAT THIS FILE WATCHES IS THE SEAM, because the seam is where the value was
 * lost. Asserting that the client computes an id proves nothing if the route
 * drops it one function later, which is exactly what happened for the entire
 * life of the field.
 */

const capture: { body: Record<string, unknown> | null } = { body: null };

vi.mock("@deepagents-nextjs/server", () => ({
  // CAPTURE AT THE HANDOFF, which is where the route's decision is final: it
  // rebuilds the request with `forwardBody` and hands that to the handler. What
  // this reads is exactly what leaves the route. The real handler streams to a
  // Python host; nothing here needs that.
  createSseProxyHandler: () => async (req: Request) => {
    capture.body = JSON.parse(await req.text());
    return new Response("data: {}\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  },
  createApprovalGatingTransform: () => ({ name: "approval" }),
  createDeepAgentsEnrichTransform: () => ({ name: "enrich" }),
  deepagentsAdapter: { name: "deepagents" },
  langGraphAdapter: { name: "langgraph" },
  langchainAdapter: { name: "langchain" },
}));

const originalFetch = globalThis.fetch;

beforeEach(() => {
  capture.body = null;
  process.env.FASTAPI_URL = "http://backend.test";
  globalThis.fetch = vi.fn(async () =>
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
  pythonBackend: "fastapi",
  aiBackend: "deepagents",
  topology: "react",
};

describe("the route forwards the session it is given (#171)", () => {
  it("sessionId reaches the backend body", async () => {
    const { POST } = await import("./route");
    await POST(post({ ...base, sessionId: "conv-abc-123" }));
    expect(capture.body, "the route never called the backend").not.toBeNull();
    expect(capture.body!.sessionId).toBe("conv-abc-123");
  });

  it("a DIFFERENT session forwards differently — not a constant echoed back", async () => {
    // The original defect would satisfy any single-value assertion if the
    // expected string happened to be the hardcoded one. Two distinct values are
    // what distinguishes "forwarded" from "always says the same thing".
    const { POST } = await import("./route");
    await POST(post({ ...base, sessionId: "conv-one" }));
    const first = capture.body!.sessionId;
    await POST(post({ ...base, sessionId: "conv-two" }));
    expect([first, capture.body!.sessionId]).toEqual(["conv-one", "conv-two"]);
  });

  it("no sessionId means none forwarded — not an empty string", async () => {
    // An absent session and a session whose value is "" are different facts,
    // and only one of them is true. The Python side drops falsey axes for the
    // same reason: a trace grouped under "" is worse than an ungrouped one.
    const { POST } = await import("./route");
    await POST(post(base));
    expect(capture.body!.sessionId).toBeUndefined();
  });

  it("adapter-selection fields are STILL stripped — the fix did not widen", async () => {
    // These are answered by the time the request leaves this route; forwarding
    // them would let a backend act on a choice already made. Keeping this
    // assertion next to the one above is the point: only `sessionId` changed.
    const { POST } = await import("./route");
    await POST(post({ ...base, sessionId: "conv-abc" }));
    expect(capture.body!.pythonBackend).toBeUndefined();
    expect(capture.body!.aiBackend).toBeUndefined();
    // ...while `topology` is deliberately forwarded: the backend reads it to
    // pick ReAct vs plan-execute.
    expect(capture.body!.topology).toBe("react");
  });
});
