/**
 * A CHECKSUM OVER THE CENSUS'S DERIVED FIELDS, SO "EVERY ROW CAME FROM ONE TREE" IS CHECKABLE (#1167).
 *
 * `baseNote` states the census's job: to say every row came from ONE tree and to name which. It
 * also explains, correctly, that `measuredAt`'s REACHABILITY can never be enforced. This is the
 * part that can be: a file assembled from two runs cannot reproduce either run's seal.
 *
 * WHAT IS BOUND. The four scalars that name the tree, and every row's DERIVED fields. NOT the
 * authored ones (`note`, `lifts`, `liftsRuledAt`, `retainedFrom`, `noteWrittenAt`): roughly half
 * the entries carry a hand-written ruling, #834 restorations edit them on purpose, and a seal that
 * made prose unwritable would be a worse artifact than the one it protects.
 *
 * `measuredAtParents` IS BOUND FOR A MEASURED REASON (TEAMLEAD, from DEV1's artifacts): in a
 * hunk-wise merge git carried it through untouched and WRONG -- `census-M-merged` holds A's
 * `measuredAt` and `measuredAtParents: 1` over a two-parent tree whose rows came from both sides.
 *
 * WHAT IT CANNOT CATCH, stated here so it is not discovered as a surprise:
 *   1. a merge resolved by taking one side WHOLESALE -- accepted, and correct: that file is a
 *      self-consistent snapshot of one tree, and it is the cheap remedy to recommend;
 *   2. a hand edit that was RE-SEALED -- which is why there is no reseal flag and no helper, and
 *      why the producer's single write is the only writer of this field;
 *   3. two runs whose derived rows are byte-identical -- indistinguishable by rows alone;
 *   4. staleness against HEAD -- out of scope: the census is an identity at `measuredAt`.
 *
 * NO SIDE EFFECTS ON IMPORT. The producer and the gate both import this, and a module that does
 * work merely by being loaded would make the gate depend on the producer's behaviour.
 */
import { createHash } from "node:crypto";

export const SEALED_SCALARS = [
  "measuredAt",
  "base",
  "measuredAtParents",
  "ejectTarget",
];
export const SEALED_ROW_FIELDS = ["verdict", "full", "ejected", "why"];

/** The exact bytes the seal is taken over. Sorted by row name, so re-serialisation cannot move it. */
export function canonicalDerived(census) {
  const head = SEALED_SCALARS.map(
    (k) => `${k}=${JSON.stringify(census?.[k] ?? null)}`
  );
  const rows = Object.keys(census?.checkers ?? {})
    .sort()
    .map((name) => {
      const e = census.checkers[name] ?? {};
      return [name, ...SEALED_ROW_FIELDS.map((f) => e[f])]
        .map((v) => JSON.stringify(v ?? null))
        .join(" ");
    });
  return [...head, ...rows].join("\n");
}

export const sealOf = (census) =>
  createHash("sha256").update(canonicalDerived(census)).digest("hex");
