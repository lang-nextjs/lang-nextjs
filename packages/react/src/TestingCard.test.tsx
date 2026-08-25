/**
 * TestingCard — rung-5-owned (software-developer-agent).
 *
 * The two properties that matter are not "does it render":
 *
 *   1. NO TWO STATUSES RENDER IDENTICALLY. `data-testing` exists only because
 *      `data-todo` cannot express "the tests FAILED" versus "testing was SKIPPED".
 *      If the card collapses them, the part was paid for and the loss was kept.
 *      Asserted pairwise over all seven, not spot-checked.
 *
 *   2. NO STATUS RENDERS AN EMPTY CARD, including "unknown" — a value sdaEnrich.ts
 *      genuinely emits when a model sends something outside the tool's enum.
 *
 * Driven from TESTING_STATUSES, the exported source of truth, so adding a status to
 * the schema without teaching the card about it fails here rather than shipping a
 * blank card.
 */

import { describe, it, expect } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { TestingCard } from "./TestingCard";
import { TESTING_STATUSES, TestingSchema } from "./schemas";

afterEach(cleanup);

function statusPart(status: string) {
  return {
    id: "run-1--set_testing_status-0",
    seq: 0,
    kind: "status" as const,
    status,
    reason: "because the suite is red",
    updatedAt: "2026-08-25T09:00:00.000Z",
  };
}

const runPart = {
  id: "run-1--playwright-0",
  seq: 1,
  kind: "run" as const,
  command: "run_test_file",
  testFile: "e2e/login.spec.ts",
  browser: "chromium",
  headless: false,
  status: "in_progress",
  updatedAt: "2026-08-25T09:00:00.000Z",
};

describe("TestingCard — every status the producer can emit", () => {
  it("renders a non-empty card for EVERY status, including unknown", () => {
    for (const status of TESTING_STATUSES) {
      cleanup();
      // Guard: the fixture must be something the schema actually accepts, or this
      // would be testing the card against a payload the converter would have
      // dropped before it ever reached a component.
      expect(TestingSchema.safeParse(statusPart(status)).success, status).toBe(
        true
      );

      render(<TestingCard testing={statusPart(status) as never} />);
      const card = screen.getByTestId("testing-card");
      expect(card, status).toBeTruthy();

      const label =
        screen.getByTestId("testing-status-label").textContent ?? "";
      expect(
        label.trim().length,
        `status ${status} rendered an empty label`
      ).toBeGreaterThan(0);
      // The raw status is on the element too, so a consumer can style or query it
      // without parsing the human label.
      expect(card.getAttribute("data-testing-status")).toBe(status);
    }
  });

  it("renders all seven statuses PAIRWISE DISTINCTLY — the whole reason this part exists", () => {
    const seen = new Map<string, string>();
    for (const status of TESTING_STATUSES) {
      cleanup();
      render(<TestingCard testing={statusPart(status) as never} />);
      const label = (
        screen.getByTestId("testing-status-label").textContent ?? ""
      ).trim();
      const prior = seen.get(label);
      expect(
        prior,
        `"${status}" renders the same visible label ("${label}") as "${prior}" — ` +
          "data-testing exists precisely to keep these distinguishable"
      ).toBeUndefined();
      seen.set(label, status);
    }
    expect(seen.size).toBe(TESTING_STATUSES.length);
  });

  it("keeps failed and skipped distinct in icon AND accessible name, not just the label", () => {
    // The specific collapse named in the ruling. Checked on all three channels a
    // user might rely on, because a card that distinguishes them only in a
    // colour-coded tone attribute fails anyone not seeing colour.
    cleanup();
    render(<TestingCard testing={statusPart("failed") as never} />);
    const failed = {
      label: screen.getByTestId("testing-status-label").textContent,
      icon: screen.getByTestId("testing-icon").textContent,
      aria: screen.getByTestId("testing-card").getAttribute("aria-label"),
    };
    cleanup();
    render(<TestingCard testing={statusPart("skipped") as never} />);
    const skipped = {
      label: screen.getByTestId("testing-status-label").textContent,
      icon: screen.getByTestId("testing-icon").textContent,
      aria: screen.getByTestId("testing-card").getAttribute("aria-label"),
    };

    expect(failed.label).not.toBe(skipped.label);
    expect(failed.icon).not.toBe(skipped.icon);
    expect(failed.aria).not.toBe(skipped.aria);
  });

  it("does not rely on tone alone — two statuses may share a tone but never a label", () => {
    // failed and unknown are both `danger`. That is fine; it must not make them
    // indistinguishable.
    cleanup();
    render(<TestingCard testing={statusPart("failed") as never} />);
    const a = {
      tone: screen
        .getByTestId("testing-card")
        .getAttribute("data-testing-tone"),
      label: screen.getByTestId("testing-status-label").textContent,
    };
    cleanup();
    render(<TestingCard testing={statusPart("unknown") as never} />);
    const b = {
      tone: screen
        .getByTestId("testing-card")
        .getAttribute("data-testing-tone"),
      label: screen.getByTestId("testing-status-label").textContent,
    };
    expect(a.tone).toBe(b.tone); // same severity
    expect(a.label).not.toBe(b.label); // different identity
  });

  it('renders "unknown" as a named state, not as a blank or a fallback to not_started', () => {
    cleanup();
    render(<TestingCard testing={statusPart("unknown") as never} />);
    const label = screen.getByTestId("testing-status-label").textContent ?? "";
    expect(label.trim()).not.toBe("");
    expect(label).not.toBe("Not started");
  });

  it("renders a readable label for a status the map has not caught up with", () => {
    // Not schema-valid, so it cannot arrive through the converter today — but a card
    // that renders blank for an unmapped value is a latent version of the bug this
    // file guards. The raw value must reach the DOM.
    cleanup();
    render(<TestingCard testing={statusPart("brand_new_state") as never} />);
    expect(screen.getByTestId("testing-status-label").textContent).toContain(
      "brand_new_state"
    );
  });

  it("SCHEMA/UI DRIFT is visibly distinct from the contract's own `unknown`", () => {
    // Raised by ARCHITECT [34d4ad]: two different situations were landing in the
    // same visual state.
    //   "unknown"        -> the producer told us it met a status it did not
    //                       recognise. Expected; part of the contract.
    //   "brand_new_state"-> the SCHEMA accepted a status this CARD never learned.
    //                       That is drift, and it is our bug, not the agent's.
    // If these render identically the drift is invisible again — the fail-open seam
    // reappearing inside the component built to close it.
    cleanup();
    render(<TestingCard testing={statusPart("unknown") as never} />);
    const known = {
      label: screen.getByTestId("testing-status-label").textContent,
      icon: screen.getByTestId("testing-icon").textContent,
      tone: screen
        .getByTestId("testing-card")
        .getAttribute("data-testing-tone"),
      drift: screen
        .getByTestId("testing-card")
        .getAttribute("data-testing-drift"),
    };
    cleanup();
    render(<TestingCard testing={statusPart("brand_new_state") as never} />);
    const drifted = {
      label: screen.getByTestId("testing-status-label").textContent,
      icon: screen.getByTestId("testing-icon").textContent,
      tone: screen
        .getByTestId("testing-card")
        .getAttribute("data-testing-tone"),
      drift: screen
        .getByTestId("testing-card")
        .getAttribute("data-testing-drift"),
    };

    expect(drifted.label).not.toBe(known.label);
    expect(drifted.icon).not.toBe(known.icon);
    expect(drifted.tone).not.toBe(known.tone);
    expect(known.drift).toBeNull();
    expect(drifted.drift).toBe("true");
  });

  it("drift does not borrow `failed`'s tone — a UI bug must not look like a red suite", () => {
    cleanup();
    render(<TestingCard testing={statusPart("failed") as never} />);
    const failedTone = screen
      .getByTestId("testing-card")
      .getAttribute("data-testing-tone");
    cleanup();
    render(<TestingCard testing={statusPart("brand_new_state") as never} />);
    const driftTone = screen
      .getByTestId("testing-card")
      .getAttribute("data-testing-tone");
    expect(driftTone).not.toBe(failedTone);
  });

  it("no status in the schema's own list is treated as drift", () => {
    // The inverse guard: if someone adds a status to TESTING_STATUSES and forgets
    // the card, this fails here rather than shipping a permanent drift warning.
    for (const status of TESTING_STATUSES) {
      cleanup();
      render(<TestingCard testing={statusPart(status) as never} />);
      expect(
        screen.getByTestId("testing-card").getAttribute("data-testing-drift"),
        `"${status}" is in TESTING_STATUSES but the card does not know it`
      ).toBeNull();
    }
  });
});

describe("TestingCard — kind discrimination", () => {
  it("renders run detail for kind=run and no run detail for kind=status", () => {
    cleanup();
    render(<TestingCard testing={runPart as never} />);
    expect(screen.getByTestId("testing-heading").textContent).toBe("Test run");
    expect(screen.getByTestId("testing-run-command").textContent).toBe(
      "run_test_file"
    );
    expect(screen.getByTestId("testing-run-file").textContent).toBe(
      "e2e/login.spec.ts"
    );
    expect(screen.getByTestId("testing-run-mode").textContent).toBe("Headed");

    cleanup();
    render(<TestingCard testing={statusPart("completed") as never} />);
    expect(screen.getByTestId("testing-heading").textContent).toBe(
      "Testing status"
    );
    expect(screen.queryByTestId("testing-run-detail")).toBeNull();
  });

  it("renders stand-ins rather than blanks for nullable run fields", () => {
    cleanup();
    render(
      <TestingCard
        testing={{ ...runPart, testFile: null, browser: null } as never}
      />
    );
    expect(screen.getByTestId("testing-run-file").textContent?.trim()).not.toBe(
      ""
    );
    expect(
      screen.getByTestId("testing-run-browser").textContent?.trim()
    ).not.toBe("");
  });

  it("renders a stand-in when reason is empty rather than an empty element", () => {
    cleanup();
    render(
      <TestingCard
        testing={{ ...statusPart("skipped"), reason: "" } as never}
      />
    );
    expect(screen.getByTestId("testing-reason").textContent?.trim()).not.toBe(
      ""
    );
  });
});
