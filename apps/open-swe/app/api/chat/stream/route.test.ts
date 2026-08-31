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

/**
 * #360 — THE TRANSITION WINDOW IS CLOSED, ASSERTED AGAINST THE ROUTE.
 *
 * These replace a block in lib/frameworks.test.ts that could not have caught
 * the deletion. It defined its own resolver —
 *
 *   const resolve = (body) =>
 *     parseRuntime(body.runtime ?? body.pythonBackend ?? body.backend);
 *
 * — a RESTATEMENT of the route's rule rather than the route. Closing the window
 * in both routes left all 65 of its cases green, including the one whose
 * comment promised "when the deletion commit lands, this block is what should
 * fail". It could not fail: it was guarding a copy of the behaviour, so the
 * behaviour changing was invisible to it.
 *
 * Same shape as #372, where the only thing that ever talked to the resume route
 * was a mock. A test that duplicates what it guards cannot witness the change.
 *
 * So these drive the real POST. When someone re-opens the window, the first
 * case goes red; when someone deletes `runtime`, the second does.
 */
describe("#360 — the deprecated runtime keys are no longer accepted", () => {
  it("`runtime` is honoured — the control, so the refusals below mean something", async () => {
    const { POST } = await import("./route");
    // `base` names fastapi, which is the runtime this harness configures a URL
    // for. Naming django here would refuse for a DIFFERENT reason — no
    // DJANGO_URL — and a control that fails for the wrong reason proves nothing
    // about the one under test.
    const res = await POST(post(base));
    expect(res.status).not.toBe(400);
    expect(capture.body, "the route never called the backend").not.toBeNull();
  });

  it("`pythonBackend` alone is now a 400 — the window is shut", async () => {
    const { POST } = await import("./route");
    const { runtime: _drop, ...noRuntime } = base;
    const res = await POST(post({ ...noRuntime, pythonBackend: "fastapi" }));
    expect(res.status).toBe(400);
    // MISSING, not unknown: the key is unread, so the request named no runtime
    // at all. Reporting it as "unknown runtime: django" would send the caller
    // to fix a value that was never the problem.
    const body = (await res.json()) as { reason?: string };
    expect(body.reason).toBe("missing");
  });

  it("`backend` alone is now a 400 too — both legacy spellings, not just one", async () => {
    const { POST } = await import("./route");
    const { runtime: _drop, ...noRuntime } = base;
    const res = await POST(post({ ...noRuntime, backend: "fastapi" }));
    expect(res.status).toBe(400);
  });

  it("the UNCONFIGURED-RUNTIME ERROR names `runtime`, not `pythonBackend`", async () => {
    /*
     * THIS ONE IS A WIRE FIELD, and it survived the rename until review caught
     * it. A client asking for a runtime this deployment has no URL for got back
     * {"pythonBackend":"node"} — the exact contradiction #360 deletes, on the
     * response side, from the commit that closes the window.
     *
     * django has no URL in this harness, which is what makes it the input that
     * reaches this branch.
     */
    const { POST } = await import("./route");
    const res = await POST(post({ ...base, runtime: "django" }));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.runtime).toBe("django");
    expect(body.pythonBackend).toBeUndefined();
    // The message names the variable a reader must set, which is the whole
    // point of refusing here rather than falling back to another runtime.
    expect(String(body.error)).toContain("DJANGO_URL");
  });

  it("a deprecated key is not FORWARDED either, now that it is ignored", async () => {
    // Stripping outlives reading. With the key unread, forwarding it would let
    // the backend act on a choice this proxy did not make — a worse version of
    // what the strip list already prevented.
    const { POST } = await import("./route");
    await POST(post({ ...base, pythonBackend: "django", backend: "django" }));
    expect(capture.body!.pythonBackend).toBeUndefined();
    expect(capture.body!.backend).toBeUndefined();
    expect(capture.body!.runtime).toBeUndefined();
  });
});

/**
 * ONE ALLOWLIST REACHES BOTH GATES (#449, invariant I2).
 *
 * #449 was ruled "no bypass" partly because a tool is gated UPSTREAM exactly when
 * the proxy gate would have gated it — which is true only while both ends read one
 * list. Two lists that happen to match today would make the ruling accidental, and
 * would fail the way this repo's duplications always fail: silently, at the first
 * edit of one copy.
 *
 * IDENTITY CANNOT BE THE ASSERTION, and the reason is worth stating rather than
 * working around. The allowlist reaches the backend by being SERIALISED, so the
 * value the other gate reads is necessarily a copy — `toBe` is unavailable across
 * a wire by construction, not by an accident of this harness. The meaningful claim
 * is therefore AGREEMENT, asserted in both directions on the two things that
 * actually consume it.
 */
describe("one allowlist reaches both gates (#449 I2)", () => {
  it("forwards exactly the allowlist the proxy gate reads — same members", async () => {
    const { POST } = await import("./route");
    const { READ_ONLY_TOOLS } = await import("../../../../lib/approval-policy");
    await POST(post({ ...base }));
    expect(capture.body, "the route never called the backend").not.toBeNull();
    const sent = (capture.body!.approvalPolicy as { readOnlyTools: string[] })
      .readOnlyTools;
    expect([...sent].sort()).toEqual([...READ_ONLY_TOOLS].sort());
  });

  /*
   * THE DIRECTION THAT MATTERS. The list above is what the BACKEND excuses from
   * gating. This asserts the proxy gate excuses exactly the same names — so a tool
   * upstream lets through is one the proxy also declines to gate, and a tool
   * upstream gates is one the proxy would have gated. That equivalence is the
   * ruling's premise, stated as a test rather than as prose.
   */
  it("the proxy gate excuses exactly what is forwarded, and gates everything else", async () => {
    const { POST } = await import("./route");
    const { requiresApproval } = await import(
      "../../../../lib/approval-policy"
    );
    await POST(post({ ...base }));
    const sent = (capture.body!.approvalPolicy as { readOnlyTools: string[] })
      .readOnlyTools;

    expect(
      sent.length,
      "an empty allowlist would make both halves vacuous"
    ).toBeGreaterThan(0);

    for (const name of sent) {
      expect(
        requiresApproval(name),
        `"${name}" is sent to the backend as read-only but the proxy gate would ` +
          `still gate it — the two gates disagree about one tool`
      ).toBe(false);
    }

    // The presence companion: a name NOT on the list must be gated. Without it,
    // a `requiresApproval` that returned false for everything passes above.
    expect(
      requiresApproval("definitely__not__read_only__tool"),
      "a tool absent from the allowlist was not gated — the fail-closed rule is " +
        "what makes an unrecognised tool safe, and it is not in force"
    ).toBe(true);
  });
});
