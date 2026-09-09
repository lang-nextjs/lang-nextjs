/**
 * Blank the comments in a JS/TS source, preserving every byte offset.
 *
 * ONE COPY, BECAUSE THERE WERE ABOUT TO BE SIX. Four checkers converted away from
 * regex comment stripping in two days (#1134, #1141, #1149) and each carried its
 * own copy of this loop. The copies had already drifted: #1142's took LEADING
 * trivia only and flagged a palette class written in a trailing comment, and the
 * same omission in the argv checker read an import clause as importing nothing.
 * A defect in a copied loop is a defect per copy.
 *
 * BLANKS RATHER THAN REMOVES, so no line number shifts. A finding that points at
 * the wrong line sends the reader to innocent code, which is barely better than no
 * finding — measured on assert-child-process-argv-form against the pre-#736 tree.
 *
 * LEADING **AND TRAILING** TRIVIA. TypeScript classifies a comment on the same
 * line as the preceding token as TRAILING, and `getLeadingCommentRanges` does not
 * return those. Taking only the leading ones misses a comment after a statement,
 * inside an object literal, an array, a call argument list, an import clause, or
 * between class members — six of seven positions.
 *
 * UTF-16 CODE UNITS, NOT CODE POINTS. TypeScript's comment ranges are UTF-16
 * offsets; `[...src]` splits into code POINTS, so one astral character shifts
 * every index after it and the blanking lands on the wrong bytes. Caught by the
 * length invariant below rather than by review.
 *
 * RETURNS null RATHER THAN THE INPUT when the file does not parse, or when the
 * result would not be offset-preserving. An unparsed file yields no findings,
 * which reads exactly like a clean one — so callers must be able to tell the two
 * apart, and this is the seam that lets them.
 */
export function blankComments(ts, source, file = "f.ts") {
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    /x$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  if ((sf.parseDiagnostics ?? []).length > 0) return null;

  const out = source.split("");
  const seen = new Set();
  const take = (ranges) => {
    for (const r of ranges ?? []) {
      const key = `${r.pos}:${r.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      for (let i = r.pos; i < r.end; i++) if (out[i] !== "\n") out[i] = " ";
    }
  };
  const visit = (node) => {
    take(ts.getLeadingCommentRanges(source, node.getFullStart()));
    take(ts.getTrailingCommentRanges(source, node.getEnd()));
    node.getChildren(sf).forEach(visit);
  };
  visit(sf);

  const blanked = out.join("");
  const nl = (t) => (t.match(/\n/g) ?? []).length;
  if (blanked.length !== source.length || nl(blanked) !== nl(source))
    return null;
  return blanked;
}
