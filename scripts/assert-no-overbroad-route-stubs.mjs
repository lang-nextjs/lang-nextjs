#!/usr/bin/env node
/**
 * Property: A ROUTE STUB MATCHES EXACTLY ONE REAL ENDPOINT.
 *
 * #361 added `/api/chat/stream/resume`. Five specs that had never heard of it went red,
 * because they stubbed `"**\/api/chat/stream**"` and the trailing `**` also matches the new
 * sibling. The stub answered the mount-time resume GET with frames scripted for the POST:
 * enter tests asserted `posts[0] === "POST"` and got `"GET"`; the tool-failure test asserted
 * two tool-cards and got four, the scripted body delivered twice. THE APP WAS RIGHT
 * THROUGHOUT. The stubs were catching an endpoint nobody had told them about.
 *
 * Seven sites were narrowed by hand in #361. This makes the property mechanical, because a
 * one-time sweep fixes today and the next endpoint added under an existing prefix reproduces
 * it exactly, in specs whose authors have no reason to look.
 *
 * WHY NOT "AVOID TRAILING `**`". Because it is wrong. Playwright matches the FULL url
 * including the query string, so `"**\/api/config*"` needs its star to match
 * `/api/config?runtime=django`, and 40-odd trailing globs here are load-bearing for exactly
 * that reason. A blanket rule would flag them all and be deleted within a week — #328 records
 * a detector that reported 63 then 4 then 0 findings and was deliberately not kept. The
 * property that survives is not about the pattern's SHAPE, it is about how many real things
 * it hits.
 *
 * BOTH HALVES ARE KNOWABLE, which is what makes this checkable rather than stylistic:
 *
 *   real endpoints   apps/<app>/app/api/**\/route.ts  — the filesystem IS the route table
 *   stub patterns    string literals in `.route("…")` — no computation, no indirection
 *
 * THE MATCHER IS PLAYWRIGHT'S OWN, COPIED VERBATIM (see globToRegexPattern below). A
 * reimplementation that merely looked right would make this checker's verdict a claim about a
 * matcher nobody uses. The selftest re-extracts the function from the installed
 * playwright-core and fails if the two have drifted, so an upgrade that changes glob
 * semantics is reported rather than silently absorbed.
 *
 * A STUB MATCHING ZERO ENDPOINTS IS NOT A VIOLATION. Specs legitimately stub things this
 * repo does not serve — a backend on another origin, a URL a rung-1 fork has no route for.
 * The property is "more than one", and widening it to "exactly one" would fail honest specs.
 * Zero is reported in the summary rather than enforced, so it stays visible without being a
 * gate that has to be argued with.
 *
 * Usage: node scripts/assert-no-overbroad-route-stubs.mjs [--cwd DIR]
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const cwdFlag = process.argv.indexOf("--cwd");
const ROOT =
  cwdFlag !== -1 && process.argv[cwdFlag + 1]
    ? resolve(process.argv[cwdFlag + 1])
    : join(dirname(fileURLToPath(import.meta.url)), "..");

/*
 * VERBATIM FROM playwright-core, packages/isomorphic/urlMatch.ts.
 *
 * Do not "clean this up". The `charBefore === "/"` branch, the `((.+/)|)` that lets `**\/`
 * match nothing at all, and the single `*` compiling to `[^/]*` rather than `.*` are the
 * three details the whole join depends on, and each is easy to lose while tidying. The
 * selftest compares this source against the installed copy; if you change it, that case is
 * the one that will tell you.
 */
const escapedChars = new Set([
  "$", "^", "+", ".", "*", "(", ")", "|", "\\", "?", "{", "}", "[", "]",
]);

export function globToRegexPattern(glob) {
  const tokens = ["^"];
  let inGroup = false;
  for (let i = 0; i < glob.length; ++i) {
    const c = glob[i];
    if (c === "\\" && i + 1 < glob.length) {
      const char = glob[++i];
      tokens.push(escapedChars.has(char) ? "\\" + char : char);
      continue;
    }
    if (c === "*") {
      const charBefore = glob[i - 1];
      let starCount = 1;
      while (glob[i + 1] === "*") {
        starCount++;
        i++;
      }
      if (starCount > 1) {
        const charAfter = glob[i + 1];
        if (charAfter === "/") {
          if (charBefore === "/") tokens.push("((.+/)|)");
          else tokens.push("(.*/)");
          ++i;
        } else {
          tokens.push("(.*)");
        }
      } else {
        tokens.push("([^/]*)");
      }
      continue;
    }
    switch (c) {
      case "{":
        if (inGroup)
          throw new Error(`Invalid glob pattern ${JSON.stringify(glob)}: nested '{'`);
        inGroup = true;
        tokens.push("(");
        break;
      case "}":
        if (!inGroup)
          throw new Error(`Invalid glob pattern ${JSON.stringify(glob)}: unmatched '}'`);
        inGroup = false;
        tokens.push(")");
        break;
      case ",":
        if (inGroup) {
          tokens.push("|");
          break;
        }
        tokens.push("\\" + c);
        break;
      default:
        tokens.push(escapedChars.has(c) ? "\\" + c : c);
    }
  }
  if (inGroup)
    throw new Error(`Invalid glob pattern ${JSON.stringify(glob)}: unmatched '{'`);
  tokens.push("$");
  return tokens.join("");
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/**
 * The route table, read off the filesystem: `apps/<app>/app/api/**\/route.ts`.
 *
 * DEDUPED BY URL PATH, not by file. `apps/example` and `apps/open-swe` both serve
 * `/api/chat/stream`, and that is ONE endpoint a stub can hit, not two — counting per app
 * would report every shared route as an over-broad match and the checker would fail on a
 * clean tree.
 */
export function realEndpoints(root) {
  const paths = new Set();
  for (const file of walk(join(root, "apps"))) {
    const rel = relative(root, file).split("/").join("/");
    const m = rel.match(/^apps\/[^/]+\/app\/(api\/.+)\/route\.ts$/);
    if (m) paths.add("/" + m[1]);
  }
  return [...paths].sort();
}

/**
 * Stub patterns, as string literals passed to `.route(…)`.
 *
 * `[^"\n]` deliberately: the literal may not span a newline. Without that the pattern runs
 * past the closing quote and swallows the next one, and a `.route("…")` written inside a
 * BLOCK COMMENT — this repo has several, explaining exactly this bug — parses as a stub whose
 * text is two lines of prose. It then matches nothing, and a spurious zero-match entry is how
 * a reader learns to ignore the zero-match column.
 */
export function stubPatterns(root) {
  const found = new Map();
  for (const file of walk(join(root, "e2e"))) {
    if (!file.endsWith(".ts")) continue;
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/\.route\(\s*"([^"\n]+)"/g)) {
      if (!found.has(m[1])) found.set(m[1], new Set());
      found.get(m[1]).add(relative(root, file));
    }
  }
  return found;
}

const TOKEN = "_id_";

/**
 * Instantiate an endpoint's dynamic segments so a concrete url can be tested.
 *
 * A DYNAMIC SEGMENT IS PINNED BY THE STUB'S OWN LITERAL AT THAT POSITION. Filling `[runId]`
 * with a generic token unconditionally would make `"**\/api/open-swe/runs/run-1"` match
 * `/api/open-swe/runs/_id_` — that is, match NOTHING — and a precise stub aimed squarely at
 * one endpoint would be scored zero. Zero is not a violation here, so it would not go red; it
 * would quietly get the right verdict for the wrong reason, and the first stub that needed
 * the logic would be the one it failed on.
 */
export function instantiate(endpoint, glob) {
  const gs = glob.replace(/^\*\*\//, "").split("/");
  const es = endpoint.replace(/^\//, "").split("/");
  return (
    "/" +
    es
      .map((seg, i) => {
        if (!/^\[.*\]$/.test(seg)) return seg;
        // The stub's LITERAL PREFIX at this position, not the whole segment: the site that
        // needs this most is `.../runs/run-1**`, where the segment carries a trailing star
        // and an exact-match test would fall back to the token and score the stub zero.
        const literal = (gs[i] ?? "").split("*")[0];
        return literal ? literal : TOKEN;
      })
      .join("/")
  );
}

/**
 * Deliberate multi-endpoint stubs. Each entry names the endpoints it is allowed to match, so
 * it decays loudly: if the set changes — an endpoint added under the prefix, or the stub
 * narrowed — the entry no longer describes reality and the run fails saying so. An allowlist
 * that only says "ignore this" is a suppression; one that restates the fact it is suppressing
 * has to be revisited when the fact moves. Same obligation as KNOWN_UNPROVEN in
 * assert-checker-proof-pairing.mjs and knownRungNamedSharedPaths in classify.mjs.
 */
export const KNOWN_OVERBROAD = [
  // { glob: "**/api/x**", endpoints: ["/api/x", "/api/x/y"], why: "…" },
];

export function findOverbroad(root) {
  const endpoints = realEndpoints(root);
  const stubs = stubPatterns(root);
  const results = [];
  for (const [glob, files] of [...stubs].sort((a, b) => a[0].localeCompare(b[0]))) {
    let re;
    try {
      re = new RegExp(globToRegexPattern(glob));
    } catch (err) {
      results.push({ glob, files: [...files], matched: [], invalid: String(err.message) });
      continue;
    }
    // Playwright tests the pattern against the FULL url. The origin is irrelevant to every
    // pattern here (they all start `**/`), but testing a bare path would silently change what
    // a leading `**/` means, so a real one is used.
    const matched = endpoints.filter((e) =>
      re.test("http://localhost:3000" + instantiate(e, glob))
    );
    results.push({ glob, files: [...files].sort(), matched });
  }
  return { endpoints, results };
}

function main() {
  const { endpoints, results } = findOverbroad(ROOT);

  /*
   * POSITIVE CONTROLS, BEFORE ANY VERDICT.
   *
   * "no over-broad stubs" and "I could not read the route table" produce identical output,
   * and the second is the likelier failure the day someone moves apps/ or renames route.ts.
   * A checker whose clean result is indistinguishable from its broken result reports the same
   * green either way, so both inputs are asserted to be non-empty first — and the counts are
   * printed on success, so the reader can see WHAT was checked and not only that it passed.
   */
  if (endpoints.length === 0) {
    console.error(
      `FAIL: no route files found under ${ROOT}/apps/*/app/api/**/route.ts.\n` +
        `      That is the route table this checker joins against, so an empty one means it\n` +
        `      cannot compute the property — not that the property holds.`
    );
    process.exit(2);
  }
  if (results.length === 0) {
    console.error(
      `FAIL: no \`.route("…")\` stubs found under ${ROOT}/e2e.\n` +
        `      Same reason: nothing examined is not the same as nothing wrong.`
    );
    process.exit(2);
  }

  const invalid = results.filter((r) => r.invalid);
  const violations = [];
  const staleAllowances = [];

  for (const r of results) {
    if (r.matched.length <= 1) continue;
    const allowed = KNOWN_OVERBROAD.find((k) => k.glob === r.glob);
    if (!allowed) {
      violations.push(r);
      continue;
    }
    const same =
      allowed.endpoints.length === r.matched.length &&
      allowed.endpoints.every((e, i) => e === r.matched[i]);
    if (!same) staleAllowances.push({ r, allowed });
  }
  for (const k of KNOWN_OVERBROAD) {
    const r = results.find((x) => x.glob === k.glob);
    if (!r || r.matched.length <= 1) {
      staleAllowances.push({ r: r ?? { glob: k.glob, matched: [], files: [] }, allowed: k, fixed: true });
    }
  }

  let bad = false;

  for (const r of invalid) {
    bad = true;
    console.error(`FAIL: ${r.glob} is not a valid Playwright glob — ${r.invalid}`);
    r.files.forEach((f) => console.error(`        ${f}`));
  }

  for (const r of violations) {
    bad = true;
    console.error(
      `FAIL: ${JSON.stringify(r.glob)} matches ${r.matched.length} real endpoints:`
    );
    r.matched.forEach((e) => console.error(`        ${e}`));
    console.error(`      stubbed in:`);
    r.files.forEach((f) => console.error(`        ${f}`));
    console.error(
      `      A stub that matches more than one endpoint answers requests it was never\n` +
        `      written for. Narrow it to the endpoint it means, or add a KNOWN_OVERBROAD\n` +
        `      entry naming these endpoints and why catching all of them is intended.\n`
    );
  }

  for (const { r, allowed, fixed } of staleAllowances) {
    bad = true;
    console.error(
      fixed
        ? `FAIL: KNOWN_OVERBROAD entry for ${JSON.stringify(allowed.glob)} is obsolete — it now\n` +
            `      matches ${r.matched.length}. Delete the entry.`
        : `FAIL: KNOWN_OVERBROAD entry for ${JSON.stringify(allowed.glob)} is out of date.\n` +
            `      recorded: ${allowed.endpoints.join(", ")}\n` +
            `      actual:   ${r.matched.join(", ")}\n` +
            `      The set moved, so the recorded reason no longer describes it.`
    );
  }

  if (bad) process.exit(1);

  const matchedOne = results.filter((r) => r.matched.length === 1).length;
  const matchedNone = results.length - matchedOne;
  console.log(
    `PASS: ${results.length} route stub pattern(s) checked against ${endpoints.length} real ` +
      `endpoint(s).\n` +
      `      ${matchedOne} match exactly one endpoint; ${matchedNone} match none (an origin ` +
      `this repo does not serve —\n` +
      `      reported, not enforced). No stub matches more than one.`
  );
}

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();
