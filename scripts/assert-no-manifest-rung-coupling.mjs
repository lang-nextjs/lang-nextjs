#!/usr/bin/env node
/**
 * Property: A SHARED FILE MUST NOT INDEX A GENERATED MANIFEST MAP WITH A RUNG
 * ID THAT A FORK CAN REMOVE.
 *
 * The instance (#374), found by a person reading a file during a freeze:
 *
 *     // apps/open-swe/lib/routes.ts — SHARED at the time
 *     RUNG_BY_ID["open-swe"].target
 *
 * `RUNG_BY_ID` comes from `@deepagents-nextjs/rungs`, GENERATED from rungs.json.
 * After `pnpm eject langchain` the generated union is `RungId = "langchain"`, the
 * shared file survives, and the index no longer type-checks. Measured on a real
 * eject, not inferred:
 *
 *     open-swe:build: ./lib/routes.ts:17:13
 *     Type error: expression of type '"open-swe"' can't be used to index
 *                 type 'Readonly<Record<"langchain", Rung>>'.
 *
 * ── WHY THE EXISTING TOOLS MISS IT ─────────────────────────────────────────
 *
 * Every severability tool we have follows RELATIVE IMPORTS. This coupling
 * crosses a PACKAGE boundary and is expressed as an index into a data
 * structure, so it looks like data access rather than a dependency. `pnpm
 * eject` verified the same tree and reported "no dangling imports, no config
 * pointing at a deleted app" — correctly, by its own definition.
 *
 * ── WHAT THIS IS NOT, AND THE AUTHORITY IT DEFERS TO ───────────────────────
 *
 * THIS IS AN EARLY WARNING, NOT THE COMPLETE CHECK. The complete check already
 * exists and is the `eject N (ts)` CI matrix, which builds the ejected tree and
 * fails on any type error — it caught the instance above when pointed at it.
 * What it costs is a full eject, install and build, and what it reports is a
 * TypeScript symptom rather than a severability coupling.
 *
 * So this catches ONE SHAPE — indexing a generated map with a rung literal —
 * cheaply, locally, before the matrix runs, and names the file and the rung.
 * It does NOT catch every coupling through the generated types: a comparison
 * against a `RungId`-typed value, or a literal reaching the union by inference,
 * are real and are not found here. Claiming otherwise would make this the kind
 * of check this repo spends its time deleting. The build remains the authority.
 *
 * ── WHY ONLY *REMOVABLE* RUNGS ─────────────────────────────────────────────
 *
 * Ejecting to rung N keeps ordinals 1..N, so the LOWEST-ordinal rung survives
 * every fork and naming it couples nothing. Derived from the manifest's own
 * ordinals rather than hardcoded, so a re-ordered ladder cannot leave this
 * checking the wrong set.
 *
 * Usage: node scripts/assert-no-manifest-rung-coupling.mjs [--cwd DIR]
 */
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classify } from "./classify.mjs";

import { reportSubject } from "./lib/subject.mjs";
const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const ci = argv.indexOf("--cwd");
const CWD = ci >= 0 ? resolve(argv[ci + 1]) : resolve(HERE, "..");
const MANIFEST_PKG = "@deepagents-nextjs/rungs";

function fail(lines) {
  for (const l of lines) console.error(l);
  process.exit(1);
}

/** Source with comments removed, so a rung named in prose is not a finding. */
export function stripComments(text) {
  let out = "";
  let i = 0;
  let state = "code"; // code | line | block | s | d | t
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (state === "code") {
      if (c === "/" && n === "/") {
        state = "line";
        i += 2;
        continue;
      }
      if (c === "/" && n === "*") {
        state = "block";
        i += 2;
        continue;
      }
      if (c === "'") state = "s";
      else if (c === '"') state = "d";
      else if (c === "`") state = "t";
      out += c;
      i++;
      continue;
    }
    if (state === "line") {
      if (c === "\n") {
        state = "code";
        out += c;
      }
      i++;
      continue;
    }
    if (state === "block") {
      if (c === "*" && n === "/") {
        state = "code";
        i += 2;
      } else i++;
      continue;
    }
    // inside a string: copy through, honour escapes, and end on the matching quote
    if (c === "\\") {
      out += c + (n ?? "");
      i += 2;
      continue;
    }
    if (
      (state === "s" && c === "'") ||
      (state === "d" && c === '"') ||
      (state === "t" && c === "`")
    )
      state = "code";
    out += c;
    i++;
  }
  return out;
}

/** Local names bound to the generated package by this file's imports. */
export function manifestBindings(code) {
  const names = new Set();
  const re = new RegExp(
    `import\\s+(?:type\\s+)?\\{([^}]*)\\}\\s*from\\s*["']${MANIFEST_PKG.replace(
      "/",
      "\\/"
    )}["']`,
    "g"
  );
  for (const m of code.matchAll(re)) {
    for (const part of m[1].split(",")) {
      const name = part
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name) names.add(name);
    }
  }
  return names;
}

/** `NAME["rung-id"]` for a binding from the generated package. */
export function couplings(code, bindings, removable) {
  const hits = [];
  for (const name of bindings) {
    const re = new RegExp(
      `\\b${name}\\s*\\[\\s*["'\`](${removable.join("|")})["'\`]\\s*\\]`,
      "g"
    );
    for (const m of code.matchAll(re)) hits.push({ symbol: name, rung: m[1] });
  }
  return hits;
}

/*
 * THE CHECK RUNS ONLY WHEN THIS FILE IS THE ENTRY POINT.
 *
 * Its selftest imports the pure helpers above. Without this guard that import
 * executed the whole check as a side effect — and on a tree where the check
 * FAILS it would call process.exit(1) during the import, killing the selftest
 * before a single case ran. A proof that cannot run when its subject is broken
 * is a proof that reports green exactly when it matters least.
 *
 * Same shape as scripts/classify.mjs, which guards its main block for the same
 * reason.
 */
const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  const manifest = JSON.parse(readFileSync(join(CWD, "rungs.json"), "utf8"));
  const minOrdinal = Math.min(...manifest.rungs.map((r) => r.ordinal));
  const removable = manifest.rungs
    .filter((r) => r.ordinal > minOrdinal)
    .map((r) => r.id);

  if (removable.length === 0) {
    fail([
      "FAIL: the manifest declares no removable rung, so this check has no subject.",
      "      With one rung there is nothing a fork can eject; with more, the ordinals",
      "      are wrong. Either way this is a broken probe, not a clean tree.",
    ]);
  }

  const { sharedFiles } = classify(CWD, manifest);
  const sources = [...sharedFiles].filter((f) => /\.(ts|tsx|mts|cts)$/.test(f));

  // ANTI-VACUITY. A scan that examined no file, or found no file importing the
  // generated package at all, reports zero couplings with total confidence — the
  // shape of the failure, not evidence against it.
  if (sources.length === 0) {
    fail([
      "FAIL: no shared TypeScript files were classified. A scan with no subject cannot certify a tree.",
    ]);
  }

  let importers = 0;
  const findings = [];
  for (const rel of sources) {
    let text;
    try {
      text = readFileSync(join(CWD, rel), "utf8");
    } catch {
      continue;
    }
    if (!text.includes(MANIFEST_PKG)) continue;
    const code = stripComments(text);
    const bindings = manifestBindings(code);
    if (bindings.size === 0) continue;
    importers++;
    for (const hit of couplings(code, bindings, removable)) {
      findings.push({ file: rel, ...hit });
    }
  }

  if (importers === 0) {
    fail([
      `FAIL: no shared file imports ${MANIFEST_PKG}, so nothing was examined.`,
      "      Zero couplings out of zero importers is not a clean tree — it is a",
      "      scan that lost its subject, which is what this gate exists to catch",
      "      one level down.",
    ]);
  }

  if (findings.length > 0) {
    const lines = [
      `FAIL: ${findings.length} shared file reference(s) index a generated manifest map with a removable rung id:`,
      "",
    ];
    for (const f of findings) {
      lines.push(`       ${f.file}`);
      lines.push(
        `         ${f.symbol}["${f.rung}"] — this file is SHARED, so it survives \`pnpm eject\`,`
      );
      lines.push(
        `         but "${f.rung}" leaves the generated union and the index stops compiling.`
      );
    }
    lines.push(
      "",
      "       Fix by making the file rung-owned in rungs.json, or by removing the",
      "       rung-specific reference. Relative-import scans cannot see this: the",
      "       coupling crosses a package boundary and looks like data access."
    );
    fail(lines);
  }

  reportSubject(importers, "shared file(s) importing the manifest package");
  console.log(
    `PASS: ${importers} shared file(s) import ${MANIFEST_PKG}; none indexes it with a ` +
      `removable rung id (${removable.join(", ")}). Early warning only — the ` +
      `eject build remains the complete check.`
  );
}
