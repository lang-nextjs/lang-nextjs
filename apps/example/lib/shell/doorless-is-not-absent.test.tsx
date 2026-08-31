// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import type { Rung } from "@deepagents-nextjs/rungs";
import { rungNote } from "./nav";
import { RunDeparture } from "../../components/shell/RunDeparture";

/**
 * A MISSING FRONT DOOR IS NOT A MISSING RUNG — AT EVERY SURFACE, NOT ONE (#483).
 *
 * #424 fixed this in `rungNote`: presence now comes from `state`, reachability
 * from `reach`, and neither is derived from `rungHref` returning null. That fix
 * is correct and this file does not touch it.
 *
 * IT DID NOT REACH THE OTHER TWO SURFACES, because they were not asking. Both
 * `RunDeparture` and the example sidebar carried their OWN copy of "not present
 * in this repo", shown on `href === null` — so they went on saying the false
 * thing about software-developer-agent (state "implemented", reach "vendored",
 * 248 files) after the central rule was already right. A rule living in one
 * place and repeated in two others is only fixed where someone looked.
 *
 * That is why this is RENDERED rather than inspected. A source check over
 * nav.ts — the obvious one, and the one I would have written — reports the class
 * closed while two screens still show the sentence.
 *
 * WHY THE SUBJECTS ARE CONSTRUCTED RATHER THAN READ FROM THE MANIFEST.
 *
 * Exactly ONE declared rung is vendored-with-no-door today. A guard that asked
 * the manifest for its subject would have a single witness and would go silently
 * vacuous the day that rung gains a target or changes classification — passing
 * forever, having stopped examining the case it exists for. These are built here
 * and hold in every configuration of the ladder, including one where no real
 * rung exercises the case at all.
 */

/*
 * The overrides are loosely typed and the result is cast, and that is the point
 * rather than a shortcut: `RungId` is a CLOSED union derived from the manifest,
 * so a constructed subject cannot carry a real id — and borrowing one would
 * reintroduce the dependency the construction exists to remove.
 */
const rung = (over: Record<string, unknown>): Rung =>
  ({
    id: "constructed",
    ordinal: 99,
    shape: "run",
    state: "implemented",
    requires: [],
    languages: ["ts"],
    runtimes: {},
    target: { kind: "none" },
    owns: {},
    ...over,
  } as unknown as Rung);

/** Here, forkable, and simply not linked from this build. */
const VENDORED = rung({ state: "implemented", reach: "vendored" });
/** Genuinely not in the tree. */
const PLANNED = rung({ state: "planned" });

/** Any wording that asserts the rung is not in the tree. */
const CLAIMS_ABSENT = /not present in this repo|not in this repo/i;

describe("rungNote — the rule the surfaces must ask", () => {
  it("does not call a vendored rung absent", () => {
    const note = rungNote(VENDORED, null) ?? "";
    expect(note, `rungNote said: "${note}"`).not.toMatch(CLAIMS_ABSENT);
  });

  it("  ...and says something, rather than going silent to satisfy that", () => {
    // Silence passes the assertion above while telling a reader nothing, which
    // is a different failure and not an improvement on the wrong sentence.
    expect(rungNote(VENDORED, null)).toBeTruthy();
  });

  it("STILL calls a planned rung absent — the vocabulary is intact", () => {
    // The other half. Without it, deleting every "not present" string in the
    // repo would pass this file, and a shell that had quietly lost the ability
    // to say "absent" is indistinguishable from one that correctly never does.
    expect(rungNote(PLANNED, null)).toMatch(CLAIMS_ABSENT);
  });

  it("separates the two by state and reach, not by having no door", () => {
    // Both have target.kind === "none" and both get href === null. If the two
    // answers were equal, the surface would be reading the door and calling it
    // the room — the conflation itself.
    expect(rungNote(VENDORED, null)).not.toBe(rungNote(PLANNED, null));
  });
});

describe("RunDeparture — the rule reaches the screen", () => {
  /*
   * This surface had its own literal, so `rungNote` being right did not make it
   * right. Rendered, because that is the only level at which the difference was
   * observable.
   */
  it("does not tell a reader a vendored rung is absent", () => {
    render(<RunDeparture rung={VENDORED} />);
    expect(document.body.textContent ?? "").not.toMatch(CLAIMS_ABSENT);
  });

  it("  ...and shows the note rungNote actually returns", () => {
    // Pins the wiring, not just the absence of a bad string: a screen rendering
    // nothing at all would pass the case above.
    render(<RunDeparture rung={VENDORED} />);
    expect(document.body.textContent ?? "").toContain(rungNote(VENDORED, null));
  });

  it("still says so for a genuinely planned rung", () => {
    render(<RunDeparture rung={PLANNED} />);
    expect(document.body.textContent ?? "").toMatch(CLAIMS_ABSENT);
  });
});
