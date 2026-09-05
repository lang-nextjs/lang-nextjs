/**
 * EVERY SCRIPT WITH A PROOF IS ACCOUNTED FOR, OR SAYS WHY NOT (#741, widened by #774).
 *
 * WHY A GATE AND NOT A CLEANUP. Eighteen checkers sat unregistered, and the sixteenth arrived
 * the same way the fifteenth did: PRODUCT-lang wired `pnpm sibling-tests` knowing the mechanism
 * existed and did not register it, then disclosed it rather than arguing from the other
 * fourteen. That is the absence of a gate, not carelessness. Without this, the registrations
 * are a one-time tidy with a known repair.
 *
 * WHY #774 WIDENED IT, AND IT IS THE SHARPEST THING ON THIS FILE. The first version's
 * population was `scripts/assert-*` — a PREFIX. Nine `scripts/check-*` checkers sat outside it,
 * running from hand-written ci.yml steps, invisible to the gate built to catch exactly that.
 * And the reason they were hand-wired is #117: `check-palette.mjs` existed with a selftest and
 * ran NOWHERE, and the repair was to wire it into ci.yml by hand. THE REPAIR FOR ONE INSTANCE
 * BUILT THE PLACE THAT HID THE CLASS. A prefix cannot see that; only a content rule can.
 *
 * THE POPULATION IS "HAS A PROOF", AND IT IS DELIBERATELY WIDER THAN "IS A CHECKER".
 * 82 files qualify and about 20 are not checkers at all — census.mjs, eject.mjs, format.mjs,
 * matrix.mjs, and run-checks.mjs, which is the runner itself. That is harmless under the
 * accounting below, because a legitimate tool a workflow runs is accounted for BY that
 * invocation. It is not harmless in the SUBJECT LINE: this reports "scripts with a proof",
 * never "checkers", because a subject line claiming a domain the population does not have is
 * the defect this gate exists to catch, arriving inside the gate.
 *
 * ACCOUNTING IS THREE-WAY AND RECOMPUTED EVERY RUN:
 *
 *     registered in checks.json  |  declared unregistered with a reason  |  invoked by a workflow
 *
 * THE THIRD IS DERIVED, NOT DECLARED, and that is ARCHITECT-lang's B refined rather than
 * softened. B asked for a pointer to where a checker runs plus a verifier. A DECLARED pointer
 * would be 44 hand-maintained citations of where something lives — the single artifact class
 * that produced five wrong readings in this repo in one day, one of them inside the commit
 * that wrote it, where rewriting a step's comment moved the lines the same commit cited. The
 * extra power a declared pointer buys is noticing a checker MOVE between workflows while
 * staying invoked, and the ruling already forgoes that: it verifies invocation, not execution,
 * and stays green on a push-gated job. So the citation purchases nothing that survives its own
 * scope. Deriving it collapses "the pointer resolves" and "the invocation matches an entry"
 * into ONE query, so they cannot drift apart.
 *
 * THE ACCEPTANCE TEST, which is the only thing that says whether the class is closed:
 * could `check-palette.mjs`, present with a selftest and invoked nowhere, be added to this
 * tree today and go green? It cannot: it is in the population, it is in neither list, and it
 * resolves to no workflow. The selftest runs exactly that case.
 *
 * WHAT THIS DOES NOT ASSERT, stated as forgone rather than deferred:
 *   - INVOCATION, NOT EXECUTION. A step behind `if:`, or in a push-gated job, is "invoked".
 *   - The 44 invoked-only scripts have no SUBJECT line and no FLOOR. They are enumerated and
 *     their invocation is verified; nothing observes what they examined.
 *   - The dependency coupling — a checker needing an install performed by another step — is
 *     #779, and nothing here notices if that install is deleted.
 *
 * WHAT THIS ASSERTS, and each arm is a different failure:
 *
 *   1. every script with a proof is registered, declared, or invoked  — the hole this closes
 *   2. no script is BOTH registered and declared unregistered      — a contradiction nobody reads
 *   3. every declared reason names a file that still exists        — an exclusion outliving its subject
 *   4. every reason says what would LIFT it, or is permanent       — the anti-mute-button arm
 *   5. a PENDING reason names a real issue, not a placeholder      — so `#TBD` cannot ship
 *   6. no proof is unaccounted for                                 — the orphan-proof arm
 *
 * ARM 4 IS THE ONE THAT KEEPS THIS FROM BECOMING A MUTE BUTTON. "Registered or carries a stated
 * reason" is one exception list away from a list where every entry has a one-line justification
 * and nobody can tell which are permanent. A reason must be either `"lifts": null` — permanent
 * under the rule — or name the issue that would remove it.
 *
 * ARM 6 CANNOT KEY ON THE NAME, and this was measured rather than assumed. Three proofs prove a
 * subject whose stem they do not share: `langfuse-wiring.selftest.sh` proves the langfuse-*
 * scripts, `dev-hold.selftest.sh` proves `dev-hold-decision.sh`, and `dev-all-env-order.selftest.sh`
 * proves `dev-all.sh` — a rename made in #741. A naive stem match manufactures three orphan
 * findings out of a naming convention. So a proof is orphaned only when it is accounted for by
 * NOTHING: no sibling subject, not named as a `proof` in checks.json, and invoked by no workflow.
 *
 * THE TOTAL IS MEASURED INDEPENDENTLY OF THE PARTS. Four published counts of this population were
 * wrong, and one closed its own arithmetic perfectly while being short by one in two places —
 * because all three terms came from one scan. A scan that misses a file removes it from a
 * subtotal AND from the total, so the sum still balances. Closing arithmetic proves internal
 * consistency, not correct enumeration.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { invokedAsProgram } from "./lib/is-main.mjs";
import { reportSubject } from "./lib/subject.mjs";
import { resolveInvocations } from "./lib/workflow-invocations.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PROOF_MARK = ".selftest.";
const stemOf = (n) => n.replace(/\.(mjs|sh|js|cjs)$/, "");
const stemOfProof = (n) => n.replace(/\.selftest\.(mjs|sh|js|cjs)$/, "");

/**
 * Split scripts/ by CONTENT — a file with a sibling proof — not by name prefix.
 *
 * `total` is every file, counted without reference to the parts, so a scan that drops a file
 * cannot balance its own arithmetic.
 */
export function partition(names) {
  const proofs = names.filter((n) => n.includes(PROOF_MARK));
  const subjects = names.filter((n) => !n.includes(PROOF_MARK));
  const proofStems = new Set(proofs.map(stemOfProof));
  const withProof = subjects.filter((n) => proofStems.has(stemOf(n)));
  return { total: names.length, proofs, subjects, withProof };
}

/**
 * A proof accounted for by nothing: no sibling subject, not a registered `proof`, not invoked.
 *
 * Keying on the sibling ALONE reports three false orphans in this tree today — see ARM 6 above.
 */
export function orphanProofs({ proofs, subjects, registeredProofs, invoked }) {
  const subjectStems = new Set(subjects.map(stemOf));
  const reg = new Set(registeredProofs);
  return proofs.filter((p) => {
    const path = `scripts/${p}`;
    return (
      !subjectStems.has(stemOfProof(p)) && !reg.has(path) && !invoked.has(path)
    );
  });
}

export function audit({ population, registered, excluded, invoked, exists }) {
  const findings = [];
  const reg = new Set(registered);
  const byChecker = new Map(excluded.map((e) => [e.checker, e]));

  for (const name of population) {
    const path = `scripts/${name}`;
    if (reg.has(path) && byChecker.has(path))
      findings.push(`${path} is BOTH registered and listed as unregistered`);
    else if (!reg.has(path) && !byChecker.has(path) && !invoked.has(path))
      findings.push(
        `${path} has a proof but is accounted for by nothing — not registered in ` +
          `checks.json, not listed with a reason, and named by no workflow. A script with a ` +
          `proof that nothing runs is either an unwired checker (#117 was exactly this) or a ` +
          `tool that should say so.`
      );
  }
  for (const e of excluded) {
    if (!exists(e.checker))
      findings.push(`${e.checker} is listed with a reason but does not exist`);
    if (!e.reason || e.reason.trim().length < 20)
      findings.push(`${e.checker} has no substantive reason`);
    if (e.lifts !== null && !/^#\d+$/.test(String(e.lifts ?? "")))
      findings.push(
        `${e.checker} has lifts=${JSON.stringify(
          e.lifts
        )} — a reason must be ` +
          `"lifts": null (permanent under the rule) or name a real issue like "#123". ` +
          `A placeholder cannot ship.`
      );
  }
  return findings;
}

function main() {
  const names = readdirSync(join(ROOT, "scripts")).filter((n) =>
    statSync(join(ROOT, "scripts", n)).isFile()
  );
  const { total, proofs, subjects, withProof } = partition(names);
  if (withProof.length === 0) {
    console.error(
      "REFUSING TO REPORT: no scripts/* file has a sibling proof, so this check " +
        "would pass over an empty population. That is not a clean tree."
    );
    process.exit(2);
  }

  const wfDir = join(ROOT, ".github/workflows");
  const workflowSources = Object.fromEntries(
    readdirSync(wfDir)
      .filter((f) => /\.ya?ml$/.test(f))
      .map((f) => [f, readFileSync(join(wfDir, f), "utf8")])
  );
  const cfg = JSON.parse(
    readFileSync(join(ROOT, "scripts/checks.json"), "utf8")
  );
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const invoked = resolveInvocations({
    workflowSources,
    packageScripts: pkg.scripts ?? {},
  });

  /*
   * TWO REFUSALS ON THE RESOLVER ITSELF, because accounting is only as good as it is.
   *
   * A resolver that finds NOTHING makes every script unaccounted — loud, and it would be read
   * as 82 findings rather than as a broken query. A resolver that OVER-matches makes everything
   * accounted, which is silent, and is the direction that cost a scripts/checks.js that never
   * existed: the `js` branch matched inside `checks.json`. Asking whether every resolved path
   * exists is a control on the QUERY rather than on its subject, and it is the one that catches
   * the silent direction.
   */
  if (invoked.size === 0) {
    console.error(
      `REFUSING TO REPORT: resolved 0 script invocations from ${
        Object.keys(workflowSources).length
      } workflow(s). Every script would read as unaccounted — that is a broken query, not a ` +
        `finding about the tree.`
    );
    process.exit(2);
  }
  const phantom = [...invoked.keys()].filter((p) => !existsSync(join(ROOT, p)));
  if (phantom.length) {
    console.error(
      `REFUSING TO REPORT: resolved ${phantom.length} path(s) that do not exist:\n` +
        phantom.map((p) => `         ${p}`).join("\n") +
        `\n       Either a workflow names a deleted script, or this file's own matcher ` +
        `over-matched. Those need opposite repairs and this cannot tell them apart, so it ` +
        `reports neither. CHECK THE MATCHER FIRST — it has been wrong here before.`
    );
    process.exit(2);
  }

  const findings = audit({
    population: withProof,
    registered: cfg.checks.map((c) => c.checker),
    excluded: cfg.unregistered ?? [],
    invoked,
    exists: (p) => existsSync(join(ROOT, p)),
  });
  for (const p of orphanProofs({
    proofs,
    subjects,
    registeredProofs: cfg.checks.map((c) => c.proof).filter(Boolean),
    invoked,
  }))
    findings.push(
      `scripts/${p} is a proof accounted for by nothing — no sibling subject, not a ` +
        `registered proof, and named by no workflow. It proves something nobody runs.`
    );

  /*
   * THE BUCKETS PARTITION THE POPULATION AND SUM TO IT.
   *
   * The first draft printed the two REGISTRY SIZES beside one population intersection:
   * "47 registered, 12 declared, 42 invoked" against a population of 82. Those add to 101,
   * because the routes overlap — six declared scripts are also invoked, and thirteen
   * registered ones are — and two of the three numbers were counting a list rather than a
   * share of the subject. A reader who adds them gets a number larger than the whole and
   * cannot tell whether the population or the arithmetic is wrong.
   *
   * So these are assigned in precedence order and checked to sum. Registered-before-declared
   * is safe because arm 2 forbids a script being both. The overlap is reported separately,
   * as the non-partitioning fact it is.
   */
  const reg = new Set(cfg.checks.map((c) => c.checker));
  const dec = new Set((cfg.unregistered ?? []).map((e) => e.checker));
  const bucket = (n) => {
    const p = `scripts/${n}`;
    return reg.has(p)
      ? "registered"
      : dec.has(p)
      ? "declared"
      : invoked.has(p)
      ? "invokedOnly"
      : "unaccounted";
  };
  const n = { registered: 0, declared: 0, invokedOnly: 0, unaccounted: 0 };
  for (const s of withProof) n[bucket(s)]++;
  const alsoInvoked = withProof.filter(
    (s) => invoked.has(`scripts/${s}`) && bucket(s) !== "invokedOnly"
  ).length;
  const pending = (cfg.unregistered ?? []).filter((e) => e.lifts !== null);

  console.log(
    `script registration — ${total} scripts/* file(s), ${proofs.length} proof(s); ` +
      `${withProof.length} with a proof = ` +
      `${n.registered} registered + ${n.declared} declared unregistered ` +
      `(${pending.length} pending, ${
        n.declared - pending.length
      } permanent) + ` +
      `${n.invokedOnly} invoked only + ${n.unaccounted} accounted by nothing.\n` +
      `                    ${alsoInvoked} of the registered/declared are ALSO invoked by a ` +
      `step, which is why those routes overlap and only this partition sums.\n` +
      `                    Invocations resolved from run: blocks through ${
        Object.keys(pkg.scripts ?? {}).length
      } package script(s); ` +
      `about 20 of the ${withProof.length} are tools, not checkers — run-checks.mjs, the ` +
      `runner itself, among them.`
  );
  if (
    n.registered + n.declared + n.invokedOnly + n.unaccounted !==
    withProof.length
  ) {
    console.error(
      "REFUSING TO REPORT: the buckets do not sum to the population, so the partition above " +
        "is not one. That is an error in this file, not a finding about the tree."
    );
    process.exit(2);
  }

  if (findings.length) {
    console.error(`\nFAIL: ${findings.length} registration finding(s):`);
    findings.forEach((f) => console.error(`  ${f}`));
    process.exit(1);
  }
  // "scripts/* file(s) with a proof", NOT "checkers". About 20 of these are tools —
  // run-checks.mjs, the runner itself, among them. Naming the population is the
  // whole discipline; a line claiming "checkers" would overstate the domain by 20.
  reportSubject(
    withProof.length,
    "scripts/* file(s) with a proof, audited for registration"
  );
  console.log(
    "PASS: every scripts/* file with a proof is registered, declared, or invoked by a workflow."
  );
}

if (invokedAsProgram(import.meta.url)) main();
