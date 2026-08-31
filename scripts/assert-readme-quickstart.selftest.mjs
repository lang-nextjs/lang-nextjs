#!/usr/bin/env node
/**
 * Proof for assert-readme-quickstart.mjs — the defects are PLANTED, not described.
 *
 * The house rule (CONTRIBUTING.md): adding a selftest is not the fix, planting
 * the defect in it is. Every case below constructs a README or a .d.ts that is
 * wrong in one specific way and asserts this checker's own functions say so.
 *
 * The two CONTROL cases are load-bearing and go first. Every other case asserts
 * a REFUSAL, and a set of only-negative cases stays green when the extractor
 * has stopped extracting anything at all — which is not a hypothetical here:
 * the first version of scanFences returned every block with a correct language
 * tag, correct line numbers and an EMPTY BODY, and every symbol assertion
 * passed against nothing. The control is what goes red for that.
 */
import {
  scanFences,
  scanHeadings,
  quickStartBlocks,
  documentedSymbols,
  syntaxErrors,
  publishedExports,
  typesEntry,
  scriptKindFor,
  accountedFor,
  RefusedExtraction,
} from "./readme-quickstart.mjs";

let pass = 0;
const failures = [];

function ok(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
    console.log(`  FAIL  ${name}: ${e.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function refuses(fn, needle) {
  let threw = null;
  try {
    fn();
  } catch (e) {
    threw = e;
  }
  assert(
    threw instanceof RefusedExtraction,
    `expected RefusedExtraction, got ${
      threw ? threw.constructor.name + ": " + threw.message : "no throw"
    }`
  );
  if (needle)
    assert(
      threw.message.includes(needle),
      `refusal message did not mention "${needle}": ${threw.message}`
    );
}

const GOOD = [
  "# @scope/pkg",
  "",
  "## Installation",
  "",
  "```bash",
  "npm i @scope/pkg",
  "```",
  "",
  "## Quick Start",
  "",
  "```typescript",
  "import { createThing } from '@scope/pkg';",
  "export const POST = createThing({ url: 'x' });",
  "```",
  "",
  "## API Reference",
  "",
  "```typescript",
  "createThing(options)",
  "```",
].join("\n");

console.log("assert-readme-quickstart selftest");

// ── CONTROLS ───────────────────────────────────────────────────────────────

ok(
  "CONTROL: a well-formed README yields ONE block with a NON-EMPTY body",
  () => {
    const { blocks, allFences } = quickStartBlocks(GOOD, { label: "good" });
    assert(
      blocks.length === 1,
      `expected 1 quick-start block, got ${blocks.length}`
    );
    assert(
      allFences.length === 3,
      `expected 3 fences in the file, got ${allFences.length}`
    );
    // THE CASE THAT CATCHES AN EXTRACTOR RETURNING SHELLS.
    assert(
      blocks[0].lineCount === 2,
      `expected a 2-line body, got ${blocks[0].lineCount}`
    );
    assert(
      blocks[0].code.includes("createThing"),
      "body does not contain the snippet text"
    );
    assert(
      blocks[0].lang === "typescript",
      `expected lang typescript, got ${blocks[0].lang}`
    );
  }
);

ok(
  "CONTROL: a documented symbol that IS exported is not reported missing",
  () => {
    const doc = documentedSymbols(
      "import { createThing } from '@scope/pkg';",
      "@scope/pkg"
    );
    assert(
      doc.ownSymbols.length === 1 && doc.ownSymbols[0] === "createThing",
      `expected [createThing], got ${JSON.stringify(doc.ownSymbols)}`
    );
    const pub = publishedExports(
      {},
      "declare function createThing(o: any): void;\nexport { createThing };",
      { label: "p" }
    );
    const missing = doc.ownSymbols.filter((n) => !pub.values.has(n));
    assert(
      missing.length === 0,
      `false positive: reported ${JSON.stringify(missing)} as missing`
    );
  }
);

// ── PLANTED DEFECTS: EXTRACTION MUST REFUSE ────────────────────────────────

ok("PLANT: Quick Start heading with NO fenced block refuses", () => {
  refuses(
    () =>
      quickStartBlocks(
        "# p\n\n## Quick Start\n\nProse only, no code.\n\n## Next\n",
        { label: "empty" }
      ),
    "no fenced block"
  );
});

ok(
  "PLANT: a renamed Quick Start heading refuses rather than finding nothing quietly",
  () => {
    refuses(
      () =>
        quickStartBlocks("# p\n\n## Getting Started\n\n```ts\nx\n```\n", {
          label: "renamed",
        }),
      "no heading matching"
    );
  }
);

ok("PLANT: an unclosed fence refuses instead of swallowing the file", () => {
  refuses(
    () =>
      scanFences("# p\n\n## Quick Start\n\n```typescript\nconst a = 1;\n", {
        label: "unclosed",
      }),
    "never closed"
  );
});

ok("PLANT: an indented fence refuses rather than being mis-scanned", () => {
  refuses(
    () =>
      scanFences("# p\n\n  ```typescript\n  x\n  ```\n", { label: "indented" }),
    "indented"
  );
});

ok("PLANT: a ~~~ fence refuses rather than being ignored", () => {
  refuses(
    () => scanFences("# p\n\n~~~typescript\nx\n~~~\n", { label: "tilde" }),
    "~~~"
  );
});

ok(
  "PLANT: a .d.ts with no exports refuses rather than passing vacuously",
  () => {
    // "every documented symbol is present" is TRUE of an empty published set.
    refuses(
      () => publishedExports({}, "// nothing here\n", { label: "empty-dts" }),
      "NO exports"
    );
  }
);

ok("PLANT: a manifest with no types entry refuses", () => {
  refuses(
    () =>
      typesEntry(
        { exports: { ".": { import: { default: "./dist/i.mjs" } } } },
        { label: "no-types" }
      ),
    "no `types` entry"
  );
});

// ── PLANTED DEFECTS: DRIFT MUST BE REPORTED ────────────────────────────────

ok(
  "PLANT: a README importing a symbol the package does not export is caught",
  () => {
    const doc = documentedSymbols(
      "import { createRenamedThing } from '@scope/pkg';",
      "@scope/pkg"
    );
    const pub = publishedExports(
      {},
      "declare function createThing(o: any): void;\nexport { createThing };",
      { label: "p" }
    );
    const missing = doc.ownSymbols.filter((n) => !pub.values.has(n));
    assert(
      missing.length === 1 && missing[0] === "createRenamedThing",
      `expected createRenamedThing to be missing, got ${JSON.stringify(
        missing
      )}`
    );
  }
);

ok("PLANT: a syntactically broken snippet is reported", () => {
  const errs = syntaxErrors("import { from '@scope/pkg';\nconst = ;", {
    label: "broken",
  });
  assert(
    errs.length > 0,
    "a snippet with unbalanced braces reported zero syntax errors"
  );
});

// ── FALSE-POSITIVE GUARDS — the direction that is worse ────────────────────

ok("GUARD: a type-only import is NOT demanded as a runtime export", () => {
  // Both spellings, because either alone leaves a hole.
  const clause = documentedSymbols(
    "import type { State } from '@scope/pkg';",
    "@scope/pkg"
  );
  assert(
    clause.ownSymbols.length === 0,
    `clause-level type import leaked into values: ${JSON.stringify(
      clause.ownSymbols
    )}`
  );
  assert(
    clause.ownTypes.includes("State"),
    "clause-level type import was not recorded as a type"
  );
  const inline = documentedSymbols(
    "import { type State, createThing } from '@scope/pkg';",
    "@scope/pkg"
  );
  assert(
    inline.ownSymbols.join() === "createThing",
    `element-level type import leaked into values: ${JSON.stringify(
      inline.ownSymbols
    )}`
  );
  assert(
    inline.ownTypes.includes("State"),
    "element-level type import was not recorded as a type"
  );
});

ok("GUARD: a tsx block parses as TSX, not as TS", () => {
  // Read as ScriptKind.TS this fails on the first tag with "Type expected" and
  // the checker reports a documentation defect against a correct README.
  assert(
    scriptKindFor("tsx") !== scriptKindFor("typescript"),
    "tsx and typescript resolved to the same ScriptKind"
  );
  const errs = syntaxErrors("const a = <div className='x'>hi</div>;", {
    label: "jsx",
    lang: "tsx",
  });
  assert(
    errs.length === 0,
    `a valid tsx snippet reported ${errs.length} syntax error(s): ${errs[0]}`
  );
});

ok(
  "GUARD: an import from a PEER package is not demanded from this package",
  () => {
    const doc = documentedSymbols(
      "import { createDenoHandler } from '@scope/edge';\nimport { adapter } from '@scope/server';",
      "@scope/edge"
    );
    assert(
      doc.ownSymbols.join() === "createDenoHandler",
      `peer import leaked into own symbols: ${JSON.stringify(doc.ownSymbols)}`
    );
    assert(
      doc.foreignSpecifiers.includes("@scope/server"),
      "peer specifier was not recorded"
    );
  }
);

ok("GUARD: a '#' inside a code fence is not treated as a heading", () => {
  // Otherwise the Quick Start section's range ends at a comment and the block
  // after it silently drops out of the extraction.
  const md =
    "# p\n\n## Quick Start\n\n```bash\n# not a heading\nnpm i\n```\n\n```typescript\nimport { a } from 'p';\n```\n\n## Next\n";
  const headings = scanHeadings(md);
  assert(
    !headings.some((h) => h.text === "not a heading"),
    "a comment inside a fence was read as a heading"
  );
  const { blocks } = quickStartBlocks(md, { label: "fenced-hash" });
  assert(
    blocks.length === 2,
    `expected both blocks in the section, got ${blocks.length}`
  );
});

ok("GUARD: TWO Quick Start sections both yield their blocks", () => {
  // packages/react really has two `## Quick Start` headings, at L11 and L190.
  // An extractor that takes the first match reports one block and calls the
  // package covered.
  const md =
    "# p\n\n## Quick Start\n\n```typescript\nimport { a } from 'p';\n```\n\n## Middle\n\ntext\n\n## Quick Start\n\n```tsx\nimport { b } from 'p';\n```\n";
  const { blocks } = quickStartBlocks(md, { label: "two-sections" });
  assert(
    blocks.length === 2,
    `expected 2 blocks across both sections, got ${blocks.length}`
  );
  assert(blocks[1].lang === "tsx", `second block lang was ${blocks[1].lang}`);
});

ok(
  "GUARD: every returned block is one of the document's own fences (set difference)",
  () => {
    const { blocks, allFences } = quickStartBlocks(GOOD, { label: "setdiff" });
    const lines = new Set(allFences.map((f) => f.startLine));
    const foreign = blocks.filter((b) => !lines.has(b.startLine));
    assert(
      foreign.length === 0,
      `${foreign.length} returned block(s) are not fences of the document`
    );
    assert(
      blocks.length < allFences.length,
      "every fence was returned — the section filter did nothing"
    );
  }
);

// ── THE SUBJECT LIST ITSELF (#485) ─────────────────────────────────────────

ok("CONTROL: a fully accounted-for workspace reports nothing", () => {
  const r = accountedFor(
    ["packages/a", "packages/b"],
    ["packages/a"],
    ["packages/b"]
  );
  assert(
    r.unaccounted.length === 0,
    `false positive: ${JSON.stringify(r.unaccounted)}`
  );
  assert(r.phantom.length === 0, `false phantom: ${JSON.stringify(r.phantom)}`);
  assert(
    r.duplicated.length === 0,
    `false duplicate: ${JSON.stringify(r.duplicated)}`
  );
});

ok(
  "PLANT: a package in NEITHER list is reported, not silently uncovered",
  () => {
    // The defect that hid packages/rungs, packages/ui AND packages/test-utils:
    // a hand-written list of subjects cannot report what it never mentions.
    const r = accountedFor(
      ["packages/a", "packages/ghost"],
      ["packages/a"],
      []
    );
    assert(
      r.unaccounted.join() === "packages/ghost",
      `expected packages/ghost, got ${JSON.stringify(r.unaccounted)}`
    );
  }
);

ok("PLANT: a listed package that no longer exists is reported", () => {
  const r = accountedFor(
    ["packages/a"],
    ["packages/a", "packages/deleted"],
    []
  );
  assert(
    r.phantom.join() === "packages/deleted",
    `expected packages/deleted, got ${JSON.stringify(r.phantom)}`
  );
});

ok(
  "PLANT: a package in BOTH lists is reported — one claim must be false",
  () => {
    const r = accountedFor(["packages/a"], ["packages/a"], ["packages/a"]);
    assert(
      r.duplicated.join() === "packages/a",
      `expected packages/a, got ${JSON.stringify(r.duplicated)}`
    );
  }
);

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
