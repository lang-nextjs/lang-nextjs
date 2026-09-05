#!/usr/bin/env node
/**
 * Property: EVERY e2e SPEC IS ACTUALLY RUN BY SOME PROJECT, AND EVERY PROJECT
 * ACTUALLY RUNS SOMETHING.
 *
 * The defect this exists for: `playwright.config.ts` matches projects with
 * per-file patterns, several of them exact —
 *
 *     testMatch: /rungs\/open-swe\/open-swe-dashboard\.spec\.ts/
 *
 * so a NEW spec file matches no project and silently never runs. It exists, it
 * reads well, it passes review, and it executes zero times. Nothing downstream
 * notices, because the failure happens before a single assertion is evaluated —
 * the suite reports green BY ABSENCE. Two people hit this independently in one
 * night (#135 and DEV5's chat/settings spec), which is what moved it from
 * "remember to check" to a build step.
 *
 * BOTH DIRECTIONS, because they are the same defect at opposite ends:
 *   ORPHAN SPEC   a file no project matches            -> written, never run
 *   GHOST PATTERN a project whose patterns match nothing -> renamed the file,
 *                 left the pattern; that project now runs zero tests and passes
 *
 * ── HOW testMatch IS RESOLVED, AND WHY NOT BY READING THE CONFIG ────────────
 *
 * By asking Playwright, via `playwright test --list --reporter=json`, and using
 * the resulting file/project assignments as ground truth.
 *
 * The alternative — parsing `playwright.config.ts` and re-implementing the match
 * — would have to reproduce regex form, string form, array form, `testDir`
 * resolution, `testIgnore`, shared consts (`CROSS_BROWSER_TESTMATCH` is used by
 * two projects here), and whatever Playwright does next release. Every gap in
 * that reimplementation is a pattern silently treated as "no match", which is
 * THE SAME DEFECT ONE LEVEL UP: a checker that cannot resolve a form and skips
 * it reports green by absence exactly like the specs it is meant to catch.
 *
 * So this never guesses. If `--list` cannot run, or reports config errors, this
 * FAILS rather than proceeding with partial knowledge.
 *
 * ── ANTI-VACUITY ───────────────────────────────────────────────────────────
 *
 * A listing with no specs, or no projects, is not a pass — it is a broken probe.
 * This refuses to score a run in which nothing ran, because "zero orphans out of
 * zero specs" is the exact shape of the failure being checked for.
 *
 * Usage: node scripts/check-e2e-registration.mjs [--cwd DIR] [--json]
 */
import { execFileSync } from "node:child_process";
import { readdirSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const cwdFlag = argv.indexOf("--cwd");
const CWD = cwdFlag >= 0 ? resolve(argv[cwdFlag + 1]) : resolve(HERE, "..");
const AS_JSON = argv.includes("--json");

/** A spec file we expect some project to claim. */
const SPEC_RE = /\.spec\.ts$/;

/** Every *.spec.ts under a directory, as paths relative to it. */
function findSpecs(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // node_modules under e2e/ would be someone else's fixtures, never ours.
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (SPEC_RE.test(entry.name))
        out.push(relative(root, full).split(sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}

function fail(lines) {
  for (const l of lines) console.error(l);
  process.exit(1);
}

// ── 1. Ask Playwright what it would run ────────────────────────────────────
let listing;
try {
  const raw = execFileSync(
    "pnpm",
    ["exec", "playwright", "test", "--list", "--reporter=json"],
    {
      cwd: CWD,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  listing = JSON.parse(raw);
} catch (err) {
  // Deliberately fatal. A checker that cannot see the config must not report a
  // clean bill of health — that is the defect it exists to prevent, wearing the
  // checker's own uniform.
  fail([
    "FAIL: could not enumerate Playwright tests, so registration cannot be checked.",
    "      This is a hard failure, NOT a skip: an unresolvable config is exactly",
    "      the state in which an orphan spec would go unnoticed.",
    `      ${String(err.stderr || err.message)
      .split("\n")
      .slice(0, 6)
      .join("\n      ")}`,
  ]);
}

if (Array.isArray(listing.errors) && listing.errors.length > 0) {
  fail([
    `FAIL: Playwright reported ${listing.errors.length} config error(s); the listing`,
    "      cannot be trusted and a partial listing would hide orphans.",
    ...listing.errors
      .slice(0, 5)
      .map((e) => `      ${e.message ?? JSON.stringify(e)}`),
  ]);
}

const rootDir = listing?.config?.rootDir;
if (!rootDir || !existsSync(rootDir) || !statSync(rootDir).isDirectory()) {
  fail([
    `FAIL: Playwright reported no usable rootDir (got ${JSON.stringify(
      rootDir
    )}).`,
  ]);
}

const configuredProjects = (listing.config.projects ?? []).map((p) => p.name);

// ── 2. Flatten the listing into file -> Set<projectName> ───────────────────
const claimedBy = new Map();
const projectSawSomething = new Set();
function visit(node) {
  for (const spec of node.specs ?? []) {
    const file = String(spec.file ?? node.file ?? "")
      .split(sep)
      .join("/");
    for (const t of spec.tests ?? []) {
      if (!t.projectName) continue;
      projectSawSomething.add(t.projectName);
      if (!claimedBy.has(file)) claimedBy.set(file, new Set());
      claimedBy.get(file).add(t.projectName);
    }
  }
  for (const child of node.suites ?? []) visit(child);
}
for (const s of listing.suites ?? []) visit(s);

// ── 3. Anti-vacuity: refuse to score a run in which nothing ran ────────────
const onDisk = findSpecs(rootDir);
if (onDisk.length === 0) {
  fail([
    `FAIL: found no *.spec.ts under ${rootDir}.`,
    "      Refusing to pass: 'zero orphans out of zero specs' is not evidence,",
    "      it is the failure mode being checked for.",
  ]);
}
if (configuredProjects.length === 0 || claimedBy.size === 0) {
  fail([
    "FAIL: the Playwright listing contained no projects or no matched specs.",
    `      projects=${configuredProjects.length} matchedFiles=${claimedBy.size}`,
    "      A probe that finds nothing cannot certify that nothing is wrong.",
  ]);
}

// ── 4. Direction A — orphan specs ──────────────────────────────────────────
const orphans = onDisk.filter((f) => !claimedBy.has(f));

// ── 5. Direction B — ghost projects ────────────────────────────────────────
const ghosts = configuredProjects.filter((p) => !projectSawSomething.has(p));

if (AS_JSON) {
  console.log(
    JSON.stringify({ onDisk, orphans, ghosts, configuredProjects }, null, 2)
  );
}

const problems = [];
if (orphans.length > 0) {
  problems.push(
    `FAIL: ${orphans.length} e2e spec(s) are matched by NO project and will never run:`
  );
  for (const o of orphans)
    problems.push(`       ${join(relative(CWD, rootDir), o)}`);
  problems.push(
    "       Each exists, reads fine, and executes zero times. Add it to a",
    "       project's testMatch in playwright.config.ts — note several patterns",
    "       are per-file and exact, so a new file is NOT picked up by default.",
    `       Projects available: ${configuredProjects.join(", ")}`
  );
}
if (ghosts.length > 0) {
  if (problems.length) problems.push("");
  problems.push(
    `FAIL: ${ghosts.length} project(s) match no spec at all and run zero tests:`
  );
  for (const g of ghosts) problems.push(`       ${g}`);
  problems.push(
    "       A project that matches nothing passes by running nothing — usually a",
    "       spec was renamed and its testMatch left pointing at a ghost. Fix the",
    "       pattern or delete the project."
  );
}
if (problems.length) fail(problems);

console.log(
  `PASS: ${onDisk.length} e2e spec(s) each matched by >=1 of ${configuredProjects.length} ` +
    `project(s), and every project matches >=1 spec.`
);
