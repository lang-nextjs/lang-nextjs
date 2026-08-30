#!/usr/bin/env node
/**
 * assert-overrides-cannot-go-inert.mjs — a dependency override must not carry a version
 * selector, because a selector is what lets an override silently stop applying.
 *
 * THE DEFECT, MEASURED (#378). package.json carried
 *
 *     "tar@<7.5.11": ">=7.5.11"
 *
 * The advisory widened; `pnpm audit` now reports tar vulnerable through 7.5.20. The resolved
 * tree held 7.5.15 — ABOVE the selector's bound, so the override no longer matched it and did
 * nothing at all. It read as a handled dependency and was not one. The same had happened to
 * fast-uri and postcss; eleven advisories were closed by rewriting three lines.
 *
 * THE FIX IS SHAPE, NOT CURRENCY, AND THAT IS THE WHOLE POINT OF CHECKING IT HERE.
 *
 *   "tar@<7.5.11": ">=7.5.11"   can stop matching, and says nothing when it does
 *   "tar": ">=7.5.21"           always matches; it can only be BEHIND, never INERT
 *
 * Both can be out of date. Only the first can be out of date INVISIBLY — the second still
 * pins every resolution, so a stale target shows up as an audit finding on a package the
 * repo is actively overriding, which is a thing a person can act on. This checker therefore
 * asserts the SHAPE and leaves currency to `pnpm audit` and Dependabot, which already own it.
 *
 * WHY NOT CHECK CURRENCY HERE. It would need the network on every run, and a checker that
 * fails when a registry hiccups is a checker someone disables. Worse, it would duplicate a
 * signal the repo already has: the audit step reports the same 67 advisories either way. The
 * defect this file exists for is not "the pin is old" — it is "the pin is not applied", and
 * that is decidable offline from package.json alone.
 *
 * Usage:  node scripts/assert-overrides-cannot-go-inert.mjs [--cwd DIR]
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const cwdFlag = argv.indexOf("--cwd");
const CWD = cwdFlag >= 0 ? resolve(argv[cwdFlag + 1]) : ROOT;

/**
 * A key carries a selector when it names a version range after the package name.
 *
 * Scoped packages start with `@`, so the separator is an `@` that is NOT at index 0 — the
 * naive `key.includes("@")` reports every `@scope/pkg` as selective and the checker fires on
 * a clean tree, which is how a gate earns the reflex to be skipped.
 */
export function selectorOf(key) {
  const at = key.indexOf("@", 1);
  return at === -1 ? null : key.slice(at + 1);
}

export function findInertRiskOverrides(cwd = CWD) {
  const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
  const overrides = pkg?.pnpm?.overrides ?? {};
  const keys = Object.keys(overrides);
  const offenders = keys
    .map((k) => ({ key: k, selector: selectorOf(k), target: overrides[k] }))
    .filter((o) => o.selector !== null);
  return { offenders, total: keys.length };
}

function main() {
  const { offenders, total } = findInertRiskOverrides(CWD);

  /*
   * THE NON-VACUITY FLOOR. With no overrides at all there are no offenders and this exits 0
   * having checked nothing — the shape it exists to catch. A repo that genuinely removes its
   * last override should have to delete this check deliberately rather than have it quietly
   * start passing about an empty set.
   */
  if (total === 0) {
    console.error(
      "FAIL: package.json declares no pnpm.overrides, so this check measured nothing. " +
        "If that is deliberate, remove this checker rather than leaving it passing over an " +
        "empty set."
    );
    process.exit(2);
  }

  if (offenders.length === 0) {
    console.log(
      `PASS: ${total} override(s), none carrying a version selector — an override here can be ` +
        `behind, but it cannot silently stop applying.`
    );
    return;
  }

  console.error(
    `FAIL: ${offenders.length} of ${total} override(s) carry a version selector and can go ` +
      `inert.\n`
  );
  for (const o of offenders) {
    const name = o.key.slice(0, o.key.length - o.selector.length - 1);
    console.error(`  "${o.key}": "${o.target}"`);
    console.error(
      `      the selector "${o.selector}" stops matching once a resolution rises above it, and\n` +
        `      the override then does nothing while still reading as protection.\n` +
        `      write it as  "${name}": "${o.target}"\n`
    );
  }
  process.exit(1);
}

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();
