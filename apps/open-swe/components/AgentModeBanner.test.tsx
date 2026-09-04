// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { AgentModeBanner } from "./AgentModeBanner";

/**
 * THE BANNER'S LOUDNESS IS ASYMMETRIC, AND BOTH HALVES MUST BE DRIVEN.
 *
 * `AgentModeBanner` is "deliberately not dismissible" so that a forker cannot
 * mistake a scripted run for a real one. That guarantee is not symmetric:
 *
 *   - `canned` / `unknown` — the reader is about to form a FALSE belief, and
 *     the detail is a paragraph naming the thing to go and fix. Loud is the
 *     entire point, and the box must stay.
 *   - `live` — nobody is misled by a live run being live. The same full-bleed
 *     box costs three lines and outweighs the answer it introduces.
 *
 * WHY A MATCHED PAIR RATHER THAN ONE CASE. A test that only renders `live` and
 * asserts "compact" passes identically against a component that is compact for
 * EVERY tone — which would silently delete the diagnostic this component exists
 * to deliver. The assertion that carries weight is that the two renders DIFFER,
 * and that the canned diagnostic survives the change verbatim.
 *
 * WHY `data-density` AND NOT A CLASS NAME. The claim is "this render is the
 * compact one", not "this render has these utility classes". Keyed to a token
 * the component states, a restyle cannot silently invert the verdict.
 */
describe("AgentModeBanner density is keyed to tone", () => {
  afterEach(cleanup);

  it("renders `live` COMPACT — the tone where a full box buys nothing", () => {
    render(<AgentModeBanner provenance={{ mode: "live" }} />);
    const el = screen.getByTestId("agent-mode-banner");
    expect(el.getAttribute("data-density")).toBe("compact");
    expect(el.getAttribute("data-agent-mode")).toBe("live");
    expect(el.textContent).toContain("Live agent run");
  });

  it("renders `canned` FULL, diagnostic intact — the half a compact-always component would delete", () => {
    render(
      <AgentModeBanner
        provenance={{ mode: "canned", reason: "no-model-backend" }}
      />
    );
    const el = screen.getByTestId("agent-mode-banner");
    expect(el.getAttribute("data-density")).toBe("full");
    expect(el.textContent).toContain("Scripted run");
    // The actionable sentence, verbatim. This is the payload the box exists to
    // carry; a compact form that dropped it would still say "Scripted run".
    expect(el.textContent).toContain("Set MODEL_BACKEND");
  });

  it("renders `unknown` FULL — an unidentified backend is the other misleading case", () => {
    render(<AgentModeBanner provenance={{ mode: "unknown" }} />);
    const el = screen.getByTestId("agent-mode-banner");
    expect(el.getAttribute("data-density")).toBe("full");
    expect(el.textContent).toContain("did not identify itself");
  });

  it("THE CONTROL: the three tones do not all render alike", () => {
    const density = (
      p: Parameters<typeof AgentModeBanner>[0]["provenance"]
    ) => {
      cleanup();
      render(<AgentModeBanner provenance={p} />);
      return screen
        .getByTestId("agent-mode-banner")
        .getAttribute("data-density");
    };
    const live = density({ mode: "live" });
    const canned = density({ mode: "canned", reason: "no-model-backend" });
    expect(live).not.toBe(canned);
  });

  it("still claims nothing before provenance resolves", () => {
    const { container } = render(<AgentModeBanner provenance={undefined} />);
    expect(container.firstChild).toBeNull();
  });
});
