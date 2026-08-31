#!/usr/bin/env node
/**
 * Proof that assert-no-overbroad-route-stubs.mjs can fail, and — the half that matters more —
 * that it does NOT fire on the forty-odd legitimate trailing-`**` globs in this repo.
 *
 * #328 records an ad-hoc scan for this same family of bug that reported 63 findings, then 4,
 * then 0, and was deliberately not kept: it was measuring pattern SHAPE, and shape does not
 * distinguish a stub that catches a sibling endpoint from one that needs its star to match a
 * query string. A rule that fires on a clean tree gets deleted rather than fixed, so the
 * ACCEPT cases below are not padding — they are the reason this one is allowed to exist.
 *
 * Every case is a synthetic tree. The checker is pointed at it with --cwd, so a case says
 * exactly what it means and does not go stale when this repo's real routes move.
 *
 * Usage: node scripts/assert-no-overbroad-route-stubs.selftest.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKER = join(HERE, "assert-no-overbroad-route-stubs.mjs");
const ROOT = join(HERE, "..");
const TMP = mkdtempSync(join(tmpdir(), "overbroad-selftest-"));

let pass = 0;
let fail = 0;

function sandbox({ routes, stubs }) {
  const dir = mkdtempSync(join(TMP, "case-"));
  for (const r of routes) {
    const d = join(dir, "apps", "demo", "app", r);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "route.ts"), "export async function GET() {}\n");
  }
  mkdirSync(join(dir, "e2e"), { recursive: true });
  writeFileSync(
    join(dir, "e2e", "case.spec.ts"),
    stubs.map((s) => `await page.route(${JSON.stringify(s)}, () => {});`).join("\n") + "\n"
  );
  return dir;
}

function run(dir) {
  try {
    const out = execFileSync("node", [CHECKER, "--cwd", dir], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { rc: 0, out };
  } catch (e) {
    return { rc: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

function reject(label, spec, mustName = []) {
  const { rc, out } = run(sandbox(spec));
  const named = mustName.every((n) => out.includes(n));
  if (rc !== 0 && named) {
    console.log(`  ok   ${label.padEnd(58)} (rejected)`);
    pass++;
  } else {
    console.error(`  FAIL ${label} — rc=${rc}, named=${named}`);
    console.error(out.split("\n").map((l) => "         " + l).join("\n"));
    fail++;
  }
}

function accept(label, spec) {
  const { rc, out } = run(sandbox(spec));
  if (rc === 0) {
    console.log(`  ok   ${label.padEnd(58)} (accepted)`);
    pass++;
  } else {
    console.error(`  FAIL ${label} — a clean tree was rejected (rc=${rc})`);
    console.error(out.split("\n").map((l) => "         " + l).join("\n"));
    fail++;
  }
}

console.log("\nassert-no-overbroad-route-stubs — REJECT cases\n");

/*
 * THE ISSUE'S OWN INSTANCE, reconstructed. This is the shape that broke five specs in #361:
 * a stub for the chat POST whose trailing `**` also caught the resume GET added beside it.
 * The endpoints must be NAMED, not merely counted — "1 problem found" would not have told
 * anyone which sibling was being swallowed, and that is the entire diagnostic value.
 */
reject(
  "the #361 instance: chat/stream** also catches /resume",
  {
    routes: ["api/chat/stream", "api/chat/stream/resume"],
    stubs: ["**/api/chat/stream**"],
  },
  ["/api/chat/stream", "/api/chat/stream/resume"]
);

reject(
  "a prefix stub catching a whole collection subtree",
  {
    routes: [
      "api/open-swe/runs",
      "api/open-swe/runs/[runId]",
      "api/open-swe/runs/[runId]/state",
    ],
    stubs: ["**/api/open-swe/runs**"],
  },
  ["/api/open-swe/runs/[runId]/state"]
);

/*
 * THE CASE THAT MAKES `instantiate`'s SEGMENT PINNING LOAD-BEARING.
 *
 * A concrete id plus a trailing star. WITH the pinning, `[runId]` is filled from the stub's
 * own literal, so this correctly matches all four `/runs/run-1/*` endpoints and is rejected.
 * WITHOUT it, `[runId]` becomes a generic token, the stub matches NOTHING, and zero is not a
 * violation — so the checker would return green on a genuinely over-broad stub.
 *
 * The plain `**\/api/open-swe/runs/run-1` accept case below cannot catch that regression: it
 * would go from one match to zero, and both are green. This one is the only case where the
 * pinning changes a verdict.
 */
reject(
  "concrete id + trailing star still catches the subtree",
  {
    routes: [
      "api/open-swe/runs/[runId]",
      "api/open-swe/runs/[runId]/cancel",
      "api/open-swe/runs/[runId]/state",
    ],
    stubs: ["**/api/open-swe/runs/run-1**"],
  },
  ["/api/open-swe/runs/[runId]/cancel"]
);

{
  // NO ROUTE TABLE IS NOT A CLEAN TREE. This is the failure the issue calls out by name: a
  // checker that finds zero because it cannot read the routes looks exactly like one that
  // finds zero because the specs are fine. Exit 2, distinct from a violation's 1.
  const dir = mkdtempSync(join(TMP, "case-"));
  mkdirSync(join(dir, "e2e"), { recursive: true });
  writeFileSync(join(dir, "e2e", "a.spec.ts"), 'await page.route("**/api/x", () => {});\n');
  const { rc, out } = run(dir);
  const label = "an unreadable route table is exit 2, not a green";
  if (rc === 2 && out.includes("cannot compute the property")) {
    console.log(`  ok   ${label.padEnd(58)} (rejected)`);
    pass++;
  } else {
    console.error(`  FAIL ${label} — rc=${rc}`);
    fail++;
  }
}

{
  // ...and the mirror: routes present, no stubs found. Same reasoning, same exit.
  const dir = sandbox({ routes: ["api/chat/stream"], stubs: [] });
  writeFileSync(join(dir, "e2e", "case.spec.ts"), "// no stubs here\n");
  const { rc, out } = run(dir);
  const label = "no stubs found is exit 2, not a green";
  if (rc === 2 && out.includes("nothing examined")) {
    console.log(`  ok   ${label.padEnd(58)} (rejected)`);
    pass++;
  } else {
    console.error(`  FAIL ${label} — rc=${rc}`);
    fail++;
  }
}

console.log("\nassert-no-overbroad-route-stubs — ACCEPT cases (the half that keeps it alive)\n");

/*
 * THE ISSUE'S NAMED PASSING CASE. Same tree as the first REJECT, stub narrowed. If this ever
 * fails, the checker is telling people to write a stub that cannot be written.
 */
accept("the #361 fix: chat/stream (narrowed) is clean", {
  routes: ["api/chat/stream", "api/chat/stream/resume"],
  stubs: ["**/api/chat/stream"],
});

/*
 * A TRAILING STAR THAT EXISTS FOR THE QUERY STRING. Playwright matches the full url, so
 * `/api/config?runtime=django` needs it. This is the single largest class of trailing-glob in
 * the repo and the one a shape-based rule would flag — 15 sites use exactly this pattern.
 */
accept("trailing single star for a query string is fine", {
  routes: ["api/config"],
  stubs: ["**/api/config*"],
});

/*
 * A `**` TAIL ON A LEAF. `/api/open-swe/dependencies**` has nothing under it, so the star is
 * only reaching a query string. Legitimate, and indistinguishable from the #361 bug by shape
 * alone — which is the whole argument for joining against the route table.
 */
accept("a ** tail with no sibling below it is fine", {
  routes: ["api/open-swe/dependencies", "api/open-swe/runs"],
  stubs: ["**/api/open-swe/dependencies**"],
});

accept("a mid-glob * standing in for a dynamic segment is fine", {
  routes: ["api/open-swe/runs/[runId]/state", "api/open-swe/runs/[runId]/stream"],
  stubs: ["**/api/open-swe/runs/*/state**"],
});

accept("a concrete id resolves to its dynamic endpoint, not zero", {
  routes: ["api/open-swe/runs", "api/open-swe/runs/[runId]"],
  stubs: ["**/api/open-swe/runs/run-1"],
});

/*
 * A STUB FOR SOMETHING THIS REPO DOES NOT SERVE. Specs stub backends on other origins. Zero
 * matches is reported in the summary and never enforced; making it a violation would fail
 * honest specs and is how a checker earns a reputation for being wrong.
 */
accept("a stub matching no local endpoint is not a violation", {
  routes: ["api/chat/stream"],
  stubs: ["**/localhost:8001/v1/chat/**"],
});

{
  /*
   * THE SAME ROUTE IN TWO APPS IS ONE ENDPOINT. apps/example and apps/open-swe both serve
   * /api/chat/stream. Counting per route FILE rather than per url would score every shared
   * route as two matches, and the checker would fail on a clean tree — the exact failure mode
   * that got #328's detector discarded.
   */
  const dir = mkdtempSync(join(TMP, "case-"));
  for (const app of ["example", "open-swe"]) {
    const d = join(dir, "apps", app, "app", "api", "chat", "stream");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "route.ts"), "export async function POST() {}\n");
  }
  mkdirSync(join(dir, "e2e"), { recursive: true });
  writeFileSync(
    join(dir, "e2e", "a.spec.ts"),
    'await page.route("**/api/chat/stream", () => {});\n'
  );
  const { rc, out } = run(dir);
  const label = "one url served by two apps counts once";
  if (rc === 0 && /against 1 real endpoint/.test(out)) {
    console.log(`  ok   ${label.padEnd(58)} (accepted)`);
    pass++;
  } else {
    console.error(`  FAIL ${label} — rc=${rc}\n${out}`);
    fail++;
  }
}

{
  /*
   * A `.route("…")` INSIDE A BLOCK COMMENT IS NOT A STUB. This repo has several, in comments
   * explaining this very bug. Before the literal was constrained to a single line, the
   * pattern ran past the closing quote and produced an entry whose text was two lines of
   * prose — harmless to the verdict, and precisely the kind of visible nonsense that teaches
   * a reader to stop trusting the output.
   */
  const dir = sandbox({ routes: ["api/chat/stream"], stubs: ["**/api/chat/stream"] });
  writeFileSync(
    join(dir, "e2e", "case.spec.ts"),
    '/*\n * The old form was page.route("**/api/chat/stream/\n * resume**", …) and it was wrong.\n */\n' +
      'await page.route("**/api/chat/stream", () => {});\n'
  );
  const { rc, out } = run(dir);
  const label = "a .route() inside a comment is not parsed as a stub";
  if (rc === 0 && /1 route stub pattern\(s\)/.test(out)) {
    console.log(`  ok   ${label.padEnd(58)} (accepted)`);
    pass++;
  } else {
    console.error(`  FAIL ${label} — rc=${rc}\n${out}`);
    fail++;
  }
}

console.log("\nassert-no-overbroad-route-stubs — matcher provenance\n");

{
  /*
   * THE MATCHER MUST STILL BE PLAYWRIGHT'S.
   *
   * globToRegexPattern is copied verbatim from playwright-core. A copy is a fact that was
   * true once, and this checker's entire verdict rests on it: if Playwright changes glob
   * semantics in an upgrade, every answer here becomes a claim about a matcher nobody runs,
   * and nothing else in the suite would notice — the ACCEPT and REJECT cases above all use
   * the copy, so they would agree with themselves.
   *
   * So the installed copy is re-extracted and compared. This fails on an upgrade that touches
   * the function, which is the point: it should be read and re-copied deliberately, not
   * absorbed.
   */
  /*
   * EXTRACT TO A SENTINEL, NOT BY COUNTING BRACES. The first version brace-matched and
   * returned null for both sides, because the function's own body contains `case "{":` and
   * the string `'{'` inside its error messages — the counter never returns to depth zero.
   * Both sides came back null, `null === null` was never reached because the guard ran first,
   * and the case reported DRIFT. A comparison that cannot read either side must say so; it
   * must not resolve to the alarming answer, and it must not resolve to the reassuring one.
   */
  function extract(src, needle) {
    const start = src.indexOf(needle);
    if (start === -1) return null;
    const MARK = 'return tokens.join("");';
    const end = src.indexOf(MARK, start);
    return end === -1 ? null : src.slice(start, end + MARK.length);
  }
  /*
   * COMPARED AS TOKENS, NOT AS TEXT (#545).
   *
   * This normalised with `.replace(/\s+/g, " ")`, which COLLAPSES whitespace runs but never
   * REMOVES them. Prettier breaks three `throw new Error(...)` calls across lines; the break
   * lands right after `(`, and collapsing turns it into a space that was never there. So
   * `new Error(ERR)` became `new Error( ERR )` — six characters across three sites, 1035 to
   * 1041 — and the case reported DRIFT on a reformat that changed nothing.
   *
   * THE SECOND-ORDER RISK IS THE WORSE ONE, and it is why this is fixed rather than exempted:
   * the right-hand side is the INSTALLED playwright-core bundle. A Playwright upgrade that
   * merely reformats this function would go red with no semantic change either — a red that
   * is nobody's defect, arriving while someone is already busy with an upgrade. That is how a
   * check teaches people to re-run it until it passes.
   *
   * WHY TOKENS RATHER THAN STRIPPING WHITESPACE ENTIRELY. `.replace(/\s+/g, "")` also fixes
   * the reported bug, and trades it for a false NEGATIVE: it equates token streams that
   * differ, `a - -b` against `a--b` among them. The whole value of this case is that it fails
   * on real divergence, so a repair that can silently agree is the wrong repair.
   *
   * WHY NOT A VENDORED SNAPSHOT. It removes the upgrade hazard by removing the subject: the
   * point of this case is that it reads the matcher THIS TREE ACTUALLY RUNS, so a snapshot
   * would compare our copy against our own record of it and agree with itself forever.
   *
   * String literals compare by VALUE, so prettier normalising quotes does not move the
   * verdict either — while a changed character class or quantifier does, because in this
   * function those live INSIDE the string literals.
   */
  const tsRequire = createRequire(join(ROOT, "package.json"));
  let ts = null;
  try {
    ts = tsRequire("typescript");
  } catch {
    /* reported below — this case must not pass by being unable to look */
  }

  const preNorm = (s) =>
    s
      .replace(/^export\s+/, "")
      // The bundle spells the error text in full; ours trims the tail. The MESSAGE is not the
      // semantics, so it is normalised away rather than kept in lockstep. Done on TEXT because
      // it rewrites one template literal into an identifier on both sides.
      .replace(/`Invalid glob pattern \$\{JSON\.stringify\(glob\)\}[^`]*`/g, "ERR");

  /** The token stream, with trivia and comments dropped by the scanner itself. */
  const norm = (src) => {
    const scanner = ts.createScanner(
      ts.ScriptTarget.Latest,
      /* skipTrivia */ true,
      ts.LanguageVariant.Standard,
      preNorm(src)
    );
    const out = [];
    for (;;) {
      const kind = scanner.scan();
      if (kind === ts.SyntaxKind.EndOfFileToken) break;
      out.push(
        kind === ts.SyntaxKind.StringLiteral ||
          kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral
          ? JSON.stringify(scanner.getTokenValue())
          : scanner.getTokenText()
      );
    }
    return out.join("\u0000");
  };

  // pnpm's strict layout does not expose playwright-core at the root, so it is resolved
  // THROUGH @playwright/test, which is the dependency this repo actually declares.
  let bundle = null;
  try {
    const fromRoot = createRequire(join(ROOT, "package.json"));
    const fromTest = createRequire(fromRoot.resolve("@playwright/test/package.json"));
    const pwDir = dirname(fromTest.resolve("playwright-core/package.json"));
    bundle = readFileSync(join(pwDir, "lib", "coreBundle.js"), "utf8");
  } catch {
    /* reported below — this case must not pass by being unable to look */
  }

  const label = "the glob matcher still matches playwright-core's";
  const theirs = bundle ? extract(bundle, "function globToRegexPattern(glob) {") : null;
  const ours = extract(
    readFileSync(CHECKER, "utf8"),
    "export function globToRegexPattern(glob) {"
  );

  if (!ts) {
    console.error(
      `  FAIL ${label} — could not load typescript to tokenise the two copies.\n` +
        `         Cannot compute the comparison, which is not the same as it holding.`
    );
    fail++;
  } else if (!bundle) {
    console.error(
      `  FAIL ${label} — could not read playwright-core's coreBundle.js.\n` +
        `         Cannot compute the comparison, which is not the same as it holding.`
    );
    fail++;
  } else if (!theirs || !ours) {
    console.error(
      `  FAIL ${label} — could not EXTRACT the function ` +
        `(playwright=${!!theirs}, ours=${!!ours}).\n` +
        `         Playwright has probably restructured it. Read it and re-copy; do not relax\n` +
        `         this case, which is the only thing tying the checker to the real matcher.`
    );
    fail++;
  } else if (norm(theirs) === norm(ours)) {
    console.log(`  ok   ${label.padEnd(58)} (identical)`);
    pass++;
  } else {
    console.error(
      `  FAIL ${label} — the copy has drifted from playwright-core.\n` +
        `         Re-read packages/isomorphic/urlMatch.ts and re-copy it deliberately;\n` +
        `         every verdict this checker gives depends on the two agreeing.`
    );
    fail++;
  }
}

const EXPECTED_CASES = 14;
const total = pass + fail;
console.log();
rmSync(TMP, { recursive: true, force: true });

if (total !== EXPECTED_CASES) {
  console.error(
    `FAIL: ran ${total} cases, expected ${EXPECTED_CASES} — the harness is broken.`
  );
  process.exit(1);
}
if (fail !== 0) {
  console.error(`FAIL: ${fail}/${total} cases wrong.`);
  process.exit(1);
}
console.log(
  `PASS: ${pass}/${total}. The rule fires on a stub that catches a sibling endpoint, stays\n` +
    `      silent on the trailing globs that exist for query strings, and is still using\n` +
    `      Playwright's own matcher.`
);
