#!/usr/bin/env node
/**
 * THE TYPESCRIPT MAJOR PIN IS STILL JUSTIFIED, AND STILL IN FORCE (#1050).
 *
 * .github/dependabot.yml ignores typescript majors. The reason is recorded on that
 * entry rather than here, because a reason kept somewhere else expires without the
 * constraint noticing. This script is the half a comment cannot do: it watches for
 * the event that LIFTS the pin, and for the pin quietly ceasing to apply.
 *
 * WHAT THE PIN IS ABOUT. Our TypeScript version does not govern our .d.ts output.
 * tsup emits declarations through a rollup-plugin-dts that its PUBLISHED BUNDLE
 * froze at its own build time. Measured on the installed tree: the pnpm store key
 * reads `tsup@8.5.1_..._typescript@6.0.3_...` while the file inside it,
 * dist/rollup.js, carries the literal `typescript@5.7.3` twice. The store key is a
 * RESOLUTION fact — which compiler pnpm handed tsup. The string is a BUILD fact —
 * which compiler tsup runs. Only the second emits our declarations, and no
 * lockfile query can reach it, because it is not a resolution at all.
 *
 * WHY A CHECKER RATHER THAN A DATE. The pin expires on an EVENT: tsup publishing a
 * dist that no longer bakes a TypeScript older than ours. A date cannot observe an
 * event, so a dated TODO would either fire while the reason still holds or sit
 * unfired after it stops. Reading the dist observes it directly.
 *
 * WHY IT MUST NOT SHELL OUT TO `grep`. The subject lives in node_modules, which is
 * gitignored, and this repo's interactive `grep` is a shell function dispatching to
 * ugrep with `--ignore-files`. A recursive grep from the repo root returns ZERO for
 * `typescript@5.7.3` — not an error, a zero. A checker built on that would find no
 * baked version, have nothing to compare, and pass vacuously forever while
 * asserting the opposite of what it means. Everything here reads through `fs`,
 * which has no opinion about .gitignore.
 *
 * EXIT CODES
 *   0  the pin is in force and still justified
 *   1  a violation: the pin is inert, bypassed, or its premise has expired
 *   2  a refusal: an input could not be read, so no verdict is available
 *
 * Exit 2 is never a pass. Every "cannot compute" path below refuses, because the
 * failure this guards is precisely one that looks like nothing.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The major this repo is held at. Changing this number is a decision, not a
 * refresh: the dependabot.yml entry states the reason it is 6, and the two must
 * move together or the constraint and its justification stop describing the
 * same thing.
 */
export const PINNED_MAJOR = 6;
export const PINNED_DEP = "typescript";

export class Refusal extends Error {}

export function parseMajor(range) {
  if (typeof range !== "string") return null;
  const m = /(\d+)\.\d+\.\d+/.exec(range);
  return m ? Number(m[1]) : null;
}

/**
 * Every `typescript@X.Y.Z` baked into a directory's .js files, read as bytes.
 * Returns [] when the directory has no such string, which the caller must treat
 * as "could not compute" rather than as "none" — see the refusal in main().
 */
export function bakedVersionsIn(distDir) {
  const out = [];
  if (!existsSync(distDir)) return out;
  for (const f of readdirSync(distDir)) {
    if (!f.endsWith(".js")) continue;
    const text = readFileSync(join(distDir, f), "utf8");
    for (const m of text.matchAll(/typescript@(\d+)\.(\d+)\.(\d+)/g))
      out.push({
        file: `${f}`,
        version: `${m[1]}.${m[2]}.${m[3]}`,
        major: Number(m[1]),
      });
  }
  return out;
}

/** Where tsup's built bundle lives, in either pnpm's layout or a hoisted one. */
export function tsupDistDirs(root) {
  const dirs = [];
  const store = join(root, "node_modules/.pnpm");
  if (existsSync(store))
    for (const d of readdirSync(store))
      if (d.startsWith("tsup@")) {
        const dist = join(store, d, "node_modules/tsup/dist");
        if (existsSync(dist)) dirs.push({ key: d, dist });
      }
  const hoisted = join(root, "node_modules/tsup/dist");
  if (existsSync(hoisted) && !dirs.some((d) => d.dist === hoisted))
    dirs.push({ key: "node_modules/tsup", dist: hoisted });
  return dirs;
}

/**
 * The `ignore:` entries of a dependabot config, WITHOUT a YAML parser (this repo
 * has none resolvable) and without a regex over the whole file.
 *
 * It returns the duplicate-key count alongside the entries because a mapping with
 * two `ignore:` keys silently keeps only the last — measured: PyYAML on such a
 * document returns `{'ignore': ['second']}`. A file can therefore SHOW two fully
 * commented ignore blocks and MEAN one, which is a defect no reading of the diff
 * catches and which this checker's own author shipped before catching it.
 */
export function readIgnoreBlocks(yamlText) {
  const lines = yamlText.split("\n");
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)ignore:\s*$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    const entries = [];
    let current = null;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === "" || /^\s*#/.test(line)) continue;
      const lead = line.length - line.trimStart().length;
      if (lead <= indent) break;
      const item = /^\s*-\s*dependency-name:\s*(\S+)\s*$/.exec(line);
      if (item) {
        current = {
          name: item[1].replace(/^["']|["']$/g, ""),
          updateTypes: [],
        };
        entries.push(current);
        continue;
      }
      const ut = /^\s*-\s*(version-update:[a-z-]+)\s*$/.exec(line);
      if (ut && current) current.updateTypes.push(ut[1]);
    }
    blocks.push({ line: i + 1, indent, entries });
  }
  return blocks;
}

/** Two ignore blocks at the same indent are two keys in one mapping. */
export function shadowedBlocks(blocks) {
  const byIndent = new Map();
  for (const b of blocks)
    byIndent.set(b.indent, (byIndent.get(b.indent) ?? 0) + 1);
  return [...byIndent.entries()].filter(([, n]) => n > 1);
}

/**
 * The verdict, as a pure function of facts, so the selftest can drive every arm
 * without a node_modules tree or a dependabot file.
 */
export function evaluate({
  declaredMajor,
  bakedMajors,
  ignoresMajor,
  shadowed,
}) {
  const problems = [];
  if (shadowed.length)
    problems.push(
      `.github/dependabot.yml has ${shadowed
        .map(([ind, n]) => `${n} \`ignore:\` keys at indent ${ind}`)
        .join(", ")}. ` +
        `YAML keeps only the LAST, silently, so at least one fully written ignore block means nothing. ` +
        `REPAIR: merge them into a single ignore list.`
    );
  if (!ignoresMajor)
    problems.push(
      `.github/dependabot.yml does not ignore ${PINNED_DEP} majors, so nothing stops the bump this pin exists to stop. ` +
        `REPAIR: restore the entry with its reason — or, if the pin was removed deliberately, delete this checker ` +
        `and its scripts/checks.json entry in the same commit, because a guard for a constraint nobody holds is worse ` +
        `than no guard.`
    );
  if (declaredMajor !== PINNED_MAJOR)
    problems.push(
      `package.json declares typescript major ${declaredMajor}, but the pin recorded in dependabot.yml is ${PINNED_MAJOR}. ` +
        `dependabot.yml constrains Dependabot; a person editing package.json is not Dependabot, so the two can disagree ` +
        `with every gate green. REPAIR: move both together, or neither.`
    );
  const min = bakedMajors.length ? Math.min(...bakedMajors) : null;
  if (min !== null && min >= PINNED_MAJOR)
    problems.push(
      `tsup's installed dist no longer bakes a TypeScript older than ours (oldest baked major ${min}, ours ${PINNED_MAJOR}). ` +
        `THE PIN'S PREMISE HAS EXPIRED — this is the event it was waiting for, not a failure. ` +
        `REPAIR: remove the typescript entry from .github/dependabot.yml, delete this checker and its ` +
        `scripts/checks.json entry, and take the major bump on its own merits.`
    );
  return problems;
}

function main(argv) {
  const here = dirname(fileURLToPath(import.meta.url));
  const rootArg = argv.indexOf("--root");
  const root =
    rootArg === -1 ? resolve(here, "..") : resolve(argv[rootArg + 1]);

  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) throw new Refusal(`no package.json at ${pkgPath}`);
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const range =
    pkg.devDependencies?.[PINNED_DEP] ?? pkg.dependencies?.[PINNED_DEP];
  if (range === undefined)
    throw new Refusal(
      `root package.json declares no ${PINNED_DEP}. This checker cannot say whether a pin is in force ` +
        `on a dependency the manifest does not mention.`
    );
  const declaredMajor = parseMajor(range);
  if (declaredMajor === null)
    throw new Refusal(
      `cannot read a major out of the declared ${PINNED_DEP} range "${range}"`
    );

  const dbPath = join(root, ".github/dependabot.yml");
  if (!existsSync(dbPath))
    throw new Refusal(`no .github/dependabot.yml at ${dbPath}`);
  const blocks = readIgnoreBlocks(readFileSync(dbPath, "utf8"));
  const shadowed = shadowedBlocks(blocks);
  const ignoresMajor = blocks.some((b) =>
    b.entries.some(
      (e) =>
        e.name === PINNED_DEP &&
        e.updateTypes.includes("version-update:semver-major")
    )
  );

  const dists = tsupDistDirs(root);
  if (dists.length === 0)
    throw new Refusal(
      `tsup is not installed under ${root}, so its baked TypeScript cannot be read. Run the install first — ` +
        `this check reports on an installed tree, and an absent one is not a clean one.`
    );
  const baked = dists.flatMap((d) =>
    bakedVersionsIn(d.dist).map((b) => ({ ...b, key: d.key }))
  );
  if (baked.length === 0)
    throw new Refusal(
      `tsup's dist was found (${dists
        .map((d) => d.key)
        .join(", ")}) but contains NO \`typescript@X.Y.Z\` string. ` +
        `Either tsup changed how it records its frozen toolchain, or this is reading the wrong files. ` +
        `Refusing rather than reporting "nothing baked", which is the same output a broken search gives.`
    );

  const problems = evaluate({
    declaredMajor,
    bakedMajors: baked.map((b) => b.major),
    ignoresMajor,
    shadowed,
  });

  const subject =
    `declared: ${PINNED_DEP}@${range} (major ${declaredMajor})\n` +
    `  dependabot ignores ${PINNED_DEP} majors: ${ignoresMajor}\n` +
    [
      ...baked.reduce((m, b) => {
        const k = `${b.key}/dist/${b.file}: typescript@${b.version}`;
        return m.set(k, (m.get(k) ?? 0) + 1);
      }, new Map()),
    ]
      .map(([k, n]) => `  baked in ${k}${n > 1 ? ` (x${n})` : ""}`)
      .join("\n");

  if (problems.length) {
    console.error(
      `FAIL: the typescript pin is not both in force and justified.\n\n${subject}\n`
    );
    for (const p of problems) console.error(`  - ${p}\n`);
    return 1;
  }
  console.log(
    `PASS: the typescript major pin is in force and its premise still holds.\n\n  ${subject}\n\n` +
      `  tsup still emits our declarations with a TypeScript older than the one that typechecks\n` +
      `  our source, so holding at ${PINNED_MAJOR} keeps that gap from widening. This passes by\n` +
      `  READING THE INSTALLED BUNDLE, not the lockfile — the baked version is a string inside a\n` +
      `  published file and appears in no resolution anywhere.`
  );
  return 0;
}

const invokedDirectly =
  resolve(process.argv[1] ?? "") === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    if (e instanceof Refusal) {
      console.error(`REFUSING: ${e.message}`);
      process.exit(2);
    }
    throw e;
  }
}
