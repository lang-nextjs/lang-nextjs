// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * EVERY REGISTERED PART TYPE MUST PUT SOMETHING ON THE SCREEN.
 *
 * WHY THIS IS NOT ALREADY COVERED BY schema-dispatch-parity.test.ts. That file asks whether
 * each registered key has a DISPATCH, and it answers by pattern-matching source text:
 *
 *   dispatchedTypes()  /msg\.type === "(data-[a-z-]+)"/   a comparison exists
 *   packTypes()        /"(data-[a-z-]+)":\s*\(/            a key mapped to an arrow fn exists
 *
 * Both assert the PRESENCE OF A REFERENCE, not the PRODUCTION OF OUTPUT. State the property
 * — "a part that arrives is shown to the person" — and ask what would have to be true for
 * those checks to pass while it is violated. The answer is one line:
 *
 *   "data-todo": () => null,          in a rung card pack
 *   if (msg.type === "data-todo") return null;   in page.tsx
 *
 * Both still match. The part is parsed, the branch fires, and nothing reaches the DOM — the
 * same blank screen as a part that never arrived, which is the failure this whole family of
 * tests exists to make impossible. The pack form is the more likely of the two: a pack entry
 * is a one-liner, so stubbing one is an ordinary edit rather than an act of vandalism.
 *
 * WHY A RENDER TEST RATHER THAN A SMARTER PARSE. There are now two dispatch mechanisms —
 * inline branches in page.tsx and `lib/rungs/cards/*.tsx` packs — so a source parse would
 * need two grammars and would still be a proxy in both, because neither grammar can say
 * whether the component it names returns anything. Mounting the surface does not care which
 * mechanism rendered a part, and it covers pack entries added later without being taught
 * about them.
 *
 * WHAT THIS DOES NOT CLAIM. It does not check that the card is CORRECT, only that the type
 * produces identifiable output carrying its own payload. Schema validation is bypassed here
 * — the hook is mocked, so parts go straight to the render dispatch — which is deliberate:
 * the subject is the render path, and `partsToMessages` dropping an unregistered part is
 * already #476's subject.
 */

const messages: Array<Record<string, unknown>> = [];

vi.mock("@deepagents-nextjs/react", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "@deepagents-nextjs/react"
  );
  // Only the chat hook is replaced. useApprovalPauseController and the cards stay REAL,
  // because a mocked renderer would render whatever the mock says and this file would be
  // asserting its own fixture back to itself.
  return {
    ...actual,
    useDeepAgentsChat: () => ({
      messages,
      sendMessage: vi.fn(),
      status: "ready",
      error: null,
    }),
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));

import ChatPage from "./page";

/**
 * The keys of the `schemas: { … }` literal, read the same way the sibling parity test reads
 * them. Used ONLY to decide which fixtures must exist — never as the assertion itself, which
 * is the distinction this file is about.
 */
function registeredKeys(): string[] {
  const source = readFileSync(join(__dirname, "page.tsx"), "utf-8");
  const start = source.indexOf("schemas: {");
  if (start === -1) return [];
  /*
   * INDENTATION-AGNOSTIC, and copied in that form on purpose. The sibling reader was
   * `indexOf("\n    },")` — four spaces exactly — until #420, when adding a key made
   * prettier re-indent the literal to six, the reader found no end and returned nothing.
   * Writing a fresh hardcoded marker here would have reintroduced a defect this repo has
   * already paid for once.
   */
  const end = source.slice(start).search(/\n\s*},/);
  if (end === -1) return [];
  return [...source.slice(start, start + end).matchAll(/"(data-[a-z-]+)":/g)]
    .map((m) => m[1])
    .sort();
}

/**
 * One fixture per registered type: a part to feed in, and what must appear because of it.
 *
 * `testid` is the card's ROOT, which is how coverage is counted in this repo — a spec that
 * names a type somewhere without asserting its root testid has not covered it. `contains` is
 * the payload's OWN content, so a card rendering an empty shell fails even though its root
 * is present.
 */
type Fixture = {
  data: unknown;
  /** Root testid the type must produce. */
  testid: string;
  /** A testid whose text must carry the payload's own content. */
  contentTestid?: string;
  /** Substring of that content, taken from the fixture above. */
  contains?: string;
  /** Set when the type deliberately does NOT pass its payload through — see data-error. */
  whyNoContent?: string;
};

const FIXTURES: Record<string, Fixture> = {
  "data-plan": {
    data: {
      id: "p1",
      seq: 0,
      title: "Close the render gap",
      markdown: "# plan",
      // PlanCard maps plan.subtasks unconditionally, so an empty array is required rather
      // than optional: the schema is bypassed here (the hook is mocked) and a fixture that
      // omits it crashes the card instead of being rejected. Caught on the first run.
      subtasks: [{ id: "st1", label: "first subtask", status: "pending" }],
      updatedAt: "2026-08-31T00:00:00.000Z",
    },
    testid: "plan-card",
    contentTestid: "plan-title",
    contains: "Close the render gap",
  },
  "data-task": {
    data: {
      id: "t1",
      seq: 0,
      taskName: "Wire the fixture map",
      groupLabel: "g",
      status: "running",
    },
    testid: "task-card",
    contentTestid: "task-name",
    contains: "Wire the fixture map",
  },
  "data-file": {
    data: {
      id: "f1",
      seq: 0,
      name: "parity-fixture.ts",
      path: "/tmp/parity-fixture.ts",
      size: 12,
    },
    testid: "file-card",
    contentTestid: "file-name",
    contains: "parity-fixture.ts",
  },
  "data-sub-agent": {
    data: {
      id: "s1",
      seq: 0,
      parentToolCallId: "tc1",
      name: "researcher-fixture",
      status: "running",
      prompt: "p",
      startedAt: "2026-08-31T00:00:00.000Z",
    },
    testid: "sub-agent-card",
    contentTestid: "sub-agent-name",
    contains: "researcher-fixture",
  },
  "data-todo": {
    data: {
      id: "td1",
      seq: 0,
      items: [
        { id: "i1", text: "first fixture item", status: "pending" },
        { id: "i2", text: "second fixture item", status: "pending" },
      ],
    },
    testid: "todo-card",
    contentTestid: "todo-count",
    contains: "2 items",
  },
  "data-human-response": {
    data: {
      id: "hr1",
      seq: 0,
      response: "the fixture's own reply text",
      createdAt: "2026-08-31T00:00:00.000Z",
    },
    testid: "human-response-card",
    contentTestid: "human-response-text",
    contains: "the fixture's own reply text",
  },
  "data-agents-md": {
    data: {
      id: "amd1",
      seq: 0,
      path: "FIXTURE-AGENTS.md",
      content: "# fixture",
    },
    testid: "agents-md-card",
    contentTestid: "agents-md-path",
    contains: "FIXTURE-AGENTS.md",
  },
  "data-approval": {
    data: {
      id: "a1",
      seq: 0,
      actionName: "fixture_action_approval",
      status: "waiting",
      description: "d",
      arguments: {},
    },
    testid: "approval-card",
    contentTestid: "approval-action-name",
    contains: "fixture_action_approval",
  },
  "data-approval-required": {
    data: {
      id: "a2",
      seq: 0,
      actionName: "fixture_action_required",
      status: "waiting",
      description: "d",
      arguments: {},
    },
    testid: "approval-card",
    contentTestid: "approval-action-name",
    contains: "fixture_action_required",
  },
  "data-approval-pause": {
    data: {
      interrupt: {
        action_requests: [
          {
            name: "fixture_paused_tool",
            args: { by: 1 },
            description: "Tool execution requires approval",
          },
        ],
        review_configs: [
          {
            action_name: "fixture_paused_tool",
            allowed_decisions: ["approve", "reject"],
          },
        ],
      },
    },
    testid: "approval-pause-group",
    contentTestid: "pause-action-name",
    contains: "fixture_paused_tool",
  },
  "data-error": {
    data: { message: "raw upstream detail", code: "not_a_mapped_code" },
    testid: "chat-error",
    /*
     * THE ONE TYPE THAT MUST NOT PASS ITS PAYLOAD THROUGH, and it is a contract rather than
     * an exemption. #262 removed the raw message from the DOM deliberately — it used to show
     * a person a sentence about buffer management where they expected to be told what went
     * wrong — so the branch renders mapped copy and sends the detail to the console. Asserting
     * `contains: "raw upstream detail"` here would demand back the exact defect #262 removed.
     *
     * So this type asserts OUTPUT rather than passthrough, which is still the property under
     * test: `return null` fails it. The absence half is checked separately below, with the
     * presence of the card as its companion.
     */
    whyNoContent:
      "#262: the raw message is deliberately withheld from the DOM; mapped copy is shown instead",
  },
};

beforeEach(() => {
  messages.length = 0;
  window.localStorage.clear();
  // jsdom implements no layout, so scrollIntoView does not exist and the page calls it in an
  // effect on every message change. Without this every case below fails for a HARNESS reason
  // that reads exactly like "the card is missing" — see agents-md.test.tsx, where that cost a
  // confident wrong verdict once already.
  Element.prototype.scrollIntoView = vi.fn();
});

describe("chat page: every registered part type produces output", () => {
  /*
   * THE FIXTURE MAP CANNOT GO STALE, WHICH IS THE WHOLE REASON IT IS ASSERTED RATHER THAN
   * MERELY USED. A render test covering a hand-picked list is green on exactly the key
   * somebody forgot to add — the same shape as instrumenting the one test that was already
   * quarantined. So a newly registered key with no fixture FAILS here, and a fixture for a
   * key that is no longer registered fails too, because a fixture nothing exercises is the
   * next stale record.
   */
  it("every registered schema key has a fixture, and every fixture a registered key", () => {
    const registered = registeredKeys();
    /*
     * The floor, because registeredKeys() is a regex over source: if `schemas:` is renamed or
     * reformatted it returns [], an empty list matches an empty list, and this case would go
     * green over nothing — the exact vacuity the sibling file guards against, arriving here
     * through the reader added to avoid it.
     */
    expect(
      registered.length,
      "schema-map reader matched nothing — the regex has drifted from page.tsx"
    ).toBeGreaterThanOrEqual(9);

    const fixtures = Object.keys(FIXTURES).sort();
    expect(
      registered.filter((k) => !fixtures.includes(k)),
      "registered with no render fixture — add one to FIXTURES so the type is proven to render"
    ).toEqual([]);
    expect(
      fixtures.filter((k) => !registered.includes(k)),
      "fixture for a key that is no longer registered — delete it"
    ).toEqual([]);
  });

  /*
   * ONE CASE PER TYPE, NAMED, so a failure says which part vanished rather than reporting a
   * count. Each renders the surface with exactly one part of that type and asserts the card's
   * root testid is in the document — the measure this repo counts coverage by — and, where
   * the card passes payload through, that the fixture's OWN content reached the DOM. A card
   * rendering an empty shell satisfies the first and fails the second.
   */
  for (const [type, fx] of Object.entries(FIXTURES)) {
    it(`${type} puts its card on the screen`, () => {
      messages.push({ type, id: `m-${type}`, data: fx.data });
      render(<ChatPage />);

      expect(
        screen.queryByTestId(fx.testid),
        `${type} produced no ${fx.testid} — the part was dispatched and rendered nothing`
      ).not.toBeNull();

      if (fx.contentTestid && fx.contains) {
        expect(
          screen.getByTestId(fx.contentTestid).textContent,
          `${type} rendered a shell: its own payload content did not reach the DOM`
        ).toContain(fx.contains);
      } else {
        expect(
          fx.whyNoContent,
          `${type} has no content assertion and no stated reason — say why, or add one`
        ).toBeTruthy();
        expect(
          screen.getByTestId(fx.testid).textContent?.trim(),
          `${type} rendered an EMPTY ${fx.testid} — present but carrying nothing`
        ).toBeTruthy();
      }
    });
  }

  /*
   * THE COMPANION FOR THE ABSENCE. Every case above is a presence assertion, so a page that
   * rendered every card unconditionally would pass all of them. This feeds ONE type and
   * asserts the OTHERS are absent — which is only meaningful because the positive cases prove
   * those cards can appear at all.
   */
  it("a type that did not arrive renders nothing", () => {
    messages.push({
      type: "data-todo",
      id: "m1",
      data: FIXTURES["data-todo"]!.data,
    });
    render(<ChatPage />);

    expect(screen.queryByTestId("todo-card")).not.toBeNull();
    for (const other of ["plan-card", "task-card", "file-card", "agents-md-card"]) {
      expect(
        screen.queryByTestId(other),
        `${other} rendered for a message that was not its type`
      ).toBeNull();
    }
  });

  /*
   * #262's contract, asserted where its companion is. The raw detail must NOT be in the DOM,
   * and "not in the DOM" is satisfied by a page that rendered nothing at all — so this only
   * means something next to the presence of chat-error, which the loop above establishes.
   */
  it("data-error shows mapped copy and keeps the raw detail out of the DOM (#262)", () => {
    messages.push({
      type: "data-error",
      id: "m1",
      data: FIXTURES["data-error"]!.data,
    });
    render(<ChatPage />);

    const box = screen.getByTestId("chat-error");
    expect(box.textContent?.trim(), "chat-error rendered empty").toBeTruthy();
    expect(document.body.textContent).not.toContain("raw upstream detail");
  });
});
