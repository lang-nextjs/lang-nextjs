import type { Run } from "./types";

/**
 * WHAT CAME BACK FROM A POLL, AND WHAT HAD TO BE THROWN AWAY TO USE IT (#243).
 *
 * `dropped` is carried rather than swallowed. The board's whole design rule is
 * that it must not make work disappear — run-board.ts keeps an `other` column
 * so "a backend that grows a state should make this column appear, not make
 * runs disappear." Silently filtering unusable entries would break that rule
 * quietly, which is worse than breaking it loudly.
 */
export interface ParsedRuns {
  runs: Run[];
  /** Entries present in the response that could not be rendered as a run. */
  dropped: number;
}

/** A run has to be an object with an id, or there is nothing to show or open. */
function isRenderable(v: unknown): v is Run {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const id = (v as { run_id?: unknown }).run_id;
  return typeof id === "string" && id.length > 0;
}

/**
 * PARSE, DO NOT CAST (#243).
 *
 * This existed as `(await res.json()) as Run[]` — an assertion to the compiler
 * that the network had kept a promise, with nothing checking that it had. A 200
 * carrying `{"runs": []}` was stored as if it were an array, iterated during
 * render, and threw `runs is not iterable`. React's error boundary then replaced
 * the entire page, including the runs already on screen.
 *
 * The comparison is the point, and it is why this was a defect and not a shrug:
 * on a 500 the caller carefully preserves the board, shows the error, and
 * recovers on the next tick. On a malformed 200 it destroyed the page and could
 * NOT recover, because the boundary had unmounted the component that polls. The
 * careless path delivered exactly the failure the careful path exists to prevent.
 *
 * So a body that is not an array is an ERROR, routed to the path that already
 * handles errors well. Entries inside an array that cannot be rendered are
 * counted and reported, because a response that is 90% usable should show those
 * 90% rather than blank the board.
 *
 * @throws {TypeError} if the body is not an array at all.
 */
export function parseRuns(body: unknown): ParsedRuns {
  if (!Array.isArray(body)) {
    throw new TypeError(
      `Expected a list of runs, got ${describe(
        body
      )}. The board was left as it was.`
    );
  }
  const runs = body.filter(isRenderable);
  return { runs, dropped: body.length - runs.length };
}

/** Names the shape in the error a person will read, without dumping the body. */
function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array"; // unreachable here; kept total
  const t = typeof v;
  if (t === "object") {
    const keys = Object.keys(v as object);
    return keys.length
      ? `an object with keys: ${keys.slice(0, 5).join(", ")}`
      : "an empty object";
  }
  return `a ${t}`;
}

/** The banner text for a partly-usable response. Plural-correct, no "1 runs". */
export function droppedMessage(dropped: number): string {
  return dropped === 1
    ? "1 run in the last update was malformed and is not shown."
    : `${dropped} runs in the last update were malformed and are not shown.`;
}
