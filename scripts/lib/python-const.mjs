/**
 * Read a module-level Python constant, as written.
 *
 * SHARED BECAUSE TWO CHECKERS ASK THE SAME QUESTION OF THE SAME FILES.
 * check-run-axes-parity compares each rung's `GATED_TOPOLOGIES` across the two
 * planes; check-doc-claims holds a documented gating position against the same
 * constant. Both need "what does this constant say", and a second copy of a
 * bracket matcher is the made-twice divergence those checkers exist to catch —
 * with the added sting that the two would disagree only on the wrapped-literal
 * case neither author would think to test twice.
 *
 * It lives here rather than being imported from one checker into the other so
 * that neither owns the other's correctness, and so a checker that stops using
 * it does not silently take the definition with it.
 */

/** The value of a module-level `NAME = ...`, as written, with balanced brackets.
 *
 *  READS TO THE CLOSING BRACKET RATHER THAN THE END OF THE LINE. Every
 *  GATED_TOPOLOGIES in the tree is a one-liner today, and a line-based reader
 *  would work on all six — right up until someone wraps a long frozenset across
 *  two lines, at which point it silently compares the first line of each and
 *  calls two different sets equal. That is a check whose subject shrinks without
 *  its verdict changing, so it is closed here rather than left to a future
 *  formatter.
 *
 *  Returns null if the constant is absent; the caller decides what absence means.
 */
export function extractConst(src, name) {
  const lines = src.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^${name}\\s*=`).test(l));
  if (start === -1) return null;

  const opens = { "(": ")", "[": "]", "{": "}" };
  const stack = [];
  const out = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);
    // Comments and string contents cannot open a bracket that matters here;
    // strip a trailing `#` comment so `frozenset()  # empty (see note)` closes.
    const code = line.replace(/#.*$/, "");
    for (const ch of code) {
      if (opens[ch]) stack.push(opens[ch]);
      else if (ch === stack[stack.length - 1]) stack.pop();
    }
    if (stack.length === 0) break;
  }
  return out
    .join("\n")
    .replace(new RegExp(`^${name}\\s*=\\s*`), "")
    .trim();
}
