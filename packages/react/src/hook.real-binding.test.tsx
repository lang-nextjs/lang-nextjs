/**
 * THE SHIPPED SURFACE ISSUES ITS REQUEST, DRIVEN AGAINST THE REAL BINDING (#984).
 *
 * `hook.test.ts` mocks BOTH `@ai-sdk/react` and `ai`, and asserts the hook's logic given a
 * fabricated transport. Those tests are right and they are not weak. But on the `ai` 6->7 /
 * `@ai-sdk/react` 3->4 bump the shipped surface stopped issuing its resume GET and **all 41 of
 * them stayed green**, because a fabricated transport does not participate in the contract that
 * changed. The defect was in the ASSEMBLY — what the hook hands to the binding it actually ships
 * against — and no amount of care inside a mocked-binding test reaches it.
 *
 * So this file mocks NOTHING. It is a sibling rather than a section because `vi.mock` is
 * hoisted per FILE: a single file cannot both mock the binding and drive it.
 *
 * ─── THREE FABRICATIONS HID THE DEFECT, AND REMOVING ANY TWO STILL HIDES IT ───
 *
 * Measured while building this file, on `ai@7.0.93` + `@ai-sdk/react@4.0.96`:
 *
 *     the SDK binding    mocked          the assembly is never exercised
 *     the environment    single mount    StrictMode's 2nd request never aborts the 1st
 *     the fetch stub     ignores abort   an ABORTED request counts as a DELIVERED GET
 *
 * The third is the one worth stating, because it is invisible. A real `fetch` REJECTS on an
 * aborted signal and puts nothing on the wire. A stub that ignores the signal answers an aborted
 * request exactly as it answers a live one, so no assertion built on it can tell the two apart —
 * the request is recorded as delivered when nothing was sent. With the stub ignoring the signal
 * this suite could see the mechanism (one call versus two) and could not see the symptom (zero).
 *
 * STRICTMODE IS DRIVEN BELOW, AND WHAT THIS HEADER USED TO SAY ABOUT IT NO LONGER HOLDS (#1063).
 * An earlier version recorded that under StrictMode the only request reaching `fetch` arrived
 * ALREADY ABORTED, so nothing reached the wire. On `ai@6.0.197` + `@ai-sdk/react@3.0.199` + React
 * 19.2.8 that does not reproduce. With a harness shown to replay effects, the SDK issues TWO resume
 * requests, neither carrying a signal (measured on #1063, and not pinned here), and exactly one
 * reaches the wire (pinned by the StrictMode arm below). Why the earlier observation differed is
 * not established.
 *
 * DRIVEN, ON `ai@6.0.197` AS THIS PACKAGE INSTALLS IT. Each mutation was applied to the source
 * and reverted, and the suite re-run:
 *
 *     baseline                                            2 pass
 *     hook stops passing `resume` to useChat              positive arm dies
 *     transport stops receiving the resume api/fetch      positive arm dies
 *     resume-fetch suppresses every GET                   positive arm dies
 *     `enableReconnect` stops gating flag AND wiring      NEGATIVE arm dies
 *
 * The last row is why the negative arm is here rather than decorative. Note also what it took:
 * dropping `enableReconnect` from the `resume` flag ALONE does not kill it, because the
 * transport wiring independently gates the URL, so a resume then goes to the chat endpoint and
 * not to this one. The property is protected twice and only losing both shows up here.
 *
 * WHAT THIS FILE IS NOT. It is not where the duplicate-suppression POLICY is proved — that, and
 * the measurements behind it, live in `resume-fetch.test.ts`. The StrictMode arm below asserts only
 * the ASSEMBLED outcome: that the hook, the binding and the transport together put one resume GET
 * on the wire, which is the one thing a policy test with a fabricated caller cannot see.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { StrictMode, createElement, useEffect } from "react";
import {
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";

// Deliberately unmocked: `@ai-sdk/react` and `ai` are the subject, not a dependency to stub.
import { useDeepAgentsChat } from "./hook";

const RESUME = "/api/chat/stream/resume";
const RESUME_ID = "resume-abc";

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * A `fetch` stand-in that behaves like `fetch` on the one axis this file turns on: an aborted
 * signal rejects and records nothing. Reading the signal from BOTH `init` and the `Request` form,
 * so the fidelity cannot be sidestepped by which shape the SDK happens to pass.
 */
function recordingFetch(calls: string[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const signal =
      init && "signal" in init
        ? init.signal
        : input instanceof Request
        ? input.signal
        : undefined;
    if (signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    calls.push(String(input));
    return new Response(null, { status: 204 });
  }) as typeof fetch;
}

describe("the shipped surface issues its resume GET (#984)", () => {
  it("reaches the resume endpoint on mount, carrying the resumeId", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", recordingFetch(calls));

    renderHook(() =>
      useDeepAgentsChat({
        endpoint: "/api/chat",
        sessionId: "session-1",
        enableReconnect: true,
        resumeId: RESUME_ID,
        resumeEndpoint: RESUME,
      })
    );

    await waitFor(
      () =>
        expect(
          calls.filter((c) => c.includes(RESUME)),
          "no GET reached the resume endpoint — the surface did not issue the " +
            "request it exists to make"
        ).not.toHaveLength(0),
      { timeout: 4000 }
    );

    expect(
      calls.find((c) => c.includes(RESUME)),
      "the resume GET carries no resumeId, so the handler cannot answer it"
    ).toContain(`resumeId=${RESUME_ID}`);
  });

  /*
   * THE NEGATIVE HALF. Without it, a stub that recorded every call — or a hook that resumed
   * unconditionally — would satisfy everything above. `enableReconnect: false` must issue NO
   * resume GET at all, which is also the option's documented contract.
   */
  it("issues NO resume GET when reconnect is disabled", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", recordingFetch(calls));

    renderHook(() =>
      useDeepAgentsChat({
        endpoint: "/api/chat",
        sessionId: "session-1",
        enableReconnect: false,
        resumeId: RESUME_ID,
        resumeEndpoint: RESUME,
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(
      calls.filter((c) => c.includes(RESUME)),
      "a resume GET went out with reconnect disabled"
    ).toHaveLength(0);
  });
});

/*
 * UNDER STRICTMODE, THE ASSEMBLY STILL PUTS EXACTLY ONE RESUME GET ON THE WIRE (#1063).
 *
 * `next dev` runs StrictMode, which mounts, unmounts and remounts, so the SDK issues its resume
 * TWICE, and `createResumeFetch` answers the second 204 before it reaches the network. Nothing
 * pinned that at the level of the real hook: disabling the 204 branch reddened only
 * resume-fetch.test.ts, 4 of 510. Measured on ai@6.0.197 + @ai-sdk/react@3.0.199 + React 19.2.8:
 *
 *     dedup intact     2 resume requests issued, 1 on the wire
 *     dedup disabled   2 resume requests issued, 2 on the wire   <- this arm dies
 *
 * THE HARNESS IS GUARDED, because whether a StrictMode harness replays effects depends on its exact
 * form (#1063; DEV1 on #1194). `renderHook` with a `wrapper` that is a function component returning
 * `<StrictMode>` double-renders but does NOT replay effects (effect runs: 1), so an arm built on it
 * is a plain mount wearing a StrictMode label and passes either way. Passing `StrictMode` itself as
 * the `wrapper` DOES replay them (effect runs: 2, cleanups: 1), as does `render(<StrictMode>)`,
 * which this arm uses. The first assertion reads the effect count, not the harness, so it refuses
 * under any form that did not replay.
 *
 * WHAT THIS DOES NOT ASSERT: that the resumed stream reaches the rendered chat. This stub answers
 * 204 with no body, so it cannot; the next arm streams one and pins the delivery half.
 */
describe("under StrictMode, one resume GET reaches the wire (#1063)", () => {
  it("the SDK's two resume requests put exactly one GET on the network", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", recordingFetch(calls));
    let effectRuns = 0;
    function Probe() {
      useEffect(() => {
        effectRuns++;
      }, []);
      useDeepAgentsChat({
        endpoint: "/api/chat",
        sessionId: "session-1",
        enableReconnect: true,
        resumeId: RESUME_ID,
        resumeEndpoint: RESUME,
      });
      return null;
    }
    try {
      render(createElement(StrictMode, null, createElement(Probe)));
      await waitFor(
        () =>
          expect(calls.filter((c) => c.includes(RESUME))).not.toHaveLength(0),
        { timeout: 4000 }
      );
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(
        effectRuns,
        "StrictMode did not replay effects, so this arm is a plain mount and proves nothing about #1063"
      ).toBe(2);
      expect(
        calls.filter((c) => c.includes(RESUME)),
        "the SDK's second resume request reached the network — the duplicate 204 is not being applied"
      ).toHaveLength(1);
    } finally {
      cleanup();
    }
  });
});

/**
 * `recordingFetch`, except that the FIRST resume request to reach the network is answered with a
 * streamed body carrying `word`, in the AI SDK v6 UI-message stream shape. Every later resume
 * request, and every request when `word` is null, gets `recordingFetch`'s 204. Built on top of it
 * rather than beside it, so an aborted request still rejects and is still not recorded.
 */
function recordingFetchWithBody(
  calls: string[],
  word: string | null
): typeof fetch {
  const record = recordingFetch(calls);
  let resumes = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await record(input, init);
    if (word === null || !String(input).includes(RESUME) || ++resumes !== 1)
      return res;
    const frames = [
      { type: "text-start", id: "msg-1" },
      { type: "text-delta", id: "msg-1", delta: word },
      { type: "text-end", id: "msg-1" },
    ];
    return new Response(
      frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(""),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    );
  }) as typeof fetch;
}

/*
 * UNDER STRICTMODE, THE RESUMED STREAM REACHES THE RENDERED CHAT (#1063).
 *
 * The arm above pins the NETWORK half: one resume GET on the wire. This pins the DELIVERY half,
 * which that arm cannot see because its stub answers 204 with no body. The dedup lets the FIRST
 * request through, and that request belongs to the effect run StrictMode then cleans up; the live,
 * remounted instance's request is the one answered 204. So the resumed text reaches the rendered
 * chat only if the SDK's chat state survives the replay. DEV5 measured that it does, on
 * ai@6.0.197 + @ai-sdk/react@3.0.199 + React 19.2.8:
 *
 *     the first resume streams a body   the word renders, 1 GET on the wire   this arm passes
 *     every resume is answered 204      the word never renders                this arm dies, on the word
 *
 * THE GUARD COMES FIRST. A harness that did not replay effects fails on the effect count and never
 * reaches the word, so a failure here says which of the two it was.
 */
describe("under StrictMode, the resumed stream reaches the rendered chat (#1063)", () => {
  it("renders the word the first resume response streamed, with one GET on the wire", async () => {
    const WORD = "resume-tells-truth-9182";
    const calls: string[] = [];
    vi.stubGlobal("fetch", recordingFetchWithBody(calls, WORD));
    let effectRuns = 0;
    function Chat() {
      useEffect(() => {
        effectRuns++;
      }, []);
      const { messages } = useDeepAgentsChat({
        endpoint: "/api/chat",
        sessionId: "session-1",
        enableReconnect: true,
        resumeId: RESUME_ID,
        resumeEndpoint: RESUME,
      });
      // The hook hands back this package's Message union (converter output), not the SDK's
      // UIMessage, so the rendered text is each message's `content`.
      const text = messages
        .map((m) =>
          "content" in m && typeof m.content === "string" ? m.content : ""
        )
        .join("|");
      return createElement("div", { "data-testid": "chat-text" }, text);
    }
    try {
      render(createElement(StrictMode, null, createElement(Chat)));
      expect(
        effectRuns,
        "StrictMode did not replay effects, so this arm is a plain mount and proves nothing about #1063"
      ).toBe(2);
      await waitFor(
        () =>
          expect(
            screen.getByTestId("chat-text").textContent,
            "the resumed stream's text never reached the rendered chat"
          ).toContain(WORD),
        { timeout: 4000 }
      );
      expect(
        calls.filter((c) => c.includes(RESUME)),
        "more than one resume GET reached the network while the body was delivered"
      ).toHaveLength(1);
    } finally {
      cleanup();
    }
  });
});
