#!/usr/bin/env node
/**
 * assert-barrel-covers-type-exports.mjs — every module's TYPE-ONLY exports reach the barrel.
 *
 * THE GAP (#446), AND IT IS A BLINDNESS IN THE SUBSTRATE RATHER THAN IN A PATTERN.
 *
 * #438's guard (public-api-completeness.test.ts) enumerates every module, `import()`s it, and
 * asserts each runtime export name is reachable from the barrel. That instrument is the module
 * system itself, which is exactly why it cannot miscount the way two hand-written extractors
 * did. And TYPE-ONLY EXPORTS DO NOT EXIST AT RUNTIME — they are erased before the namespace
 * object is built, so a barrel that drops `export type { X }` passes it with nothing missing.
 *
 * That is not a bug in that check. It is a question the artifact cannot answer for that class
 * of export, and no amount of care with the runtime instrument reaches them.
 *
 * TWO INSTRUMENTS WITH DISJOINT BLINDNESS, WHICH IS THE POINT AND NOT A REDUNDANCY:
 *
 *   runtime (#445)   sees VALUE exports exactly, because it asks the module system.
 *                    Cannot see types at all — they are gone by then.
 *   compiler (here)  sees the DECLARATION GRAPH, so it sees types. Depends on the program
 *                    constructing from the package's tsconfig, which a runtime check does not.
 *
 * Neither subsumes the other, and their failure modes do not overlap: a tree where the module
 * system loads but the program does not construct is caught by one, and a dropped type export
 * only by the other. That is why this ships ALONGSIDE #445 rather than replacing it — and why
 * this file asserts TYPES ONLY. Asserting values here too would be a second implementation of a
 * question #445 already answers, and two implementations are two answers that drift.
 *
 * DERIVED, NOT LISTED. The set comes from the checker's view of each module, never from a
 * hand-written list of expected names — a listed pin has exactly the expiry that made #438
 * necessary, and this issue would recur verbatim with a later date on it.
 *
 * ALIASES MUST BE RESOLVED, and getting this wrong is silent. `export type { X } from "./m"`
 * produces an ALIAS symbol whose own flags say Alias and nothing else. Classifying on those
 * reported the barrel as exporting ZERO types — which would have called all 55 of its type
 * exports missing, a confident answer about the opposite of the truth.
 *
 * Exit codes:  0  every module type export reaches the barrel (or is a stated exception)
 *              1  one or more do not
 *              2  the subject was empty or unreadable — see REFUSE below
 *
 * Usage: node scripts/assert-barrel-covers-type-exports.mjs [--cwd DIR] [--package DIR]
 */
import ts from "typescript";
import { readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 || !argv[i + 1] ? d : argv[i + 1];
};
const CWD = resolve(arg("cwd", ROOT));
const PKG = resolve(arg("package", join(CWD, "packages/react")));
const SRC = join(PKG, "src");

/**
 * Type exports a module publishes for its own siblings rather than for consumers.
 *
 * EVERY ENTRY CARRIES A REASON, the same deliberate cost #445's NOT_PUBLIC pays. A list that is
 * cheap to append to is how the next snapshot forms: the first genuinely-internal type becomes
 * a one-line addition, then a habit. Writing down WHY makes extending it a decision.
 *
 * EMPTY TODAY, and that is a fact about the tree rather than an oversight — the five types that
 * were unreachable when this landed were all genuine gaps, and were exported rather than
 * excused. See the commit for why each one was public-by-implication already.
 */
const NOT_PUBLIC = {};

class Refusal extends Error {}

/** Type-only and value export names of a module, aliases resolved. */
function exportsOf(program, checker, file) {
  const sf = program.getSourceFile(file);
  if (!sf) return null;
  const moduleSymbol = checker.getSymbolAtLocation(sf);
  // A file with no module symbol has no top-level export — a script, not a module. Not an
  // error, and not a subject either.
  if (!moduleSymbol) return { types: [], values: [] };
  const types = [];
  const values = [];
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const target =
      exported.getFlags() & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(exported)
        : exported;
    const flags = target.getFlags();
    const isValue = !!(flags & (ts.SymbolFlags.Value | ts.SymbolFlags.ValueModule));
    const isType = !!(
      flags &
      (ts.SymbolFlags.Type |
        ts.SymbolFlags.TypeAlias |
        ts.SymbolFlags.Interface |
        ts.SymbolFlags.TypeParameter |
        ts.SymbolFlags.Enum)
    );
    // TYPE-ONLY means it has no value side. A class or an enum is both, and belongs to the
    // runtime guard's subject rather than this one — counting it here would make the two
    // instruments overlap and disagree.
    if (!isValue && isType) types.push(exported.getName());
    else if (isValue) values.push(exported.getName());
  }
  return { types, values };
}

/** Every non-test, non-declaration module in the package, excluding the barrel. */
function moduleFiles(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...moduleFiles(join(dir, entry.name), rel));
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    if (/\.test\.tsx?$/.test(entry.name)) continue;
    if (/\.d\.ts$/.test(entry.name)) continue;
    if (rel === "index.ts") continue;
    out.push(rel);
  }
  return out;
}

export function check({ pkg = PKG, notPublic = NOT_PUBLIC } = {}) {
  const src = join(pkg, "src");
  const tsconfig = join(pkg, "tsconfig.json");
  if (!existsSync(tsconfig)) throw new Refusal(`no tsconfig at ${tsconfig}`);
  if (!existsSync(src)) throw new Refusal(`no source directory at ${src}`);

  const raw = ts.readConfigFile(tsconfig, ts.sys.readFile);
  if (raw.error)
    throw new Refusal(
      `${tsconfig} did not parse — ${ts.flattenDiagnosticMessageText(raw.error.messageText, " ")}`
    );
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, pkg);
  if (parsed.fileNames.length === 0)
    throw new Refusal(
      `${tsconfig} yielded ZERO files, so the program has no subject. A type guard over no ` +
        `program reports no missing types for the same reason an empty grep reports no matches.`
    );

  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();

  const barrelPath = join(src, "index.ts");
  const barrel = exportsOf(program, checker, barrelPath);
  if (!barrel)
    throw new Refusal(
      `${barrelPath} is not in the program the tsconfig produced, so what the barrel exports ` +
        `is unknown — not empty.`
    );
  const reachable = new Set([...barrel.types, ...barrel.values]);
  if (reachable.size === 0)
    throw new Refusal(
      `the barrel resolved to ZERO exports. Either it stopped being a module or alias ` +
        `resolution is broken; both make "every type export reaches it" vacuously false ` +
        `rather than true, and neither is a verdict about the tree.`
    );

  const files = moduleFiles(src);
  if (files.length === 0)
    throw new Refusal(`no non-test modules found under ${src}; nothing was examined.`);

  let typeExports = 0;
  const missing = [];
  for (const rel of files) {
    const e = exportsOf(program, checker, join(src, rel));
    if (!e) continue;
    for (const name of e.types) {
      typeExports++;
      if (name in notPublic) continue;
      if (!reachable.has(name)) missing.push({ rel, name });
    }
  }
  if (typeExports === 0)
    throw new Refusal(
      `${files.length} module(s) examined and ZERO type exports found among them. A package ` +
        `whose modules export no types at all would make this guard trivially true; more ` +
        `likely the alias/flag classification stopped working.`
    );

  return { files, typeExports, barrel, reachable, missing };
}

function main() {
  let r;
  try {
    r = check();
  } catch (e) {
    if (e instanceof Refusal) {
      console.error(`REFUSING TO REPORT: ${e.message}`);
      console.error(
        `      Exit 2, not 0 — the subject was empty or unreadable, which is a different\n` +
          `      answer from "every type export reaches the barrel".`
      );
      process.exit(2);
    }
    throw e;
  }

  /*
   * THE SUBJECT IS PART OF THE ANSWER. "PASS" is the same string over 21 modules and over none;
   * these counts are not. A moved src or a tsconfig that stops including the package reads as
   * "0 modules" and refuses above rather than printing a clean pass over nothing.
   */
  console.log(
    `packages/react — ${r.files.length} module(s), ${r.typeExports} type export(s) checked ` +
      `against a barrel of ${r.barrel.types.length} type + ${r.barrel.values.length} value ` +
      `export(s)`
  );

  if (r.missing.length === 0) {
    const excused = Object.keys(NOT_PUBLIC).length;
    console.log(
      `\nOK — every module type export is reachable from the barrel` +
        (excused ? `, or is one of ${excused} stated exception(s)` : "") +
        `.\n     Types only: value exports are public-api-completeness.test.ts's subject (#438), ` +
        `and the\n     two instruments are kept apart because their blindness is.`
    );
    return;
  }

  console.error(
    `\nFAIL: ${r.missing.length} type export(s) are declared and unreachable from the barrel:\n`
  );
  for (const m of r.missing) console.error(`  ${m.rel}  ${m.name}`);
  console.error(
    `\n      A barrel missing a type still COMPILES — it is well-typed either way — so tsc is\n` +
      `      silent and the break surfaces at a consumer that happens to annotate with the\n` +
      `      name. Export it from packages/react/src/index.ts, or add it to NOT_PUBLIC with a\n` +
      `      reason if it is genuinely internal.`
  );
  process.exit(1);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();
