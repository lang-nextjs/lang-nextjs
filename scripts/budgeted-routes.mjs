/**
 * WHICH ROUTES CARRY A PERFORMANCE BUDGET — and the proof that they may.
 *
 * THE RULE (PRODUCT): budget only routes the rung manifest guarantees exist in
 * EVERY fork. A perf budget here is not "our demo must be fast" — it is
 * inherited by every forker, so its job is to teach what is worth measuring and
 * to catch regressions in surface every fork carries. A budget on a route that
 * exists in only some forks is the same defect as auditing a 404, just slower
 * to find.
 *
 * That rule is only worth anything if something ENFORCES it, so this file does
 * two things and fails loudly at either:
 *
 *   1. SELECTION is by ROLE, not by path. PRODUCT named two roles; the paths
 *      they currently map to are recorded below and are expected to move
 *      (#6 makes apps/example degrade per rung and shape-routes the shell).
 *   2. ELIGIBILITY is DERIVED, not asserted. Every selected route's page file
 *      is run through scripts/classify.mjs — the same classifier the
 *      severability gate uses — and must come back SHARED, i.e. owned by no
 *      rung and therefore present after any `pnpm eject`. If a route ever
 *      becomes rung-owned, this throws instead of quietly budgeting surface
 *      that half the forks do not have.
 *
 * Reusing classify.mjs is deliberate. A second glob matcher would be a second
 * answer to "is this shared", and the two would drift.
 *
 * WHY NOT /r/[rung]: rungs 1-3 target `/r/[rung]` and rung 4 targets another
 * origin entirely. Those are rung-DEPENDENT by construction — exactly what the
 * rule excludes — so they must never appear here, however central they look.
 *
 * Usage:
 *   node scripts/budgeted-routes.mjs                 # print the URLs, one per line
 *   node scripts/budgeted-routes.mjs --json          # print [{role, path, file}]
 *   node scripts/budgeted-routes.mjs --assert-live <origin>
 *                                                    # wait for the server, then
 *                                                    # require every route to
 *                                                    # answer 200 before scoring
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classify } from "./classify.mjs";

import { invokedAsProgram } from "./lib/is-main.mjs";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_ORIGIN = "http://localhost:3000";

/**
 * PRODUCT's two roles, mapped to the paths that fill them TODAY.
 *
 * shell            — the first thing a forker sees; what #44 built. Currently
 *                    /dashboard (SidebarProvider + SiteHeader shell). NOT `/`:
 *                    `/` is the chat surface, and after #6 the shell is the
 *                    route that survives rung degradation.
 * streaming-run-view — "Streaming SSE into rendered parts IS the product."
 *                    Currently `/`: useDeepAgentsChat -> /api/chat/stream ->
 *                    data-* parts rendered as cards. This is the route whose
 *                    regression budget PRODUCT actually cares about.
 *
 * The payload behind the streaming view is the CANNED path, because that is
 * what runs without credentials. That is the point, not a limitation: a
 * deterministic payload is a better regression baseline than a live model
 * whose latency we do not control.
 */
const ROLES = [
  {
    role: "shell",
    path: "/dashboard",
  },
  {
    role: "streaming-run-view",
    path: "/",
  },
];

/** The app whose budget this is. Relative to the resolved root, never absolute. */
const APP_DIR = "apps/example/app";

/**
 * Every URL path this app serves, mapped to the page file(s) that serve it.
 *
 * WHY A MAP FROM THE TREE AND NOT A FORMULA. `/dashboard` ->
 * `app/dashboard/page.tsx` is a pure function right up until someone adds a
 * route group: `app/(marketing)/dashboard/page.tsx` serves the SAME url, and a
 * formula would compute a path that does not exist, then report the role
 * unguaranteed for a route that is fine. So the correspondence is read off the
 * tree, and an ambiguous url is a hard failure rather than a first match.
 */
function pageFileMap(root) {
  const byPath = new Map();
  const base = join(root, APP_DIR);
  if (!existsSync(base)) return byPath;
  // TWO accumulators, not one, and the distinction is the whole function. `segments` builds the
  // URL and drops route groups; `dirs` builds the real filesystem path and keeps them. Deriving
  // the file from `segments` produced `app/grouped/page.tsx` for a page that actually lives at
  // `app/(grp)/grouped/page.tsx` — a path that does not exist, handed to the classifier, which
  // duly reported it unclassified. That is the same path/file mismatch this derivation exists to
  // remove, reintroduced inside the derivation. Caught by this file's route-group case.
  //
  // It fails OPEN in the dangerous direction: had the phantom path matched a shared glob, the
  // guard would have ACCEPTED while the route's real file was rung-owned.
  const walk = (dir, segments, dirs) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.isDirectory()) {
        // Route groups `(name)` and private folders `_name` contribute no url
        // segment. Parallel/intercepting routes (@slot, (.)x) are deliberately
        // NOT handled: none exist here, and guessing at them is how a
        // derivation quietly returns the wrong file.
        if (ent.name.startsWith("_")) continue;
        const isGroup = ent.name.startsWith("(") && ent.name.endsWith(")");
        walk(
          join(dir, ent.name),
          isGroup ? segments : [...segments, ent.name],
          [...dirs, ent.name]
        );
      } else if (/^page\.[jt]sx?$/.test(ent.name)) {
        const url = "/" + segments.join("/");
        const rel = [APP_DIR, ...dirs, ent.name].join("/");
        byPath.set(url, [...(byPath.get(url) ?? []), rel]);
      }
    }
  };
  walk(base, [], []);
  return byPath;
}

/**
 * Resolve the budgeted routes, proving each is fork-guaranteed. Throws if not.
 *
 * `root` is ONE parameter on purpose. It selects both the tree walked for page
 * files and the tree handed to the classifier, so the two can never disagree —
 * a generator of mine once read one tree and wrote another because those were
 * separately overridable, and it rewrote a real file twice before I saw it.
 */
export function budgetedRoutes(root = ROOT, roles = ROLES) {
  // Non-vacuity. Budgeting nothing satisfies "every budgeted route is
  // fork-guaranteed" trivially, and would report success over an empty audit.
  if (roles.length === 0) {
    throw new Error(
      `budgeted-routes: no roles declared — there is nothing to budget, which is ` +
        `a broken config rather than a clean bill of health.`
    );
  }

  // The manifest comes from `root` too. classify()'s default is the module-level
  // manifest read from the REPO — so passing only a cwd would walk one tree and
  // classify against another's rules, which is the split-subject bug this
  // signature exists to prevent. One parameter, or it is not one subject.
  const result = classify(
    root,
    JSON.parse(readFileSync(join(root, "rungs.json"), "utf8"))
  );
  const pages = pageFileMap(root);
  const problems = [];
  const resolved = [];

  for (const r of roles) {
    // The file is DERIVED from the budgeted path, never written beside it.
    // When both were hand-written, nothing checked they corresponded: re-map
    // `path` to a rung-owned route, leave `file` on the old shared one, and
    // this check proved fork-survival for a file that no longer served the
    // budgeted url. The guarantee was computed about a different subject than
    // the one the budget applied to.
    const serving = pages.get(r.path) ?? [];
    if (serving.length === 0) {
      problems.push(
        `role "${r.role}" -> ${r.path}: no page file under ${APP_DIR} serves this path. ` +
          `The route moved or was deleted; re-map the role rather than dropping the budget.`
      );
      continue;
    }
    if (serving.length > 1) {
      problems.push(
        `role "${r.role}" -> ${r.path}: AMBIGUOUS — ${serving.length} page files serve it ` +
          `(${serving.join(
            ", "
          )}). Next.js would reject this too; resolve it rather than ` +
          `letting this pick one.`
      );
      continue;
    }

    const file = serving[0];
    const rung = result.owner.get(file);
    if (rung) {
      problems.push(
        `role "${r.role}" -> ${r.path}: ${file} is OWNED BY RUNG "${rung}", so a fork that ` +
          `ejects ${rung} will not have it. Budget only routes every fork carries — re-map ` +
          `this role to a shared route, or drop it.`
      );
      continue;
    }
    if (!result.sharedFiles.has(file)) {
      problems.push(
        `role "${r.role}" -> ${r.path}: ${file} is neither rung-owned nor matched by a ` +
          `shared path in rungs.json. It is unclassified, so nothing guarantees it survives ` +
          `an eject. Classify it before budgeting it.`
      );
      continue;
    }
    resolved.push({ ...r, file });
  }

  if (problems.length > 0) {
    throw new Error(
      `budgeted-routes: ${problems.length} route(s) are not fork-guaranteed:\n  - ` +
        problems.join("\n  - ")
    );
  }
  return resolved;
}

/** Absolute URLs for lighthouse `collect.url`. */
export function budgetedUrls(origin = DEFAULT_ORIGIN, root = ROOT) {
  const base = origin.replace(/\/$/, "");
  return budgetedRoutes(root).map((r) => `${base}${r.path}`);
}

/**
 * PREFLIGHT — every budgeted route must RESOLVE before it is scored.
 *
 * A route that 404s must FAIL the audit, not skip it. Without this, a moved or
 * ejected route surfaces as Lighthouse's own ERRORED_DOCUMENT_REQUEST — which
 * is Lighthouse falling over, not us checking, and it names the failure after
 * Lighthouse's plumbing rather than after the route. This turns that into a
 * deliberate assertion that says which route is missing and what it was for.
 */
async function assertLive(origin, root = ROOT) {
  const routes = budgetedRoutes(root);
  const deadline = Date.now() + 60_000;
  const base = origin.replace(/\/$/, "");

  // Wait for the server itself, so "route missing" is never really "server
  // not up yet" wearing the wrong label.
  for (;;) {
    try {
      await fetch(base, { redirect: "manual" });
      break;
    } catch (err) {
      if (Date.now() > deadline) {
        throw new Error(
          `budgeted-routes: no server answered at ${base} within 60s — cannot audit. (${err.message})`
        );
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  const failures = [];
  for (const r of routes) {
    const url = `${base}${r.path}`;
    let status;
    try {
      status = (await fetch(url, { redirect: "manual" })).status;
    } catch (err) {
      failures.push(
        `${url}  (role "${r.role}") — request failed: ${err.message}`
      );
      continue;
    }
    if (status !== 200) {
      failures.push(
        `${url}  (role "${r.role}", ${r.file}) — expected 200, got ${status}`
      );
    } else {
      console.log(`  ok  ${url}  (role "${r.role}")`);
    }
  }

  if (failures.length > 0) {
    console.error(
      `\nbudgeted-routes: ${failures.length} budgeted route(s) did not resolve:\n  - ` +
        failures.join("\n  - ") +
        `\n\nA budgeted route that does not resolve is a budget over an absent subject. ` +
        `Fix the route, or re-map the role in scripts/budgeted-routes.mjs — do not delete ` +
        `the assertion.\n`
    );
    process.exit(1);
  }
  console.log(
    `\nbudgeted-routes: all ${routes.length} budgeted routes resolved 200.`
  );
}

// --- CLI -------------------------------------------------------------------
const isMain = invokedAsProgram(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const assertIdx = argv.indexOf("--assert-live");
  try {
    if (assertIdx >= 0) {
      await assertLive(argv[assertIdx + 1] || DEFAULT_ORIGIN);
    } else if (argv.includes("--json")) {
      console.log(JSON.stringify(budgetedRoutes(), null, 2));
    } else {
      for (const u of budgetedUrls(process.env.LHCI_ORIGIN || DEFAULT_ORIGIN)) {
        console.log(u);
      }
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
