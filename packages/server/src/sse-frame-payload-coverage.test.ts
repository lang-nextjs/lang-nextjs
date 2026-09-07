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
const DECLARES_PAYLOAD_SHAPE: Record<string, boolean> = {
  "data-agents-md": false,
  "data-approval": false,
  "data-approval-pause": false,
  "data-approval-required": true,
  "data-error": true,
  "data-file": false,
  "data-human-response": true,
  "data-plan": false,
  "data-sub-agent": false,
  "data-task": false,
  "data-testing": false,
  "data-todo": false,
};

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

  it("the SET of data-* variants is exactly the frozen set", () => {
    expect(
      dataVariants()
        .map((v) => v.type)
        .sort()
    ).toEqual(Object.keys(DECLARES_PAYLOAD_SHAPE).sort());
  });

  for (const [type, expected] of Object.entries(DECLARES_PAYLOAD_SHAPE)) {
    it(`${type} ${
      expected ? "declares" : "does NOT declare"
    } a payload shape`, () => {
      const v = dataVariants().find((x) => x.type === type);
      expect(v, `no branch declares type ${type}`).toBeDefined();
      expect(shapedIn(v!.branch)).toBe(expected);
    });
  }

  /*
   * THE NON-VACUITY COMPANION. Every case above is satisfied by a contract with no data-*
   * variants at all -- an empty population trivially equals an empty frozen set, and the
   * per-variant loop would run zero times. That is the shape this file exists to name, so it
   * must not be the shape this file has.
   */
  it("...and the population is non-empty and mostly UNSHAPED, so the freeze is not vacuous", () => {
    const shaped = dataVariants().filter((v) => shapedIn(v.branch)).length;
    const total = dataVariants().length;
    expect(total).toBeGreaterThan(10);
    expect(shaped).toBeLessThan(total);
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
 */
