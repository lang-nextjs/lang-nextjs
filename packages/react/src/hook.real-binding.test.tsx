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
 * STRICTMODE IS NOT DRIVEN HERE, AND THE REASON IS A FINDING RATHER THAN A CHOICE. `next dev`
 * runs StrictMode, so it is the environment that shipped, and an arm for it was written first.
 * It fails on `ai@6.0.197` — the version this package installs today — and it fails for a
 * reason worth recording rather than working around. Instrumented, the only request that
 * reaches `fetch` under StrictMode arrives ALREADY ABORTED:
 *
 *     plain mount    [ live RESUME ]      one GET delivered
 *     StrictMode     [ ABORTED RESUME ]   a real fetch rejects; nothing reaches the wire
 *
 * That is #986's symptom on a version #986 says is unaffected. It is not established whether
 * that is a genuine dev-mode defect — the E2E runs a production build, where StrictMode is off,
 * which would explain why nothing has caught it — or an artifact of driving the hook without the
 * surrounding app. Asserting it either way would be asserting an unresolved question, so this
 * file drives the plain mount and the observation is filed instead.
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
 * WHAT THIS FILE IS NOT. It is not a duplicate-suppression test — that policy, and the
 * measurements behind it, live in `resume-fetch.test.ts`. This asserts one thing: that the
 * request the surface exists to make actually leaves it.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

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
