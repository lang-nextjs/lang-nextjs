#!/usr/bin/env node
/**
 * assert-coverage-follows-the-surface.mjs — a SHARED surface must not be covered only by
 * tests that leave with a rung.
 *
 * THE DEFECT, WITH A DATE ON IT (#373). #370 promoted the chat shell from rung-4-owned to
 * `shared`. The specs covering it stayed under `e2e/rungs/open-swe/**`, which rung 4 owns. So
 * `pnpm eject langchain` kept the feature and deleted its tests — and the fork was GREEN,
 * because the specs that could have failed were gone. Nothing failed anywhere: the manifest
 * was total and disjoint, every project matched a spec, and eject reported no dangling
 * anything. The loss is only visible as a JOIN between two facts each of which is fine.
 *
 * THE PROPERTY. For every route a SHARED file serves, at least one spec that covers it must
 * itself be shared. A route whose whole covering set travels with a rung is a feature every
 * fork keeps and only one fork tests.
 *
 * OWNERSHIP COMES FROM classify(), NOT FROM A SECOND GLOB MATCHER. `classify` already answers
 * "does this file survive every eject" per file, and it exports that verdict for exactly this
 * reason. A second implementation is a second answer, and the two drift silently — which is
 * the failure this file exists to catch, one level up.
 *
 * Usage:  node scripts/assert-coverage-follows-the-surface.mjs [--json] [--cwd DIR]
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { classify } from "./classify.mjs";

import { invokedAsProgram } from "./lib/is-main.mjs";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const cwdFlag = argv.indexOf("--cwd");
const CWD = cwdFlag >= 0 ? resolve(argv[cwdFlag + 1]) : ROOT;

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const f = join(dir, name);
    statSync(f).isDirectory() ? walk(f, out) : out.push(f);
  }
  return out;
}

/**
 * Routes this repo serves, as url -> the files that serve it.
 *
 * KEYED BY URL, NOT BY FILE, because apps/example and apps/open-swe both serve
 * `/api/chat/stream` and that is ONE address a spec can visit. Keying by file would ask the
 * coverage question twice for one url and answer it wrong at least once — the same dedupe
 * assert-no-overbroad-route-stubs.mjs had to make for the same reason.
 */
export function routeTable(root) {
  const routes = new Map();
  const add = (url, rel) => {
    if (!routes.has(url)) routes.set(url, []);
    routes.get(url).push(rel);
  };
  for (const f of walk(join(root, "apps"))) {
    const rel = relative(root, f);
    const api = rel.match(/^apps\/[^/]+\/app\/(api\/.+)\/route\.ts$/);
    if (api) {
      add("/" + api[1], rel);
      continue;
    }
    const page = rel.match(/^apps\/[^/]+\/app\/(.*)page\.tsx$/);
    if (page) add("/" + page[1].replace(/\/$/, ""), rel);
  }
  return routes;
}

/**
 * Which specs COVER a url — where covering means the spec goes there or asks it directly.
 *
 * `page.route(…)` IS SETUP, NOT SUBJECT, AND THIS IS THE WHOLE DIFFICULTY. A chat spec stubs
 * `/api/open-swe/sandbox/health` so the readiness indicator resolves and the composer becomes
 * usable; that does not make it a test of the sandbox. Counting stubs as coverage classified
 * FOURTEEN plainly-chat specs as touching the run surface when this rule was first tried by
 * hand — a false-positive rate that gets a checker deleted within a month.
 *
 * So: navigations and direct requests only.
 */
export function coverageTable(root) {
  const cover = new Map();
  for (const f of walk(join(root, "e2e"))) {
    if (!f.endsWith(".ts")) continue;
    const rel = relative(root, f);
    const src = readFileSync(f, "utf8");
    const urls = [
      ...[...src.matchAll(/goto\(\s*[`"']([^`"'?)]*)/g)].map((m) => m[1]),
      ...[
        ...src.matchAll(
          /request\.(?:get|post|put|patch|delete|fetch)\(\s*[`"']([^`"'?)]*)/g
        ),
      ].map((m) => m[1]),
    ];
    for (const raw of urls) {
      // A template hole is a dynamic segment; normalise it to the same token the route table
      // uses for `[runId]`, so `/runs/${id}` and `/runs/[runId]` meet.
      const url = raw.replace(/\$\{[^}]*\}/g, "*").replace(/\/$/, "") || "/";
      if (!url.startsWith("/")) continue;
      if (!cover.has(url)) cover.set(url, new Set());
      cover.get(url).add(rel);
    }
  }
  return cover;
}

const normalise = (url) => url.replace(/\[[^\]]+\]/g, "*");

export function findUncoveredAfterEject(root = CWD) {
  /*
   * THE MANIFEST COMES FROM THE TREE BEING CHECKED, NOT FROM THIS ONE.
   *
   * `classify(cwd)` defaults its manifest to the one beside classify.mjs, so passing only a
   * cwd asks "how would MY manifest classify THEIR files" — which answers a question nobody
   * asked and is wrong in exactly the sandboxes a selftest builds. Caught by writing the
   * selftest, not by running the checker: on the real tree the two are the same file and the
   * bug is invisible.
   */
  const manifest = JSON.parse(readFileSync(join(root, "rungs.json"), "utf8"));
  const { owner, sharedFiles } = classify(root, manifest);
  const routes = routeTable(root);
  const cover = coverageTable(root);

  const violations = [];
  let sharedRoutes = 0;
  let covered = 0;
  const uncovered = [];

  for (const [url, servers] of [...routes].sort()) {
    const sharedServers = servers.filter((s) => sharedFiles.has(s));
    if (sharedServers.length === 0) continue; // a rung's own route; its specs may travel with it
    sharedRoutes++;
    const covering = [...(cover.get(normalise(url)) ?? cover.get(url) ?? [])];
    if (covering.length === 0) {
      // A DIFFERENT DEFECT, AND NOT THIS ONE. A shared route with no e2e coverage at all is
      // untested everywhere, not untested-after-eject. Reported as a count so the skip is
      // visible: a checker that silently drops its hardest inputs is the shape being guarded
      // against here.
      uncovered.push(url);
      continue;
    }
    covered++;
    const rungOwned = covering.filter((c) => owner.has(c));
    if (rungOwned.length === covering.length) {
      violations.push({
        url,
        servers: sharedServers,
        covering,
        rungs: [...new Set(rungOwned.map((c) => owner.get(c)))],
      });
    }
  }
  return { violations, sharedRoutes, covered, uncovered, routes: routes.size };
}

function main() {
  const r = findUncoveredAfterEject(CWD);
  if (argv.includes("--json")) {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.violations.length === 0 ? 0 : 1);
  }

  /*
   * THE NON-VACUITY FLOOR. Every assertion here is over sets built by two regex walks; if
   * either finds nothing, there are no violations and this exits 0 having checked nothing —
   * exactly the shape it exists to catch. The floors are deliberately low and absolute: this
   * repo has fewer routes in an ejected fork than on main, so a count pinned to today's tree
   * would fail in the forks the checker is FOR.
   */
  if (r.routes < 5 || r.covered < 3) {
    console.error(
      `FAIL: the walk found ${r.routes} route(s) and ${r.covered} with e2e coverage. ` +
        `That is too few to have measured anything — a broken walk or a moved directory ` +
        `makes every assertion below vacuously true.`
    );
    process.exit(2);
  }

  console.log(
    `coverage-follows-the-surface: ${r.sharedRoutes} shared route(s), ` +
      `${r.covered} with e2e coverage, ${r.uncovered.length} with none.`
  );
  if (r.uncovered.length > 0) {
    console.log(
      `  no e2e coverage at all (a different defect, not checked here):`
    );
    for (const u of r.uncovered) console.log(`    ${u}`);
  }

  if (r.violations.length === 0) {
    console.log(
      `\nPASS: every shared route with e2e coverage keeps at least one spec that survives ` +
        `every eject.`
    );
    return;
  }

  console.error(
    `\nFAIL: ${r.violations.length} shared route(s) covered only by rung-owned specs.`
  );
  console.error(
    `A fork that ejects the rung keeps the feature and loses its tests, and stays GREEN — the\n` +
      `specs that could have failed are gone.\n`
  );
  for (const v of r.violations) {
    console.error(`  ${v.url}`);
    console.error(`    served by (shared) : ${v.servers.join(", ")}`);
    console.error(`    covered only by    : ${v.covering.join(", ")}`);
    console.error(`    which leave with   : ${v.rungs.join(", ")}`);
    console.error(
      `    fix: move the spec to a shared path (e2e/shell/ for the open-swe surface), or\n` +
        `         split it if it covers both — see #373 and #384.\n`
    );
  }
  process.exit(1);
}

const isMain = invokedAsProgram(import.meta.url);
if (isMain) main();
