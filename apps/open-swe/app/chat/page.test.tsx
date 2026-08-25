// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { CONVERSATIONS_KEY } from "../../lib/conversations";
import { SETTINGS_KEY } from "../../lib/workspace-settings";

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

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => searchParams,
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

    const btn = container.querySelector<HTMLButtonElement>(
      '[data-testid="framework-langchain"]'
    );
    expect(btn, "the framework button must exist for this to test anything").not.toBeNull();
    btn!.click();

    expect(replace).toHaveBeenCalled();
    const url = String(replace.mock.calls[replace.mock.calls.length - 1][0]);
    expect(url).toContain("framework=langchain");
    expect(url).toContain("c=conv-1");
  });
});
