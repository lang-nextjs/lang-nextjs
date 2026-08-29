// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { ChatSelectors } from "./ChatSelectors";
import {
  FRAMEWORKS,
  PYTHON_BACKENDS,
  ALL_TOPOLOGIES,
  topologiesFor,
} from "../lib/frameworks";

/**
 * #158 — THE TWO OPPOSITE AVAILABILITY RULES.
 *
 *     DISABLE WHAT THE USER CAN OBTAIN.  HIDE WHAT THEY CANNOT.
 *
 * These tests exist to make the rules FALSIFIABLE, not to describe them. Each
 * one is mutation-verified: the rule it names was inverted in ChatSelectors and
 * the test observed failing before being restored. The decisive check is the
 * SWAP — inverting both rules at once must fail BOTH tests. A pair of tests
 * that survives the swap is testing that a control exists, not that the right
 * rule governs it.
 *
 * The mode test asserts a COUNT rather than only that a click fails, because
 * "greyed out" and "absent" are both un-clickable. Only the count separates
 * them, and greying is the regression the rule forbids.
 */

/** Rendered with sane defaults; every test overrides only what it is about. */
function renderSelectors(over: Partial<Parameters<typeof ChatSelectors>[0]> = {}) {
  const props = {
    frameworks: FRAMEWORKS,
    framework: FRAMEWORKS[0].id,
    onFramework: vi.fn(),
    runtimes: PYTHON_BACKENDS,
    runtime: "fastapi" as const,
    availableRuntimes: { django: true, fastapi: true },
    onRuntime: vi.fn(),
    modes: topologiesFor(FRAMEWORKS[0].id, "fastapi"),
    mode: "react",
    onMode: vi.fn(),
    ...over,
  };
  render(<ChatSelectors {...props} />);
  return props;
}

const opt = (id: string) => screen.queryByTestId(id) as HTMLOptionElement | null;

/**
 * The options inside one axis, by ROLE and scoped to that select.
 *
 * Deliberately not `getAllByTestId(/^runtime-/)`: that prefix also matches the
 * select's own `runtime-select`, so every count came back one too high. An
 * unbounded prefix answers a wider question than the one being asked, and it
 * only failed here because the off-by-one happened to be visible.
 */
const optionsOf = (axis: "framework" | "runtime" | "topology") =>
  within(screen.getByTestId(`${axis}-select`)).getAllByRole(
    "option"
  ) as HTMLOptionElement[];

describe("ChatSelectors — RULE 1: an unconfigured runtime is DISABLED, not hidden", () => {
  it("lists a runtime with no URL in this deployment rather than dropping it", () => {
    renderSelectors({ availableRuntimes: { django: false, fastapi: true } });

    // PRESENT. The regression this forbids is a <select> built from "available
    // options", which removes the row and the remedy written on it together.
    expect(opt("runtime-django")).not.toBeNull();
    expect(optionsOf("runtime").length).toBe(PYTHON_BACKENDS.length);
  });

  it("disables it, so it cannot be selected", () => {
    renderSelectors({ availableRuntimes: { django: false, fastapi: true } });
    expect(opt("runtime-django")!.disabled).toBe(true);
    expect(opt("runtime-fastapi")!.disabled).toBe(false);
  });

  it("still names the env var that would enable it — in the TEXT, not only the title", () => {
    renderSelectors({ availableRuntimes: { django: false, fastapi: true } });
    const django = opt("runtime-django")!;

    // The remedy has to survive the conversion. `title` alone is a mouse-hover
    // affordance: unreachable by keyboard, touch, and most screen readers. The
    // accessible name is what a user actually receives, so the env var is
    // asserted THERE. The title is asserted too, because it was the promise the
    // old button made and removing it would be a silent downgrade for pointers.
    expect(django.textContent).toContain("DJANGO_URL");
    expect(django.textContent).toContain(".env.local");
    expect(django.getAttribute("title")).toContain("DJANGO_URL");
  });

  it("names the OTHER runtime's env var when fastapi is the unconfigured one", () => {
    // Guards a hardcoded "DJANGO_URL": the previous inline ternary was correct
    // and still a second copy of envVarFor. One fixture cannot tell a lookup
    // from a constant.
    renderSelectors({ availableRuntimes: { django: true, fastapi: false } });
    expect(opt("runtime-fastapi")!.textContent).toContain("FASTAPI_URL");
    expect(opt("runtime-django")!.disabled).toBe(false);
  });
});

describe("ChatSelectors — RULE 2: an undeclared mode is ABSENT, not greyed", () => {
  // langchain declares react + plan-execute and NOT deep-research, so the
  // vocabulary is strictly larger than this cell. Asserted rather than assumed:
  // a fork whose manifest makes every cell uniform would make this whole
  // describe vacuous, and it must say so instead of passing.
  const langchainModes = topologiesFor("langchain", "fastapi");
  it("the manifest still provides a mode this cell does not declare", () => {
    expect(ALL_TOPOLOGIES.length).toBeGreaterThan(langchainModes.length);
  });

  it("lists exactly the declared modes — a COUNT, because greyed and absent are both un-clickable", () => {
    renderSelectors({ framework: "langchain", modes: langchainModes });
    expect(optionsOf("topology").length).toBe(langchainModes.length);
  });

  it("omits deep-research entirely for a framework that cannot run it", () => {
    renderSelectors({ framework: "langchain", modes: langchainModes });
    expect(opt("topology-deep-research")).toBeNull();
  });

  it("greys NOTHING — no mode option carries `disabled`", () => {
    // The inverse of rule 1 stated positively. Without this, a conversion that
    // renders ALL_TOPOLOGIES with disabled={!modes.includes(id)} is caught only
    // by the count above; this names the forbidden attribute directly.
    renderSelectors({ framework: "langchain", modes: langchainModes });
    for (const o of optionsOf("topology")) {
      expect(o.disabled).toBe(false);
    }
  });

  it("does list deep-research for the framework that DOES declare it", () => {
    // Absence must be caused by the rule, not by the option never rendering.
    // Without this the mode tests pass on a component that drops every mode.
    const deepModes = topologiesFor("deepagents", "fastapi");
    renderSelectors({ framework: "deepagents", modes: deepModes, mode: "react" });
    expect(opt("topology-deep-research")).not.toBeNull();
  });
});

describe("ChatSelectors — it is a select, and it reports the shape", () => {
  it("renders three selects, not eight buttons", () => {
    renderSelectors();
    expect(screen.getByTestId("framework-select").tagName).toBe("SELECT");
    expect(screen.getByTestId("runtime-select").tagName).toBe("SELECT");
    expect(screen.getByTestId("topology-select").tagName).toBe("SELECT");
    expect(screen.queryAllByRole("button").length).toBe(0);
  });

  it("labels each select so its accessible name is the axis, not the count", () => {
    renderSelectors();
    // getByLabelText resolves through htmlFor; the count is aria-hidden so it
    // must NOT appear in the name.
    expect(screen.getByLabelText("Framework")).toBe(
      screen.getByTestId("framework-select")
    );
    expect(screen.getByLabelText("Runtime")).toBe(
      screen.getByTestId("runtime-select")
    );
    expect(screen.getByLabelText("Mode")).toBe(
      screen.getByTestId("topology-select")
    );
  });

  it("says how many modes exist, not only how many are offered", () => {
    // The teaching value flat buttons had for free: you could see there were
    // three modes. "2 of 3" is what tells a reader the third one exists.
    const langchainModes = topologiesFor("langchain", "fastapi");
    renderSelectors({ framework: "langchain", modes: langchainModes });
    expect(
      screen.getByText(`${langchainModes.length} of ${ALL_TOPOLOGIES.length}`)
    ).toBeTruthy();
  });

  it("reports the current selection as the select's value", () => {
    renderSelectors({ framework: "langgraph", runtime: "django", mode: "plan-execute", modes: topologiesFor("langgraph", "django") });
    expect((screen.getByTestId("framework-select") as HTMLSelectElement).value).toBe("langgraph");
    expect((screen.getByTestId("runtime-select") as HTMLSelectElement).value).toBe("django");
    expect((screen.getByTestId("topology-select") as HTMLSelectElement).value).toBe("plan-execute");
  });

  it("calls back with the chosen id on each axis", () => {
    const props = renderSelectors({ framework: "langchain", modes: topologiesFor("deepagents", "fastapi") });
    fireEvent.change(screen.getByTestId("framework-select"), { target: { value: "langgraph" } });
    fireEvent.change(screen.getByTestId("runtime-select"), { target: { value: "django" } });
    fireEvent.change(screen.getByTestId("topology-select"), { target: { value: "deep-research" } });
    expect(props.onFramework).toHaveBeenCalledWith("langgraph");
    expect(props.onRuntime).toHaveBeenCalledWith("django");
    expect(props.onMode).toHaveBeenCalledWith("deep-research");
  });
});
