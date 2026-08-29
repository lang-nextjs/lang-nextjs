import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RUNG_BY_ID } from "@deepagents-nextjs/rungs";
import { BOARD_ROUTE } from "./routes";

/**
 * #154 — THE BACK ARROW THAT CHANGED MEANING WITHOUT CHANGING TEXT.
 *
 * The run detail page linked `href="/"` to mean "back to the board". After the
 * board moved to `/runs` that link still resolved, still rendered an arrow,
 * and went to the CHAT. A mutation planting it passed all 904 unit tests —
 * nothing anywhere could tell the two meanings apart, because the two meanings
 * had the same spelling.
 *
 * These assert both halves of the repair: the constant tracks the manifest,
 * and the call site uses the constant instead of respelling it.
 */
describe("BOARD_ROUTE tracks the manifest", () => {
  it("equals the route rungs.json declares — not a literal repeated here", () => {
    const t = RUNG_BY_ID["open-swe"].target;
    // Reads the manifest independently of lib/routes.ts's own derivation, so
    // this fails if that derivation stops following the manifest.
    expect(t.kind).toBe("origin");
    expect(BOARD_ROUTE).toBe(t.kind === "origin" ? t.route : "unreachable");
  });

  it("is not the front door, which the chat now serves", () => {
    // The specific regression, named. `/` still resolves and still renders, so
    // "the link works" cannot catch this; only naming the surface can.
    expect(BOARD_ROUTE).not.toBe("/");
  });

  it("does not fall back — the manifest actually declared a route", () => {
    // boardRoute() has a fallback for the type narrowing. If the manifest ever
    // stopped declaring this, BOARD_ROUTE would still be "/runs" and every
    // assertion above would pass while the derivation had gone dead.
    const t = RUNG_BY_ID["open-swe"].target;
    expect(t.kind === "origin" && typeof t.route).toBe("string");
  });
});

describe("the run detail page uses BOARD_ROUTE rather than respelling it", () => {
  const src = readFileSync(
    join(__dirname, "..", "app", "runs", "[runId]", "page.tsx"),
    "utf-8"
  );

  it("the reader found the file and it contains links", () => {
    // ANTI-VACUITY GUARD. Every assertion below is of the form "the source does
    // not contain X". An empty string satisfies all of them, and an empty
    // string is exactly what a moved or renamed file produces.
    expect(src.length).toBeGreaterThan(500);
    expect(src).toContain("<Link");
  });

  it("links to the board through the constant", () => {
    expect(src).toContain("href={BOARD_ROUTE}");
  });

  it('contains no `href="/"` — the spelling whose meaning silently changed', () => {
    expect(src).not.toContain('href="/"');
  });
});
