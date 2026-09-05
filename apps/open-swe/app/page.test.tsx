// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, within, waitFor } from "@testing-library/react";
import { CONVERSATIONS_KEY } from "../lib/conversations";
import { SETTINGS_KEY } from "../lib/workspace-settings";

/**
 * THE SYSTEM PROMPT THAT ACTUALLY LEAVES THE PAGE.
 *
 * `effectiveSystemPrompt` had ten passing tests and its only call sites were
 * those tests. `Conversation.systemPrompt` was stored, typed, parsed and
 * defended — and no line of the app ever read it. Every unit was green and the
 * feature did not exist.
 *
 * So these assert the BODY the chat hook is called with, which is the one place
 * the wiring is observable. A test of `effectiveSystemPrompt` in isolation
 * cannot fail on this bug, because that function was never the broken part.
 *
 * The hook is mocked rather than the network, because `useDeepAgentsChat` takes
 * the body as a plain option — intercepting fetch would additionally depend on
 * when the hook chooses to send, which is not what is under test here.
 */

const capturedBody: Array<Record<string, unknown>> = [];

vi.mock("@deepagents-nextjs/react", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "@deepagents-nextjs/react"
  );
  return {
    ...actual,
    useDeepAgentsChat: (opts: { body?: Record<string, unknown> }) => {
      if (opts?.body) capturedBody.push(opts.body);
      return {
        messages: [],
        sendMessage: vi.fn(),
        status: "ready",
        error: null,
      };
    },
  };
});

const replace = vi.fn();
let searchParams = new URLSearchParams();

let pathname = "/";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => searchParams,
  // #154 — the page reads usePathname so a framework switch stays on the
  // address the user arrived at. Absent here, the page throws on render.
  usePathname: () => pathname,
}));

import ChatPage from "./page";

/** The body the hook was last constructed with. */
function lastBody() {
  return capturedBody[capturedBody.length - 1] ?? {};
}

function seedConversation(over?: string) {
  window.localStorage.setItem(
    CONVERSATIONS_KEY,
    JSON.stringify([
      {
        id: "conv-1",
        title: "A conversation",
        framework: "deepagents",
        updatedAt: "2026-08-25T12:00:00Z",
        ...(over === undefined ? {} : { systemPrompt: over }),
      },
    ])
  );
}

function seedWorkspace(prompt: string) {
  window.localStorage.setItem(
    SETTINGS_KEY,
    JSON.stringify({ systemPrompt: prompt })
  );
}

// jsdom implements no layout, so `scrollIntoView` does not exist and the
// page's scroll-to-bottom effect throws during mount. Stubbed rather than
// worked around in the component: the effect is correct, the environment is
// the thing that is incomplete.
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  capturedBody.length = 0;
  replace.mockClear();
  window.localStorage.clear();
  searchParams = new URLSearchParams();
});

describe("the system prompt the chat page sends", () => {
  it("sends the workspace prompt when no conversation is selected", () => {
    seedWorkspace("workspace default");
    render(<ChatPage />);
    expect(lastBody().systemPrompt).toBe("workspace default");
  });

  it("sends the CONVERSATION's override when ?c= names one that has it", () => {
    // THE REGRESSION. Before the fix the page never read ?c=, so this returned
    // the workspace prompt and the override reached nothing.
    seedWorkspace("workspace default");
    seedConversation("conversation override");
    searchParams = new URLSearchParams("framework=deepagents&c=conv-1");
    render(<ChatPage />);
    expect(lastBody().systemPrompt).toBe("conversation override");
  });

  it("falls back to the workspace prompt when the conversation has no override", () => {
    // Not the same as "override is empty and therefore the prompt is empty" —
    // absent means defer, and sending "" would silently disable the workspace
    // prompt for every conversation that never set one.
    seedWorkspace("workspace default");
    seedConversation(undefined);
    searchParams = new URLSearchParams("framework=deepagents&c=conv-1");
    render(<ChatPage />);
    expect(lastBody().systemPrompt).toBe("workspace default");
  });

  it("treats a whitespace-only override as not set", () => {
    seedWorkspace("workspace default");
    seedConversation("   \n  ");
    searchParams = new URLSearchParams("framework=deepagents&c=conv-1");
    render(<ChatPage />);
    expect(lastBody().systemPrompt).toBe("workspace default");
  });

  it("falls back when ?c= names a conversation that does not exist", () => {
    // A deleted conversation still linked from an open tab must not strand the
    // surface or send `undefined`.
    seedWorkspace("workspace default");
    seedConversation("conversation override");
    searchParams = new URLSearchParams("framework=deepagents&c=gone");
    render(<ChatPage />);
    expect(lastBody().systemPrompt).toBe("workspace default");
  });

  it("the two prompts differ in the fixtures — the cases are not vacuous", () => {
    // Without this, a page that always sent the workspace prompt would satisfy
    // every case above that expects the workspace prompt, and the one case that
    // expects the override would be the only real assertion in the block.
    seedWorkspace("workspace default");
    seedConversation("conversation override");
    expect("workspace default").not.toBe("conversation override");
  });
});

describe("switching framework does not detach the conversation", () => {
  it("carries ?c= through the replace", () => {
    // THE SECOND BUG. selectFramework rebuilt the URL from the framework alone,
    // so changing framework mid-conversation dropped the conversation id and
    // silently reverted the prompt to the workspace default.
    seedWorkspace("workspace default");
    seedConversation("conversation override");
    searchParams = new URLSearchParams("framework=deepagents&c=conv-1");
    const { container } = render(<ChatPage />);

    const select = container.querySelector<HTMLSelectElement>(
      '[data-testid="framework-select"]'
    );
    expect(
      select,
      "the framework select must exist for this to test anything"
    ).not.toBeNull();
    // #158 — an axis is a <select> now, so the interaction is a change event,
    // not a click. The assertion below is unchanged: what this test is about is
    // the URL selectFramework builds, not how the control is operated.
    fireEvent.change(select!, { target: { value: "langchain" } });

    expect(replace).toHaveBeenCalled();
    const url = String(replace.mock.calls[replace.mock.calls.length - 1][0]);
    expect(url).toContain("framework=langchain");
    expect(url).toContain("c=conv-1");
  });
});

/**
 * #158 — THE SELECTORS ARE ON THE PAGE.
 *
 * ChatSelectors.test.tsx proves the two availability rules. It cannot prove the
 * component is REACHED: a rule with no caller is this repo's most expensive
 * shape — `titleFromMessage` had six passing tests and every History row read
 * "New chat" forever. These assertions are deliberately shallow and are here
 * only to make "the component is wired in" a thing that can fail.
 */
describe("#158 — the chat page renders the three axis selects", () => {
  it("renders a select per axis and no selector buttons", () => {
    searchParams = new URLSearchParams("framework=langchain");
    const { container } = render(<ChatPage />);

    for (const axis of ["framework", "runtime", "topology"]) {
      const el = container.querySelector(`[data-testid="${axis}-select"]`);
      expect(el, `${axis} must render as a select`).not.toBeNull();
      expect(el!.tagName).toBe("SELECT");
    }
    // The eight buttons are gone. Scoped to the group so the composer's Send
    // button — a real button that must survive — is not counted.
    const group = container.querySelector('[data-testid="chat-selectors"]')!;
    expect(within(group as HTMLElement).queryAllByRole("button").length).toBe(
      0
    );
  });

  it("carries the runtime rule end to end: unprobed runtimes are present and disabled", () => {
    // /api/config never resolves in this environment, so `availableBackends`
    // stays all-false — which is exactly the unconfigured case rule 1 governs.
    // A page that filtered its runtime list would render zero options here.
    searchParams = new URLSearchParams("framework=langchain");
    const { container } = render(<ChatPage />);

    const django = container.querySelector<HTMLOptionElement>(
      '[data-testid="runtime-django"]'
    );
    expect(
      django,
      "an unconfigured runtime must still be listed"
    ).not.toBeNull();
    expect(django!.disabled).toBe(true);
    expect(django!.textContent).toContain("DJANGO_URL");
  });

  it("moves the status out of the control group", () => {
    // `idle` is a status, not a fourth axis. It sat inside the same flex row as
    // the eight buttons and read as one of them.
    searchParams = new URLSearchParams("framework=langchain");
    const { container } = render(<ChatPage />);
    const group = container.querySelector('[data-testid="chat-selectors"]')!;
    const status = container.querySelector('[data-testid="chat-status"]')!;
    expect(status).not.toBeNull();
    expect(group.contains(status)).toBe(false);
  });
});

/**
 * #154 — THE ALIAS MUST NOT BE A TRAPDOOR.
 *
 * This surface is served at `/` and, for conversation links already written
 * into browsers' localStorage, at `/chat`. `selectFramework` rebuilds the URL,
 * and building it from a literal `/` makes the switch a ROUTE change for
 * anyone who arrived at `/chat` — Next remounts across routes, so the
 * conversation dies on the first framework switch. That is exactly what
 * selectFramework's own comment promises cannot happen.
 *
 * NOTHING IN THIS FILE COULD FAIL ON IT. The defect shipped to CI and was
 * isolated by the switch-separator e2e suite, which enters at `/chat` and
 * sends a message before switching — the only place in the repo where a
 * conversation exists to be lost. These put the claim where it fails cheaply.
 */
describe("#154 — switching framework stays on the address you arrived at", () => {
  function switchFramework(): string {
    seedConversation();
    const { container } = render(<ChatPage />);
    const select = container.querySelector<HTMLSelectElement>(
      '[data-testid="framework-select"]'
    );
    expect(
      select,
      "the framework select must exist for this to test anything"
    ).not.toBeNull();
    fireEvent.change(select!, { target: { value: "langchain" } });
    const calls = replace.mock.calls;
    expect(
      calls.length,
      "selectFramework did not navigate at all"
    ).toBeGreaterThan(0);
    return String(calls[calls.length - 1][0]);
  }

  it("from /, replaces within /", () => {
    pathname = "/";
    searchParams = new URLSearchParams("framework=deepagents&c=conv-1");
    const url = switchFramework();
    expect(url.startsWith("/?")).toBe(true);
    expect(url).toContain("framework=langchain");
    expect(url).toContain("c=conv-1");
  });

  it("FROM /chat, REPLACES WITHIN /chat — a route change remounts and loses the conversation", () => {
    pathname = "/chat";
    searchParams = new URLSearchParams("framework=deepagents&c=conv-1");
    const url = switchFramework();
    expect(
      url.startsWith("/chat?"),
      "the framework switch navigated away from /chat, which remounts the page " +
        "and discards the conversation — see selectFramework"
    ).toBe(true);
    // Staying put must not cost the payload.
    expect(url).toContain("framework=langchain");
    expect(url).toContain("c=conv-1");
  });
});

/**
 * #360 — THE THREE WAYS THE CONFIG PROBE CAN FAIL, AND WHY THEY MUST NOT MERGE.
 *
 * The parser separates a MISSING runtime from an UNKNOWN one, because two
 * inputs reaching one output is what let three TypeScript rungs ship
 * unreachable. Re-merging every failure at the surface would be the same trade
 * one layer up: all three of these previously left the indicator on
 * "checking…", so a permanent failure rendered as a probe still in flight.
 *
 * Each case asserts the KIND, not merely that something rendered — "a notice
 * appears" is satisfied by a surface that shows the same notice for everything.
 */
describe("#360 — the config probe reports WHICH way it failed", () => {
  function bootWithConfig(body: unknown, ok = true) {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/config")) {
          return ok
            ? Promise.resolve(
                new Response(JSON.stringify(body), { status: 200 })
              )
            : Promise.reject(new Error("network down"));
        }
        return Promise.resolve(new Response("{}", { status: 200 }));
      })
    );
    searchParams = new URLSearchParams("framework=langchain");
    pathname = "/";
    return render(<ChatPage />);
  }

  const notice = (c: HTMLElement) =>
    c.querySelector('[data-testid="config-notice"]');

  it("an UNRESOLVED runtime is reported, and named", async () => {
    const { container } = bootWithConfig({
      runtime: "fastapi",
      runtimeUnresolved: "unknown runtime: flask",
      activeLlm: "nvidia",
    });
    await waitFor(() => expect(notice(container)).not.toBeNull());
    expect(notice(container)!.getAttribute("data-kind")).toBe(
      "runtime-unresolved"
    );
    // The offending value survives to the screen. A notice that cannot name
    // its subject sends the reader looking in the wrong place.
    expect(notice(container)!.textContent).toContain("flask");
  });

  it("an answer ABOUT ANOTHER RUNTIME is reported — it used to return silently", async () => {
    // The bare `return` here left "checking…" on screen forever: a permanent
    // wrong answer wearing the look of one still arriving.
    const { container } = bootWithConfig({
      runtime: "django",
      activeLlm: "nvidia",
    });
    await waitFor(() => expect(notice(container)).not.toBeNull());
    expect(notice(container)!.getAttribute("data-kind")).toBe(
      "answered-about-another-runtime"
    );
  });

  it("a FAILED probe is reported, and is a different kind from the other two", async () => {
    const { container } = bootWithConfig(null, false);
    await waitFor(() => expect(notice(container)).not.toBeNull());
    expect(notice(container)!.getAttribute("data-kind")).toBe("probe-failed");
  });

  it("A HEALTHY ANSWER RENDERS NO NOTICE — the presence companion", async () => {
    /*
     * Without this, every case above is satisfied by a surface that shows a
     * notice unconditionally, which would put a warning on screen for every
     * correct request. "It reports failures" and "it reports" are different
     * claims and only this separates them.
     */
    const { container } = bootWithConfig({
      runtime: "fastapi",
      runtimeUnresolved: null,
      activeLlm: "nvidia",
      backends: { django: true, fastapi: true, node: true },
    });
    await waitFor(() =>
      expect(
        container.querySelector('[data-testid="runtime-select"]')
      ).not.toBeNull()
    );
    expect(notice(container)).toBeNull();
  });

  it("the three kinds are three distinct strings, not one repeated", async () => {
    // Guards the shape of the fix rather than any one branch: if a future
    // edit collapsed two kinds into one label, each case above would still
    // pass on its own.
    const kinds = new Set<string>();
    for (const [body, ok] of [
      [
        { runtime: "fastapi", runtimeUnresolved: "unknown runtime: flask" },
        true,
      ],
      [{ runtime: "django" }, true],
      [null, false],
    ] as const) {
      const { container, unmount } = bootWithConfig(body, ok);
      await waitFor(() => expect(notice(container)).not.toBeNull());
      kinds.add(notice(container)!.getAttribute("data-kind")!);
      unmount();
    }
    expect(kinds.size).toBe(3);
  });
});
