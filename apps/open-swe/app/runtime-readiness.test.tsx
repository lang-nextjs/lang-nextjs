// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  act,
  fireEvent,
} from "@testing-library/react";

/**
 * THE READINESS INDICATOR MUST REPORT ON THE RUNTIME THE USER SELECTED (#333).
 *
 * django and fastapi are an axis of this surface — a toolbar toggle, not a deployment
 * constant. The readiness probe was `fetch("/api/config")` in an effect with `[]` deps, so
 * it asked once, about whichever runtime the route happened to name, and never asked again.
 * Switch to django and the dot kept reporting fastapi's model.
 *
 * TWO INDEPENDENT DEFECTS PRODUCED THE ONE WRONG VERDICT, and fixing either alone leaves it:
 *
 *   server   /api/config probed FASTAPI_URL unconditionally     (config/route.test.ts)
 *   client   the probe never re-ran when the runtime changed    (here)
 *
 * A route that honours `?runtime=` is inert if nobody ever asks it a second question, which
 * is why this file exists next to the route's own tests rather than inside them.
 *
 * WHY THIS ASSERTS THE REQUESTED URL. Asserting the rendered dot would pass whenever the two
 * runtimes happen to agree — and in the common local setup they do, because one .env
 * configures both. The observable that distinguishes "asked about django" from "still showing
 * fastapi's answer" is where the request went.
 */

vi.mock("@deepagents-nextjs/react", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "@deepagents-nextjs/react"
  );
  return {
    ...actual,
    useDeepAgentsChat: () => ({
      messages: [],
      sendMessage: vi.fn(),
      status: "ready",
      error: null,
    }),
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams("framework=deepagents"),
  // #154 — the page reads usePathname so a framework switch stays on the
  // address the user arrived at. Absent here, the page throws on render.
  usePathname: () => "/",
}));

import ChatPage from "./page";

/** Every /api/config URL the page asked for, in order. */
let configCalls: string[] = [];

function stubFetch() {
  configCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/config")) {
        configCalls.push(url);
        const runtime =
          new URLSearchParams(url.split("?")[1] ?? "").get("runtime") ??
          "fastapi";
        return new Response(
          JSON.stringify({
            runtime,
            backends: { django: true, fastapi: true },
            llm: {},
            // django has a key, fastapi does not — so the two runtimes give
            // DIFFERENT answers and a stale one is detectable.
            activeLlm: runtime === "django" ? "anthropic" : null,
            llmSource: "backend",
            observability: {},
            observabilitySource: "backend",
          }),
          { status: 200 }
        );
      }
      if (url.startsWith("/api/chat/tools")) {
        return new Response(JSON.stringify({ tools: [] }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    })
  );
}

/**
 * Drive the runtime axis the way a person does.
 *
 * #327 turned the three axes into native `<select>`s, so clicking the `<option>` does
 * nothing — a native select changes on the SELECT, not on its children. An earlier version of
 * this file clicked `runtime-django` and passed until that landed, which is the ordinary way a
 * UI test quietly stops exercising the control it names.
 */
async function selectRuntime(rt: "django" | "fastapi") {
  const select = await screen.findByTestId("runtime-select");
  await act(async () => {
    fireEvent.change(select, { target: { value: rt } });
  });
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  window.localStorage.clear();
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the readiness probe follows the selected runtime (#333)", () => {
  it("names the runtime on the very first probe", async () => {
    render(<ChatPage />);
    await waitFor(() => expect(configCalls.length).toBeGreaterThan(0));
    // An unqualified /api/config is the defect in its original form: the client
    // asking a question that cannot name its subject.
    expect(configCalls[0]).toContain("runtime=fastapi");
  });

  it("re-probes, naming django, when the user switches runtime", async () => {
    render(<ChatPage />);
    await waitFor(() => expect(configCalls.length).toBeGreaterThan(0));
    const before = configCalls.length;

    await selectRuntime("django");

    await waitFor(() => expect(configCalls.length).toBeGreaterThan(before));
    expect(configCalls[configCalls.length - 1]).toContain("runtime=django");
  });

  it("ignores a payload that answers about a runtime nobody selected", async () => {
    /*
     * THE GUARD THAT MAKES THE NEW `runtime` FIELD LOAD-BEARING.
     *
     * The effect's `cancelled` flag already covers the ordinary switch. This covers what it
     * cannot see: a response that is not about the runtime that was asked for — a proxy or
     * cache serving a stale payload, or a caller passing the parameter wrong.
     *
     * Without a case, `if (c.runtime && c.runtime !== pythonBackend) return;` is a line
     * nothing exercises, and this repo has a name for a field that is returned and never
     * consumed: `llmSource` sat unread in this very payload while a stopped backend was
     * reported to users as a missing API key.
     */
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/api/config")) {
          configCalls.push(url);
          // Asked about fastapi; answers about django, and claims a model.
          return new Response(
            JSON.stringify({
              runtime: "django",
              backends: { django: true, fastapi: true },
              llm: {},
              activeLlm: "anthropic",
              llmSource: "backend",
            }),
            { status: 200 }
          );
        }
        return new Response("{}", { status: 200 });
      })
    );

    render(<ChatPage />);
    await waitFor(() => expect(configCalls.length).toBeGreaterThan(0));
    expect(configCalls[0]).toContain("runtime=fastapi");

    // The answer is discarded, so the surface stays "checking" rather than
    // adopting a verdict about a runtime the user is not on.
    await waitFor(() => {
      expect(
        screen.getByTestId("chat-status").getAttribute("data-readiness")
      ).toBe("unknown");
    });
  });

  it("ACCEPTS a payload with no runtime field at all — absent is not wrong", async () => {
    /*
     * ABSENT AND MISMATCHED ARE DIFFERENT FACTS, AND ONLY ONE IS A DEFECT.
     *
     * `runtime` is new. Every mock, fixture and older deployment predates it, and a payload
     * that does not name a runtime is not claiming the wrong one — it is an answer from
     * something that was never asked. Dropping it would make this guard reject every producer
     * that has not caught up, which is a bigger outage than the defect it was added for.
     *
     * This is the pair to the case below: one says an unlabelled answer is USED, the other
     * says a wrongly-labelled answer is DROPPED. Either alone is satisfiable by a guard that
     * does nothing — the first by removing the check entirely, the second by rejecting
     * everything — so both are needed to pin the behaviour between them.
     */
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/api/config")) {
          configCalls.push(url);
          return new Response(
            JSON.stringify({
              // no `runtime` key at all — the shape every existing fixture has
              backends: { django: true, fastapi: true },
              llm: {},
              activeLlm: "anthropic",
              llmSource: "backend",
            }),
            { status: 200 }
          );
        }
        return new Response("{}", { status: 200 });
      })
    );

    render(<ChatPage />);
    await waitFor(() => expect(configCalls.length).toBeGreaterThan(0));

    // The answer is USED: readiness leaves "checking" and settles on the verdict it carried.
    await waitFor(() => {
      expect(
        screen.getByTestId("chat-status").getAttribute("data-readiness")
      ).not.toBe("unknown");
    });
  });

  it("does not leave the previous runtime's verdict on screen mid-switch", async () => {
    // The harm is not only asking the wrong question, it is CONTINUING TO ANSWER
    // the old one. While the new probe is in flight the indicator must say it is
    // checking; a green held over from the runtime the user just left is the exact
    // false confidence readiness.ts exists to prevent.
    // Declared with a no-op initializer rather than `| null`: TS narrows a
    // variable only ever assigned inside a Promise executor to `never`, and the
    // call below then fails to compile.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const realFetch = globalThis.fetch;
    let gated = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("runtime=django") && !gated) {
          gated = true;
          await gate;
        }
        return realFetch(input as RequestInfo);
      })
    );

    render(<ChatPage />);
    await waitFor(() => expect(configCalls.length).toBeGreaterThan(0));

    await selectRuntime("django");

    // The fastapi answer said activeLlm: null -> "blocked"/"no model". django's
    // will say anthropic. In between, neither is known.
    await waitFor(() => {
      const indicator = screen.getByTestId("chat-status");
      expect(indicator.getAttribute("data-readiness")).toBe("unknown");
    });
    release();
  });
});
