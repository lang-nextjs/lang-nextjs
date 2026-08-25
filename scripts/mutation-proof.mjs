/**
 * Shared harness for mutation-based proofs (the `*.selftest.mjs` family).
 *
 * ONE PROPERTY, which is the whole thing:
 *
 *   A case declares its expected verdict, and the harness holds it to that.
 *   A mutation that CANNOT have moved the verdict has proven nothing.
 *
 * Everything below is that sentence, mechanised. Extracted because DEV2's survey
 * found FOUR independently-invented implementations of it across this repo, none
 * aware of the others, disagreeing on mechanism:
 *
 *   classify.selftest         JSON.stringify before/after, compare
 *   payload-triangulation     the mutate callback RETURNS a boolean
 *   eject.selftest            plant helpers throw if they cannot plant
 *   check-langfuse-wiring     fingerprint paths+bytes before/after
 *
 * THE HARNESS MEASURES; THE CASE DOES NOT SELF-REPORT. That is the one design
 * rule worth stating, and it is why this does not copy payload-triangulation's
 * shape: its guard is `if (landed === false)`, so a case that forgets to return
 * anything yields `undefined`, which is not `false`, and is trusted as applied.
 * An opt-in guard that defaults to trusting is the failure it was written to
 * prevent. Here the fingerprint is taken by the harness, and a case cannot
 * opt out of being measured — only out of being expected to mutate.
 *
 * THE MUTATION-TO-EXECUTION GAP, and why `witness` exists. The fingerprint
 * brackets the MUTATION, so it proves the SOURCE changed. When the thing the
 * checker executes is COMPILED from that source, those are different artifacts
 * and the fingerprint is answering a question one step upstream of the one that
 * matters. The chain is: mutate .ts -> build -> run dist/*.js. If the build is
 * cached, skipped, or silently fails, the suite runs against UNMUTATED compiled
 * output and reports the opposite of the truth, with every earlier guard green.
 *
 * A mutation over an interpreted file cannot have this gap; one over compiled,
 * cached or vendored output can — and NOTHING IN A PROOF'S TEXT REVEALS WHICH
 * KIND IT IS, which is what makes it invisible to a survey. Found by i15-97 on
 * rungs/5-software-developer-agent/security-patches.test.mjs, which imports
 * `packages/shared/dist/crypto.js` — untracked, built on demand, with nothing
 * asserting the build reproduced the mutation. Their caveat is the right one and
 * is preserved here: that is an EXPOSED gap, not a known false result.
 *
 * Re-fingerprinting after the build does not work — a build moves dist/ for
 * reasons unrelated to the mutation, so it would pass on any rebuild. The
 * property is narrower and mutation-specific: THE EXECUTED ARTIFACT MUST CONTAIN
 * THE MUTATION. Only the case knows what that looks like, so the case declares
 * it and the harness enforces both halves — false before, true after.
 *
 * WHY THE BASELINE MATTERS AS MUCH AS THE MUTATION. A reject-case proves the
 * mutation caused the rejection only if the UNMUTATED fixture was accepted. If
 * the baseline already fails — a broken fixture, a checker firing on something
 * unrelated — then every reject-case goes green for a reason that has nothing to
 * do with what it claims to test, and the suite reports a wall of passes over a
 * checker nobody exercised. The baseline is asserted once, up front, and a
 * failing baseline voids the run rather than decorating it.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Fingerprint of a directory tree: every path AND every byte, so a deletion
 * moves it as surely as an edit does. Sorted, so ordering is not a variable.
 */
export function fingerprint(dir) {
  const h = createHash("sha256");
  const walk = (d, rel = "") => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      const path = rel ? `${rel}/${name}` : name;
      if (statSync(full).isDirectory()) walk(full, path);
      else {
        h.update(path);
        h.update(readFileSync(full));
      }
    }
  };
  walk(dir);
  return h.digest("hex");
}

/**
 * Witness helper for the common case: does a built artifact contain a marker?
 *
 * A MISSING FILE RETURNS FALSE, not an error. That is correct on both sides of
 * the contract: before the build the artifact legitimately does not exist yet
 * (untracked dist/), and after the build a missing artifact means the build did
 * not produce it — which is exactly the failure the witness is there to catch.
 */
export function artifactContains(dir, relPath, pattern) {
  let text;
  try {
    text = readFileSync(join(dir, relPath), "utf8");
  } catch {
    return false;
  }
  return typeof pattern === "string" ? text.includes(pattern) : pattern.test(text);
}

/**
 * @param makeFixture () => string    fresh sandbox dir, caller owns its contents
 * @param verdict     (dir) => bool   TRUE means the checker REJECTED the tree
 */
export function createProofRunner({ makeFixture, verdict }) {
  if (typeof makeFixture !== "function" || typeof verdict !== "function") {
    throw new Error("createProofRunner needs { makeFixture, verdict } functions");
  }

  const results = { ok: 0, failed: 0, void: 0, unproven: 0, total: 0 };
  const lines = [];
  let baselineChecked = false;

  function checkBaseline() {
    const dir = makeFixture();
    try {
      if (verdict(dir)) {
        lines.push(
          "  BASELINE REJECTED — the unmutated fixture already fails. Every " +
            "reject-case below would pass for a reason unrelated to its mutation."
        );
        results.failed++;
        return false;
      }
      lines.push("  ok   baseline: the unmutated fixture is accepted");
      results.ok++;
      return true;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  return {
    /**
     * @param want    "reject" | "accept"
     * @param label   human description
     * @param mutate  (dir) => void   the harness measures; return value ignored
     * @param opts    { mutates?: boolean, witness?: (dir) => boolean }
     *
     * `witness` is for proofs whose checker EXECUTES a built artifact rather than
     * the file the mutation edited. It must be FALSE before the mutation (or it
     * cannot discriminate) and TRUE after `verdict` has run (which is what does
     * the building). Absent, behaviour is exactly as before — interpreted proofs
     * are untouched.
     */
    expect(want, label, mutate, opts = {}) {
      if (want !== "reject" && want !== "accept") {
        throw new Error(`expect(): want must be "reject" or "accept", got ${want}`);
      }
      if (!baselineChecked) {
        baselineChecked = true;
        results.total++;
        if (!checkBaseline()) return;
      }

      results.total++;
      const dir = makeFixture();
      try {
        const { witness } = opts;
        if (witness && witness(dir)) {
          // A witness already true cannot be evidence that the mutation arrived.
          results.void++;
          lines.push(
            `  VOID ${label.padEnd(56)} witness was already TRUE before the mutation — it cannot discriminate`
          );
          return;
        }

        const before = fingerprint(dir);
        mutate(dir);
        const after = fingerprint(dir);
        const shouldMutate = opts.mutates ?? true;
        const moved = before !== after;

        if (shouldMutate && !moved) {
          // The mutation is inert. This is NOT evidence about the checker, and
          // saying so is the point: classify.selftest announced MUTATION SURVIVED
          // and accused a checker that was working perfectly.
          results.void++;
          lines.push(
            `  VOID ${label.padEnd(56)} mutation changed NOTHING — proof missing, checker not implicated`
          );
          return;
        }
        if (!shouldMutate && moved) {
          results.void++;
          lines.push(
            `  VOID ${label.padEnd(56)} declared { mutates: false } but the tree changed`
          );
          return;
        }

        // verdict() is what builds and runs, so the artifact only exists after it.
        const rejected = verdict(dir);

        if (witness && !witness(dir)) {
          // The source moved, the checker ran, and the executed artifact never
          // received the mutation — a cached, skipped or failed build. The
          // verdict is meaningless either way, so this is checked BEFORE it.
          results.void++;
          lines.push(
            `  VOID ${label.padEnd(56)} mutation never reached the EXECUTED artifact (stale/cached build?)`
          );
          return;
        }

        const pass = rejected === (want === "reject");

        if (pass && want === "accept" && moved) {
          // DEV2's open region, made VISIBLE rather than guarded. A mutation
          // expected NOT to flip the verdict has no flip to serve as evidence
          // that it exercised anything. There is no demonstrated failure here —
          // nobody has an example of one rotting — so this counts and prints,
          // and does not fail the suite. A guard nobody needed would be worse
          // than a documented gap.
          results.unproven++;
          results.ok++;
          lines.push(
            `  ok?  ${label.padEnd(56)} accepted — but no verdict flip, so the mutation is unproven`
          );
          return;
        }

        if (pass) {
          results.ok++;
          lines.push(`  ok   ${label.padEnd(56)} ${rejected ? "rejected" : "accepted"}`);
        } else {
          results.failed++;
          lines.push(
            `  FAIL ${label.padEnd(56)} ${rejected ? "rejected" : "accepted"}, wanted ${want}ed`
          );
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },

    /** Print and return an exit code. VOID fails: a missing proof is not a pass. */
    report(name = "proof") {
      for (const l of lines) console.log(l);
      console.log();
      if (results.failed || results.void) {
        if (results.void) {
          console.log(
            `FAIL: ${results.void} mutation(s) changed nothing — those proofs are VOID.`
          );
          console.log(
            "      Re-anchor them. A checker is not implicated by a mutation that never happened."
          );
        }
        if (results.failed) console.log(`FAIL: ${results.failed} case(s) did not match their expected verdict.`);
        return 1;
      }
      const tail = results.unproven
        ? ` (${results.unproven} accepted-without-a-flip, unproven by construction)`
        : "";
      console.log(`PASS: ${results.ok}/${results.total} — ${name} held to its declared verdicts${tail}.`);
      return 0;
    },

    results,
  };
}
