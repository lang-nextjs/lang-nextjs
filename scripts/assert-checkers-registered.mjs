/**
 * EVERY CHECKER THE RUNNER CAN EXECUTE IS REGISTERED, OR SAYS WHY NOT (#741).
 *
 * WHY A GATE AND NOT A CLEANUP. Eighteen checkers sat unregistered, and the sixteenth arrived
 * the same way the fifteenth did: PRODUCT-lang wired `pnpm sibling-tests` knowing the mechanism
 * existed and did not register it, then disclosed it rather than arguing from the other
 * fourteen. That is the absence of a gate, not carelessness. Without this, the registrations
 * are a one-time tidy with a known repair.
 *
 * THE RULE IS ARCHITECT-lang's, and it is a CAPABILITY boundary rather than a quality one:
 *
 *     a checker belongs in checks.json if THE RUNNER CAN EXECUTE AND OBSERVE IT — it is a node
 *     script, it needs no run-specific arguments, and it does not consume the runner's output.
 *
 * CLAUSE 2 IS NOT DECIDABLE BY READING, and that is worth knowing before applying this to a
 * seventeenth. Three of the exclusions were found by inspection; `assert-severance-removes-rungs`
 * could not be — "needs run-specific arguments" has no fixed vocabulary, and a scan for
 * `--base|--head|--at` does not see `--record|--verify`. RUN the candidate.
 *
 * WHAT THIS ASSERTS, and each arm is a different failure:
 *
 *   1. every scripts/assert-* checker is registered or listed      — the hole this closes
 *      with a reason. NOT every checker: scripts/check-* is outside     (see #774)
 *      the population at :52, and the success line says so too.
 *   2. no checker is BOTH registered and listed                 — a contradiction nobody reads
 *   3. every listed reason names a file that still exists       — an exclusion outliving its subject
 *   4. every reason says what would LIFT it, or is permanent    — the anti-mute-button arm
 *   5. a PENDING reason names a real issue, not a placeholder   — so `#TBD` cannot ship
 *   6. no proof sits beside a checker that does not exist       — the orphan-proof arm
 *
 * ARM 4 IS THE ONE THAT KEEPS THIS FROM BECOMING A MUTE BUTTON. "Registered or carries a stated
 * reason" is one exception list away from a list where every entry has a one-line justification
 * and nobody can tell which are permanent. A reason must be either `"lifts": null` — permanent
 * under the rule — or name the issue that would remove it. Two of the six today are the same
 * clause and one is pending; without arm 4 the pending one would be written in the shape of the
 * permanent ones and stop being visible as work.
 *
 * THE TOTAL IS MEASURED INDEPENDENTLY OF THE PARTS. Four published counts of this population were
 * wrong, and one closed its own arithmetic perfectly while being short by one in two places —
 * because all three terms came from one scan. A scan that misses a file removes it from a
 * subtotal AND from the total, so the sum still balances. Closing arithmetic proves internal
 * consistency, not correct enumeration.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { invokedAsProgram } from "./lib/is-main.mjs";
import { reportSubject } from "./lib/subject.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every `scripts/assert-*` entry, and the total counted without reference to the parts. */
export function partition(names) {
  const all = names.filter((n) => n.startsWith("assert-"));
  const proofs = all.filter((n) => n.includes(".selftest."));
  const checkers = all.filter((n) => !n.includes(".selftest."));
  return { total: all.length, proofs, checkers };
}

/** A proof whose subject does not exist — the convention implying a checker nobody wrote. */
export function orphanProofs(proofs, checkers) {
  const stems = new Set(checkers.map((c) => c.replace(/\.(mjs|sh)$/, "")));
  return proofs
    .map((p) => p.replace(/\.selftest\.(mjs|sh)$/, ""))
    .filter((stem) => !stems.has(stem));
}

export function audit({ checkers, registered, excluded, exists }) {
  const findings = [];
  const reg = new Set(registered);
  const byChecker = new Map(excluded.map((e) => [e.checker, e]));

  for (const c of checkers) {
    const path = `scripts/${c}`;
    if (reg.has(path) && byChecker.has(path))
      findings.push(`${path} is BOTH registered and listed as unregistered`);
    else if (!reg.has(path) && !byChecker.has(path))
      findings.push(
        `${path} is neither registered in checks.json nor listed with a reason`
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
  const names = readdirSync(join(ROOT, "scripts"));
  const { total, proofs, checkers } = partition(names);
  if (checkers.length === 0) {
    console.error(
      "REFUSING TO REPORT: no scripts/assert-* checkers were found, so this " +
        "check would pass over an empty population. That is not a clean tree."
    );
    process.exit(2);
  }

  const cfg = JSON.parse(
    readFileSync(join(ROOT, "scripts/checks.json"), "utf8")
  );
  const findings = audit({
    checkers,
    registered: cfg.checks.map((c) => c.checker),
    excluded: cfg.unregistered ?? [],
    exists: (p) => existsSync(join(ROOT, p)),
  });
  for (const stem of orphanProofs(proofs, checkers))
    findings.push(
      `scripts/${stem}.selftest.* is a proof with no scripts/${stem}.* beside it — ` +
        `the assert-<name>.selftest.* convention implies a checker that does not exist`
    );

  const pending = (cfg.unregistered ?? []).filter((e) => e.lifts !== null);
  console.log(
    `checker registration — ${total} scripts/assert-* file(s): ` +
      `${proofs.length} proof(s), ${checkers.length} checker(s); ` +
      `${cfg.checks.length} registered, ${
        (cfg.unregistered ?? []).length
      } listed with a reason ` +
      `(${pending.length} pending, ${
        (cfg.unregistered ?? []).length - pending.length
      } permanent)`
  );

  if (findings.length) {
    console.error(`\nFAIL: ${findings.length} registration finding(s):`);
    findings.forEach((f) => console.error(`  ${f}`));
    process.exit(1);
  }
  // "assert-*", NOT "checker" — the population is this readdir glob, and
  // scripts/check-* checkers exist outside it. A subject line that said
  // "checker file(s)" would claim a domain this gate does not have.
  reportSubject(
    checkers.length,
    "scripts/assert-* checker file(s) audited for registration"
  );
  console.log(
    "PASS: every scripts/assert-* checker is registered or says why it cannot be."
  );
}

if (invokedAsProgram(import.meta.url)) main();
