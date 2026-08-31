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
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  quickStartBlocks,
  documentedSymbols,
  syntaxErrors,
  publishedExports,
  typesEntry,
  RefusedExtraction,
  accountedFor,
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
  // #485 — written against the published surface, and verified BY this checker.
  { dir: "packages/mcp", spec: "@deepagents-nextjs/mcp", expectedBlocks: 1 },
  {
    dir: "packages/rungs",
    spec: "@deepagents-nextjs/rungs",
    expectedBlocks: 2,
  },
  // Its Quick Start is a fragment with no import line, so the symbol check is
  // INERT here — reported as such below rather than counted as a clean pass.
  {
    dir: "packages/test-utils",
    spec: "@deepagents-nextjs/test-utils",
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
    dir: "packages/ui",
    why: "the shadcn/theme component package — classified `shared`, so every fork carries it, and it has no README. Found while writing the mcp and rungs ones (#485); a component library's README is a larger job than a factory's and is not folded in here.",
  },
];

const failures = [];
const report = [];

/**
 * EVERY WORKSPACE PACKAGE IS ACCOUNTED FOR, DERIVED RATHER THAN LISTED.
 *
 * The two lists above are hand-written, and a hand-written list of SUBJECTS has
 * the defect this checker exists for: a package in neither list is not reported
 * as uncovered, it is invisible, and the run still says PASS.
 *
 * Not hypothetical. The first version listed only the six packages that had a
 * `readme-quickstart.test.*`; packages/rungs and packages/ui have no such test
 * AND no README, so neither appeared anywhere — the manifest package, where a
 * forker goes to learn the vocabulary, was undocumented and unmentioned.
 *
 * So the package set comes from the filesystem and every member must be in
 * exactly one list. Adding a package now forces a decision rather than
 * silently widening the gap.
 */
{
  const dirs = readdirSync(join(ROOT, "packages"), { withFileTypes: true })
    .filter(
      (d) =>
        d.isDirectory() &&
        existsSync(join(ROOT, "packages", d.name, "package.json"))
    )
    .map((d) => `packages/${d.name}`);
  if (dirs.length === 0)
    failures.push(
      "packages/: enumerated ZERO workspace packages, so every claim below is about an empty set"
    );
  const { unaccounted, phantom, duplicated } = accountedFor(
    dirs,
    CHECKED.map((c) => c.dir),
    NO_README.map((n) => n.dir)
  );
  if (unaccounted.length)
    failures.push(
      `these workspace package(s) are in neither CHECKED nor NO_README, so nothing says whether their README is checked: ${unaccounted.join(
        ", "
      )}. Add each to one list.`
    );
  if (phantom.length)
    failures.push(
      `these listed package(s) no longer exist: ${phantom.join(
        ", "
      )}. A list entry for a deleted package is a check that cannot run.`
    );
  if (duplicated.length)
    failures.push(
      `these package(s) are in BOTH lists: ${duplicated.join(
        ", "
      )}. One of the two claims is false and the run cannot say which.`
    );
}

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

  // A package whose Quick Start imports nothing from itself is not "clean" —
  // there was nothing to check. Saying PASS without distinguishing the two is
  // how a gate reports confidence it never earned.
  entry.documentsOwnSymbols = entry.blocks.some((b) => b.values.length > 0);

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
  for (const e of report.filter((e) => !e.documentsOwnSymbols))
    console.log(
      `${e.dir}  SYMBOL CHECK INERT — its Quick Start imports nothing from ${e.spec}, so "every documented symbol is exported" is vacuously true here. Extraction, block count and syntax are still checked.`
    );
}

if (failures.length) {
  console.error(`\nFAIL: ${failures.length} README Quick Start defect(s):`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}

const blockTotal = report.reduce((n, e) => n + e.blocks.length, 0);
const withSymbols = report.filter((e) => e.documentsOwnSymbols).length;
console.log(
  `\nPASS: ${report.length} package(s), ${blockTotal} Quick Start block(s) read from the published READMEs. ` +
    `${withSymbols} package(s) document symbols from their own package and every one is exported; ` +
    `${
      report.length - withSymbols
    } document none, so the symbol check is inert there. ` +
    `${NO_README.length} package(s) recorded as having no README.`
);
