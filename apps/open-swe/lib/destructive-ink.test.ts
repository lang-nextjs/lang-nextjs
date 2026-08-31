/**
 * --df-bad-ink IS VERIFIED BY ARITHMETIC, BECAUSE NOTHING ELSE CAN VERIFY IT.
 *
 * The open-swe a11y audit renders four routes in their DEFAULT state. Nineteen of
 * the twenty call sites this token exists for are error and conditional states —
 * a failed run fetch, a rejected approval, a missing thread id — which that audit
 * never reaches. Its green is not evidence about them, and #538 exists precisely
 * because that green was read as evidence once already.
 *
 * So the contrast is asserted here instead: computed from the DECLARED token, by
 * the WCAG formula, against every backdrop those call sites sit on. For nineteen
 * of the twenty this is the only gate there is.
 *
 * WHY IT LIVES IN apps/open-swe AND NOT BESIDE THE TOKEN. packages/ui has no test
 * runner — no vitest dependency, no config, no `test` script — so a spec file
 * placed next to globals.css would never execute, and a gate that never runs is
 * worse than none: it reads as coverage. This app runs vitest today and holds
 * eighteen of the call sites, and reading across the tree is the same thing
 * app/schema-dispatch-parity.test.ts does with packages/react. Giving packages/ui
 * its own runner is the better home and is worth doing; it is not worth doing
 * inside a colour-token change.
 *
 * WHAT WOULD HAVE TO BE TRUE for these to pass while the property is violated?
 *   - the tokens could go unparsed and the suite could compare nothing
 *   - the backdrop list could omit the surface that actually binds
 *   - upstream could ship its own token, leaving two sources for one decision
 * One case each, below.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* ── colour maths: oklch -> sRGB -> WCAG relative luminance ─────────────── */

const gamma = (t: number) =>
  t <= 0.0031308 ? 12.92 * t : 1.055 * Math.pow(t, 1 / 2.4) - 0.055;

type RGB = [number, number, number];

function oklch(L: number, C: number, Hdeg: number): RGB {
  const h = (Hdeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((c) => Math.round(Math.min(1, Math.max(0, gamma(c))) * 255)) as RGB;
}

const channel = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: RGB) =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}

/** Alpha compositing, the way a browser paints a `/15` tint over a surface. */
const over = (fg: RGB, bg: RGB, alpha: number): RGB =>
  fg.map((c, i) => Math.round(alpha * c + (1 - alpha) * bg[i])) as RGB;

/* ── reading the declared values rather than restating them ─────────────── */

/**
 * Pull `--name: oklch(L C H)` out of a stylesheet.
 *
 * READ, never hardcoded. A test that restates the token's value keeps passing
 * after someone edits the token, which is the failure it exists to prevent.
 */
function readOklch(css: string, name: string): RGB | null {
  const m = css.match(
    new RegExp(
      `--${name}\\s*:\\s*oklch\\(\\s*([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)\\s*\\)`
    )
  );
  return m ? oklch(Number(m[1]), Number(m[2]), Number(m[3])) : null;
}

const UI = join(__dirname, "..", "..", "..", "packages", "ui");
const localCss = readFileSync(
  join(UI, "src", "styles", "globals.css"),
  "utf-8"
);
// Through packages/ui's own node_modules: the dependency belongs to that package,
// and pnpm's strict layout means this app cannot resolve it from its own tree.
const upstreamCss = readFileSync(
  join(UI, "node_modules", "@digitalfrontier", "theme", "theme.css"),
  "utf-8"
);

const INK = readOklch(localCss, "df-bad-ink");
const BG = readOklch(upstreamCss, "df-bg");
const CARD = readOklch(upstreamCss, "df-surface");
const BAD = readOklch(upstreamCss, "df-bad");

/**
 * Every backdrop the call sites sit on: two surfaces, bare and under each
 * destructive tint the error treatments use.
 *
 * The tint strengths are DERIVED from the tree rather than listed, because an
 * omitted backdrop is exactly how this check would stay green while a call site
 * still failed — and the binding case is the LIGHTEST backdrop, so a missing
 * heavier tint is not a harmless omission.
 */
function tintStrengths(): number[] {
  const files = [
    join(__dirname, "..", "app", "page.tsx"),
    join(__dirname, "..", "app", "runs", "page.tsx"),
    join(__dirname, "..", "app", "runs", "[runId]", "page.tsx"),
    join(__dirname, "..", "app", "settings", "page.tsx"),
    join(__dirname, "run-badge.ts"),
  ];
  const found = new Set<number>();
  for (const f of files)
    for (const m of readFileSync(f, "utf-8").matchAll(/bg-destructive\/(\d+)/g))
      found.add(Number(m[1]) / 100);
  return [...found].sort((a, b) => a - b);
}

function backdrops(): { name: string; rgb: RGB }[] {
  const out = [
    { name: "--background", rgb: BG as RGB },
    { name: "--card", rgb: CARD as RGB },
  ];
  for (const [label, surface] of [
    ["bg", BG as RGB],
    ["card", CARD as RGB],
  ] as const)
    for (const t of tintStrengths())
      out.push({
        name: `bg-destructive/${Math.round(t * 100)} over ${label}`,
        rgb: over(BAD as RGB, surface, t),
      });
  return out;
}

const AA = 4.5;
/** The margin is the point: 4.56:1 is a pass a single token nudge erases. */
const MARGIN_FLOOR = 5.0;

describe("--df-bad-ink: destructive text that clears AA on every surface it lands on", () => {
  it("the tokens and the tint strengths were actually read", () => {
    // Anti-vacuity. Every assertion below compares values parsed out of CSS by
    // regex; if one drifts, the value is null and the maths yields NaN. `NaN >= 5`
    // is false, so the suite would fail rather than pass — this case exists to say
    // WHICH input broke instead of printing six confusing ratios.
    expect(
      INK,
      "--df-bad-ink not found in packages/ui globals.css"
    ).not.toBeNull();
    expect(BG, "--df-bg not found in the pinned theme").not.toBeNull();
    expect(CARD, "--df-surface not found in the pinned theme").not.toBeNull();
    expect(BAD, "--df-bad not found in the pinned theme").not.toBeNull();
    expect(
      tintStrengths().length,
      "no bg-destructive tint found in the call sites — the reader has drifted, and " +
        "an empty tint list silently removes the backdrops that bind"
    ).toBeGreaterThan(0);
  });

  it("clears AA with margin against every backdrop, not by a hair", () => {
    const measured = backdrops().map((b) => ({
      ...b,
      ratio: contrast(INK as RGB, b.rgb),
    }));
    const thin = measured
      .filter((b) => b.ratio < MARGIN_FLOOR)
      .map((b) => `${b.name}: ${b.ratio.toFixed(2)}:1`);
    expect(
      thin,
      `--df-bad-ink must clear ${AA}:1 with margin on every surface it is used on. ` +
        `Nineteen of its call sites are error states the a11y audit never renders, so ` +
        `this arithmetic is the only evidence they get, and a value that passes by 0.06 ` +
        `is not evidence. Measured: ${measured
          .map((m) => `${m.name} ${m.ratio.toFixed(2)}:1`)
          .join("; ")}`
    ).toEqual([]);
  });

  it("is NOT the token for text on a solid destructive fill", () => {
    // The complement, asserted so the two cannot be swapped by someone reading
    // only their names. --df-bad-ink IS the destructive colour used as ink;
    // --df-on-bad is ink ON that colour. The swap looks reasonable and measures
    // 1.81:1.
    expect(contrast(INK as RGB, BAD as RGB)).toBeLessThan(AA);
  });

  it("shadows no token the upstream theme declares", () => {
    // The df-theme-check property, asserted beside the reasoning rather than only
    // in a CI step. `--df-bad-ink` has to be genuinely NEW: if upstream ever
    // declares that exact name, the local one stops being additive and becomes an
    // override, which is the drift packages/ui exists to prevent.
    expect(
      /--df-bad-ink\s*:/.test(upstreamCss),
      "--df-bad-ink is declared upstream — the local declaration now SHADOWS it"
    ).toBe(false);
  });

  it("is still absent from the pinned theme — delete it when that stops being true", () => {
    /*
     * THE EXPIRY CASE, and the reason this token is allowed to be local at all.
     * It exists only because the pinned theme has no destructive-as-text
     * primitive and this repository does not open changes upstream. The day the
     * theme ships one, two declarations describe one decision and ours is the
     * stale one — so this goes red and says to delete it, rather than letting a
     * local palette outlive its reason. Same discipline as the a11y
     * known-violation list, for the same reason.
     *
     * Matched on the ROLE, not on our chosen name: upstream would not call it
     * `--df-bad-ink`, so checking for that name would be a check that can never
     * fire — which is the shape of a guard that reads as protection and is not.
     */
    const upstreamEquivalent = [
      ...upstreamCss.matchAll(/--(df-[a-z0-9-]*)\s*:/g),
    ]
      .map((m) => m[1])
      .filter(
        (n) =>
          /bad/.test(n) &&
          n !== "df-bad" &&
          n !== "df-on-bad" &&
          /(ink|text|fg|foreground|on-surface)/.test(n)
      );
    expect(
      upstreamEquivalent,
      "the pinned theme now declares its own destructive-as-text primitive. Delete " +
        "--df-bad-ink and --destructive-ink from packages/ui globals.css, point " +
        "--color-destructive-ink at the upstream token, and delete this test."
    ).toEqual([]);
  });
});
