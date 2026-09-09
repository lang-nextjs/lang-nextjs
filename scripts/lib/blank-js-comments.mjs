/**
 * Blank JS/TS comments with a CHARACTER SCANNER, preserving every byte offset.
 *
 * NO DEPENDENCY, DELIBERATELY. `eject` is a user-facing tool importing only node
 * builtins; requiring the TypeScript compiler would mean a fork with no
 * devDependencies installed cannot eject at all. `check-langfuse-wiring` sets the
 * precedent with `maskPythonNonCode` for Python.
 *
 * WHAT THIS REPLACES, AND WHY NEITHER EARLIER FORM WAS RIGHT. An UNANCHORED regex
 * is fail-OPEN: a glob inside a comment opens a false block comment, the region is
 * blanked, and a leak reference disappears from a severability gate. Measured, it
 * blanked real code in 47 of 958 files. ANCHORING it (#1158) took that to 3 — but
 * left comment text standing in 549 files and left those three fail-open positions
 * alive, all one shape: a template literal containing source code whose content
 * begins a line with a block-comment opener.
 *
 * THE AMBIGUITY IS NARROWER THAN IT LOOKS, and settling that decided the design.
 * In JavaScript both comment openers are UNAMBIGUOUS in code position:
 *
 *     the line form    an empty regex is illegal, so two slashes ARE a comment
 *     the block form   a regex cannot open with a quantifier, so it is a comment
 *
 * The only ambiguity is a LONE slash beginning a regex literal, whose CONTENTS may
 * contain either opener. Miss the literal and its contents get blanked — fail-open,
 * the exact failure being repaired.
 *
 * SO THE UNCLASSIFIABLE CASE RESOLVES TO "REGEX", NOT TO "COMMENT". Where the
 * preceding token leaves it open whether a slash divides or opens a literal, this
 * treats it as a literal and skips it as CODE. The cost is a comment left standing
 * — a false POSITIVE, a leak reported that is only a mention — which is the
 * direction this scan must err in. Decided before writing rather than discovered as
 * a behaviour, so it stays a decision rather than becoming one.
 *
 * THE RESIDUAL, NAMED — AND MY FIRST STATEMENT OF IT WAS WRONG IN A WAY WORTH
 * RECORDING. I wrote that what remained was "a regex after some word-shaped
 * operator position absent from the keyword list", and that I could not construct
 * one. DEV3 constructed four, three of which are not word-shaped: a `)` closing an
 * `if`, `while` or `for` head is an operand position, and my header had listed a
 * closing bracket among the places where division is settled.
 *
 * So the boundary is OPERAND POSITION, and both the keyword list and the value-end
 * character class are proxies for it. Both are now narrower than the property, and
 * that is the residual: a construct that opens an operand position by some route
 * neither proxy covers would read as division, its regex body would be scanned as
 * code, and a comment opener inside it would be blanked. Fail-open.
 *
 * The proxies also OVER-fire, which is safe: `obj.in / 2` reads as a regex because a
 * property may be named `in`. That direction leaves a comment standing rather than
 * removing code, so it is corrected where cheap — the keyword pattern now refuses a
 * preceding dot — and tolerated where not.
 *
 * MEASURED RATHER THAN ARGUED, and the measurement is oracle-free. Blanking comments
 * cannot change whether a program parses, so every case here is checked by parsing
 * the blanked output rather than by comparing against another compiler-based tool —
 * which would share exactly the assumptions being tested.
 */
export function blankJsComments(src) {
  const out = src.split("");
  const n = src.length;
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };
  /*
   * A slash divides only where the previous meaningful character ENDS A VALUE —
   * an identifier, a number, a closing bracket. Everywhere else an operand may
   * begin, so a regex may. The heuristic is incomplete for word operators such as
   * `return`, which is precisely why the fallthrough is "regex" and not "division".
   */
  const VALUE_END = /[A-Za-z0-9_$)\]"'`]/;
  /*
   * A WORD BEFORE A SLASH IS NOT ALWAYS A VALUE. `return /re/` is a regex; `x /re/`
   * is division twice. Both end in a letter, so the character test alone reads the
   * first as division and then scans the regex body AS CODE — and a comment opener
   * inside that body would be blanked. Fail-OPEN, which is the direction this whole
   * change exists to close.
   *
   * These are the positions where an operand may begin even though the preceding
   * character is a letter. The list is not exhaustive over the grammar, and that is
   * the residual named in the header.
   */
  const REGEX_KEYWORD =
    /(?:^|[^\w$.])(return|typeof|instanceof|in|of|new|delete|void|throw|case|default|do|else|yield|await)$/;
  /*
   * A CLOSING PAREN DOES NOT ALWAYS END A VALUE, which is the correction that
   * matters most here. `(a) / 2` divides; `if (x) /re/.test(s)` does not — the paren
   * closes a CONTROL HEAD and an operand may begin after it. DEV3 constructed four
   * fail-open cases from this while reading #1163, three of them not word-shaped at
   * all:
   *
   *     if (x)    /[ * ]/.test(s);      13 code bytes blanked
   *     while (x) /[ * ]/.test(s);      13
   *     for (;;)  /[ * ]/.test(s);      13
   *
   * So the residual was never a gap in a WORD LIST. It is a gap in the notion of
   * OPERAND POSITION, and a keyword list is a proxy for that property rather than
   * the property itself. These parens are tracked so the proxy is not asked to
   * carry a case it cannot express.
   */
  const CONTROL_HEAD = /(?:^|[^\w$.])(if|while|for|switch|catch|with)\s*$/;

  /*
   * A STACK, NOT A DEPTH COUNTER, AND A COUNTER IS WHAT I WROTE FIRST.
   *
   * A template interpolation can contain another template, and that inner template's
   * TEXT can contain a closing brace — `gen-rung-types.mjs` emits TypeScript whose
   * lines end `},`. A counter decremented on every brace exits the interpolation on
   * one of those, then the next backtick closes the OUTER template early, and every
   * comment-shaped thing after it is blanked as though it were code. That file was
   * the single residual my first version left, and it is the file this change exists
   * to fix, so the counter failed on the only case that motivated it.
   *
   * The stack distinguishes "inside a template's text" from "inside an interpolation",
   * so a brace only closes an interpolation and a backtick only closes the template
   * that opened it.
   */
  const stack = [];
  const inTemplateText = () => stack[stack.length - 1] === "tmpl";
  let i = 0;
  let prev = "";

  while (i < n) {
    const c = src[i];

    if (inTemplateText()) {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "$" && src[i + 1] === "{") {
        stack.push("interp");
        i += 2;
        prev = "{";
        continue;
      }
      if (c === "`") {
        stack.pop();
        i++;
        prev = "`";
        continue;
      }
      i++;
      continue;
    }

    /*
     * BRACES ARE TRACKED TOO, AND OMITTING THEM WAS THE SECOND VERSION'S BUG.
     * An interpolation may contain an object literal, and its closing brace popped
     * the interpolation early — after which a comment inside the interpolation was
     * read as template TEXT and left standing. One file in this tree does exactly
     * that: an inline comment beside `{ marker: sym.toString() }` inside a `${...}`.
     * Pushing on every open brace means a brace only ever closes the thing that
     * opened it.
     */
    if (c === "(") {
      stack.push(CONTROL_HEAD.test(src.slice(0, i)) ? "cparen" : "paren");
      i++;
      prev = "(";
      continue;
    }
    if (c === ")") {
      const top = stack.pop();
      i++;
      // A control head's closing paren leaves an OPERAND position, so a slash after
      // it opens a regex. An ordinary one ends a value, so a slash divides.
      prev = top === "cparen" ? "(" : ")";
      continue;
    }
    if (c === "{") {
      stack.push("brace");
      i++;
      prev = "{";
      continue;
    }
    if (c === "}") {
      const top = stack.pop();
      i++;
      prev = "}";
      if (top === "interp") continue;
      continue;
    }

    if (c === "/" && src[i + 1] === "/") {
      let j = i;
      while (j < n && src[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*" + "/", i + 2);
      const end = close === -1 ? n : close + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === "/") {
      const before = src.slice(0, i).replace(/\s+$/, "");
      if (VALUE_END.test(prev) && !REGEX_KEYWORD.test(before)) {
        prev = c;
        i++;
        continue;
      }
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        const d = src[j];
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === "\n") break;
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) {
          j++;
          break;
        }
        j++;
      }
      i = j;
      prev = "/";
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === c || src[j] === "\n") break;
        j++;
      }
      i = j < n && src[j] === c ? j + 1 : j;
      prev = c;
      continue;
    }
    if (c === "`") {
      stack.push("tmpl");
      i++;
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out.join("");
}
