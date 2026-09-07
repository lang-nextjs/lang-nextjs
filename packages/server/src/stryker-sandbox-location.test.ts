/**
 * THE STRYKER SANDBOX MUST STAY INSIDE THE REPOSITORY, AND THIS IS THE ONLY PLACE
 * THAT CAN SAY SO (#1025).
 *
 * Stryker copies this package into `.stryker-tmp/sandbox-N/` and runs the suite from
 * there. Two things depend on that directory being INSIDE the repo, and until this
 * file neither was asserted anywhere:
 *
 *  1. OUR CODE. Five suites reach repo-root artifacts -- apps/, docs/, rungs.json --
 *     by searching UPWARD from their own file (`__testing__/repo-root.ts`). That
 *     search terminates at the real root only because the sandbox is a descendant of
 *     it. Outside the tree it finds no marker and every one of them refuses.
 *
 *  2. STRYKER ITSELF, AND THIS IS THE HALF WE CANNOT FIX. It rewrites the sandbox
 *     copy's relative `extends` BY DEPTH:
 *
 *         packages/server/tsconfig.json     extends ../../tsconfig.base.json
 *         the copy in the sandbox           extends ../../../../tsconfig.base.json
 *
 *     -- exactly the two levels the sandbox sits below the package. Correct only on
 *     the assumption that it sits there at all. Point the temp dir outside and the
 *     rewrite resolves to `/tsconfig.base.json`, the runner dies at transform time
 *     with TSCONFIG_ERROR, and OUR five suites never load at all: they get no chance
 *     to give the refusal designed for exactly this.
 *
 * SO AN ASSERTION IS NOT THE BEST REMEDY, IT IS THE ONLY ONE. #1021's own finding is
 * that a fixed distance is a fact about where code SITS, not where it RUNS. #1023
 * stopped our test files counting dots. The remaining counter is inside Stryker, and
 * it is not ours to repair -- so the input to the broken counter is constrained here
 * instead. That is why this file exists and why deleting it as "obviously true" would
 * be wrong: it is obviously true only while nobody has set the key.
 *
 * WHY IT LIVES IN THE VITEST SUITE RATHER THAN IN A CHECKER OR IN THE GATE. It reads
 * the config file and needs no sandbox, so it runs under `pnpm test` -- including the
 * step that now precedes Stryker in mutation.yml. That is the one place it can fire.
 * The mutation gate itself cannot host it: a misconfiguration is invisible to the dry
 * run either way, since the runner crashes before any test registers and Stryker's
 * completion check filters a result list that a crashed file never contributed to
 * (#1024). Loud in the log, silent in the verdict, which is what #1021 was three
 * weeks of.
 */
import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot } from "./__testing__/repo-root";

const ROOT = repoRoot(__dirname);

/**
 * THE SUBJECT IS DISCOVERED, NOT LISTED. There is one Stryker config today. A
 * hardcoded path would keep passing about that one file while saying nothing about
 * the second the day someone adds it -- a check whose subject is narrower than the
 * property it claims, which is the shape #1021 was. Walking also means a config that
 * is RENAMED or MOVED shows up as an empty list and fails the arm below, rather than
 * as a quiet green over a path nobody visits any more.
 */
function strykerConfigs(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) strykerConfigs(full, acc);
    else if (/^stryker\.config\.(mjs|js|cjs|json)$/.test(e.name))
      acc.push(relative(ROOT, full).split(sep).join("/"));
  }
  return acc;
}

const CONFIGS = strykerConfigs(ROOT).sort();

/** Where Stryker resolves a relative `tempDirName` from: the config's own directory. */
const projectDirOf = (rel: string) => resolve(ROOT, rel, "..");

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

describe("the Stryker sandbox stays inside the repository", () => {
  it("the config list is not empty, so nothing below is vacuous", () => {
    // A per-config loop over an empty list passes while asserting nothing -- the
    // failure this repo keeps meeting. Since the list is WALKED, an empty one means
    // the tree no longer holds a Stryker config where this file looks, which is a
    // finding rather than a nil return.
    // AND IT MUST BE ITS OWN CASE, NOT A GUARD INSIDE THE LOOP. With an empty list
    // the per-config cases DO NOT EXIST -- driven, the suite reports "1 failed (1)"
    // rather than "1 failed | 1 passed (2)". A check written inside the loop would
    // have vanished along with its subject and the file would have gone green.
    expect(
      CONFIGS,
      `found no stryker.config.* under ${ROOT} -- either the mutation gate has no ` +
        `config any more, or it moved somewhere this walk does not reach. Either way ` +
        `the per-config assertion below would be about an empty list.`
    ).not.toEqual([]);
  });

  for (const rel of CONFIGS) {
    it(`${rel}: tempDirName is unset or resolves inside the repo root`, async () => {
      const mod = await import(pathToFileURL(join(ROOT, rel)).href);
      const config = mod.default as Record<string, unknown>;

      // ANTI-VACUITY ON THE LOAD ITSELF. An import that yielded `{}` -- a moved file,
      // a changed export shape, a config that stopped being a module -- would make
      // `tempDirName` undefined and this test would PASS while reading nothing. So a
      // key Stryker cannot run without is required before the absence of another key
      // is allowed to mean anything.
      expect(
        config?.testRunner,
        `${rel} did not export a Stryker config object, so "tempDirName is unset" ` +
          `below would be a statement about an empty object rather than about the config`
      ).toBeTypeOf("string");

      const tempDirName = config.tempDirName;
      if (tempDirName === undefined) return;

      expect(
        tempDirName,
        `${rel} sets tempDirName to a non-string, which Stryker will not resolve as a path`
      ).toBeTypeOf("string");

      const abs = resolve(projectDirOf(rel), tempDirName as string);
      expect(
        isInside(ROOT, abs),
        `${rel} sets tempDirName to ${JSON.stringify(
          tempDirName
        )}, which resolves to\n` +
          `  ${abs}\n` +
          `outside the repository root\n  ${ROOT}\n\n` +
          `Stryker rewrites the sandbox copy's tsconfig \`extends\` by DEPTH, assuming the ` +
          `sandbox sits below the package inside the repo. Outside it, that rewrite ` +
          `resolves to a path that does not exist and the test runner dies at transform ` +
          `time -- before any of the five suites that search upward for the repo root can ` +
          `report anything. Keep the sandbox inside the tree, or those suites lose their ` +
          `subject and the mutation gate reports a score without them (#1021, #1024, #1025).`
      ).toBe(true);
    });
  }
});
