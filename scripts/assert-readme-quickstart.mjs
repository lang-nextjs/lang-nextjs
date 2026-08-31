#!/usr/bin/env node
/**
 * Property: EVERY SYMBOL A PACKAGE'S README QUICK START TELLS A READER TO
 * IMPORT ACTUALLY EXISTS IN THAT PACKAGE'S PUBLISHED SURFACE.
 *
 * The defect this exists for (#478): six packages carry a
 * `readme-quickstart.test.*` whose header calls it "the executable form of the
 * README so the docs can't drift silently from the API". Measured, none of them
 * reads a README — zero `fs`/`readFileSync`/`node:fs` occurrences across all
 * six, the snippet hardcoded in the test file, and packages/server's own
 * comment saying "paraphrased". They assert that A COPY OF A SNIPPET COMPILES,
 * which is a real property and not the one the name claims. If a README's Quick
 * Start changed to a wrong symbol tomorrow, all six stayed green.
 *
 * ── WHAT THIS CHECKS AND WHAT IT DELIBERATELY DOES NOT ─────────────────────
 *
 * CHECKS, from the published text: the Quick Start section exists; it contains
 * the pinned number of fenced blocks; each block parses as TypeScript; every
 * VALUE symbol it imports from its own package is exported by that package's
 * published .d.ts; every TYPE symbol likewise.
 *
 * DOES NOT check that the snippet EXECUTES. Three of the eleven blocks cannot:
 * react's and remix's call a hook at module scope (illegal outside a render),
 * sveltekit's is a `.svelte` component, and edge's Deno block calls
 * `Deno.serve`. Claiming execution here and quietly skipping those is the
 * overclaim this issue is about. The per-package vitest tests keep the runtime
 * job — their headers are corrected to say so.
 *
 * ── WHY THE COUNT IS PINNED ────────────────────────────────────────────────
 *
 * `expectedBlocks` is asserted per package. Without it, a Quick Start block
 * deleted from a README makes this checker check less and still pass — the
 * same green-by-absence the six tests already had. The pin is self-invalidating
 * in both directions: adding a block fails too, so the number has to be a
 * decision rather than a drift.
 *
 * Usage: node scripts/assert-readme-quickstart.mjs [--json]
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  quickStartBlocks,
  documentedSymbols,
  syntaxErrors,
  publishedExports,
  typesEntry,
  RefusedExtraction,
} from "./readme-quickstart.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AS_JSON = process.argv.includes("--json");

/**
 * The packages whose Quick Start is checked, with the block count pinned.
 *
 * Counts are MEASURED, not guessed — react has TWO `## Quick Start` headings
 * (lines 11 and 190), which is exactly the shape a "first block after the
 * heading" extractor reports as one and calls it covered.
 */
const CHECKED = [
  {
    dir: "packages/server",
    spec: "@deepagents-nextjs/server",
    expectedBlocks: 1,
  },
  {
    dir: "packages/react",
    spec: "@deepagents-nextjs/react",
    expectedBlocks: 2,
  },
  { dir: "packages/edge", spec: "@deepagents-nextjs/edge", expectedBlocks: 2 },
  {
    dir: "packages/sveltekit",
    spec: "@deepagents-nextjs/sveltekit",
    expectedBlocks: 2,
  },
  {
    dir: "packages/remix",
    spec: "@deepagents-nextjs/remix",
    expectedBlocks: 2,
  },
];

/**
 * Packages that have a readme-quickstart test and NO README to check it against.
 *
 * packages/mcp ships `createDeepAgentsMcpServer` and a test whose describe block
 * reads "README Quick Start", and packages/mcp/README.md does not exist — there
 * is no such file at any depth. The test asserts a document that was never
 * written.
 *
 * Listed rather than silently skipped, and SELF-INVALIDATING: if a README
 * appears, the entry goes stale and this checker fails until the package is
 * moved into CHECKED. An exception that outlives its cause is how a gap becomes
 * permanent.
 */
const NO_README = [
  {
    dir: "packages/mcp",
    why: "has src/readme-quickstart.test.ts but no README.md at any path. Its public surface is one function — createDeepAgentsMcpServer(options): McpServer — so the README is short, but writing it is a docs decision rather than a drift fix.",
  },
];

const failures = [];
const report = [];

function fail(pkg, msg) {
  failures.push(`${pkg}: ${msg}`);
}

for (const { dir, spec, expectedBlocks } of CHECKED) {
  const readmePath = join(ROOT, dir, "README.md");
  const pkgPath = join(ROOT, dir, "package.json");
  const entry = { dir, spec, blocks: [] };

  if (!existsSync(readmePath)) {
    fail(
      dir,
      `README.md does not exist, but this package is in CHECKED. Either it was deleted or the list is wrong; both are defects.`
    );
    continue;
  }

  const md = readFileSync(readmePath, "utf8");
  let extracted;
  try {
    extracted = quickStartBlocks(md, { label: `${dir}/README.md` });
  } catch (e) {
    // A refusal is a FAILURE, never a skip. A reader that silently finds
    // nothing is the defect being fixed, one level up.
    fail(
      dir,
      e instanceof RefusedExtraction
        ? e.message
        : `unexpected error: ${e.message}`
    );
    continue;
  }

  const { blocks, allFences } = extracted;
  entry.fencesInFile = allFences.length;
  entry.quickStartBlocks = blocks.length;

  // SET DIFFERENCE, not just a count: every block returned must be one of the
  // document's own fences. An extractor that synthesised or mangled a block
  // would otherwise be indistinguishable from one that worked.
  const byLine = new Set(allFences.map((f) => f.startLine));
  const foreign = blocks.filter((b) => !byLine.has(b.startLine));
  if (foreign.length)
    fail(
      dir,
      `extraction returned ${foreign.length} block(s) that are not fences of this document — the extractor is wrong, not the README.`
    );

  if (blocks.length !== expectedBlocks)
    fail(
      dir,
      `Quick Start has ${blocks.length} fenced block(s), pinned at ${expectedBlocks}. ` +
        `If a block was added or removed on purpose, update expectedBlocks in this file — an unpinned count means a deleted snippet checks less and still passes.`
    );

  let published;
  try {
    const pj = JSON.parse(readFileSync(pkgPath, "utf8"));
    const dts = join(ROOT, dir, typesEntry(pj, { label: dir }));
    if (!existsSync(dts)) {
      fail(
        dir,
        `published types entry ${dts} does not exist — build the packages first. Refusing rather than reporting every documented symbol as present.`
      );
      continue;
    }
    published = publishedExports(pj, readFileSync(dts, "utf8"), { label: dir });
    entry.publishedValues = published.values.size;
    entry.publishedTypes = published.types.size;
  } catch (e) {
    fail(
      dir,
      e instanceof RefusedExtraction
        ? e.message
        : `could not read published surface: ${e.message}`
    );
    continue;
  }

  for (const b of blocks) {
    const doc = documentedSymbols(b.code, spec, {
      label: `${dir}:${b.startLine}`,
      lang: b.lang,
    });
    const errs = syntaxErrors(b.code, {
      label: `${dir}:${b.startLine}`,
      lang: b.lang,
    });
    const blockReport = {
      lang: b.lang,
      lines: `${b.startLine}-${b.endLine}`,
      lineCount: b.lineCount,
      heading: b.heading,
      values: doc.ownSymbols,
      types: doc.ownTypes,
      foreign: doc.foreignSpecifiers,
      destructured: doc.destructured,
      syntaxErrors: errs.length,
    };
    entry.blocks.push(blockReport);

    // An EMPTY block is not a clean block. The first version of the extractor
    // returned every block with a correct language tag, correct line numbers
    // and an empty body, and every symbol check passed against nothing.
    if (b.lineCount === 0)
      fail(
        dir,
        `the block at L${b.startLine} extracted as ZERO lines. A documented snippet is never empty; the extractor is wrong.`
      );

    // `.svelte` is not TypeScript and its parse errors mean nothing here.
    if (errs.length && b.lang !== "svelte")
      fail(
        dir,
        `the ${b.lang} block at L${b.startLine} does not parse as TypeScript: ${errs[0]}`
      );

    const missingValues = doc.ownSymbols.filter(
      (n) => !published.values.has(n)
    );
    if (missingValues.length)
      fail(
        dir,
        `README L${b.startLine} tells the reader to import ${missingValues
          .map((n) => `\`${n}\``)
          .join(", ")} from ${spec}, and the package does not export ${
          missingValues.length > 1 ? "them" : "it"
        }.`
      );

    // A documented type may legitimately be published as a value (a class), so
    // both sets count. The reverse is not true and is why they are separate.
    const missingTypes = doc.ownTypes.filter(
      (n) => !published.types.has(n) && !published.values.has(n)
    );
    if (missingTypes.length)
      fail(
        dir,
        `README L${b.startLine} documents type(s) ${missingTypes
          .map((n) => `\`${n}\``)
          .join(", ")} from ${spec} that the package does not export.`
      );
  }

  report.push(entry);
}

for (const { dir, why } of NO_README) {
  const readmePath = join(ROOT, dir, "README.md");
  if (existsSync(readmePath))
    fail(
      dir,
      `is listed as having no README, but README.md now exists. Move it into CHECKED and delete the NO_README entry — a recorded gap that has been filled must not stay recorded.`
    );
}

// NAME THE SUBJECT. A run that read the wrong file or an empty block cannot
// report success quietly.
if (AS_JSON) {
  console.log(
    JSON.stringify({ report, noReadme: NO_README, failures }, null, 2)
  );
} else {
  for (const e of report) {
    console.log(`${e.dir}  ${e.spec}`);
    console.log(
      `   Quick Start: ${e.quickStartBlocks} block(s) of ${e.fencesInFile} fence(s) in the file`
    );
    console.log(
      `   published  : ${e.publishedValues} value export(s), ${e.publishedTypes} type export(s)`
    );
    for (const b of e.blocks) {
      console.log(
        `     [${b.lang || "no-lang"}] L${b.lines} ${
          b.lineCount
        } line(s) under "${b.heading}"`
      );
      console.log(
        `        imports ${
          b.values.length ? b.values.join(", ") : "(no values)"
        }` +
          (b.types.length ? ` | types ${b.types.join(", ")}` : "") +
          (b.foreign.length
            ? ` | from peers ${[...new Set(b.foreign)].join(", ")}`
            : "")
      );
      for (const d of b.destructured)
        console.log(
          `        documents ${d.callee}() -> { ${d.names.join(
            ", "
          )} }  (recorded, not asserted — needs a live call)`
        );
    }
  }
  for (const n of NO_README) console.log(`${n.dir}  NO README — ${n.why}`);
}

if (failures.length) {
  console.error(`\nFAIL: ${failures.length} README Quick Start defect(s):`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}

const blockTotal = report.reduce((n, e) => n + e.blocks.length, 0);
console.log(
  `\nPASS: ${report.length} package(s), ${blockTotal} Quick Start block(s) read from the published READMEs; every documented symbol is exported. ${NO_README.length} package(s) recorded as having no README.`
);
