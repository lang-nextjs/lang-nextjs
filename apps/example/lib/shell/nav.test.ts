import { describe, it, expect } from "vitest";
import { RUNGS, RUNG_SHAPES } from "@deepagents-nextjs/rungs";
import { rungNavGroups, groupLabelForShape, HARNESS_GROUP } from "./nav";

/**
 * The property under test is NOT "the nav renders entries". It is that the nav
 * is DERIVED from the rung manifest and grouped by shape — so that adding a
 * rung to rungs.json makes it appear, and no second list has to be edited.
 *
 * A hardcoded nav that happens to list today's five rungs would satisfy "the
 * nav renders five entries" and violate the property completely. Several
 * assertions below are written against RUNGS rather than against literals so
 * that a hardcoded implementation fails them.
 *
 * HOW FAR THAT ACTUALLY GOES — measured, not assumed. Replacing the
 * implementation with a static list of today's five rungs fails **2 of these
 * 10 tests**, not all of them:
 *
 *   FAILS  "renders a rung with no target as unreachable"   (planned rung gets a fake href)
 *   FAILS  "renders a cross-origin rung as external"        (env override ignored)
 *   PASSES the eight structural ones — because a list written to match today's
 *          manifest does match today's manifest.
 *
 * So these tests catch a nav that gets TARGET SEMANTICS wrong, and they do not
 * catch a nav that is merely frozen. Freezing is caught by the manifest moving
 * underneath it — which is a CI concern (rungs.json changes, these fail) rather
 * than something a unit test can prove at a single point in time. Said plainly
 * here so nobody reads a green run as proof of derivation it does not give.
 */
describe("rungNavGroups — derived from the manifest, grouped by shape", () => {
  it("includes every rung in the manifest, exactly once", () => {
    const ids = rungNavGroups().flatMap((g) => g.items.map((i) => i.title));
    expect([...ids].sort()).toEqual([...RUNGS.map((r) => r.id)].sort());
  });

  it("produces one group per shape actually present, labelled by shape", () => {
    const shapesPresent = new Set(RUNGS.map((r) => r.shape));
    const labels = rungNavGroups().map((g) => g.label);
    expect(labels).toHaveLength(shapesPresent.size);
    for (const s of shapesPresent)
      expect(labels).toContain(groupLabelForShape(s));
  });

  it("puts each rung under its own shape's group and no other", () => {
    for (const group of rungNavGroups()) {
      for (const item of group.items) {
        const rung = RUNGS.find((r) => r.id === item.title)!;
        expect(group.label).toBe(groupLabelForShape(rung.shape));
      }
    }
  });

  it("orders rungs by ordinal within a group", () => {
    for (const group of rungNavGroups()) {
      const ordinals = group.items.map(
        (i) => RUNGS.find((r) => r.id === i.title)!.ordinal
      );
      expect(ordinals).toEqual([...ordinals].sort((a, b) => a - b));
    }
  });

  it("covers every declared shape with a label — a new shape must not fall through", () => {
    for (const shape of RUNG_SHAPES)
      expect(groupLabelForShape(shape)).toBeTruthy();
  });
});

describe("targets are honoured, not guessed", () => {
  const groups = () =>
    rungNavGroups({ NEXT_PUBLIC_QUEUE_URL: "http://queue.example" });
  const item = (id: string) =>
    groups()
      .flatMap((g) => g.items)
      .find((i) => i.title === id)!;

  /**
   * COUNT FIRST, THEN PER-ITEM.
   *
   * Each of these iterates a filtered slice of RUNGS, and in a reduced fork the
   * slice can legitimately be EMPTY — `eject langchain` leaves no origin rung
   * and no planned rung at all. A bare `for (…) { expect(…) }` then runs zero
   * assertions and reports green, which is a test passing over nothing: exactly
   * the failure mode this repo has spent the milestone removing.
   *
   * So each asserts the COUNT the nav produced equals the count the manifest
   * declares, BEFORE checking the items. At zero that is still a real
   * assertion — it says the nav invented no entry the manifest does not have —
   * and it shrinks with the manifest instead of demanding a shape a fork
   * legitimately lacks.
   */
  const allItems = () => groups().flatMap((g) => g.items);

  it("renders a rung with no target as unreachable — null href, never a dead link", () => {
    const declared = RUNGS.filter((r) => r.target.kind === "none");
    expect(allItems().filter((i) => i.href === null)).toHaveLength(
      declared.length
    );
    for (const rung of declared) {
      const it_ = item(rung.id);
      expect(
        it_.href,
        `${rung.id} declares no target and must not be linkable`
      ).toBeNull();
      expect(it_.external).toBe(false);
      expect(it_.note).toBeTruthy();
    }
  });

  it("renders a cross-origin rung as external, honouring the env override", () => {
    const declared = RUNGS.filter((r) => r.target.kind === "origin");
    expect(allItems().filter((i) => i.external === true)).toHaveLength(
      declared.length
    );
    for (const rung of declared) {
      const it_ = item(rung.id);
      expect(it_.external).toBe(true);
      expect(it_.href).toContain("http://queue.example");
    }
  });

  it("substitutes the route placeholder for param rungs — never ships a literal [param]", () => {
    const declared = RUNGS.filter((r) => r.target.kind === "param");
    expect(
      allItems().filter((i) => i.href !== null && !i.external)
    ).toHaveLength(declared.length);
    for (const rung of declared) {
      const it_ = item(rung.id);
      expect(it_.href).toBeTruthy();
      expect(
        it_.href!,
        `${rung.id} href leaked an unsubstituted placeholder`
      ).not.toMatch(/\[.*\]/);
      expect(it_.href!.startsWith("/")).toBe(true);
      expect(it_.external).toBe(false);
    }
  });
});

describe("harnesses are kept out of the ladder", () => {
  it("lists no rung id, because a harness is not a rung", () => {
    const rungIds = new Set<string>(RUNGS.map((r) => r.id));
    for (const item of HARNESS_GROUP.items)
      expect(rungIds.has(item.title)).toBe(false);
  });

  it("is a separate group from every shape group", () => {
    const shapeLabels = rungNavGroups().map((g) => g.label);
    expect(shapeLabels).not.toContain(HARNESS_GROUP.label);
  });
});

/**
 * `reach` MUST HAVE A CONSUMER THAT BRANCHES ON IT (#424, #451).
 *
 * A manifest field nothing branches on is `data-approval-pause` with a different name: declared,
 * schema'd, tested, and inert. Worse than an overloaded field, because an overloaded field is at
 * least read. So the acceptance criterion is not "a branch exists" — it is that a test FAILS if
 * nothing branches on it.
 *
 * These assert BEHAVIOUR THAT DIFFERS BY `reach`, not the presence of an `if`. Delete the
 * `reach` branch in noteFor() and the first two fail; make every note identical and the third
 * fails. A branch that stopped mattering cannot stay green here.
 *
 * The first case is also a regression pin on a live UI defect: noteFor() keyed on
 * `href === null` and told the reader rung 5 was "not present in this repo" while it owned 248
 * files and was state:"implemented". A reachability signal was answering a presence question.
 */
describe("reach has a consumer, and it is the nav", () => {
  const items = rungNavGroups().flatMap((g) => g.items);
  const noteOf = (id: string) => items.find((i) => i.title === id)?.note;

  it("a vendored rung is never described as absent from the repo", () => {
    const vendored = RUNGS.filter((r) => r.reach === "vendored");
    // Non-vacuity: if no rung is vendored this proves nothing, and the assertion below would
    // pass over an empty list — which is the shape this whole milestone has been removing.
    expect(vendored.length, "no vendored rung to test — this case is vacuous").toBeGreaterThan(0);
    for (const r of vendored) {
      expect(r.state, `${r.id} must be present to make this case meaningful`).not.toBe("planned");
      expect(noteOf(r.id), `${r.id} nav note`).not.toMatch(/not present in this repo/);
      expect(noteOf(r.id), `${r.id} nav note`).toMatch(/no front door/);
    }
  });

  it("a referenced rung carries no no-front-door note", () => {
    const referenced = RUNGS.filter((r) => r.reach === "referenced");
    expect(referenced.length).toBeGreaterThan(0);
    for (const r of referenced) {
      // Most referenced rungs correctly carry NO note at all, and `.not.toMatch` on undefined
      // throws rather than passing — the assertion has to say "no note, or a note that is not
      // this one", which is the actual property.
      const note = noteOf(r.id);
      if (note !== undefined)
        expect(note, `${r.id} nav note`).not.toMatch(/no front door/);
    }
  });

  it("the two reach values produce DIFFERENT notes, so the branch is load-bearing", () => {
    const noteFor = (v: string) =>
      new Set(
        RUNGS.filter((r) => r.reach === v && r.state !== "planned").map(
          (r) => noteOf(r.id) ?? "(no note)"
        )
      );
    const vendoredNotes = noteFor("vendored");
    const referencedNotes = noteFor("referenced");
    expect(vendoredNotes.size).toBeGreaterThan(0);
    expect(referencedNotes.size).toBeGreaterThan(0);
    for (const n of vendoredNotes)
      expect(referencedNotes.has(n), `note "${n}" does not distinguish reach`).toBe(false);
  });
});
