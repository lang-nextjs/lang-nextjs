/**
 * WHICH FRAMES THE CONTRACT SAYS ANYTHING ABOUT (#988).
 *
 * `docs/sse-frame-schema.json` declares 12 `data-*` variants. NINE of them declare their
 * payload as a bare object -- no properties, no required -- so no payload can fail against
 * them. Three declare a shape, and one of those three acquired it only last cycle (#970).
 * The shaped variants are the exception rather than the norm.
 *
 * WHY THIS CLASS IS INVISIBLE TO EVERY PROCESS THAT HUNTS FOR DRIFT. A WRONG declaration
 * DISAGREES with an emission, and disagreement is what this repository is built to surface --
 * #944 was found that way, and #951's fixture went red the moment the document was corrected.
 * AN EMPTY DECLARATION AGREES WITH EVERYTHING. It cannot disagree with an emitter, cannot
 * disagree with the client, and cannot go red when either changes. It is #944's defect in its
 * EMPTY form rather than its WRONG one, and the empty form is strictly harder to find because
 * nothing it touches ever complains.
 *
 * THE FROZEN SET IS INTERSECTED WITH THE RUNGS THIS TREE STILL HAS, and that is not a
 * concession to the ejector -- it asserts something the plain frozen list could not. `eject.mjs`
 * prunes `data-*` branches by `x-emitted-by`, so a full-population assertion is false in EVERY
 * ejected tree by construction: the 2-langgraph fork carries SIX variants against twelve here,
 * which is exactly `core` (4) plus the two `null`-attributed ones retained per #50.
 *
 * SURVIVAL IS READ FROM `rungs.json`, NOT FROM THE CONTRACT, AND THE DISTINCTION IS THE WHOLE
 * SOUNDNESS ARGUMENT. `eject.mjs` rewrites the manifest to `rungs.filter(r => retain.has(r.id))`,
 * so it names the surviving rungs independently of the file under test. Deriving survival from
 * the contract's own `x-emitted-by` would be the vacuous loop #987 refuted one level over:
 * deleting a branch would remove it from the expected set AND the actual one, so the deletion
 * could not fail. The ATTRIBUTION is frozen here beside each variant; only membership is read.
 *
 * WHAT THAT BUYS IN A FORK. Today an eject that dropped `data-plan` while removing langgraph
 * would be invisible -- the fork simply has fewer variants and nothing says which. Under this
 * form the expected set still contains it, because `open-swe` is still in that fork's manifest,
 * and the run fails naming it.
 *
 * SO THE POPULATION IS FROZEN BEFORE ANY OF IT IS FILLED, and the order is the point. Filling
 * nine variants needs a producer enumeration per variant -- `data-approval-required` had TWO
 * producers and taking the shape from one would have been wrong about the other (#970) -- which
 * is slow, and the set can drift while it runs. Freezing first means each fill happens against
 * a population that is ASSERTED rather than assumed, and a tenth variant appearing during the
 * work fires rather than joining silently.
 *
 * IT COMMITS TO NONE OF THE DECISIONS. Whether a given payload SHOULD be shaped is open --
 * `data-*` payloads are this repo's declared extension point, and
 * `scripts/sse_frame_conformance.py` records that `additionalProperties: false` binds a frame's
 * OWN keys and deliberately does not reach inside `data`. Declaring a shape is compatible with
 * that; declaring `additionalProperties: false` inside `data` is not, and nothing here asks for
 * it.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const schemaPath = path.resolve(
  __dirname,
  "../../../docs/sse-frame-schema.json"
);

const contract = JSON.parse(fs.readFileSync(schemaPath, "utf-8")) as {
  oneOf: Array<Record<string, any>>;
};

/**
 * Every `data-*` variant, and whether the contract says ANYTHING about its payload.
 *
 * `false` is not a defect list and not an approval: it records that the contract currently
 * describes nothing, which is a fact about the document rather than a judgement about whether
 * it should. Measured at `fd4c3498`.
 */
const FROZEN: Record<
  string,
  { emittedBy: string | null; declaresShape: boolean }
> = {
  "data-agents-md": { emittedBy: null, declaresShape: false },
  "data-approval": { emittedBy: "open-swe", declaresShape: false },
  "data-approval-pause": { emittedBy: "core", declaresShape: false },
  "data-approval-required": { emittedBy: "core", declaresShape: true },
  "data-error": { emittedBy: "core", declaresShape: true },
  "data-file": { emittedBy: "deepagents", declaresShape: false },
  "data-human-response": { emittedBy: "core", declaresShape: true },
  "data-plan": { emittedBy: "open-swe", declaresShape: false },
  "data-sub-agent": { emittedBy: "deepagents", declaresShape: false },
  "data-task": { emittedBy: null, declaresShape: false },
  "data-testing": {
    emittedBy: "software-developer-agent",
    declaresShape: false,
  },
  "data-todo": { emittedBy: "deepagents", declaresShape: false },
};

/**
 * The rungs THIS tree still has, from the manifest the ejector rewrites -- never from the
 * contract, which is the file under test.
 */
const survivingRungs = new Set(
  (
    JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "../../../rungs.json"), "utf-8")
    ) as { rungs: Array<{ id: string }> }
  ).rungs.map((r) => r.id)
);

/** `core` and `null` survive every eject by construction; a rung-attributed variant survives iff its rung does. */
const survivesHere = (emittedBy: string | null): boolean =>
  emittedBy === null || emittedBy === "core" || survivingRungs.has(emittedBy);

const EXPECTED_HERE = Object.entries(FROZEN)
  .filter(([, f]) => survivesHere(f.emittedBy))
  .map(([type]) => type)
  .sort();

/** A payload is SHAPED if the contract names any property or requires any field of it. */
const shapedIn = (branch: Record<string, any>): boolean => {
  const data = branch.properties?.data ?? {};
  return (
    Object.keys(data.properties ?? {}).length > 0 ||
    (data.required ?? []).length > 0
  );
};

describe("the contract's payload coverage is frozen (#988)", () => {
  const dataVariants = () =>
    contract.oneOf
      .map((b) => ({ type: b.properties?.type?.const as string, branch: b }))
      .filter((v) => typeof v.type === "string" && v.type.startsWith("data-"));

  it("the SET of data-* variants is exactly the frozen set INTERSECTED with this tree's rungs", () => {
    expect(
      dataVariants()
        .map((v) => v.type)
        .sort()
    ).toEqual(EXPECTED_HERE);
  });

  for (const type of EXPECTED_HERE) {
    const expected = FROZEN[type].declaresShape;
    it(`${type} ${
      expected ? "declares" : "does NOT declare"
    } a payload shape`, () => {
      const v = dataVariants().find((x) => x.type === type);
      expect(v, `no branch declares type ${type}`).toBeDefined();
      expect(shapedIn(v!.branch)).toBe(expected);
    });
  }

  /*
   * THE NON-VACUITY COMPANION, AND ITS FLOOR IS TREE-RELATIVE. Every case above is satisfied by
   * a contract with no data-* variants at all: an empty population trivially equals an empty
   * expected set and the per-variant loop runs zero times. A fixed floor of 10 would be wrong in
   * a fork, so the floor is the part that survives EVERY eject -- `core` plus the two
   * `null`-attributed variants retained per #50, which is SIX. The 2-langgraph fork carries
   * exactly that.
   *
   * AND THE SECOND ASSERTION IS DELIBERATELY WEAK: `toBeLessThan(length)` says AT LEAST ONE is
   * unshaped, not that most are. The name claimed a majority, and that sentence is already
   * false in a tree this comment names -- at the six-variant floor the 2-langgraph fork carries
   * three shaped and three unshaped, which is exactly half. Tightening the assertion to a real
   * majority is the WRONG repair: it would go red in that fork, where the population is correct
   * and this check is doing its job. So the sentence moves to what the assertion enforces,
   * which holds in every tree. What that still buys is the case it exists for -- a contract
   * where `shapedIn` answers true for everything cannot pass here vacuously.
   */
  it("...and the surviving population is non-empty and not ENTIRELY shaped, so the freeze is not vacuous", () => {
    const alwaysPresent = Object.values(FROZEN).filter(
      (f) => f.emittedBy === null || f.emittedBy === "core"
    ).length;
    expect(alwaysPresent).toBe(6);
    expect(dataVariants().length).toBeGreaterThanOrEqual(alwaysPresent);
    const shaped = dataVariants().filter((v) => shapedIn(v.branch)).length;
    expect(shaped).toBeLessThan(dataVariants().length);
  });
});

/*
 * WHAT A GREEN HERE DOES NOT SAY.
 *
 * IT DOES NOT DISTINGUISH A DEFECT FROM A TRUE NEGATIVE, AND THAT REQUIREMENT IS UNMET RATHER
 * THAN DROPPED. A variant declaring nothing while a producer emits eight fields, and a variant
 * declaring nothing because nothing is emitted, are both `false` above. Telling them apart needs
 * a per-variant PRODUCER enumeration, which nobody has taken -- and it must not be taken from
 * the client's registered schemas, because those are a second DOCUMENT rather than the emitter;
 * filling from them would restore agreement between two documents while leaving both untested
 * against what ships, which is #951's defect one level up.
 *
 * A FIRST ATTEMPT AT THAT COLUMN WAS WRONG AND IS RECORDED HERE SO IT IS NOT REPEATED. Counting
 * client fields with `Object.keys(schema.shape ?? {}).length` returns 0 for every UNION, because
 * `.shape` is undefined there -- so `data-testing`, a discriminated union of two shaped members,
 * scored 0 and was reported as a true negative. The `?? {}` turned an inapplicable query into a
 * plausible number, and a plausible number is the dangerous output: a throw announces itself, a
 * zero blends in with the real ones.
 *
 * IT SAYS NOTHING ABOUT WHETHER THE THREE SHAPED VARIANTS ARE RIGHT. #987 pins their
 * requiredness and #970 took their shapes from the emitters; this only records that they are
 * shaped at all.
 *
 * AND IT REACHES ONE LEVEL INTO `data` ONLY, consistent with #987's frozen list and #989's
 * reader: a shape declared deeper inside a payload object is neither seen nor counted.
 *
 * `expect(alwaysPresent).toBe(6)` IS A TRIPWIRE, NOT COVERAGE, and is named as one so nobody
 * reads it as the latter. It counts entries in the FROZEN literal above it, so it cannot fail
 * for any reason outside this file: it fires when someone edits the table, which is exactly its
 * job -- forcing the eject-survival floor to be changed consciously rather than drifting along
 * with the table. No tree, no producer and no schema can move it.
 *
 * `survivesHere` TREATS `core` AND `null` AS SURVIVING BY CONSTRUCTION, and nothing enforces
 * that. It is a premise about scripts/eject.mjs held in THIS file: `core` is never a rung, and
 * #50 ruled the two `null`-attributed variants are retained. Both are true today and neither is
 * asserted here or there, so the day someone teaches the ejector to prune by attribution this
 * floor becomes wrong silently rather than loudly -- declared in one place, depended on in
 * another, with no check at the seam.
 */
