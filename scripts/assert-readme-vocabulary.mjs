#!/usr/bin/env node
/**
 * assert-readme-vocabulary.mjs — the README's vocabulary table names exactly the fields the
 * published type has.
 *
 * THE GAP (#487). packages/rungs/README.md carries a table describing the manifest's
 * discriminants — the ones this repository spent a day making precise (#424, #425, #451). It is
 * a SECOND DECLARATION of a fact the type already states, and prose does not run, so it fails
 * as documentation long before anyone notices.
 *
 * BOTH DIRECTIONS, AND THE QUIET ONE IS THE STALE ROW. A missing row is a field a forker never
 * learns about; a row for a field that no longer exists sends them to import something gone.
 * The second is worse because the table still reads as complete.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * BOTH SIDES ARE DERIVED. NEITHER IS A LIST IN THIS FILE.
 *
 * A checker that derives one side and hardcodes the other has not removed the duplication, it
 * has MOVED it — the literal list becomes a third declaration, and the third is the one nobody
 * thinks to update. So:
 *
 *   fields      read from the `Rung` interface through the TypeScript CHECKER, not a regex over
 *               the source. Same instrument as #446, for the same reason: a parser that
 *               miscounts a type surface fails in the silent direction.
 *   documented  read from the README's own table.
 *   excluded    read from the README's own "deliberately not here" section — so the exception
 *               list lives where a READER sees it, not where only CI does.
 *
 * WHICH ARTIFACT IS THE SOURCE, AND WHY IT IS NOT rungs.json DIRECTLY. The table describes what
 * a CONSUMER can import, and `owns` is in the manifest and deliberately NOT projected into the
 * types — so deriving from rungs.json would demand a row for a field the package does not
 * expose, and would need an exclusion list to say so. The generated type is the right subject,
 * and it is not an unguarded copy: `gen-rung-types.mjs --check` already asserts it agrees with
 * rungs.json, and ci.yml runs it. The chain is
 *
 *     rungs.json --[gen-rung-types --check]--> generated.ts --[this file]--> README.md
 *
 * with every link asserted. Reading the middle of a gated chain is not reading a copy.
 *
 * WHAT THIS DOES NOT CLAIM. Nothing about whether the DESCRIPTIONS are accurate. "Is this prose
 * true" has no cheap mechanical answer, and a text-matching version produces false positives —
 * which teaches people to widen allowlists, which is worse than no gate. This asserts the
 * NAMES, and says so rather than implying more.
 * ────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Exit codes:  0  the table names exactly the published fields
 *              1  a field is undocumented, or a row describes a field that does not exist
 *              2  the property could not be checked — no README, no table, no type, empty side
 *
 * Usage: node scripts/assert-readme-vocabulary.mjs [--cwd DIR] [--package DIR] [--type NAME]
 */
import ts from "typescript";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 || !argv[i + 1] ? d : argv[i + 1];
};
const CWD = resolve(arg("cwd", ROOT));
const PKG = resolve(arg("package", join(CWD, "packages/rungs")));
const TYPE = arg("type", "Rung");

class Refusal extends Error {}

/** The property names of an interface, taken from the checker rather than from the text. */
export function fieldsOfType(pkg, typeName) {
  const tsconfig = join(pkg, "tsconfig.json");
  if (!existsSync(tsconfig)) throw new Refusal(`no tsconfig at ${tsconfig}`);
  const raw = ts.readConfigFile(tsconfig, ts.sys.readFile);
  if (raw.error)
    throw new Refusal(
      `${tsconfig} did not parse — ${ts.flattenDiagnosticMessageText(raw.error.messageText, " ")}`
    );
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, pkg);
  if (parsed.fileNames.length === 0)
    throw new Refusal(`${tsconfig} yielded ZERO files, so there is no program to read a type from.`);

  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    const moduleSymbol = checker.getSymbolAtLocation(sf);
    if (!moduleSymbol) continue;
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      if (exported.getName() !== typeName) continue;
      const target =
        exported.getFlags() & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      const decl = target.declarations?.[0];
      if (!decl) continue;
      const type = checker.getTypeAtLocation(decl);
      const names = checker.getPropertiesOfType(type).map((p) => p.getName());
      if (names.length === 0)
        throw new Refusal(
          `\`${typeName}\` resolved to a type with ZERO properties. A vocabulary check against ` +
            `no fields is trivially satisfied, which is not the same as satisfied.`
        );
      return { names, where: relative(CWD, decl.getSourceFile().fileName) };
    }
  }
  throw new Refusal(
    `no exported type named \`${typeName}\` in the program built from ${relative(CWD, tsconfig)}.`
  );
}

/**
 * The field names a markdown table documents.
 *
 * The table is found by its HEADER — a first column called "Field" — rather than by position or
 * by a heading, because a heading can be renamed and a position can shift while the table is
 * still the table. Only the first column is read: later columns are prose and mentioning a
 * field there is not documenting it.
 */
export function documentedFields(markdown) {
  const lines = markdown.split("\n");
  const header = lines.findIndex((l) => /^\|\s*Field\s*\|/i.test(l));
  if (header === -1) return null;
  const out = [];
  for (let i = header + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("|")) break;
    const first = line.split("|")[1] ?? "";
    const m = first.match(/`([A-Za-z0-9_]+)`/);
    if (m) out.push(m[1]);
  }
  return out;
}

/**
 * Fields the README says on purpose are absent.
 *
 * Read from the document rather than kept here, so the exception list is the one a READER sees.
 * An exclusion recorded only in CI is a decision the audience never learns about.
 */
export function excludedFields(markdown) {
  const start = markdown.search(/^##+\s+What is deliberately not here/im);
  if (start === -1) return [];
  /*
   * PAST THE HEADING FIRST. `markdown.slice(start).split(/^##\s/m)[0]` returns the EMPTY STRING,
   * because the slice BEGINS with the very heading the split delimits on — so every exclusion
   * silently failed to register and the "declared absent" mechanism was decoration. It changed
   * no verdict here only because the one exclusion on file names a field the type does not
   * have; the next one would have been ignored in silence.
   */
  const afterHeading = markdown.slice(start).replace(/^[^\n]*\n/, "");
  const section = afterHeading.split(/^##\s/m)[0];
  return [...section.matchAll(/^-\s+\*\*`([A-Za-z0-9_]+)`\*\*/gm)].map((m) => m[1]);
}

export function check({ pkg = PKG, typeName = TYPE, cwd = CWD } = {}) {
  const readmePath = join(pkg, "README.md");
  if (!existsSync(readmePath)) throw new Refusal(`no README at ${relative(cwd, readmePath)}`);
  const markdown = readFileSync(readmePath, "utf8");

  const documented = documentedFields(markdown);
  if (documented === null)
    throw new Refusal(
      `${relative(cwd, readmePath)} has no table with a \`Field\` column, so there is no ` +
        `vocabulary to compare. A README without one is not a README that agrees.`
    );
  if (documented.length === 0)
    throw new Refusal(
      `${relative(cwd, readmePath)}'s Field table has ZERO rows. An empty table names no wrong ` +
        `field and documents nothing; that is not agreement.`
    );

  const { names, where } = fieldsOfType(pkg, typeName);
  const excluded = excludedFields(markdown);

  const documentedSet = new Set(documented);
  const excludedSet = new Set(excluded);
  const undocumented = names.filter((n) => !documentedSet.has(n) && !excludedSet.has(n));
  // A row for a field the type does not have. The quiet direction: the table still reads whole.
  const stale = documented.filter((d) => !names.includes(d));

  return { readmePath, where, names, documented, excluded, undocumented, stale };
}

function main() {
  let r;
  try {
    r = check();
  } catch (e) {
    if (e instanceof Refusal) {
      console.error(`REFUSING TO REPORT: ${e.message}`);
      console.error(
        `      Exit 2, not 0 — nothing was compared, which is a different answer from "the\n` +
          `      table and the type agree".`
      );
      process.exit(2);
    }
    throw e;
  }

  /* NAME WHAT WAS READ. This will be met by someone whose new field is failing CI, and a
   * verdict that does not say which table it read against which type fools them once. */
  console.log(
    `${relative(CWD, r.readmePath)} — Field table with ${r.documented.length} row(s), ` +
      `against \`${TYPE}\` in ${r.where} with ${r.names.length} field(s)` +
      (r.excluded.length ? `, ${r.excluded.length} declared absent` : "")
  );
  console.log(`  type  : ${r.names.join(", ")}`);
  console.log(`  table : ${r.documented.join(", ")}`);
  if (r.excluded.length) console.log(`  absent: ${r.excluded.join(", ")}`);

  const problems = [];
  if (r.undocumented.length)
    problems.push(
      `${r.undocumented.length} field(s) on \`${TYPE}\` are in NEITHER the table nor the ` +
        `"deliberately not here" section: ${r.undocumented.join(", ")}\n` +
        `      Document them, or say in the README why they are absent. A forker reading the\n` +
        `      vocabulary has no way to learn a field the vocabulary omits.`
    );
  if (r.stale.length)
    problems.push(
      `${r.stale.length} table row(s) describe a field \`${TYPE}\` does not have: ` +
        `${r.stale.join(", ")}\n` +
        `      This is the direction that rots quietly — the table still reads complete, and\n` +
        `      sends a reader to import something that is gone.`
    );

  if (problems.length === 0) {
    console.log(
      `\nOK — every field is documented or declared absent, and no row describes a field that ` +
        `does not exist.\n     NAMES ONLY: nothing here asserts the descriptions are accurate, ` +
        `and a text match on prose\n     would produce false positives rather than coverage.`
    );
    return;
  }
  console.error(`\nFAIL:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();
