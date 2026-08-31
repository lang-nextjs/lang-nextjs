"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * The shell's vertical scroller — FOCUSABLE EXACTLY WHEN IT SCROLLS (#486).
 *
 * ── WHY THIS IS A COMPONENT OF ITS OWN ────────────────────────────────────────────────────
 *
 * `AppShell` is a SERVER component; it is rendered straight from `app/layout.tsx` and holds no
 * state. Measuring overflow needs a layout effect, so the measurement lives here behind a
 * client boundary and `children` continues to be server-rendered and passed through untouched.
 * Putting the hook in AppShell would have made the whole shell client-rendered to fix a P3
 * focus stop.
 *
 * ── WHAT IS BEING FIXED, AND WHY THE OBVIOUS REMEDY IS THE DEFECT ─────────────────────────
 *
 * #451 gave this div `tabIndex={0}` because a keyboard user could not otherwise reach it to
 * scroll it — a mouse user could read a long page and a keyboard user could not. That is right
 * WHERE IT SCROLLS. Measured on open-swe after #451 merged:
 *
 *     /          scrolls=false  tabindex=0  takesFocus=true  name=null
 *     /chat      scrolls=false  tabindex=0  takesFocus=true  name=null
 *     /runs      scrolls=false  tabindex=0  takesFocus=true  name=null
 *     /settings  scrolls=true   tabindex=0  takesFocus=true  name=null
 *
 * On three of four routes a keyboard user tabs onto something that announces nothing and does
 * nothing. THAT IS THE INVERSE OF THE DEFECT #451 FIXED: the remedy for "a scroller you cannot
 * reach", applied where that does not occur, produces "a focus stop with nothing behind it".
 *
 * NEITHER SIDE IS CAUGHT BY axe. `scrollable-region-focusable` fires only when a region
 * OVERFLOWS without focusable content, so a focusable region that does not overflow violates
 * no rule — nothing is red now and nothing will go red. The cost is real and the gate is blind
 * to it in both directions.
 *
 * ── WHY MEASURED RATHER THAN JUST NAMED ───────────────────────────────────────────────────
 *
 * Adding an `aria-label` unconditionally is cheaper and leaves a redundant-but-announced stop
 * on three routes. It is rejected because this is ONE element that scrolls on one route and
 * not on three, so no per-location judgement is right everywhere. Measuring also keeps
 * apps/example correct BY CONSTRUCTION rather than by the assumption that its dashboard always
 * overflows — if that page ever shrinks, the stop goes with it instead of becoming this same
 * defect over there.
 *
 * ── THE NAME COMES WITH THE STOP, NEVER WITHOUT IT ────────────────────────────────────────
 *
 * When it does scroll it gets `role="region"` and a label together. #451 deliberately used
 * `tabindex` alone, reasoning that SidebarInset already renders the `<main>` landmark this sits
 * inside and "a second UNNAMED landmark is noise to a screen reader" — which is true of an
 * unnamed one. A named region that a user can actually land on is the case that argument does
 * not cover, and landing somewhere anonymous is the complaint here.
 *
 * ── BOTH OBSERVERS EARN THEIR LINE ────────────────────────────────────────────────────────
 *
 * A ResizeObserver alone sees the viewport change but not the content: this app streams into
 * the page, so height grows without the scroller's own box resizing and without `children`
 * changing identity. A MutationObserver alone sees content change but not a window resize that
 * makes a fitting page overflow. Each misses what the other catches.
 */
export function ShellScroller({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => setOverflows(el.scrollHeight > el.clientHeight);
    measure();

    // Guarded: jsdom has neither, and throwing in a unit test is a worse outcome than
    // reporting "does not overflow" there.
    const resize =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    resize?.observe(el);
    const mutate =
      typeof MutationObserver === "undefined" ? null : new MutationObserver(measure);
    mutate?.observe(el, { subtree: true, childList: true, characterData: true });

    return () => {
      resize?.disconnect();
      mutate?.disconnect();
    };
  }, []);

  return (
    <div
      ref={ref}
      className="min-h-0 flex-1 overflow-y-auto"
      {...(overflows
        ? { tabIndex: 0, role: "region" as const, "aria-label": "Page content" }
        : {})}
    >
      {children}
    </div>
  );
}
