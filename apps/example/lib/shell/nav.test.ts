import { describe, it, expect } from "vitest";
import { RUNGS, RUNG_SHAPES, type Rung } from "@deepagents-nextjs/rungs";
import { rungNavGroups, groupLabelForShape, HARNESS_GROUP, rungNote } from "./nav";

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
 * A manifest field nothing branches on is `data-approval-pause` with a different name:
 * declared, schema'd, tested, and inert. So the criterion is not "a branch exists" — it is that
 * a test FAILS if nothing branches on it.
 *
 * THE FIRST VERSION OF THIS BLOCK DERIVED ITS SUBJECT FROM `RUNGS`, AND THAT WAS WRONG IN
 * EVERY FORK — measured, not estimated. Rung 5 is the ONLY `vendored` rung, and every eject
 * deletes it: `pnpm eject langgraph` in a scratch worktree leaves a manifest with two rungs and
 * ZERO vendored ones. All four testing eject legs failed in CI for that reason, which is the
 * useful part — it is not a quirk of one fork, it is EVERY configuration a forker ships. A
 * consumer test for `reach` that only holds in the full tree therefore asserts nothing in any
 * tree anyone actually forks.
 *
 * The non-vacuity assertion caught it rather than letting two cases pass over nothing forever,
 * which is the whole reason it was written. The repair is NOT to skip: a skip with no guard on
 * its condition is an off switch, and the day rung 5 is reclassified these would go quiet in
 * the full tree too. It is to stop asking the manifest for a subject the branch does not need.
 *
 * So the branch is pinned DIRECTLY, against rungs constructed here, and holds in every
 * configuration. The manifest cases below remain, as the claim about the tree in front of you.
 */
describe("reach has a consumer, and the branch is pinned in every configuration", () => {
  const base = RUNGS[0];
  const as = (over: Partial<Rung>): Rung => ({ ...base, ...over }) as Rung;

  it("each kind of rung gets its own note, built here rather than borrowed from the manifest", () => {
    const planned = rungNote(as({ state: "planned", reach: undefined }), null);
    const vendored = rungNote(as({ state: "implemented", reach: "vendored" }), null);
    const referenced = rungNote(
      as({ state: "implemented", reach: "referenced", target: { kind: "param" } as Rung["target"] }),
      "/r/x"
    );

    // Presence and reachability answer DIFFERENT questions, which is the whole of #424.
    expect(planned).toMatch(/not present in this repo/);
    expect(vendored).toMatch(/no front door/);
    expect(vendored ?? "").not.toMatch(/not present in this repo/);
    // `?? ""` because a referenced rung correctly carries NO note, and `.not.toMatch` on
    // undefined THROWS rather than passing. The property is "no note, or a note that is not
    // this one" — writing it as a bare negation asserts a stronger thing than intended and
    // fails on the correct answer.
    expect(referenced ?? "").not.toMatch(/no front door/);

    // Load-bearing: the two reach values must not collapse to the same string.
    expect(vendored).not.toBe(referenced);
    expect(vendored).not.toBe(planned);
  });

  it("an unreachable rung is not described as absent just because it has no href", () => {
    // THE REGRESSION PIN. noteFor keyed on `href === null` and returned "not present in this
    // repo" — and rungHref returns null for target.kind "none", which is absence of a FRONT
    // DOOR. Rung 5 owns 248 files and is state:"implemented", so the nav told every reader
    // something false. Both of these have no href; only one of them is absent.
    const vendored = as({ state: "implemented", reach: "vendored" });
    const planned = as({ state: "planned", reach: undefined });
    expect(rungNote(vendored, null)).not.toBe(rungNote(planned, null));
  });
});

describe("reach, as the manifest actually declares it here", () => {
  const items = rungNavGroups().flatMap((g) => g.items);
  const noteOf = (id: string) => items.find((i) => i.title === id)?.note;
  const vendored = RUNGS.filter((r) => r.reach === "vendored");

  /*
   * TWO CONFIGURATIONS, TWO TRUE STATEMENTS, AND NEITHER BRANCH CAN BE TAKEN WRONGLY.
   *
   * A fork with rung 5 ejected genuinely contains no vendored rung. That is not a reason to
   * skip — a skip with no guard on its condition is an off switch, and the day rung 5 is
   * reclassified these would go quiet in the FULL tree too. So each branch asserts something
   * the OTHER configuration would falsify: with a vendored rung present the no-front-door note
   * must appear, and with none present it must appear nowhere. Taking the wrong branch cannot
   * stay green.
   */
  it("every vendored rung is noted as unreachable, or nothing claims a missing front door", () => {
    if (vendored.length > 0) {
      for (const r of vendored) {
        expect(r.state, `${r.id} must be present for this to mean anything`).not.toBe("planned");
        expect(noteOf(r.id), `${r.id} nav note`).not.toMatch(/not present in this repo/);
        expect(noteOf(r.id), `${r.id} nav note`).toMatch(/no front door/);
      }
    } else {
      // Ejected fork: rung 5 is gone and it was the only vendored rung. The true statement is
      // that NOTHING is described as lacking a front door — which fails immediately if a
      // vendored rung reappears and this branch is still taken.
      for (const i of items)
        expect(i.note ?? "", `${i.title} nav note in a tree with no vendored rung`).not.toMatch(
          /no front door/
        );
    }
  });

  it("a referenced rung never carries a no-front-door note", () => {
    const referenced = RUNGS.filter((r) => r.reach === "referenced");
    // Every tree has at least one: a fork retains rung 1, which is referenced. If this is ever
    // zero the manifest, not this test, is the thing to look at.
    expect(referenced.length, "no referenced rung — the manifest is the surprise here").toBeGreaterThan(0);
    for (const r of referenced) {
      const note = noteOf(r.id);
      // `.not.toMatch` on undefined THROWS rather than passing, and most referenced rungs
      // correctly carry no note at all.
      if (note !== undefined) expect(note, `${r.id} nav note`).not.toMatch(/no front door/);
    }
  });
});
