#!/usr/bin/env node
/**
 * Proof that assert-overrides-cannot-go-inert can fail, and that it does not fire on shapes
 * that are fine.
 *
 * THE SCOPED-PACKAGE CASE IS THE ONE THAT MATTERS. `@types/node` contains an `@` and is not a
 * selector; a naive `key.includes("@")` flags every scoped override and the checker fires on
 * a clean tree. That is the false positive that would get this deleted, so it is pinned.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECKER = join(ROOT, "scripts", "assert-overrides-cannot-go-inert.mjs");
const dirs = [];

function tree(overrides) {
  const d = mkdtempSync(join(tmpdir(), "oinert-"));
  dirs.push(d);
  writeFileSync(
    join(d, "package.json"),
    JSON.stringify({ name: "probe", pnpm: { overrides } }, null, 2) + "\n"
  );
  return d;
}
function run(d) {
  try {
    return {
      code: 0,
      out: execFileSync("node", [CHECKER, "--cwd", d], { encoding: "utf8" }),
    };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

let pass = 0,
  fail = 0;
const check = (name, ok, detail, out) => {
  if (ok) {
    console.log(`  ok    ${name}`);
    pass++;
  } else {
    console.error(`  FAIL  ${name}  ${detail}`);
    console.error(
      String(out)
        .split("\n")
        .map((l) => `        | ${l}`)
        .join("\n")
    );
    fail++;
  }
};

{
  const r = run(tree({ "tar@<7.5.11": ">=7.5.11" }));
  check(
    "REJECT  a selector-bearing override is caught, and the rewrite is named",
    r.code === 1 &&
      /can go\s*\n?\s*inert|can go inert/.test(r.out) &&
      /"tar": ">=7.5.11"/.test(r.out),
    `exit=${r.code}`,
    r.out
  );
}
{
  const r = run(tree({ tar: ">=7.5.21", "react-dom": "19.2.6" }));
  check("ACCEPT  plain overrides pass", r.code === 0, `exit=${r.code}`, r.out);
}
{
  // THE FALSE POSITIVE THIS CHECKER WOULD DIE OF. A scoped name is not a selector.
  const r = run(
    tree({ "@types/node": "^25.0.0", "@vitest/coverage-v8": "4.1.6" })
  );
  check(
    "ACCEPT  a SCOPED package name is not a version selector",
    r.code === 0,
    `exit=${r.code}`,
    r.out
  );
}
{
  // A scoped name that ALSO carries a selector must still be caught — otherwise the fix for
  // the case above would be "skip anything starting with @", which is a hole.
  const r = run(tree({ "@scope/pkg@<2.0.0": ">=2.0.0" }));
  check(
    "REJECT  a scoped name WITH a selector is still caught",
    r.code === 1 && /"@scope\/pkg": ">=2.0.0"/.test(r.out),
    `exit=${r.code}`,
    r.out
  );
}
{
  const r = run(tree({}));
  check(
    "REFUSE  no overrides at all exits 2 rather than passing over an empty set",
    r.code === 2 && /measured nothing/.test(r.out),
    `exit=${r.code}`,
    r.out
  );
}

for (const d of dirs) rmSync(d, { recursive: true, force: true });

const total = pass + fail;
if (total !== 5) {
  console.error(
    `FAIL: ran ${total} cases, expected 5 — the harness is broken.`
  );
  process.exit(1);
}
if (fail > 0) {
  console.error(`\nFAIL: ${fail}/${total}. The checker is NOT trustworthy.`);
  process.exit(1);
}
console.log(
  `\nPASS: ${pass}/${total}. Watched catching a selector-bearing override — scoped or not —\n` +
    `      and watched NOT firing on plain overrides or on a scoped name it must not misread.`
);
