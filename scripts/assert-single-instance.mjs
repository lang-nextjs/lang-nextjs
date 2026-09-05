#!/usr/bin/env node
/**
 * RCT-04's second half: no duplicate module instances.
 *
 * The requirement is "React and Zod declared as `peerDependencies` (not
 * `dependencies`) to prevent duplicate module instances". The #36 audit marked
 * it PARTIALLY COVERED, and #222 carried it forward. The covered half is the
 * declaration; the uncovered half is the CONSEQUENCE the declaration exists to
 * produce — and the consequence was not holding.
 *
 * When this file was written the tree had TWO zod copies installed, 3.25.76 and
 * 4.4.3, because `packages/mcp` pinned `zod: ^3.23.0` in `dependencies` while
 * `packages/react` peered it. Nothing anywhere reported that. Two zod copies
 * means a schema built by one is not `instanceof` the other's classes, so
 * validation across the boundary fails on objects that are structurally
 * perfect, and the error says the value is wrong rather than that the library
 * is doubled.
 *
 * TWO RULES, because either alone is escapable:
 *
 *   R1  a package that IMPORTS a shared singleton must declare it in
 *       `peerDependencies`, never in `dependencies`. This is the cause.
 *   R2  the installed tree must resolve each singleton to exactly ONE version.
 *       This is the effect, and it catches what R1 cannot: a transitive
 *       dependency dragging in a second copy with no manifest of ours at fault.
 *
 * R1 without R2 passes a tree that is already doubled by someone else's
 * dependency. R2 without R1 passes a manifest that will double the moment
 * versions drift apart. The pair is the check.
 *
 * REFUSES A ZERO-PACKAGE SWEEP. A checker that examines nothing and reports
 * PASS is worse than no checker, because the green is read as evidence — see
 * scripts/assert-no-verdict-destroying-pipelines.mjs, which learned the same
 * lesson the same way.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { reportSubject } from "./lib/subject.mjs";

// The modules whose identity matters — ones that hold module-level state or use
// `instanceof` across a package boundary. Adding a package here is cheap;
// leaving one out is what produced the zod split.
const SINGLETONS = ["react", "react-dom", "zod"];

const root = process.cwd();
const failures = [];

function read(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

// ---- R1: a package that imports a singleton must peer it, not depend on it.
function importsModule(dir, mod) {
  const stack = [dir];
  const re = new RegExp(`from\\s+["']${mod.replace("-", "\\-")}["']`);
  while (stack.length) {
    const cur = stack.pop();
    if (!existsSync(cur)) continue;
    for (const e of readdirSync(cur, { withFileTypes: true })) {
      const p = join(cur, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && e.name !== "dist") stack.push(p);
      } else if (
        /\.(ts|tsx|js|jsx|mjs)$/.test(e.name) &&
        !/\.test\./.test(e.name)
      ) {
        if (re.test(readFileSync(p, "utf8"))) return p;
      }
    }
  }
  return null;
}

const pkgDir = join(root, "packages");
const pkgs = existsSync(pkgDir)
  ? readdirSync(pkgDir, { withFileTypes: true })
      .filter(
        (e) =>
          e.isDirectory() && existsSync(join(pkgDir, e.name, "package.json"))
      )
      .map((e) => e.name)
  : [];

if (pkgs.length === 0) {
  console.error(
    "REFUSING TO PASS: swept 0 packages. A green here would mean\n" +
      "the layout moved, not that the invariant holds."
  );
  process.exit(2);
}

let r1Checks = 0;
for (const name of pkgs) {
  const dir = join(pkgDir, name);
  const manifest = read(join(dir, "package.json"));
  for (const mod of SINGLETONS) {
    const site = importsModule(join(dir, "src"), mod);
    if (!site) continue;
    r1Checks++;
    const inDeps = manifest.dependencies?.[mod];
    const inPeer = manifest.peerDependencies?.[mod];
    if (inDeps) {
      failures.push(
        `R1 ${manifest.name}: imports "${mod}" (${site.replace(
          root + "/",
          ""
        )}) ` +
          `but declares it in dependencies (${inDeps}), not peerDependencies. ` +
          `A hard dependency installs its OWN copy.`
      );
    } else if (!inPeer) {
      failures.push(
        `R1 ${manifest.name}: imports "${mod}" (${site.replace(
          root + "/",
          ""
        )}) ` +
          `but declares it nowhere. It resolves today by hoisting, which is luck.`
      );
    }
  }
}

// ---- R2: the RESOLVED GRAPH holds exactly one version of each singleton.
//
// Read from pnpm-lock.yaml, not from node_modules/.pnpm. The store directory
// keeps ORPHANS: after moving mcp's zod to a peer, the lockfile resolved to a
// single zod@4.4.3 while `zod@3.25.76` was still sitting in the store from the
// previous install. A store-based R2 reported a duplicate that no longer
// existed anywhere in the graph.
//
// That is the same class of defect this checker exists to catch, pointed the
// other way: a verdict about something the check never actually measured. The
// lockfile is what CI installs from, so it is what the claim should be about.
const lockPath = join(root, "pnpm-lock.yaml");
let r2Checks = 0;
if (!existsSync(lockPath)) {
  console.error(
    "REFUSING TO PASS: pnpm-lock.yaml is absent, so R2 measured\n" +
      "nothing. A green without it would be vacuous."
  );
  process.exit(2);
}
// The `packages:` section lists every resolved tarball exactly once, keyed
// `name@version`. Peer-disambiguated keys (`react-dom@19.2.6(react@19.2.6)`)
// live in `snapshots:` and would double-count, so only `packages:` is read.
const lockLines = readFileSync(lockPath, "utf8").split("\n");
const pkgStart = lockLines.findIndex((l) => l === "packages:");
if (pkgStart === -1) {
  console.error(
    "REFUSING TO PASS: pnpm-lock.yaml has no `packages:` section —\n" +
      "the format changed and R2 would silently match nothing."
  );
  process.exit(2);
}
const resolved = new Map();
for (let i = pkgStart + 1; i < lockLines.length; i++) {
  const line = lockLines[i];
  if (/^[a-z]/.test(line)) break; // next top-level section
  const m = /^  '?((?:@[^/]+\/)?[^@'\s]+)@([^'():\s]+)'?:/.exec(line);
  if (!m) continue;
  const [, name, version] = m;
  if (!SINGLETONS.includes(name)) continue;
  if (!resolved.has(name)) resolved.set(name, new Set());
  resolved.get(name).add(version);
}
for (const mod of SINGLETONS) {
  const versions = resolved.get(mod);
  if (!versions) continue;
  r2Checks++;
  if (versions.size > 1) {
    failures.push(
      `R2 "${mod}" resolves to ${versions.size} versions: ${[...versions]
        .sort()
        .join(", ")}. ` + `Every copy is a separate module identity.`
    );
  }
}

if (r1Checks === 0 && r2Checks === 0) {
  console.error("REFUSING TO PASS: neither rule examined anything.");
  process.exit(2);
}

if (failures.length) {
  console.error("FAIL — duplicate module instances are possible or present:\n");
  for (const f of failures) console.error("  " + f);
  console.error(
    `\nSwept ${pkgs.length} packages: ${r1Checks} import sites (R1), ` +
      `${r2Checks} resolved singletons (R2).`
  );
  process.exit(1);
}

reportSubject(pkgs.length, "package(s) swept for singleton imports");
console.log(
  `PASS: ${pkgs.length} packages swept — ${r1Checks} import sites declare their ` +
    `singletons as peers, and ${r2Checks} resolve to one version each in the lockfile.`
);
