/**
 * A FIXTURE MUST ASSERT THAT ITS SETUP ACHIEVED THE PRECONDITION (#375).
 *
 * A fixture builds a scenario, runs the subject at it, and reports a verdict. When the
 * scenario stops being constructible the fixture does not go red — it runs the setup, the
 * setup silently achieves nothing, and the subject is asked about a situation that is no
 * longer there. The verdict it returns is about nothing, and it is GREEN.
 *
 * THREE OF THESE IN ONE NIGHT, and all three left a passing suite behind:
 *
 *   eject guard 2          lost its subject twice — the refusal case had nothing to refuse
 *   assert-census-fresh    its plant path became SHARED after a reparent, so both branches
 *                          froze identically and there was no collision left to construct
 *   the #360 discriminator django gained the topology, so "every runtime offers it" became
 *                          satisfiable by a function that ignores its runtime argument
 *
 * DEV3's rule names the mechanism: a fixture that constructs its scenario FROM A PATH depends
 * on that path's ownership, and ownership is exactly what a reparent moves. The manifest is
 * edited for reasons that have nothing to do with the fixture, by someone who has no reason
 * to open it.
 *
 * WHAT THIS MODULE IS FOR, AND WHAT IT IS NOT. It makes the premise an assertion instead of
 * an assumption. It cannot tell you that you asserted the RIGHT premise — that stays a review
 * question, and assert-fixture-premises.mjs is deliberately honest about only being able to
 * check that premise verification is present at all.
 *
 * The matcher is imported from classify.mjs rather than rewritten, for the reason that file
 * now records at its export: a premise check that disagreed with the classifier would be
 * worse than none, because it would be confidently wrong in the direction of green.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { globToRegExp } from "../classify.mjs";

/** Throw with a diagnostic that names the fixture's own premise, not a generic assertion. */
export function requirePremise(ok, message) {
  if (!ok) throw new Error(`fixture premise no longer holds: ${message}`);
}

function manifestOf(dir) {
  return JSON.parse(readFileSync(join(dir, "rungs.json"), "utf8"));
}

/**
 * The planted path must be under a FROZEN SHARED glob in this tree.
 *
 * The premise behind every "…under a frozen glob is ignored" case: the file has to be
 * somewhere the census would otherwise object to. If the glob leaves `shared.paths`, the
 * census stays silent for a completely different reason and the case still reports a pass.
 */
export function requireSharedFrozen(dir, rel, why) {
  const m = manifestOf(dir);
  const globs = m.shared?.paths ?? [];
  const hit = globs.find((g) => globToRegExp(g).test(rel));
  requirePremise(
    Boolean(hit),
    `${rel} is not under any shared.paths glob in ${dir}/rungs.json ` +
      `(shared.paths = ${globs.join(", ") || "none"}). ${why}`
  );
  return hit;
}

/** The planted path must be claimed by some rung in this tree. */
export function requireRungOwned(dir, rel, why) {
  const m = manifestOf(dir);
  for (const rung of m.rungs ?? []) {
    for (const globs of Object.values(rung.owns ?? {})) {
      for (const g of globs) {
        if (g === rel || globToRegExp(g).test(rel)) return rung.id;
      }
    }
  }
  requirePremise(
    false,
    `${rel} is owned by no rung in ${dir}/rungs.json, so it cannot stand in for a ` +
      `rung-owned file. ${why}`
  );
}

/**
 * The generalisation of the VOID guard, applied to SETUP rather than to the mutation.
 *
 * check-pr-triggers.selftest.mjs already refuses a mutation that changed nothing, on the
 * grounds that the checker is then not implicated in the result. Setup has exactly the same
 * failure and no guard: a plant that writes a file nothing classifies, a manifest edit that
 * moves no count. `before` and `after` are whatever the fixture can cheaply fingerprint —
 * a count, a file's contents, a JSON blob.
 */
export function requireSetupChanged(before, after, what) {
  requirePremise(
    before !== after,
    `${what} — the setup ran and changed nothing, so whatever the subject reports next is ` +
      `about a scenario this fixture no longer builds.`
  );
}
