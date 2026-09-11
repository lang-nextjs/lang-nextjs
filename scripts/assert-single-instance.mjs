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
import { printThenRank } from "./lib/print-then-rank.mjs";
import { SINGLETONS } from "./lib/singletons.mjs";

const root = process.cwd();
const failures = [];
const refusals = [];

function read(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

// ---- R1: a package that imports a singleton must peer it, not depend on it.
//
// The walk reads each source file guarded (#1215): one chmod-000 file used to
// throw out of the walk and out of the package loop, after earlier packages'
// failures had accumulated and before they printed — the same crash as the
// manifest read below, one read over. A file that cannot be read is a refusal
// naming it, ONCE (the walk runs per singleton, and the same unreadable file
// is not a new refusal each pass); the sweep covers the files that could be
// read, and the refusal says the coverage is partial.
const unreadableSources = new Set();
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
        let text;
        try {
          text = readFileSync(p, "utf8");
        } catch (err) {
          if (!unreadableSources.has(p)) {
            unreadableSources.add(p);
            refusals.push(
              `${p.replace(root + "/", "")}: cannot be read — ${
                err.message
              }. ` +
                `The import sweep covers only the files that could be read.`
            );
          }
          continue;
        }
        if (re.test(text)) return p;
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
  /*
   * A REFUSAL NO LONGER HIDES A FINDING (#1215). This read was a bare
   * JSON.parse: a merge-conflict marker left in any manifest by an ordinary
   * rebase threw here, AFTER earlier packages' R1 failures had accumulated and
   * BEFORE they printed. The run died on a Node trailer, run-checks filed it
   * `refused`, and the finding was named 0 times (DEV1, measured). The manifest
   * that cannot be parsed is a refusal naming the file; everything computed
   * still prints, and the helper ranks the exit.
   */
  let manifest;
  try {
    manifest = read(join(dir, "package.json"));
  } catch (e) {
    refusals.push(
      `packages/${name}/package.json cannot be read as JSON — ${e.message}. ` +
        `A merge-conflict marker or a truncated write reads exactly like this. ` +
        `Nothing in it was checked.`
    );
    continue;
  }
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
  refusals.push(
    "pnpm-lock.yaml is absent, so R2 measured nothing. " +
      "A green without it would be vacuous."
  );
} else {
  // The `packages:` section lists every resolved tarball exactly once, keyed
  // `name@version`. Peer-disambiguated keys (`react-dom@19.2.6(react@19.2.6)`)
  // live in `snapshots:` and would double-count, so only `packages:` is read.
  //
  // existsSync says the lockfile is THERE, not that it can be read (#1215):
  // chmod 000, or a delete between the check and the read, threw here after
  // the R1 loop's failures had accumulated — the same crash, one read over.
  let lockLines = null;
  try {
    lockLines = readFileSync(lockPath, "utf8").split("\n");
  } catch (e) {
    refusals.push(
      `pnpm-lock.yaml exists but cannot be read — ${e.message}. ` +
        `R2 measured nothing.`
    );
  }
  if (lockLines !== null) {
    const pkgStart = lockLines.findIndex((l) => l === "packages:");
    if (pkgStart === -1) {
      refusals.push(
        "pnpm-lock.yaml has no `packages:` section — " +
          "the format changed and R2 would silently match nothing."
      );
    } else {
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
      const absent = [];
      for (const mod of SINGLETONS) {
        const versions = resolved.get(mod);
        if (!versions) {
          absent.push(mod);
          continue;
        }
        r2Checks++;
        if (versions.size > 1) {
          failures.push(
            `R2 "${mod}" resolves to ${versions.size} versions: ${[...versions]
              .sort()
              .join(", ")}. ` + `Every copy is a separate module identity.`
          );
        }
      }

      // A DECLARED SINGLETON THAT IS NOT IN THE LOCKFILE IS A REFUSAL, NOT A SKIP.
      // `continue` here used to make R2 count what it FOUND rather than what the list
      // DECLARES, so a renamed, removed or misspelled entry silently checked one fewer
      // module while the PASS line read exactly the same. Planting "raect-dom" in the
      // list produced exit 0 and "N resolve to one version each" with N unchanged.
      // A smaller subject than declared is a question that could not be asked, not an
      // answer about the tree (#689) — and since #1215 it no longer hides a finding
      // either: both print, and a finding decides the exit.
      if (absent.length) {
        refusals.push(
          `${absent.length} of ${SINGLETONS.length} declared ` +
            `singleton(s) are absent from pnpm-lock.yaml's \`packages:\` section — ` +
            `${absent.join(", ")}.\n` +
            "R2 examined the rest and would have reported PASS, so the green would\n" +
            "describe a smaller set than the list declares. Either the entry is stale\n" +
            "and should be removed, or the dependency vanished and that is the finding."
        );
      }
    }
  }
}

if (r1Checks === 0 && r2Checks === 0) {
  refusals.push("neither rule examined anything.");
}

process.exitCode = printThenRank({
  refusals,
  findings: failures,
  printRefusals: () => {
    console.error(
      `COULD NOT CHECK — ${refusals.length} part(s) of the sweep refused. ` +
        "What was read is still reported;\nwhat was not read is not an answer:\n" +
        refusals.map((r) => `  ? ${r}`).join("\n")
    );
  },
  printFindings: () => {
    console.error(
      "\nFAIL — duplicate module instances are possible or present:\n"
    );
    for (const f of failures) console.error("  " + f);
    console.error(
      `\nSwept ${pkgs.length} packages: ${r1Checks} import sites (R1), ` +
        `${r2Checks} resolved singletons (R2).`
    );
  },
  printPass: () => {
    reportSubject(pkgs.length, "package(s) swept for singleton imports");
    console.log(
      `PASS: ${pkgs.length} packages swept — ${r1Checks} import sites declare their ` +
        `singletons as peers, and all ${SINGLETONS.length} declared singletons resolve ` +
        `to one version each in the lockfile.`
    );
  },
});
