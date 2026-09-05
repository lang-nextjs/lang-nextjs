#!/usr/bin/env node
/**
 * Fail if a rung's declared topologies disagree with the module that serves
 * them.
 *
 * WHY. Every (rung, runtime) pair in rungs.json carries `topologies` AND
 * `topologiesSource` — the path to the Python module whose `TOPOLOGIES` dict
 * the backend dispatches on. The manifest is the authority the UI reads:
 * apps/example and apps/open-swe both derive their Mode buttons from it, so a
 * topology declared there becomes a button a user can press.
 *
 * `topologiesSource` was already in the schema and in gen-rung-types.mjs, and
 * NOTHING read it. The field named its own source of truth and no check
 * compared them, so the manifest could promise a topology the module cannot
 * dispatch and the only symptom would be a user pressing a button and getting
 * `unknown topology` from a 400. That is the shape this repo keeps finding: a
 * declaration whose correspondence to reality is asserted and never computed.
 *
 * It is not hypothetical. Adding deep-research to `deepagents × django` was
 * one line of JSON; making it TRUE took a tool, a prompt, a graph, a dispatch
 * entry and a dependency. Nothing in CI could tell those two apart.
 *
 * WHAT THIS CHECKS. Set equality, both directions, per (rung, runtime):
 *   - declared but not in the module  -> a button that 400s
 *   - in the module but not declared  -> a capability no UI will ever offer
 *
 * WHAT IT DOES NOT CHECK, stated because a checker that overstates its subject
 * is the defect above wearing a different hat: it reads the module's TOPOLOGIES
 * dict as TEXT, not by importing it. It cannot see a key computed at runtime,
 * and it cannot tell whether the handler behind a key works. It answers "does
 * the module name this topology", which is strictly weaker than "does the
 * module serve it" — and strictly stronger than the nothing we had.
 *
 *   node scripts/check-topologies.mjs            # check
 *   node scripts/check-topologies.mjs --selftest # prove the check can fail
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Extract the keys of a module-level `TOPOLOGIES` dispatch table.
 *
 * Anchored on the line that STARTS the assignment and stopping at the first
 * line beginning with `}` — returns null when the table is absent, so the
 * caller can distinguish "no table" from "empty table"; collapsing those would
 * let a module with no dispatch table pass as one declaring nothing.
 *
 * TWO LANGUAGE PLANES, TWO SPELLINGS (#360). "the Python module whose
 * TOPOLOGIES dict…" was the whole world when this was written:
 *
 *   Python      TOPOLOGIES = {                   keys always quoted
 *   TypeScript  export const TOPOLOGIES: Record< keys quoted only when they
 *                 …multi-line type annotation…   must be — `react:` is a valid
 *               > = {                            identifier, "plan-execute" is not
 *
 * So the TS declaration matched neither the start pattern (not at column 0,
 * `export const`, a type annotation between the name and the `=`) nor the key
 * pattern (unquoted). Every node pair reported "no module-level TOPOLOGIES
 * dict" — a truthful manifest reported as claiming topologies against a file
 * that declares none.
 *
 * This is the SECOND checker with that blind spot; classify.mjs's C8 had it
 * too, with a different message and its own regexes. Two independent parsers
 * for one fact is why fixing one did not fix the other, and it is worth saying
 * out loud that the duplication is the real defect here.
 */
export function topologyKeysInSource(text) {
  const lines = text.split("\n");
  const start = lines.findIndex(
    (l) =>
      // Python: `TOPOLOGIES = {` at column 0.
      // TypeScript: `export const TOPOLOGIES` with an optional type annotation,
      // whose `= {` may land several lines later.
      /^TOPOLOGIES\s*=\s*\{/.test(l) ||
      /^(?:export\s+)?const\s+TOPOLOGIES\b/.test(l)
  );
  if (start === -1) return null;

  // Find the `{` that opens the table. For Python it is on the anchor line; for
  // TypeScript it can be after a multi-line type, so scan forward for a line
  // ENDING in `= {`. Bounded, so a malformed file cannot run to EOF silently.
  let open = -1;
  for (let i = start; i < Math.min(start + 12, lines.length); i++) {
    if (/=\s*\{\s*$/.test(lines[i])) {
      open = i;
      break;
    }
  }
  if (open === -1) return null;

  const keys = [];
  for (let i = open + 1; i < lines.length; i++) {
    if (/^\}/.test(lines[i])) return keys;
    // Quotes optional: TypeScript quotes a key only when it is not a valid
    // identifier, so `react:` and `"plan-execute":` appear in the same table.
    const m = lines[i].match(
      /^\s+(?:["']([^"']+)["']|([A-Za-z_$][\w$-]*))\s*:/
    );
    if (m) keys.push(m[1] ?? m[2]);
  }
  return null; // unterminated table — refuse rather than guess
}

function check(manifestPath = path.join(REPO, "rungs.json"), root = REPO) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const problems = [];
  let pairs = 0;

  for (const rung of manifest.rungs ?? []) {
    for (const [runtime, cfg] of Object.entries(rung.runtimes ?? {})) {
      const declared = cfg?.topologies;
      if (!declared || declared.length === 0) continue;

      const src = cfg.topologiesSource;
      if (!src) {
        problems.push(
          `${rung.id} x ${runtime}: declares [${declared.join(
            ", "
          )}] but names no topologiesSource — the claim is unfalsifiable`
        );
        continue;
      }
      const abs = path.join(root, src);
      if (!existsSync(abs)) {
        problems.push(
          `${rung.id} x ${runtime}: topologiesSource "${src}" does not exist`
        );
        continue;
      }
      const keys = topologyKeysInSource(readFileSync(abs, "utf8"));
      if (keys === null) {
        problems.push(
          `${rung.id} x ${runtime}: no module-level TOPOLOGIES dict found in ${src}`
        );
        continue;
      }
      pairs++;
      const inSource = new Set(keys);
      const missing = declared.filter((t) => !inSource.has(t));
      const extra = keys.filter((k) => !declared.includes(k));
      if (missing.length)
        problems.push(
          `${rung.id} x ${runtime}: declared but NOT in ${src}: ${missing.join(
            ", "
          )} — the UI would offer a topology the backend 400s on`
        );
      if (extra.length)
        problems.push(
          `${rung.id} x ${runtime}: in ${src} but NOT declared: ${extra.join(
            ", "
          )} — a capability no UI will offer`
        );
    }
  }
  return { problems, pairs };
}

function main() {
  const { problems, pairs } = check();
  if (problems.length) {
    console.error("check-topologies: declaration and module disagree\n");
    for (const p of problems) console.error(`  ${p}`);
    console.error(
      `\nFAIL: ${problems.length} disagreement(s) across ${pairs} checked pair(s).`
    );
    process.exit(1);
  }
  console.log(
    `check-topologies: ${pairs} (rung, runtime) pair(s) — every declared topology is named by its topologiesSource, and vice versa.`
  );
}

const invokedDirectly =
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) ===
    realpathSync(process.argv[1]);

if (invokedDirectly) main();

export { check };
