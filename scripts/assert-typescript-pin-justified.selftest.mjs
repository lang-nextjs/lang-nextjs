#!/usr/bin/env node
/**
 * PROOF for assert-typescript-pin-justified.mjs (#1050).
 *
 * The arms that matter are the ones where a broken checker LOOKS FINE:
 *
 *   - a dist with no `typescript@` string must REFUSE (exit 2), never pass. That is
 *     the exact output a grep-based version of this checker would produce forever,
 *     because node_modules is gitignored and this repo's shell `grep` honours that.
 *     A checker that passed there would assert the opposite of what it means.
 *   - two `ignore:` keys in one mapping must FAIL. YAML keeps the last silently, so
 *     the file shows two blocks and means one.
 *   - the expiry arm must fire on a NEWER baked TypeScript, because this checker's
 *     job is to notice good news; nothing else in the repo is watching for it.
 *
 * Every fixture below is data, not a broken file: each mutation changes an ANSWER
 * rather than the parse, so an arm cannot pass merely because something crashed.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  PINNED_MAJOR,
  parseMajor,
  bakedVersionsIn,
  readIgnoreBlocks,
  shadowedBlocks,
  evaluate,
} from "./assert-typescript-pin-justified.mjs";

let pass = 0;
let fail = 0;
function t(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.error(`  WRONG ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

const CHECKER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "assert-typescript-pin-justified.mjs"
);

const IGNORE_BOTH = `version: 2
updates:
  - package-ecosystem: npm
    directory: /
    ignore:
      - dependency-name: prettier
        update-types:
          - version-update:semver-major
      # a comment inside the list must not end the block
      - dependency-name: typescript
        update-types:
          - version-update:semver-major
    labels:
      - dependencies
`;
const IGNORE_SHADOWED = `version: 2
updates:
  - package-ecosystem: npm
    ignore:
      - dependency-name: typescript
        update-types:
          - version-update:semver-major
    labels:
      - dependencies
    ignore:
      - dependency-name: prettier
        update-types:
          - version-update:semver-major
`;
const IGNORE_MINOR_ONLY = `version: 2
updates:
  - package-ecosystem: npm
    ignore:
      - dependency-name: typescript
        update-types:
          - version-update:semver-minor
`;

function makeRoot({ tsRange = "^6.0.3", yaml = IGNORE_BOTH, distJs = null }) {
  const root = mkdtempSync(join(tmpdir(), "ts-pin-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ devDependencies: { typescript: tsRange } })
  );
  mkdirSync(join(root, ".github"), { recursive: true });
  writeFileSync(join(root, ".github/dependabot.yml"), yaml);
  if (distJs !== null) {
    const dist = join(root, "node_modules/tsup/dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "rollup.js"), distJs);
  }
  return root;
}
function run(root) {
  const r = spawnSync(process.execPath, [CHECKER, "--root", root], {
    encoding: "utf8",
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const roots = [];
function withRoot(opts) {
  const r = makeRoot(opts);
  roots.push(r);
  return r;
}

console.log("parseMajor");
t("reads a major out of a caret range", parseMajor("^6.0.3") === 6);
t("reads a major out of a tilde range", parseMajor("~5.7.2") === 5);
t("reads a major out of an exact version", parseMajor("7.0.2") === 7);
t(
  "returns null for a range with no version",
  parseMajor("workspace:*") === null,
  String(parseMajor("workspace:*"))
);
t("returns null for a non-string", parseMajor(undefined) === null);

console.log("\nreadIgnoreBlocks");
{
  const b = readIgnoreBlocks(IGNORE_BOTH);
  t(
    "one ignore block when there is one key",
    b.length === 1,
    `got ${b.length}`
  );
  t(
    "both entries are read",
    b[0].entries.length === 2,
    JSON.stringify(b[0].entries)
  );
  t(
    "a comment inside the list does not truncate it",
    b[0].entries.some((e) => e.name === "typescript"),
    JSON.stringify(b[0].entries)
  );
  t(
    "update-types are attached to the right entry",
    b[0].entries
      .find((e) => e.name === "typescript")
      .updateTypes.includes("version-update:semver-major")
  );
  t(
    "the block ends at the dedent, so `labels` is not swallowed",
    b[0].entries.every((e) => e.name !== "dependencies")
  );
}
{
  const b = readIgnoreBlocks(IGNORE_SHADOWED);
  t("two ignore keys are both seen", b.length === 2, `got ${b.length}`);
  t(
    "and they are reported as shadowing at one indent",
    shadowedBlocks(b).length === 1,
    JSON.stringify(shadowedBlocks(b))
  );
}
t(
  "a single block is not reported as shadowed",
  shadowedBlocks(readIgnoreBlocks(IGNORE_BOTH)).length === 0
);

console.log("\nevaluate");
const CLEAN = {
  declaredMajor: PINNED_MAJOR,
  bakedMajors: [5],
  ignoresMajor: true,
  shadowed: [],
};
t(
  "the justified, in-force state has no problems",
  evaluate(CLEAN).length === 0,
  JSON.stringify(evaluate(CLEAN))
);
t(
  "a missing ignore entry is a violation",
  evaluate({ ...CLEAN, ignoresMajor: false }).some((p) =>
    /does not ignore/.test(p)
  )
);
t(
  "a shadowed ignore key is a violation",
  evaluate({ ...CLEAN, shadowed: [[4, 2]] }).some((p) =>
    /keeps only the LAST/.test(p)
  )
);
t(
  "the repo leaving the pinned major is a violation",
  evaluate({ ...CLEAN, declaredMajor: 7 }).some((p) =>
    /but the pin recorded/.test(p)
  )
);
t(
  "a baked TypeScript at or above ours retires the pin",
  evaluate({ ...CLEAN, bakedMajors: [6] }).some((p) =>
    /PREMISE HAS EXPIRED/.test(p)
  )
);
t(
  "expiry is decided by the OLDEST baked version, not any of them",
  evaluate({ ...CLEAN, bakedMajors: [5, 6, 7] }).length === 0,
  JSON.stringify(evaluate({ ...CLEAN, bakedMajors: [5, 6, 7] }))
);
t(
  "each problem names a repair",
  evaluate({
    declaredMajor: 7,
    bakedMajors: [6],
    ignoresMajor: false,
    shadowed: [[4, 2]],
  }).every((p) => /REPAIR:/.test(p))
);

console.log("\nend to end");
{
  const r = run(
    withRoot({
      distJs:
        'require("rollup-plugin-dts@6.1.1_rollup@4.53.2_typescript@5.7.3")',
    })
  );
  t("the real shape of the tree passes", r.code === 0, r.out);
  t(
    "and the pass names the baked version it read",
    /typescript@5\.7\.3/.test(r.out),
    r.out
  );
}
{
  const r = run(withRoot({ distJs: "var x = 1;" }));
  t(
    "A DIST WITH NO BAKED VERSION REFUSES, IT DOES NOT PASS",
    r.code === 2,
    `exit ${r.code}: ${r.out}`
  );
  t(
    "and the refusal says a broken search looks the same",
    /broken search/.test(r.out),
    r.out
  );
}
{
  const r = run(withRoot({ distJs: null }));
  t(
    "an absent tsup refuses rather than passing",
    r.code === 2,
    `exit ${r.code}: ${r.out}`
  );
}
{
  const r = run(withRoot({ distJs: "typescript@6.0.3", yaml: IGNORE_BOTH }));
  t(
    "a baked version that caught up FAILS (the expiry alarm fires)",
    r.code === 1,
    `exit ${r.code}: ${r.out}`
  );
}
{
  const r = run(
    withRoot({ distJs: "typescript@5.7.3", yaml: IGNORE_SHADOWED })
  );
  t(
    "a duplicated ignore key FAILS end to end",
    r.code === 1,
    `exit ${r.code}: ${r.out}`
  );
}
{
  const r = run(
    withRoot({ distJs: "typescript@5.7.3", yaml: IGNORE_MINOR_ONLY })
  );
  t(
    "ignoring MINORS only does not satisfy a MAJOR pin",
    r.code === 1,
    `exit ${r.code}: ${r.out}`
  );
}
{
  const r = run(withRoot({ distJs: "typescript@5.7.3", tsRange: "^7.0.2" }));
  t(
    "the repo moving to 7 while the entry stands FAILS",
    r.code === 1,
    `exit ${r.code}: ${r.out}`
  );
}
{
  const r = run(
    withRoot({ distJs: "typescript@5.7.3", tsRange: "workspace:*" })
  );
  t(
    "an unreadable declared range refuses",
    r.code === 2,
    `exit ${r.code}: ${r.out}`
  );
}

for (const r of roots) rmSync(r, { recursive: true, force: true });

const total = pass + fail;
if (fail !== 0) {
  console.error(`\nFAIL: ${fail}/${total} cases wrong.`);
  process.exit(1);
}
console.log(
  `\nPASS: ${pass}/${total}. The checker refuses — rather than passes — when tsup's dist holds no\n` +
    `      baked version at all, which is the output a grep-based implementation would give on\n` +
    `      every run, since node_modules is gitignored and this repo's shell grep honours that.\n` +
    `      It fires in BOTH directions: when the pin stops applying (entry gone, entry shadowed\n` +
    `      by a duplicate YAML key, minors-only, or package.json walking off 6) and when the\n` +
    `      pin's premise expires because tsup caught up. Expiry is judged on the OLDEST baked\n` +
    `      version, so a dist listing several does not retire the pin while an old one remains.`
);
