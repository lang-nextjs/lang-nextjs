/**
 * EVERY PROOF IS REACHABLE BY SOME ROUTE (#839).
 *
 * A `*.selftest.mjs` that no route runs is indistinguishable from a deleted one: it sits in the
 * tree, it is cited in review, and it asserts nothing. Three were found that way at 110d547f —
 * `eject-subject-audit`, `measure-push-only-jobs` and `eject-audit-run`, the last named exactly
 * once in the whole repository, inside a `reason` STRING in checks.json. Prose claiming a proof
 * does the work, and nothing running it.
 *
 * WHY NOTHING CAUGHT IT, AND WHY THAT IS NOT A BROKEN GATE. `assert-checkers-registered` passes
 * on this tree and is CORRECT to. Its rule is about CHECKERS — registered, or declared
 * unregistered with a reason, or invoked by a workflow — and all three of those checkers are
 * legitimately `unregistered`. Nothing in that rule mentions their SELFTESTS. So a green gate and
 * three unreachable proofs coexist with no contradiction, which is why this went unfound until
 * someone asked about REACHABILITY instead of about REGISTRATION.
 *
 * THE PREDICATE IS REACHABILITY, DELIBERATELY, AND NOT "RUNNABLE BY `pnpm checks`". 31 proofs run
 * only through a workflow step. That is a real cost — a contributor with a green local suite has a
 * true statement about a smaller subject — but those proofs DO execute, and #827 is the evidence
 * that they can still fail loudly. Whether they should be registered is a decision this checker
 * does not make and must not pre-empt: three of the four categories there are legitimately
 * workflow-only, because `eject`, `matrix` and `ci-completion` mean nothing outside a workflow.
 * So workflow-only PASSES here and the count is printed on every run, which is the part that was
 * previously a one-off script nobody re-ran.
 *
 * IT REUSES #774's RESOLVER RATHER THAN GREPPING, and that is the whole reason the number is
 * trustworthy. A workflow almost never names the script it runs: `ci.yml` says `pnpm palette`,
 * whose command is `node scripts/check-palette.mjs`, so `git grep check-palette .github/workflows`
 * returns nothing while the checker runs on every push. `resolveInvocations` parses `run:` blocks
 * and follows package.json aliases transitively. The capability already existed; what did not
 * exist was anything CALLING it on a schedule, so the thirty-second orphan was invisible the day
 * it was added.
 *
 * Exit 0 every proof has a route · 1 at least one has none.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { invokedAsProgram } from "./lib/is-main.mjs";
import { reportSubject } from "./lib/subject.mjs";
import { resolveInvocations } from "./lib/workflow-invocations.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every `scripts/*.selftest.mjs` in the tree, as repo-relative paths. */
export function proofsOnDisk(names) {
  return names
    .filter((f) => f.endsWith(".selftest.mjs"))
    .map((f) => `scripts/${f}`);
}

/**
 * Which routes reach each proof. A route is a way the file actually gets EXECUTED:
 *
 *   "checks.json"  named as a `proof` or `checker` of a registered check, so `pnpm checks` runs it
 *   "workflow"     resolved as invoked by a workflow step, directly or through an alias chain
 *
 * `unregistered` is NOT a route. Those entries name a CHECKER and carry no `proof` key, and
 * nothing executes them — being excused from registration is not being run.
 */
export function routesFor(proofs, { invoked, viaChecks }) {
  const routes = new Map();
  for (const p of proofs) {
    const r = [];
    if (viaChecks.has(p)) r.push("checks.json");
    if (invoked.has(p)) r.push("workflow");
    routes.set(p, r);
  }
  return routes;
}

/** The proofs no route reaches — the defect this exists to find. */
export function unreachable(routes) {
  return [...routes].filter(([, r]) => r.length === 0).map(([p]) => p);
}

function main() {
  const wfDir = join(ROOT, ".github/workflows");
  const workflowSources = Object.fromEntries(
    readdirSync(wfDir)
      .filter((f) => /\.ya?ml$/.test(f))
      .map((f) => [f, readFileSync(join(wfDir, f), "utf8")])
  );
  const packageScripts =
    JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts ?? {};
  const invoked = new Set(
    resolveInvocations({ workflowSources, packageScripts }).keys()
  );

  const cfg = JSON.parse(
    readFileSync(join(ROOT, "scripts/checks.json"), "utf8")
  );
  const viaChecks = new Set();
  for (const c of cfg.checks ?? []) {
    if (c.proof) viaChecks.add(c.proof);
    if (c.checker) viaChecks.add(c.checker);
  }

  const proofs = proofsOnDisk(readdirSync(join(ROOT, "scripts")));
  const routes = routesFor(proofs, { invoked, viaChecks });
  const orphans = unreachable(routes);

  if (orphans.length > 0) {
    console.error(
      `FAIL: ${orphans.length} proof(s) are reachable by no route — nothing runs them:`
    );
    for (const p of orphans) console.error(`  - ${p}`);
    console.error(
      `\n      A proof no route executes is indistinguishable from a deleted one. Give it a\n` +
        `      route: register it as the \`proof\` of a check in scripts/checks.json so\n` +
        `      \`pnpm checks\` runs it, or add a step to a workflow. Being cited in a \`reason\`\n` +
        `      string is not a route — that is prose claiming a proof does work it never does.`
    );
    process.exit(1);
  }

  const local = [...routes].filter(([, r]) => r.includes("checks.json")).length;
  const workflowOnly = [...routes].filter(
    ([, r]) => r.length === 1 && r[0] === "workflow"
  ).length;

  reportSubject(proofs.length, "proof(s) whose reachability was resolved");
  console.log(
    `PASS: every proof has a route.\n` +
      `      ${local} runnable by \`pnpm checks\`; ${workflowOnly} reachable ONLY through a workflow step.\n` +
      `      That second number is the cost #839 records: a green local suite is a true\n` +
      `      statement about a smaller subject. It is printed rather than asserted, because\n` +
      `      whether those should be registered is a decision per file, not a threshold.`
  );
}

if (invokedAsProgram(import.meta.url)) main();
