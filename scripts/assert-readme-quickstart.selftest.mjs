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
import { spawnSync } from "node:child_process";
import {
  existsSync,
  renameSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";

const TMP_DIR = tmpdir();
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

/* ── #842 class A: a missing typescript is a refusal, not a violation ───────── */

/*
 * readme-quickstart.mjs held `import ts from "typescript"` statically, and a static import is
 * resolved BEFORE any of the importing file's code runs. So in a tree without node_modules
 * this checker could not refuse and exited 1 — the code reserved for a property being
 * VIOLATED — with an ERR_MODULE_NOT_FOUND trace naming a library file rather than a README.
 *
 * PLANTED WITHOUT TOUCHING node_modules: a loader registered via `module.register` makes the
 * one specifier unresolvable for the child only. Moving the real package aside would leave
 * every checker in the repository broken if this proof crashed mid-plant.
 *
 * THE COMPANION ASSERTS THE ABSENCE OF A CLAIM, NOT AN EXIT CODE, and that is deliberate:
 * this checker ALSO refuses when the packages are unbuilt (#784), so "exits 0 when typescript
 * is present" is false in an unbuilt tree and would make the case environment-dependent.
 * "Does not say typescript is missing when it is not" holds in every tree state.
 */
{
  const dir = mkdtempSync(join(TMP_DIR, "hide-ts-"));
  writeFileSync(
    join(dir, "hide.mjs"),
    `export async function resolve(s, c, next) {\n` +
      `  if (s === "typescript") { const e = new Error("Cannot find package 'typescript'"); e.code = "ERR_MODULE_NOT_FOUND"; throw e; }\n` +
      `  return next(s, c);\n}\n`
  );
  writeFileSync(
    join(dir, "register.mjs"),
    `import { register } from "node:module";\nregister("./hide.mjs", import.meta.url);\n`
  );
  const CHECKER_PATH = join(ROOT, "scripts", "assert-readme-quickstart.mjs");
  const hidden = spawnSync(
    process.execPath,
    ["--import", join(dir, "register.mjs"), CHECKER_PATH],
    { encoding: "utf8" }
  );
  const hiddenOut = (hidden.stdout ?? "") + (hidden.stderr ?? "");

  ok("typescript being unimportable exits 2, not 1", () =>
    assert(hidden.status === 2, `exited ${hidden.status}`)
  );
  ok("...and names typescript rather than refusing anonymously", () =>
    assert(
      /typescript could not be imported/.test(hiddenOut),
      hiddenOut.split("\n").slice(0, 2).join(" ").slice(0, 90)
    )
  );

  const present = spawnSync(process.execPath, [CHECKER_PATH], {
    encoding: "utf8",
  });
  ok("...and does NOT claim that when typescript resolves", () =>
    assert(
      !/typescript could not be imported/.test(
        (present.stdout ?? "") + (present.stderr ?? "")
      ),
      "claimed typescript was missing in a tree where it resolves"
    )
  );
  rmSync(dir, { recursive: true, force: true });
}

let BUILT_FOR_SPAWN_CASES = false;
/* ── #784: the EXIT CODE is the property, and it is asserted by value ──────── */

/*
 * WHY THESE SPAWN THE CHECKER WHEN NOTHING ELSE IN THIS FILE DOES.
 *
 * Every case above imports the extractor and tests it directly, which is the right shape for
 * an extractor and cannot see #784 at all: the defect was that a branch saying "Refusing" in
 * prose exited 1, the code this repo reserves for a property being VIOLATED. Nothing about
 * that is observable from the library. It lives in the process's exit status, so the proof has
 * to be a process.
 *
 * AND IT IS ASSERTED BY VALUE, NOT AS "NON-ZERO". That is the whole point — a proof that only
 * ever checks `!== 0` passes identically whether the checker exits 1 or 2, which is #767's
 * subject and the reason #769 exists. `=== 2` is the assertion; `!== 1` is stated separately
 * because it is the specific wrong answer this change fixes.
 *
 * THE CONDITION IS PLANTED RATHER THAN WAITED FOR. Asserting "whatever this tree happens to
 * be" would exercise the refusal branch only on an unbuilt machine and never in CI, which is
 * the shape #825 and #833 both found: a check whose interesting path runs nowhere anybody
 * looks. Moving one published entry aside creates the condition deterministically, in any
 * environment, and it is restored in a `finally`.
 */
{
  const DTS = join(ROOT, "packages", "server", "dist", "index.d.mts");
  const HELD = `${DTS}.784-held`;
  const README = join(ROOT, "packages", "mcp", "README.md");
  const README_HELD = `${README}.784-held`;
  const CHECKER = join(ROOT, "scripts", "assert-readme-quickstart.mjs");
  const run = () => {
    const r = spawnSync(process.execPath, [CHECKER], { encoding: "utf8" });
    return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
  };
  const DEFECT_LINE = /README Quick Start defect\(s\)/;

  /*
   * AN UNBUILT TREE IS A REFUSAL FOR THIS PROOF TOO, and getting that wrong is how #784's own
   * defect reappears one level up. The first version of this block ASSERTED the tree was
   * built, so on an unbuilt tree the PROOF failed — `pnpm checks` then recorded
   * `proof=fail` and exited 1, which is the same "could not ask reported as violated" this
   * change exists to remove, just moved from the checker to its proof. Caught by running
   * run-checks against a planted unbuilt tree rather than by reading the code.
   *
   * So it is recorded and the file exits 2 at the end instead. The spawn cases need a built
   * tree to plant INTO: with no published entry anywhere there is nothing to move aside, and
   * the presence companion — the case that stops the others being satisfied by a checker
   * which refuses unconditionally — cannot be established at all.
   */
  BUILT_FOR_SPAWN_CASES = existsSync(DTS);

  if (BUILT_FOR_SPAWN_CASES) {
    try {
      renameSync(DTS, HELD);
      const { code, out } = run();
      ok("a missing published entry exits 2, the could-not-ask code", () =>
        assert(code === 2, `expected 2, got ${code}`)
      );
      ok("...and specifically NOT 1, which would claim a violation", () =>
        assert(code !== 1, `exited 1 — an unbuilt tree reported as broken`)
      );
      ok("...and says so, rather than listing it as a defect", () =>
        assert(
          /COULD NOT CHECK/.test(out) && !DEFECT_LINE.test(out),
          DEFECT_LINE.test(out)
            ? "reported the refusal under the defect heading"
            : "did not announce that it could not check"
        )
      );

      /*
       * PRECEDENCE, AND THE FAILURE IS STILL PRINTED. #689's rule for run-checks, which #833
       * carried into the phase loop: an incomplete pass cannot support "these are all the
       * defects", so the weaker verdict claims the code — but suppressing the real one would
       * trade one silence for another.
       */
      renameSync(README, README_HELD);
      const mixed = run();
      ok("a refusal OUTRANKS a real defect found in the same pass", () =>
        assert(mixed.code === 2, `expected 2, got ${mixed.code}`)
      );
      ok("...and the real defect is still reported, not ranked away", () =>
        assert(
          DEFECT_LINE.test(mixed.out) && /COULD NOT CHECK/.test(mixed.out),
          `defect section ${
            DEFECT_LINE.test(mixed.out) ? "present" : "MISSING"
          }`
        )
      );
    } finally {
      if (existsSync(HELD)) renameSync(HELD, DTS);
      if (existsSync(README_HELD)) renameSync(README_HELD, README);
    }

    ok("RESTORED: both planted files are back", () =>
      assert(
        existsSync(DTS) &&
          existsSync(README) &&
          !existsSync(HELD) &&
          !existsSync(README_HELD),
        "the plant was not fully restored"
      )
    );

    /*
     * THE PRESENCE COMPANION. Without it the cases above are satisfied by a checker that
     * exits 2 unconditionally, which would be a different way of never answering.
     */
    ok("...and with nothing planted the same checker exits 0", () => {
      const { code } = run();
      assert(code === 0, `expected 0 on an intact built tree, got ${code}`);
    });
  }
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) for (const f of failures) console.error(`   - ${f}`);

if (!BUILT_FOR_SPAWN_CASES) {
  console.error(
    `\nCOULD NOT CHECK: the exit-code cases need a BUILT tree to plant into — there is no\n` +
      `  published entry to move aside, and the presence companion cannot be established at\n` +
      `  all. Run \`pnpm build\` first.\n` +
      `  Exiting 2: the question could not be asked, not answered — which is the distinction\n` +
      `  this proof exists to defend, and it applies to the proof itself.` +
      (failures.length
        ? `\n  (${failures.length} genuine failure(s) also reported above and they are real.)`
        : ``)
  );
  process.exit(2);
}
if (failures.length) process.exit(1);
