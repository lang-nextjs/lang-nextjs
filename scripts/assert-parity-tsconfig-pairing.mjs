#!/usr/bin/env node
/**
 * Property: A PACKAGE'S `exclude` AND ITS PARITY PROGRAM'S `include` NAME THE SAME FILES.
 *
 * `packages/test-utils` typechecks with two programs, for a real reason recorded in its own
 * parity config: the cross-package suites reach into sibling packages, so they cannot live
 * under the package tsconfig's `rootDir: "./src"` (TS6059), and widening that rootDir would
 * change the published dist layout. So they are excluded from the package program and given
 * their own no-emit one.
 *
 *     tsconfig.json          include ["src"]   exclude [A, B]
 *     tsconfig.parity.json   include [A, B]
 *     typecheck              tsc --noEmit && tsc --noEmit -p tsconfig.parity.json
 *
 * BOTH LISTS ARE EXPLICIT FILENAMES, NOT GLOBS, so adding a third suite is a step someone
 * takes rather than something that happens. And the two ways of getting that step wrong are
 * not equally visible:
 *
 *   forget `exclude`          tsc fails immediately on rootDir. Loud. Protects nobody
 *                             from the other one.
 *   forget parity `include`   the file is in NO program. It still runs under vitest, so it
 *                             is green — and never typechecked.
 *
 * THE QUIET ONE IS ABOUT TO BE WALKED INTO. #429's conformance test is a new cross-package
 * suite in this exact directory, guarding a seam whose whole point is that nothing goes red
 * when it breaks. Shipping it untypechecked would be a guard that cannot see the thing it
 * guards, which is the defect it exists to catch, one level in.
 *
 * BOTH DIRECTIONS ARE CHECKED, and the second is the one nobody was worried about: a file in
 * the parity `include` and MISSING from `exclude` compiles twice today. Harmless, and the
 * quieter mis-pairing — so a checker guarding only the direction we happened to fear would be
 * the same partial-coverage habit it is meant to break.
 *
 * A PACKAGE WITH NO PARITY CONFIG IS NOT EXAMINED. Every other package in the repo is one, so
 * they are this rule's false-positive guard: a checker that fired on them would be red
 * everywhere and muted within a week.
 *
 * Usage: node scripts/assert-parity-tsconfig-pairing.mjs [--cwd DIR]
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const cwdFlag = process.argv.indexOf("--cwd");
const ROOT =
  cwdFlag !== -1 && process.argv[cwdFlag + 1]
    ? resolve(process.argv[cwdFlag + 1])
    : join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Strip `//` and block comments, but not inside strings.
 *
 * A naive `replace(/\/\/.*$/gm, "")` would cut a path containing `//` in half and the result
 * would still be valid JSON — a parse that succeeds while describing different files, which
 * is worse here than a crash.
 */
export function stripJsonComments(src) {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") {
        out += src[++i] ?? "";
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

const readTsconfig = (path) => JSON.parse(stripJsonComments(readFileSync(path, "utf8")));

/** Every package that typechecks with a second, parity program. */
export function parityPackages(root) {
  const pkgDir = join(root, "packages");
  if (!existsSync(pkgDir)) return [];
  const found = [];
  for (const name of readdirSync(pkgDir)) {
    const parity = join(pkgDir, name, "tsconfig.parity.json");
    const own = join(pkgDir, name, "tsconfig.json");
    if (existsSync(parity) && existsSync(own)) {
      found.push({ name, own, parity });
    }
  }
  return found;
}

export function checkPairing(root = ROOT) {
  const problems = [];
  const packages = parityPackages(root);

  for (const pkg of packages) {
    let own, parity;
    try {
      own = readTsconfig(pkg.own);
      parity = readTsconfig(pkg.parity);
    } catch (err) {
      problems.push(
        `packages/${pkg.name}: could not parse its tsconfigs — ${err.message}. ` +
          `Unreadable is not "paired": nothing can be compared.`
      );
      continue;
    }

    const excluded = new Set(own.exclude ?? []);
    const included = new Set(parity.include ?? []);

    for (const file of included) {
      if (!excluded.has(file)) {
        problems.push(
          `packages/${pkg.name}: ${file} is in tsconfig.parity.json's "include" but NOT in ` +
            `tsconfig.json's "exclude", so it compiles in BOTH programs. Harmless today and ` +
            `the quieter mis-pairing — add it to "exclude" or drop it from the parity config.`
        );
      }
    }
    for (const file of excluded) {
      if (!included.has(file)) {
        problems.push(
          `packages/${pkg.name}: ${file} is excluded from tsconfig.json and absent from ` +
            `tsconfig.parity.json's "include", so it is in NO PROGRAM — it still runs under ` +
            `vitest, so it is green and never typechecked. Add it to the parity "include".`
        );
      }
    }
  }
  return { problems, packages };
}

function main() {
  const { problems, packages } = checkPairing(ROOT);

  /*
   * POSITIVE CONTROL. "every pairing agrees" and "I found no package using this pattern"
   * print the same green, and the second is what happens the day someone renames the parity
   * config or moves packages/. Nothing examined is not nothing wrong.
   */
  if (packages.length === 0) {
    console.error(
      `FAIL: no package under ${ROOT}/packages has both a tsconfig.json and a ` +
        `tsconfig.parity.json.\n` +
        `      That pairing is what this checker is about, so an empty set means it could ` +
        `not compute\n      the property — not that the property holds.`
    );
    process.exit(2);
  }

  if (problems.length > 0) {
    for (const p of problems) console.error(`FAIL: ${p}`);
    process.exit(1);
  }

  const names = packages.map((p) => p.name).join(", ");
  console.log(
    `PASS: ${packages.length} package(s) with a parity program (${names}); every excluded ` +
      `file is\n      in the parity include and every parity include is excluded. Packages ` +
      `without a parity\n      config are not examined — they are this rule's ` +
      `false-positive guard.`
  );
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();
