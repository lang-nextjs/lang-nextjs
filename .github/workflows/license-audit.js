#!/usr/bin/env node
"use strict";
/**
 * Production-dependency license gate.
 *
 * Reads the resolved production dependency tree from
 * `pnpm licenses list --prod --json` — NOT a hardcoded package list — and
 * fails when a dependency carries a license outside the allowlist.
 *
 * Three layers, applied in order:
 *
 *   1. ALLOWED       — literal license strings.
 *   2. SPDX splitter — for anything unmatched, strip parens, split on
 *                      AND/OR, and allow only if EVERY component is
 *                      permissive. Handles new SPDX expression shapes as
 *                      deps evolve.
 *   3. PACKAGE_EXCEPTIONS — a named, per-package escape hatch. This is the
 *                      ONLY way a non-permissive license passes, and it is
 *                      bound to BOTH the package name AND the exact license
 *                      string. It is deliberately NOT a license-level
 *                      allowlist: adding `UNLICENSED` to ALLOWED would let
 *                      every future unlicensed dependency through forever,
 *                      in a public repo whose whole purpose is being forked.
 *                      A fork inherits the dependency and the ambiguity.
 */

const PERMISSIVE = [
  "MIT",
  "ISC",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "Unlicense",
  "0BSD",
  "BlueOak-1.0.0",
  "Python-2.0",
  "CC-BY-3.0",
  "CC-BY-4.0",
  "WTFPL",
  "Apache 2.0",
  "MPL-2.0",
  "Unicode-DFS-2016",
  "Unicode-3.0",
  "MIT-0",
  "AFL-2.1",
];

// Literal allowlist = permissive set, plus license-level exceptions that are
// NOT package-bound. Keep this list short and justify every addition.
//   - LGPL-3.0-or-later: used only by @img/sharp-libvips native binaries,
//     dynamically linked at runtime and never bundled into our output. This
//     one stays license-level on purpose: the sharp-libvips package name is
//     platform-specific (@img/sharp-libvips-darwin-arm64 locally,
//     -linux-x64 in CI), so a name-bound exception would pass on one runner
//     and fail on another. Re-evaluate if a non-sharp LGPL dep appears.
const ALLOWED = [...PERMISSIVE, "LGPL-3.0-or-later"];

/**
 * Per-package exceptions. Keyed by exact package name; `license` must match
 * the reported license string exactly, so an exception granted for one
 * license never silently covers a different one.
 *
 * STOPGAP ENTRIES — each one is a debt with a named payoff. When the payoff
 * lands, DELETE the entry; do not leave it behind "just in case".
 */
const PACKAGE_EXCEPTIONS = {
  "@digitalfrontier/theme": {
    license: "UNLICENSED",
    reason:
      "First-party package, same owner as this repo, pinned to an immutable " +
      "commit SHA in packages/ui/package.json (github:Digital-Frontier-LDA/" +
      "df-theme#e4c176cbbc46c9f067a9d352541ceb2223cc7317). Its package.json " +
      'declares "license": "UNLICENSED" EXPLICITLY — this is not a missing ' +
      'field. (A package with no license field at all reports as "Unknown", ' +
      "a different string this exception deliberately does NOT cover.) " +
      "THIS IS A STOPGAP. The real fix lives in the df-theme repo and is TWO " +
      'changes, not one: add a LICENSE file AND replace "license": ' +
      '"UNLICENSED" with a real SPDX identifier. Adding only the LICENSE file ' +
      "leaves the declared value untouched and this gate still red. When both " +
      "land, DELETE this exception rather than updating it — the gate should " +
      "go back to passing on its own.",
  },
};

/** Layer 1 + 2: is this license string acceptable on its own merits? */
function isLicenseAllowed(license) {
  if (ALLOWED.includes(license)) return true;
  const components = license
    .replace(/^\(/, "")
    .replace(/\)$/, "")
    .split(/ (?:AND|OR) /)
    .map((c) => c.trim())
    .filter(Boolean);
  // A bare string that split into nothing is not implicitly allowed.
  if (components.length === 0) return false;
  return components.every((c) => PERMISSIVE.includes(c));
}

/**
 * @param {Record<string, Array<{name:string, versions?:string[]}>>} data
 * @param {Record<string, {license:string, reason:string}>} exceptions
 */
function audit(data, exceptions = PACKAGE_EXCEPTIONS) {
  const bad = [];
  const applied = [];
  for (const [license, pkgs] of Object.entries(data)) {
    if (isLicenseAllowed(license)) continue;
    for (const pkg of pkgs || []) {
      const ex = exceptions[pkg.name];
      if (ex && ex.license === license) {
        applied.push({ name: pkg.name, license });
      } else {
        bad.push({
          name: pkg.name,
          versions: (pkg.versions || []).join(", "),
          license,
        });
      }
    }
  }
  return { ok: bad.length === 0, bad, applied };
}

module.exports = {
  audit,
  isLicenseAllowed,
  PACKAGE_EXCEPTIONS,
  ALLOWED,
  PERMISSIVE,
};

if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: license-audit.js <pnpm-licenses-json>");
    process.exit(2);
  }
  const data = require(require("path").resolve(file));
  const licenses = Object.keys(data);
  console.log("Licenses found in production deps:");
  for (const l of licenses) console.log("  " + l);

  const { ok, bad, applied } = audit(data);

  for (const a of applied) {
    console.log(`\nPer-package exception applied: ${a.name} (${a.license})`);
    console.log("  " + PACKAGE_EXCEPTIONS[a.name].reason);
  }

  if (!ok) {
    console.log("");
    console.log(
      "::error::Disallowed license(s) found in production dependencies:"
    );
    for (const b of bad) {
      console.log(
        `  ${b.license}  <-  ${b.name}${b.versions ? "@" + b.versions : ""}`
      );
    }
    console.log("");
    console.log("Fix the dependency, or add a NAMED per-package exception to");
    console.log(
      ".github/workflows/license-audit.js with a written justification."
    );
    console.log(
      "Do NOT add the license string to ALLOWED — that disables the gate."
    );
    process.exit(1);
  }
  console.log("\nAll production-dep licenses are within the allowlist.");
}
