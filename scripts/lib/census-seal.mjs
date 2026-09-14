/**
 * A CHECKSUM OVER THE CENSUS'S DERIVED FIELDS, SO "EVERY ROW CAME FROM ONE TREE" IS CHECKABLE (#1167).
 *
 * `baseNote` states the census's job: to say every row came from ONE tree and to name which. It
 * also explains, correctly, that `measuredAt`'s REACHABILITY can never be enforced. This is the
 * part that can be: a file assembled from two runs cannot reproduce either run's seal.
 *
 * THE BOUNDARY IS A RULE, AND EVERY FIELD IS ON ONE SIDE OF IT. A field is SEALED when the
 * PRODUCER originates it and a consumer reads it; it is FREE when a documented flow asks a HUMAN to
 * write it. The census has ten row fields and this lists all ten, because a reader who cannot see
 * where the boundary falls cannot trust the "what it cannot catch" paragraph below.
 *
 *   SEALED   verdict, full, ejected, why      the classification and its counts
 *            liftsDefaultedAt                 a stamp saying HOW a value arrived (producer, #1071)
 *            noteWrittenAt                    the producer's stamp for an authored note (stampFor)
 *            retainedFrom                     the #850 quarantine, built by the producer
 *   FREE     note, lifts                      the gate's own remedy tells a person to write these
 *            liftsRuledAt                     a person's ruling on a defaulted value; the producer
 *                                             CARRIES it (`old.liftsRuledAt ?? null`), never mints it
 *
 * ARCHITECT FOUND liftsDefaultedAt OUTSIDE BOTH LISTS, and it was reachable rather than theoretical:
 * rewriting its sha to zeros and its date to 2020 left the gate at exit 0. Applying the rule instead
 * of patching the one field showed `noteWrittenAt` and `retainedFrom` sat in the same gap.
 *
 * WIDENING THIS LIST INVALIDATES EVERY COMMITTED SEAL, and the repair is a REGENERATION, because
 * there is deliberately no command that re-seals a file. That cost is the point: it is what keeps
 * the field from being refreshed by whoever finds a red inconvenient.
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
export const SEALED_ROW_FIELDS = [
  "verdict",
  "full",
  "ejected",
  "why",
  "liftsDefaultedAt",
  "noteWrittenAt",
  "retainedFrom",
];

/** The fields a person is told to write. Listed so the partition is total and checkable. */
export const AUTHORED_ROW_FIELDS = ["note", "lifts", "liftsRuledAt"];

/**
 * Key order must not change an answer: three sealed fields are OBJECTS, and a re-serialisation that
 * reorders their keys is not an edit. Sorted, recursively, so only VALUES can move the seal.
 */
function stable(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  return `{${Object.keys(v)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
    .join(",")}}`;
}

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
        .map(stable)
        .join(" ");
    });
  return [...head, ...rows].join("\n");
}

export const sealOf = (census) =>
  createHash("sha256").update(canonicalDerived(census)).digest("hex");
