/**
 * THE ONE EXTRACTOR. Reads a README's Quick Start and says what is in it.
 *
 * WHY THIS FILE EXISTS (#478). Six packages carry a `readme-quickstart.test.*`
 * whose header calls it "the executable form of the README so the docs can't
 * drift silently from the API". Measured, NONE of them reads a README:
 * `fs`/`readFileSync`/`node:fs` occurrences across all six is ZERO, the snippet
 * is hardcoded in the test file, and packages/server's own comment says
 * "paraphrased from packages/server/README.md".
 *
 * So they assert that A COPY OF A SNIPPET COMPILES AND RUNS. That is a real
 * property and it is not the one the name claims: if a README's Quick Start
 * changed to a wrong symbol tomorrow, all six stay green. This module makes the
 * PUBLISHED TEXT the subject.
 *
 * ── ONE EXTRACTOR, NOT SIX ─────────────────────────────────────────────────
 *
 * Six copies drift, which is the finding that produced the issue. Everything
 * below is pure and exported; the checker and its selftest both import it, so
 * the thing under test and the thing in production cannot diverge.
 *
 * ── ASK THE PARSER, NOT THE TEXT — AND WHERE THERE IS NO PARSER, REFUSE ─────
 *
 * Snippet analysis uses the REAL TypeScript compiler (`ts.createSourceFile`),
 * already a root devDependency, so import specifiers and bindings come from an
 * AST rather than a regex.
 *
 * Markdown has no parser in this tree — `marked`, `remark-parse`,
 * `mdast-util-from-markdown` and `micromark` are all present in the pnpm store
 * as transitive deps of something else and NONE resolves from the root, so
 * using one means declaring a new dependency on a repo where a lockfile edit
 * collides with everyone. Measured, not assumed: each was import()ed and each
 * threw ERR_MODULE_NOT_FOUND.
 *
 * The fence scan below is therefore a text scan, and it is safe for exactly one
 * reason: IT REFUSES EVERY CASE IT CANNOT HANDLE rather than guessing. Indented
 * fences, `~~~` fences and unbalanced fences all throw. A text scanner that
 * silently mishandles a corner case is the defect this issue is about, one
 * level up; a text scanner that fails closed on anything outside its stated
 * grammar is a narrow parser with an honest error message.
 *
 * If the READMEs ever need the full grammar, take the dependency — do not widen
 * these regexes.
 */
import ts from "typescript";

/** Raised for anything this module refuses to interpret. */
export class RefusedExtraction extends Error {}

const FENCE = /^```(.*)$/;
const INDENTED_FENCE = /^[ \t]+```/;
const TILDE_FENCE = /^~~~/;
const HEADING = /^(#{1,6})\s+(.*?)\s*$/;

/**
 * Every fenced block in the document, with the line it opens on.
 *
 * Throws rather than guessing on anything outside the stated grammar.
 */
export function scanFences(markdown, { label = "<markdown>" } = {}) {
  const lines = markdown.split("\n");
  const blocks = [];
  let open = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (TILDE_FENCE.test(line))
      throw new RefusedExtraction(
        `${label}:${
          i + 1
        }: a ~~~ fence. This scanner only handles \`\`\` fences and will not guess at the rest of the grammar — see the header.`
      );
    // An indented fence is legal CommonMark and changes where the block ends.
    // Refusing is the difference between a narrow parser and a wrong one.
    if (INDENTED_FENCE.test(line) && open === null)
      throw new RefusedExtraction(
        `${label}:${
          i + 1
        }: an indented \`\`\` fence. This scanner only handles fences at column 0 — see the header.`
      );

    const m = FENCE.exec(line);
    if (!m) {
      // INSIDE a block, every non-fence line IS the snippet. The first version
      // of this loop created `body: []` and never appended to it, so every
      // block came back with a real language tag, real line numbers and an
      // EMPTY body — and `documentedSymbols` dutifully reported no symbols.
      // Caught by the printed line count reading 0, which is the whole reason
      // the checker prints what it extracted instead of only whether it
      // succeeded.
      if (open !== null) open.body.push(line);
      continue;
    }

    if (open === null) {
      open = { lang: m[1].trim(), startLine: i + 1, body: [] };
    } else {
      blocks.push({
        lang: open.lang,
        code: open.body.join("\n"),
        startLine: open.startLine,
        endLine: i + 1,
        lineCount: open.body.length,
      });
      open = null;
    }
  }

  if (open !== null)
    throw new RefusedExtraction(
      `${label}:${open.startLine}: fence opened and never closed. Refusing rather than treating the rest of the file as code.`
    );

  return blocks;
}

/** Every ATX heading, with its depth and line. */
export function scanHeadings(markdown) {
  const out = [];
  const lines = markdown.split("\n");
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    // A `#` inside a code block is not a heading. Missing this is how a
    // section range silently swallows the rest of the file.
    if (inFence) continue;
    const m = HEADING.exec(lines[i]);
    if (m) out.push({ depth: m[1].length, text: m[2], line: i + 1 });
  }
  return out;
}

/**
 * The Quick Start blocks, plus the evidence needed to believe them.
 *
 * Returns `allFences` alongside `blocks` so the caller can assert by SET
 * DIFFERENCE that what came back is exactly the Quick Start's blocks and not
 * merely SOME blocks — a extractor that returned the Installation snippet
 * would otherwise look identical to one that worked.
 */
export function quickStartBlocks(markdown, { label = "<markdown>" } = {}) {
  const allFences = scanFences(markdown, { label });
  const headings = scanHeadings(markdown);

  const starts = headings.filter((h) => /^Quick Start\b/i.test(h.text));
  if (starts.length === 0)
    throw new RefusedExtraction(
      `${label}: no heading matching /^Quick Start/i. The section was renamed or removed, so there is nothing to check — refusing rather than reporting a clean run over an empty extraction.`
    );

  const sections = starts.map((h) => {
    const next = headings.find((o) => o.line > h.line && o.depth <= h.depth);
    return { heading: h.text, from: h.line, to: next ? next.line : Infinity };
  });

  const blocks = allFences
    .filter((b) =>
      sections.some((s) => b.startLine > s.from && b.startLine < s.to)
    )
    .map((b) => ({
      ...b,
      heading: sections.find((s) => b.startLine > s.from && b.startLine < s.to)
        .heading,
    }));

  if (blocks.length === 0)
    throw new RefusedExtraction(
      `${label}: the Quick Start heading exists but contains no fenced block. An empty extraction must not run as an empty snippet and pass — that is the defect this checker exists for.`
    );

  return { blocks, allFences, sections };
}

/**
 * What a snippet DOCUMENTS, read off the TypeScript AST rather than the text.
 *
 * `selfSpecifier` is the package's own name: bindings imported from it are
 * claims about this package's public surface and are what the checker verifies.
 * Imports of anything else are recorded but not asserted — a Quick Start may
 * legitimately import a peer.
 */
/**
 * The parser dialect a fenced block must be read as.
 *
 * JSX IS NOT A SUPERSET-COMPATIBLE PARSE. A `tsx` block read with
 * ScriptKind.TS fails on the first `<Component />` with "Type expected", and
 * the checker then reports a documentation defect against a README that is
 * correct — a false finding, which is worse than a missed one because someone
 * will act on it. Measured: react's Quick Start tsx block at L192.
 */
export function scriptKindFor(lang) {
  const l = (lang || "").toLowerCase();
  if (l === "tsx" || l === "jsx") return ts.ScriptKind.TSX;
  return ts.ScriptKind.TS;
}

export function documentedSymbols(
  code,
  selfSpecifier,
  { label = "<snippet>", lang = "typescript" } = {}
) {
  const sf = ts.createSourceFile(
    `${label}.ts`,
    code,
    ts.ScriptTarget.ES2022,
    true,
    scriptKindFor(lang)
  );

  const ownSymbols = [];
  const ownTypes = [];
  const foreignSpecifiers = [];
  const destructured = [];

  const visit = (node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const spec = node.moduleSpecifier.text;
      // TYPE IMPORTS ARE NOT RUNTIME EXPORTS, and conflating them makes the
      // checker wrong in the direction that costs most: `import type
      // { DeepAgentsState }` is erased at compile time, so asserting it exists
      // on the module namespace fails against a package that is entirely
      // correct. sveltekit's Quick Start has exactly this shape. Both the
      // clause-level (`import type {...}`) and element-level (`import
      // { type X }`) spellings are checked, because either alone leaves a hole.
      const values = [];
      const types = [];
      const clause = node.importClause;
      const clauseIsType = clause?.isTypeOnly === true;
      if (clause?.name) (clauseIsType ? types : values).push(clause.name.text);
      if (clause?.namedBindings) {
        if (ts.isNamedImports(clause.namedBindings))
          for (const el of clause.namedBindings.elements)
            (clauseIsType || el.isTypeOnly ? types : values).push(el.name.text);
        else if (ts.isNamespaceImport(clause.namedBindings))
          (clauseIsType ? types : values).push(clause.namedBindings.name.text);
      }
      if (spec === selfSpecifier) {
        ownSymbols.push(...values);
        ownTypes.push(...types);
      } else foreignSpecifiers.push(spec);
    }
    // `const { messages, sendMessage } = useDeepAgentsChat(...)` — the
    // documented RETURN shape. Recorded and printed; see the checker for why
    // it is not asserted from here.
    if (
      ts.isVariableDeclaration(node) &&
      node.name &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression)
    ) {
      destructured.push({
        callee: node.initializer.expression.text,
        names: node.name.elements.map((e) => e.name.getText(sf)),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return { ownSymbols, ownTypes, foreignSpecifiers, destructured };
}

/**
 * Does the snippet parse as TypeScript at all?
 *
 * A Quick Start that no longer compiles is drift too, and it is the kind a
 * human reviewer skims past.
 */
export function syntaxErrors(
  code,
  { label = "<snippet>", lang = "typescript" } = {}
) {
  const host = ts.createSourceFile(
    `${label}.tsx`,
    code,
    ts.ScriptTarget.ES2022,
    true,
    scriptKindFor(lang)
  );
  // `parseDiagnostics` is not on the public type but is the only way to get
  // syntax-only errors without a full program; guarded so a compiler upgrade
  // that removes it fails loudly here rather than reporting zero errors.
  const diags = host.parseDiagnostics;
  if (!Array.isArray(diags))
    throw new RefusedExtraction(
      `${label}: this TypeScript build does not expose parseDiagnostics, so "no syntax errors" would be a statement about the probe rather than the snippet.`
    );
  return diags.map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));
}

/**
 * The package's PUBLISHED surface, read from the .d.ts its own manifest names.
 *
 * NOT by importing the module. A runtime import proves more but answers a
 * different question and fails for reasons that are not drift — measured,
 * `packages/server`'s built entry throws ERR_MODULE_NOT_FOUND on `next/server`
 * in a bare node process, and `packages/edge` has no `import` condition at all,
 * so two of six packages would report a documentation defect when the
 * documentation is fine. The existing per-package vitest tests already exercise
 * runtime construction inside a runtime that has the peers; this reads what a
 * consumer's compiler sees.
 *
 * The `types` entry is taken from `exports` — both the flat shape edge uses and
 * the import/require shape everyone else uses — so the file checked is the file
 * the manifest publishes, rather than a path this script guessed.
 */
export function publishedExports(
  packageJson,
  dtsSource,
  { label = "<pkg>" } = {}
) {
  const sf = ts.createSourceFile(
    `${label}.d.ts`,
    dtsSource,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS
  );
  const values = new Set();
  const types = new Set();

  const isExported = (n) =>
    n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;

  for (const st of sf.statements) {
    if (
      ts.isExportDeclaration(st) &&
      st.exportClause &&
      ts.isNamedExports(st.exportClause)
    ) {
      for (const el of st.exportClause.elements)
        (st.isTypeOnly || el.isTypeOnly ? types : values).add(el.name.text);
      continue;
    }
    if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) {
      if (isExported(st)) types.add(st.name.text);
      continue;
    }
    if (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) {
      if (isExported(st) && st.name) values.add(st.name.text);
      continue;
    }
    if (ts.isVariableStatement(st) && isExported(st)) {
      for (const d of st.declarationList.declarations)
        if (ts.isIdentifier(d.name)) values.add(d.name.text);
    }
  }

  if (values.size === 0 && types.size === 0)
    throw new RefusedExtraction(
      `${label}: parsed the published .d.ts and found NO exports at all. A package exports something; zero means this probe failed, and "every documented symbol is present" would be vacuously true.`
    );

  return { values, types };
}

/** The `types` path the manifest publishes for the root entry. */
export function typesEntry(packageJson, { label = "<pkg>" } = {}) {
  const root = packageJson.exports?.["."];
  const candidate =
    root?.types ??
    root?.import?.types ??
    root?.require?.types ??
    packageJson.types;
  if (!candidate)
    throw new RefusedExtraction(
      `${label}: no \`types\` entry under exports["."] or at the manifest root, so there is no published surface to check against.`
    );
  return candidate;
}

/**
 * Which packages are unaccounted for, and which listed ones no longer exist.
 *
 * Pure, and exported, so the proof can plant both directions. Lives here rather
 * than inline in the checker for the same reason everything else does: a guard
 * that cannot be tested is a guard nobody has watched fail.
 */
export function accountedFor(existingDirs, checkedDirs, noReadmeDirs) {
  const accounted = new Set([...checkedDirs, ...noReadmeDirs]);
  return {
    unaccounted: existingDirs.filter((d) => !accounted.has(d)),
    phantom: [...accounted].filter((d) => !existingDirs.includes(d)),
    duplicated: checkedDirs.filter((d) => noReadmeDirs.includes(d)),
  };
}
