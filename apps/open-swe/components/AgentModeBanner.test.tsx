// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import {
  AgentModeBanner,
  AgentModeBannerView,
  bannerDensity,
  bannerStyles,
} from "./AgentModeBanner";
import { describeProvenance } from "../lib/agent-mode";

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

/**
 * THE COLOUR MUST BE DERIVED FROM TONE, AT BOTH DENSITIES (#718).
 *
 * The banner states "this is the live tone" in two places: the surface classes
 * and the dot. The compact chip used to state the first as a LITERAL while the
 * dot beside it derived its own. Nothing asserted the two agreed, and they
 * agreed only because `bannerDensity` returns `compact` for exactly one tone —
 * so the literal and the derivation had no opportunity to disagree yet.
 *
 * WHY THE TESTS ABOVE CANNOT SEE THIS. They drive the component through
 * `provenance`, and every provenance that reaches the compact branch is `live`.
 * A component that painted every compact render success-green would pass all
 * five of them — including THE CONTROL, which compares `data-density` and never
 * looks at colour. The observation is unreachable from that direction, not
 * merely unasserted.
 *
 * So these drive `AgentModeBannerView` directly, which takes its density as an
 * argument rather than deriving it. That reaches (canned, compact) and
 * (unknown, compact) — the two cells that do not exist today and that widening
 * the compact rule by one tone would create. Widening it is the plausible edit:
 * `unknown` is the obvious next candidate for a compact render, and the moment
 * it happens a scripted or unidentified run renders in SUCCESS GREEN under a
 * warning dot, with nothing going red.
 *
 * HOW THE ASSERTION WORKS. Rather than restating the palette (a second copy
 * that would drift), each test RECOVERS the tone twice from one rendered
 * element — once from its surface classes, once from its dot — and requires
 * both to be the tone that was asked for. That is the missing agreement,
 * stated as a test.
 */
const TONES = ["canned", "live", "unknown"] as const;
const DENSITIES = ["compact", "full"] as const;

/** Class-token containment, so `bg-warning` cannot match `bg-warning/10`. */
function hasAllClasses(el: Element, classes: string) {
  const present = new Set(el.className.trim().split(/\s+/));
  return classes
    .trim()
    .split(/\s+/)
    .every((c) => present.has(c));
}

/**
 * Which tones could this element's surface belong to?
 *
 * Returns every match rather than the first, so that two tones sharing a
 * palette — which would make the recovery meaningless — shows up as a failed
 * assertion instead of an arbitrary pick.
 */
function tonesMatchingSurface(el: Element) {
  return TONES.filter((tone) =>
    DENSITIES.some((density) =>
      hasAllClasses(el, bannerStyles(tone, density).surface)
    )
  );
}

function tonesMatchingDot(el: Element) {
  const dot = el.querySelector('[aria-hidden="true"]');
  expect(dot).not.toBeNull();
  return TONES.filter((tone) =>
    hasAllClasses(dot as Element, bannerStyles(tone, "compact").dot)
  );
}

describe("AgentModeBanner colour is keyed to tone at BOTH densities", () => {
  afterEach(cleanup);

  for (const density of DENSITIES) {
    for (const tone of TONES) {
      it(`renders ${tone} at ${density} in the ${tone} palette, surface and dot agreeing`, () => {
        render(
          <AgentModeBannerView
            mode={tone}
            tone={tone}
            label="label"
            detail="detail"
            density={density}
          />
        );
        const el = screen.getByTestId("agent-mode-banner");

        // Both statements of "which tone is this" resolve, unambiguously, to
        // the same tone. Against a hardcoded compact literal the (canned,
        // compact) and (unknown, compact) cases fail here: the surface says
        // `live` and the dot says otherwise.
        expect(tonesMatchingSurface(el)).toEqual([tone]);
        expect(tonesMatchingDot(el)).toEqual([tone]);
      });
    }
  }

  it("THE COMPANION: no two tones share a palette, so the recovery above means something", () => {
    for (const density of DENSITIES) {
      const surfaces = TONES.map((t) => bannerStyles(t, density).surface);
      expect(new Set(surfaces).size).toBe(TONES.length);
    }
    const dots = TONES.map((t) => bannerStyles(t, "compact").dot);
    expect(new Set(dots).size).toBe(TONES.length);
  });

  it("THE WIRING: the provenance-driven banner takes its colour from the same table", () => {
    const provenances = [
      { mode: "live" } as const,
      { mode: "canned", reason: "no-model-backend" } as const,
      { mode: "unknown" } as const,
    ];
    for (const p of provenances) {
      cleanup();
      render(<AgentModeBanner provenance={p} />);
      const el = screen.getByTestId("agent-mode-banner");
      const { tone } = describeProvenance(p);
      expect(
        hasAllClasses(el, bannerStyles(tone, bannerDensity(p)).surface)
      ).toBe(true);
    }
  });
});
