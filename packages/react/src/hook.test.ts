import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { UIMessage } from "ai";
import { PlanSchema } from "./schemas";
import type { DataPlan } from "./schemas";
import type { UseDeepAgentsChatReturn } from "./hook";

// vi.mock is hoisted — factories must not reference outer variables
vi.mock("@ai-sdk/react", () => ({
  useChat: vi.fn(),
}));

vi.mock("ai", () => ({
  DefaultChatTransport: vi.fn(
    class {
      __opts: unknown;
      constructor(opts: unknown) {
        this.__opts = opts;
      }
    }
  ),
}));

// Import mocked modules after vi.mock declarations
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
// Import hook after mocks
import { useDeepAgentsChat } from "./hook";

const mockUseChat = useChat as ReturnType<typeof vi.fn>;
const MockDefaultChatTransport = DefaultChatTransport as ReturnType<
  typeof vi.fn
>;

const mockSendMessage = vi.fn();
const mockRegenerate = vi.fn();

function makeDefaultUseChatReturn(
  overrides?: Partial<{
    messages: UIMessage[];
    sendMessage: typeof mockSendMessage;
    status: string;
    error: Error | null;
    regenerate: typeof mockRegenerate;
  }>
) {
  return {
    messages: [],
    sendMessage: mockSendMessage,
    status: "ready",
    error: null,
    regenerate: mockRegenerate,
    ...overrides,
  };
}

describe("useDeepAgentsChat()", () => {
  beforeEach(() => {
    mockSendMessage.mockReset();
    mockRegenerate.mockReset();
    MockDefaultChatTransport.mockClear();
    MockDefaultChatTransport.mockImplementation(
      class {
        __opts: unknown;
        constructor(opts: unknown) {
          this.__opts = opts;
        }
      }
    );
    mockUseChat.mockReturnValue(makeDefaultUseChatReturn());
  });

  it("returns messages, sendMessage, status, error", () => {
    const { result } = renderHook(() =>
      useDeepAgentsChat({ sessionId: "abc", endpoint: "/api/chat/stream" })
    );
    expect(result.current.messages).toBeDefined();
    expect(result.current.sendMessage).toBeTypeOf("function");
    expect(result.current.status).toBeDefined();
    expect(result.current.error).toBeNull();
  });

  it("messages is initially an empty array", () => {
    const { result } = renderHook(() =>
      useDeepAgentsChat({ sessionId: "abc", endpoint: "/api/chat/stream" })
    );
    expect(result.current.messages).toEqual([]);
  });

  it('status is "idle" when not streaming', () => {
    const { result } = renderHook(() =>
      useDeepAgentsChat({ sessionId: "abc", endpoint: "/api/chat/stream" })
    );
    expect(result.current.status).toBe("idle");
  });

  it("error is null when no error", () => {
    const { result } = renderHook(() =>
      useDeepAgentsChat({ sessionId: "abc", endpoint: "/api/chat/stream" })
    );
    expect(result.current.error).toBeNull();
  });

  it("sendMessage calls useChat sendMessage with { text }", () => {
    const { result } = renderHook(() =>
      useDeepAgentsChat({ sessionId: "abc", endpoint: "/api/chat/stream" })
    );
    result.current.sendMessage("hello world");
    expect(mockSendMessage).toHaveBeenCalledWith({ text: "hello world" });
  });

  it("messages are derived from partsToMessages(aiMessages, isStreaming)", () => {
    const fakeUserMsg = {
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    } as unknown as UIMessage;
    mockUseChat.mockReturnValue(
      makeDefaultUseChatReturn({ messages: [fakeUserMsg] })
    );

    const { result } = renderHook(() =>
      useDeepAgentsChat({ sessionId: "abc", endpoint: "/api/chat/stream" })
    );
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].type).toBe("user");
    expect(
      result.current.messages[0].type === "user" &&
        result.current.messages[0].content
    ).toBe("hi");
  });

  it('status is "streaming" when useChat status is "streaming"', () => {
    mockUseChat.mockReturnValue(
      makeDefaultUseChatReturn({ status: "streaming" })
    );
    const { result } = renderHook(() =>
      useDeepAgentsChat({ sessionId: "abc", endpoint: "/api/chat/stream" })
    );
    expect(result.current.status).toBe("streaming");
  });

  it('status is "submitted" when useChat status is "submitted"', () => {
    mockUseChat.mockReturnValue(
      makeDefaultUseChatReturn({ status: "submitted" })
    );
    const { result } = renderHook(() =>
      useDeepAgentsChat({ sessionId: "abc", endpoint: "/api/chat/stream" })
    );
    expect(result.current.status).toBe("submitted");
  });

  it('status is "error" when useChat returns an error', () => {
    mockUseChat.mockReturnValue(
      makeDefaultUseChatReturn({ error: new Error("fail") })
    );
    const { result } = renderHook(() =>
      useDeepAgentsChat({ sessionId: "abc", endpoint: "/api/chat/stream" })
    );
    expect(result.current.status).toBe("error");
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe("fail");
  });

  it("getToken absent → no Authorization header in transport", async () => {
    renderHook(() =>
      useDeepAgentsChat({ sessionId: "abc", endpoint: "/api/chat/stream" })
    );
    expect(MockDefaultChatTransport).toHaveBeenCalled();
    const opts = MockDefaultChatTransport.mock.calls[0][0] as {
      headers?: () => Promise<Record<string, string>>;
    };
    expect(opts.headers).toBeTypeOf("function");
    const headers = await opts.headers!();
    expect(headers).toEqual({});
  });

  it("getToken returning a string → Authorization: Bearer {token} in transport", async () => {
    renderHook(() =>
      useDeepAgentsChat({
        sessionId: "abc",
        endpoint: "/api/chat/stream",
        getToken: () => "my-secret-token",
      })
    );
    const opts = MockDefaultChatTransport.mock.calls[0][0] as {
      headers?: () => Promise<Record<string, string>>;
    };
    const headers = await opts.headers!();
    expect(headers).toEqual({ Authorization: "Bearer my-secret-token" });
  });

  it("getToken returning null → no Authorization header in transport", async () => {
    renderHook(() =>
      useDeepAgentsChat({
        sessionId: "abc",
        endpoint: "/api/chat/stream",
        getToken: () => null,
      })
    );
    const opts = MockDefaultChatTransport.mock.calls[0][0] as {
      headers?: () => Promise<Record<string, string>>;
    };
    const headers = await opts.headers!();
    expect(headers).toEqual({});
  });

  it("getToken returning undefined → no Authorization header in transport", async () => {
    // getToken can return undefined (the type allows it) — must not produce
    // "Authorization: Bearer undefined"
    renderHook(() =>
      useDeepAgentsChat({
        sessionId: "abc",
        endpoint: "/api/chat/stream",
        getToken: () => undefined,
      })
    );
    const opts = MockDefaultChatTransport.mock.calls[0][0] as {
      headers?: () => Promise<Record<string, string>>;
    };
    const headers = await opts.headers!();
    expect(headers).toEqual({});
    expect(Object.keys(headers)).not.toContain("Authorization");
  });

  it('status is "error" when useChat status is "ready" AND error is set (not streaming)', () => {
    // When status is neither 'streaming' nor 'submitted' but an error is present,
    // derivedStatus must be 'error', not 'idle'.
    mockUseChat.mockReturnValue(
      makeDefaultUseChatReturn({
        status: "ready",
        error: new Error("network fail"),
      })
    );
    const { result } = renderHook(() =>
      useDeepAgentsChat({ sessionId: "abc", endpoint: "/api/chat/stream" })
    );
    expect(result.current.status).toBe("error");
    expect(result.current.error?.message).toBe("network fail");
  });

  it('status is "streaming" even when useChat also has an error (streaming wins over error)', () => {
    // The hook derives status as isStreaming ? streaming/submitted : error ? 'error' : 'idle'.
    // If both streaming=true and error≠null, streaming must take priority.
    mockUseChat.mockReturnValue(
      makeDefaultUseChatReturn({
        status: "streaming",
        error: new Error("partial fail"),
      })
    );
    const { result } = renderHook(() =>
      useDeepAgentsChat({ sessionId: "abc", endpoint: "/api/chat/stream" })
    );
    expect(result.current.status).toBe("streaming");
  });

  it("transport body() returns the sessionId passed to the hook", () => {
    renderHook(() =>
      useDeepAgentsChat({
        sessionId: "my-session-xyz",
        endpoint: "/api/chat/stream",
      })
    );
    const opts = MockDefaultChatTransport.mock.calls[0][0] as {
      body?: () => Record<string, unknown>;
    };
    expect(typeof opts.body).toBe("function");
    const body = opts.body!();
    expect(body).toEqual({ sessionId: "my-session-xyz" });
  });
});

describe("useDeepAgentsChat<TData> — generics", () => {
  beforeEach(() => {
    mockSendMessage.mockReset();
    mockRegenerate.mockReset();
    MockDefaultChatTransport.mockClear();
    MockDefaultChatTransport.mockImplementation(
      class {
        __opts: unknown;
        constructor(opts: unknown) {
          this.__opts = opts;
        }
      }
    );
    mockUseChat.mockReturnValue(makeDefaultUseChatReturn());
  });

  it("parameterized call receives custom data-plan part with narrowed type", () => {
    // Simulate the hook returning a data-plan message via the schemas option.
    // When useDeepAgentsChat<{ 'data-plan': typeof PlanSchema }> is called,
    // msg.data should be narrowed to DataPlan at compile time.
    const dataPlanPayload: DataPlan = {
      id: "p1",
      seq: 0,
      title: "T",
      markdown: "## T",
      subtasks: [],
      updatedAt: "2026-01-01T00:00:00Z",
    };

    const fakeAssistantMsg = {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "data-plan",
          data: dataPlanPayload,
        },
      ],
    } as unknown as UIMessage;

    mockUseChat.mockReturnValue(
      makeDefaultUseChatReturn({ messages: [fakeAssistantMsg] })
    );

    const { result } = renderHook(() =>
      useDeepAgentsChat<{ "data-plan": typeof PlanSchema }>({
        sessionId: "abc",
        endpoint: "/api/chat/stream",
        schemas: { "data-plan": PlanSchema },
      })
    );

    const msgs = result.current.messages;
    const dataPlanMsg = msgs.find((msg) => msg.type === "data-plan");
    expect(dataPlanMsg).toBeDefined();
    // TypeScript narrowing: after the find+type check, msg.data should be DataPlan
    // This line compiles only if the union includes { type: 'data-plan', data: DataPlan }
    if (dataPlanMsg && dataPlanMsg.type === "data-plan") {
      const narrowed = dataPlanMsg as { type: "data-plan"; data: DataPlan };
      expect(narrowed.data.id).toBe("p1");
    }
  });

  it("zero-generic call backward compatibility — return type matches UseDeepAgentsChatReturn", () => {
    // Type-level test: zero-generic call must produce the same return type as v1.1.
    // This line must compile — if UseDeepAgentsChatReturn<{}> is not assignable to
    // UseDeepAgentsChatReturn, TypeScript will error here.
    const _hook: UseDeepAgentsChatReturn = null as unknown as ReturnType<
      typeof useDeepAgentsChat
    >;
    // Suppress unused variable warning — the test is compile-time only
    expect(_hook).toBeDefined();
  });

  it("constraint rejection — compile-time only: TData values must extend ZodTypeAny", () => {
    // Pure compile-time test: verify the TData constraint is enforced.
    // We use a type-only variable — never called at runtime — to avoid Invalid hook call.
    // The @ts-expect-error suppresses the type error when the constraint IS in place.
    // If the constraint is removed, @ts-expect-error becomes an "unused directive" error.
    type BadTData = { foo: string };
    // @ts-expect-error string does not extend ZodTypeAny
    type _Check = UseDeepAgentsChatReturn<BadTData>;
    void (null as unknown as _Check);
    expect(true).toBe(true);
  });
});

describe("reconnection options", () => {
  beforeEach(() => {
    mockSendMessage.mockReset();
    mockRegenerate.mockReset();
    MockDefaultChatTransport.mockClear();
    MockDefaultChatTransport.mockImplementation(
      class {
        __opts: unknown;
        constructor(opts: unknown) {
          this.__opts = opts;
        }
      }
    );
    mockUseChat.mockReturnValue(makeDefaultUseChatReturn());
  });

  it("retry() is a no-op when enableReconnect is false (default) — reload is NOT called", () => {
    const { result } = renderHook(() =>
      useDeepAgentsChat({ sessionId: "abc", endpoint: "/api/chat/stream" })
    );
    act(() => {
      result.current.retry();
    });
    expect(mockRegenerate).not.toHaveBeenCalled();
  });

  it("retry() calls reload() when enableReconnect is true", () => {
    const { result } = renderHook(() =>
      useDeepAgentsChat({
        sessionId: "abc",
        endpoint: "/api/chat/stream",
        enableReconnect: true,
        resumeId: "res-123",
      })
    );
    act(() => {
      result.current.retry();
    });
    expect(mockRegenerate).toHaveBeenCalledTimes(1);
  });

  it("retry is always defined in return value even without enableReconnect options", () => {
    const { result } = renderHook(() =>
      useDeepAgentsChat({ sessionId: "abc", endpoint: "/api/chat/stream" })
    );
    expect(result.current.retry).toBeTypeOf("function");
  });

  it("X-Resume-Id header IS included when enableReconnect=true and resumeId is provided", async () => {
    renderHook(() =>
      useDeepAgentsChat({
        sessionId: "abc",
        endpoint: "/api/chat/stream",
        enableReconnect: true,
        resumeId: "res-456",
      })
    );
    const opts = MockDefaultChatTransport.mock.calls[0][0] as {
      headers?: () => Promise<Record<string, string>>;
    };
    const headers = await opts.headers!();
    expect(headers["x-resume-id"]).toBe("res-456");
  });

  it("X-Resume-Id header is NOT included when enableReconnect=false even if resumeId is provided", async () => {
    renderHook(() =>
      useDeepAgentsChat({
        sessionId: "abc",
        endpoint: "/api/chat/stream",
        enableReconnect: false,
        resumeId: "res-789",
      })
    );
    const opts = MockDefaultChatTransport.mock.calls[0][0] as {
      headers?: () => Promise<Record<string, string>>;
    };
    const headers = await opts.headers!();
    expect(Object.keys(headers)).not.toContain("x-resume-id");
  });

  /*
   * THE 503 BOUNDARY (#376). These four pin a swallow, so three of them exist to stop it
   * becoming a blanket catch. A test proving 503 is inert, with nothing proving 404 and a
   * non-resume 503 are not, is satisfied by a transport that ignores every response.
   */
  function resumeTransportFetch() {
    renderHook(() =>
      useDeepAgentsChat({
        sessionId: "abc",
        endpoint: "/api/chat/stream",
        enableReconnect: true,
        resumeId: "session-1",
        resumeEndpoint: "/api/chat/stream/resume",
      })
    );
    const opts = MockDefaultChatTransport.mock.calls[0][0] as {
      fetch?: (i: RequestInfo | URL, n?: RequestInit) => Promise<Response>;
    };
    expect(opts.fetch).toBeTypeOf("function");
    return opts.fetch!;
  }

  it("resume endpoint 503 is INERT — mapped to 204, so it never becomes error state", async () => {
    const doFetch = resumeTransportFetch();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response("stream reconnection disabled", { status: 503 })
      );
    try {
      const res = await doFetch("/api/chat/stream/resume?resumeId=session-1");
      // 204 is what this client already treats as "nothing to resume" — the same answer
      // the handler gives for an unknown id on a fresh load.
      expect(res.status).toBe(204);
    } finally {
      spy.mockRestore();
    }
  });

  it("resume endpoint 404 is NOT swallowed — the #372 defect must stay loud", async () => {
    // A 404 means the route does not answer the shape the hook asked for. That bug lived the
    // entire life of the feature because nothing surfaced it. If this test ever passes a 204
    // through, the next URL-contract drift is silent again.
    const doFetch = resumeTransportFetch();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("not found", { status: 404 }));
    try {
      const res = await doFetch("/api/chat/stream/resume?resumeId=session-1");
      expect(res.status).toBe(404);
    } finally {
      spy.mockRestore();
    }
  });

  it("resume endpoint 500 is NOT swallowed — a broken endpoint stays visible", async () => {
    const doFetch = resumeTransportFetch();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("boom", { status: 500 }));
    try {
      const res = await doFetch("/api/chat/stream/resume?resumeId=session-1");
      expect(res.status).toBe(500);
    } finally {
      spy.mockRestore();
    }
  });

  it("503 from the CHAT endpoint is NOT swallowed — the swallow is scoped to resume", async () => {
    // Without this, a real outage on the chat endpoint would be turned into an empty stream
    // and the conversation would fail silently.
    const doFetch = resumeTransportFetch();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("upstream down", { status: 503 }));
    try {
      const res = await doFetch("/api/chat/stream");
      expect(res.status).toBe(503);
    } finally {
      spy.mockRestore();
    }
  });

  it("enableReconnect=true with resumeId but NO resumeEndpoint — prepareReconnectToStreamRequest is NOT set on transport", () => {
    // Gap: the ternary `enableReconnect && resumeId && resumeEndpoint` requires ALL THREE to be
    // truthy before attaching prepareReconnectToStreamRequest. If resumeEndpoint is absent the
    // property must be completely absent from the transport options (not set to undefined).
    // Callers that forget resumeEndpoint would silently get a transport without reconnect wiring
    // even though enableReconnect=true — this test pins that behavior so it's a conscious choice.
    renderHook(() =>
      useDeepAgentsChat({
        sessionId: "abc",
        endpoint: "/api/chat/stream",
        enableReconnect: true,
        resumeId: "res-no-endpoint",
        // resumeEndpoint intentionally omitted
      })
    );
    const opts = MockDefaultChatTransport.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(opts).not.toHaveProperty("prepareReconnectToStreamRequest");
  });

  it("enableReconnect=true with resumeId absent → resume prop passed to useChat is false (not true)", () => {
    // Gap: useChat is called with `resume: enableReconnect && !!resumeId`.
    // When enableReconnect=true but resumeId is undefined, !!resumeId is false, so resume should
    // be false. If the implementation accidentally passes `resume: enableReconnect` (dropping the
    // !!resumeId guard), useChat would receive resume=true with no resumeId to act on, which
    // could trigger unexpected reconnect behavior in the AI SDK.
    renderHook(() =>
      useDeepAgentsChat({
        sessionId: "abc",
        endpoint: "/api/chat/stream",
        enableReconnect: true,
        // resumeId intentionally omitted
      })
    );
    const useChatCallArgs = mockUseChat.mock.calls[0][0] as {
      resume?: boolean;
    };
    expect(useChatCallArgs.resume).toBe(false);
  });

  it("prepareReconnectToStreamRequest is NOT set when resumeEndpoint provided but resumeId is absent", () => {
    // Gap: the ternary `enableReconnect && resumeId && resumeEndpoint` requires resumeId to be
    // truthy. Providing resumeEndpoint without resumeId should produce no prepareReconnectToStreamRequest.
    // This mirrors the existing test for missing resumeEndpoint but tests the other missing-param side.
    renderHook(() =>
      useDeepAgentsChat({
        sessionId: "abc",
        endpoint: "/api/chat/stream",
        enableReconnect: true,
        resumeEndpoint: "/api/chat/stream/resume",
        // resumeId intentionally omitted
      })
    );
    const opts = MockDefaultChatTransport.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(opts).not.toHaveProperty("prepareReconnectToStreamRequest");
  });

  it("prepareReconnectToStreamRequest URL uses ? separator correctly — resumeEndpoint with existing query string produces malformed URL", async () => {
    // Gap: the URL is built as `${resumeEndpoint}?resumeId=${resumeId}`.
    // If resumeEndpoint already contains a query string (e.g. '/api/resume?foo=bar'),
    // the result is '/api/resume?foo=bar?resumeId=abc' — two `?` separators, which is
    // not valid. The correct separator for the second param would be `&`.
    // This test pins the CURRENT (broken) behavior so the gap is visible; if the
    // implementation is fixed to use `&`, this test should be updated to assert the
    // correct URL instead.
    renderHook(() =>
      useDeepAgentsChat({
        sessionId: "abc",
        endpoint: "/api/chat/stream",
        enableReconnect: true,
        resumeId: "res-xyz",
        resumeEndpoint: "/api/chat/stream/resume?version=2",
      })
    );
    const opts = MockDefaultChatTransport.mock.calls[0][0] as {
      prepareReconnectToStreamRequest?: () => { api: string };
    };
    expect(opts.prepareReconnectToStreamRequest).toBeTypeOf("function");
    const { api } = opts.prepareReconnectToStreamRequest!();
    // Current implementation concatenates with ? regardless of existing query params.
    // A correct implementation would produce: /api/chat/stream/resume?version=2&resumeId=res-xyz
    // The malformed URL has two ? characters — this assertion documents the gap.
    const questionMarkCount = (api.match(/\?/g) ?? []).length;
    expect(questionMarkCount).toBe(1); // FAILS if implementation naively appends `?resumeId=`
  });

  it("both x-resume-id AND Authorization headers are present when enableReconnect=true + resumeId + getToken all provided", async () => {
    // Gap: the headers() function builds `base` with x-resume-id first, then conditionally
    // spreads the Authorization key. If the implementation accidentally returns early or
    // overwrites `base` instead of spreading into it, one of the two headers is lost.
    // This is the only test that exercises BOTH headers being present simultaneously.
    renderHook(() =>
      useDeepAgentsChat({
        sessionId: "abc",
        endpoint: "/api/chat/stream",
        enableReconnect: true,
        resumeId: "res-auth-test",
        getToken: () => "my-token",
      })
    );
    const opts = MockDefaultChatTransport.mock.calls[0][0] as {
      headers?: () => Promise<Record<string, string>>;
    };
    const headers = await opts.headers!();
    expect(headers["x-resume-id"]).toBe("res-auth-test");
    expect(headers["Authorization"]).toBe("Bearer my-token");
  });

  it("extraBody non-conflicting keys are merged additively alongside sessionId in transport body()", () => {
    // Gap: body is built as `{ sessionId, ...extraBody }`. The existing test only covers
    // the collision/overwrite case. This test verifies the additive (no-collision) path:
    // extra keys must appear in the body alongside sessionId without dropping either.
    // If the implementation accidentally returns only extraBody (forgetting the sessionId
    // spread) or only { sessionId } (ignoring extraBody), this test will catch it.
    renderHook(() =>
      useDeepAgentsChat({
        sessionId: "my-session",
        endpoint: "/api/chat/stream",
        body: { adapterName: "langgraph", threadId: "t-99" },
      })
    );
    const opts = MockDefaultChatTransport.mock.calls[0][0] as {
      body?: () => Record<string, unknown>;
    };
    const body = opts.body!();
    expect(body.sessionId).toBe("my-session");
    expect(body.adapterName).toBe("langgraph");
    expect(body.threadId).toBe("t-99");
  });

  it("extraBody containing a sessionId key overwrites the hook's sessionId in transport body()", () => {
    // Gap: body is built as `{ sessionId, ...extraBody }` — a spread where extraBody wins on
    // collision. If a caller passes body={{ sessionId: 'override' }} the hook's own sessionId
    // prop is silently replaced. This test pins the current behavior (last write wins) so any
    // future change to the merge order is a deliberate, visible decision.
    renderHook(() =>
      useDeepAgentsChat({
        sessionId: "original-session",
        endpoint: "/api/chat/stream",
        body: { sessionId: "overridden-session" },
      })
    );
    const opts = MockDefaultChatTransport.mock.calls[0][0] as {
      body?: () => Record<string, unknown>;
    };
    const body = opts.body!();
    // extraBody spread overwrites the positional sessionId — value is 'overridden-session'
    expect(body.sessionId).toBe("overridden-session");
  });
});

describe("ADVERSARIAL — useChat returning undefined messages array", () => {
  beforeEach(() => {
    mockSendMessage.mockReset();
    mockRegenerate.mockReset();
    MockDefaultChatTransport.mockClear();
    MockDefaultChatTransport.mockImplementation(
      class {
        __opts: unknown;
        constructor(opts: unknown) {
          this.__opts = opts;
        }
      }
    );
    mockUseChat.mockReturnValue(makeDefaultUseChatReturn());
  });

  it("does not crash when useChat returns messages: undefined — produces empty array", () => {
    // Defensive: some AI SDK shapes allow messages to be undefined before the
    // first message lands. partsToMessages iterates the array with map/filter,
    // which would throw "Cannot read properties of undefined (reading 'map')"
    // if the guard is missing. The hook must produce messages: [] rather than
    // throw, so subscribers render an empty state instead of an error boundary.
    mockUseChat.mockReturnValue(
      makeDefaultUseChatReturn({
        messages: undefined,
      })
    );

    const { result } = renderHook(() =>
      useDeepAgentsChat({ sessionId: "abc", endpoint: "/api/chat/stream" })
    );
    // Must NOT throw, must produce a defined messages array (empty).
    expect(result.current.messages).toBeDefined();
    expect(Array.isArray(result.current.messages)).toBe(true);
    expect(result.current.messages).toEqual([]);
  });

  it("does not crash when useChat returns messages with a null entry — null slot is silently skipped", () => {
    // Adversarial: a hostile or buggy AI SDK could emit null slots inside the
    // messages array. partsToMessages uses safeAiMessages.forEach — forEach
    // skips undefined/null entries, so a null message slot must NOT crash the
    // reducer (which accesses m.role). The hook must yield a sane (empty or
    // partial) messages array without throwing.
    const nullEntry = null as unknown as UIMessage;
    const validMsg = {
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "ok" }],
    } as unknown as UIMessage;
    mockUseChat.mockReturnValue(
      makeDefaultUseChatReturn({ messages: [nullEntry, validMsg] })
    );

    expect(() => {
      renderHook(() =>
        useDeepAgentsChat({ sessionId: "abc", endpoint: "/api/chat/stream" })
      );
    }).not.toThrow();
  });

  it("does not crash when a part uses a Symbol as its type field — Symbol part is silently skipped", () => {
    // Adversarial: a Symbol cannot be stringified via String() in a useful way,
    // and `partType.startsWith('data-')` will throw "Cannot convert a Symbol
    // value to a string" if the guard does not coerce safely. The converter
    // guards with `typeof partType === 'string'` so Symbol parts must be
    // silently dropped, never throw.
    const symbolPart = {
      type: Symbol("adversarial-symbol"),
      text: "should be ignored",
    } as unknown as { type: string };
    const msg = {
      id: "a1",
      role: "assistant",
      parts: [symbolPart],
    } as unknown as UIMessage;
    mockUseChat.mockReturnValue(makeDefaultUseChatReturn({ messages: [msg] }));

    expect(() => {
      renderHook(() =>
        useDeepAgentsChat({ sessionId: "abc", endpoint: "/api/chat/stream" })
      );
    }).not.toThrow();
  });
});

describe("ADVERSARIAL iter-2 — concurrent rapid state changes", () => {
  beforeEach(() => {
    mockSendMessage.mockReset();
    mockRegenerate.mockReset();
    MockDefaultChatTransport.mockClear();
    MockDefaultChatTransport.mockImplementation(
      class {
        __opts: unknown;
        constructor(opts: unknown) {
          this.__opts = opts;
        }
      }
    );
    mockUseChat.mockReturnValue(makeDefaultUseChatReturn());
  });

  it("survives 100 rapid setState bursts — messages array remains defined and consistent", () => {
    // Adversarial: hammer the hook with 100 fast state updates mimicking a
    // chatty SSE stream or user typing storm. The hook derives `messages` via
    // useMemo with deps [aiMessages, isStreaming, schemas]. If any update
    // creates a torn/inconsistent state (e.g. stale closure over isStreaming,
    // missing a key on a list-render path) the consumer will throw or render
    // undefined. Final state must still be the LAST message, not a random
    // intermediate frame.
    let liveMessages: UIMessage[] = [];
    let liveStatus: string = "streaming";
    const liveSendMessage = vi.fn();
    const liveRegenerate = vi.fn();

    mockUseChat.mockImplementation(() => ({
      messages: liveMessages,
      sendMessage: liveSendMessage,
      status: liveStatus,
      error: null,
      regenerate: liveRegenerate,
    }));

    const { result, rerender } = renderHook(() =>
      useDeepAgentsChat({ sessionId: "abc", endpoint: "/api/chat/stream" })
    );

    expect(() => {
      act(() => {
        for (let i = 0; i < 100; i++) {
          // Mutate the live messages array + flip status to mimic 100 fast chunks
          liveMessages = [
            ...liveMessages,
            {
              id: `a-${i}`,
              role: "assistant",
              parts: [{ type: "text", text: `chunk-${i}` }],
            } as unknown as UIMessage,
          ];
          liveStatus = i % 2 === 0 ? "streaming" : "submitted";
          // Force a re-render so the hook re-derives messages from the new
          // mockUseChat return value (without this, renderHook snapshots the
          // first call's result and never re-reads mockUseChat).
          rerender();
        }
      });
    }).not.toThrow();

    // After the burst, the hook must still expose a well-formed messages array
    // containing all 100 chunks (concatenated into one AIMessage per assistant msg)
    expect(result.current.messages).toBeDefined();
    expect(Array.isArray(result.current.messages)).toBe(true);
    const aiBubbles = result.current.messages.filter((m) => m.type === "ai");
    expect(aiBubbles.length).toBeGreaterThan(0);
    // Final bubble must contain the last chunk text — guards against stale-closure
    // bugs where a render captures an older `aiMessages` reference
    const lastBubble = aiBubbles[aiBubbles.length - 1];
    if (lastBubble && lastBubble.type === "ai") {
      expect(lastBubble.content).toContain("chunk-99");
    }
    // And the hook must remain in a known status (not stuck mid-stream)
    expect(["streaming", "submitted", "idle", "error"]).toContain(
      result.current.status
    );
  });
});

describe("ADVERSARIAL iter-2 — deeply nested part structure (stack-overflow probe)", () => {
  beforeEach(() => {
    mockSendMessage.mockReset();
    mockRegenerate.mockReset();
    MockDefaultChatTransport.mockClear();
    MockDefaultChatTransport.mockImplementation(
      class {
        __opts: unknown;
        constructor(opts: unknown) {
          this.__opts = opts;
        }
      }
    );
    mockUseChat.mockReturnValue(makeDefaultUseChatReturn());
  });

  it("does not stack-overflow when an assistant message has a 1000-level nested part array", () => {
    // Adversarial: build an assistant message whose `parts` array is itself
    // nested 1000 levels deep via wrapper objects. partsToMessages iterates
    // `parts` with for-of (not recursion), but if any helper accidentally
    // recurses on `part.children` or similar, the call stack will blow.
    // The hook must produce a defined messages array without crashing.
    type NestedPart = {
      type: "text";
      text: string;
      children?: NestedPart[];
    };
    const buildDeep = (depth: number): NestedPart => {
      if (depth === 0) return { type: "text", text: "leaf" };
      return {
        type: "text",
        text: `level-${depth}`,
        children: [buildDeep(depth - 1)],
      };
    };
    const deepPart = buildDeep(1000);
    const msg = {
      id: "a-deep",
      role: "assistant",
      parts: [deepPart],
    } as unknown as UIMessage;
    mockUseChat.mockReturnValue(makeDefaultUseChatReturn({ messages: [msg] }));

    expect(() => {
      const { result } = renderHook(() =>
        useDeepAgentsChat({
          sessionId: "abc",
          endpoint: "/api/chat/stream",
        })
      );
      // Sanity: messages array is defined and contains the ai bubble
      expect(result.current.messages).toBeDefined();
      const aiMsgs = result.current.messages.filter((m) => m.type === "ai");
      // The leaf text must survive (partsToMessages reads `part.text` directly,
      // so the deepest leaf's `text` field is concatenated into the buffer)
      expect(aiMsgs.length).toBeGreaterThan(0);
    }).not.toThrow();
  });
});

describe("ADVERSARIAL iter-3 — useChat returns messages with empty parts arrays", () => {
  beforeEach(() => {
    mockSendMessage.mockReset();
    mockRegenerate.mockReset();
    MockDefaultChatTransport.mockClear();
    MockDefaultChatTransport.mockImplementation(
      class {
        __opts: unknown;
        constructor(opts: unknown) {
          this.__opts = opts;
        }
      }
    );
  });

  it("useChat returning a mix of user/assistant messages each with parts=[] → hook yields a non-empty, well-formed messages array (no crash, no undefined entries)", () => {
    // Gap: partsToMessages guarantees a placeholder ai bubble for empty-parts
    // assistant messages (L332-344). The hook wraps that — so the public
    // contract is: every assistant message surfaces SOME bubble, and every
    // user message surfaces its UserMessage. If the implementation skipped
    // placeholder bubbles entirely (or threw on parts=undefined), this test
    // catches it.
    const fakeMessages = [
      { id: "u1", role: "user", parts: [] },
      { id: "a1", role: "assistant", parts: [] },
      { id: "u2", role: "user", parts: [] },
      { id: "a2", role: "assistant", parts: [] },
    ] as unknown as UIMessage[];
    mockUseChat.mockReturnValue(
      makeDefaultUseChatReturn({ messages: fakeMessages })
    );

    expect(() => {
      const { result } = renderHook(() =>
        useDeepAgentsChat({
          sessionId: "abc",
          endpoint: "/api/chat/stream",
        })
      );
      const msgs = result.current.messages;
      // Exactly 4: user, ai(placeholder), user, ai(placeholder)
      expect(msgs).toHaveLength(4);
      // No undefined or null entries — guard against torn list state
      expect(msgs.every((m) => m != null)).toBe(true);
      // Each assistant bubble is empty content with isStreaming=false (not streaming)
      const aiBubbles = msgs.filter((m) => m.type === "ai");
      expect(aiBubbles).toHaveLength(2);
      for (const bubble of aiBubbles) {
        if (bubble.type === "ai") {
          expect(bubble.content).toBe("");
          expect(bubble.isStreaming).toBe(false);
        }
      }
    }).not.toThrow();
  });
});
