#!/usr/bin/env node
/**
 * THE EXAMPLE APP'S TOOL CLASSIFICATION IS TOTAL OVER THE BACKEND'S REAL TOOLS (#653).
 *
 * `apps/example` sends the Python backends a read-only allowlist, and the backend
 * gates everything absent from it. That makes the allowlist a SECOND STATEMENT of
 * a fact the backend already owns — `_common.py`'s `@tool` set — with nothing
 * asserting the two agree. Two copies of one fact is the shape this repo keeps
 * removing; deriving it at runtime is not available, because the client has to
 * send the policy BEFORE the backend tells it anything.
 *
 * SO BOTH HALVES ARE DECLARED AND THE UNION IS CHECKED. `READ_ONLY_TOOLS` is what
 * crosses the wire; `GATED_TOOLS` exists only so the classification can be proven
 * TOTAL against the inventory. With one list, a newly-added backend tool would be
 * gated by default and silently unclassified — safe, and decided by nobody. The
 * drift is invisible until a tool ships ungated or a removed one lingers.
 *
 * DRIFT IN BOTH DIRECTIONS IS CAUGHT:
 *   a tool added to _common.py and classified nowhere   -> FAIL, names it
 *   a name in the policy that no longer exists upstream -> FAIL, names it
 *   a name in BOTH lists                                -> FAIL (a classification
 *                                                          that says two things)
 *
 * IT REFUSES RATHER THAN PASSING when it cannot read a side: no `@tool` found, no
 * exports found, or the two Python planes disagreeing. An empty read is the
 * failure mode this whole file family exists to prevent — a checker that parsed
 * nothing reports the same clean union as one that parsed everything.
 */
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const PLANES = [
  "apps/django-backend/deepagents_backend/ai_backends/_common.py",
  "apps/fastapi-backend/ai_backends/_common.py",
];
export const POLICY = "apps/example/lib/approval-policy.ts";

/** `@tool`-decorated function names, in declaration order. */
export function toolsIn(pySource) {
  return [...pySource.matchAll(/@tool\s*(?:\([^)]*\))?\s*\ndef\s+(\w+)/g)].map(
    (m) => m[1]
  );
}

/** The two exported string arrays, by name. Throws if an export is unreadable. */
export function policyIn(tsSource, name) {
  const m = tsSource.match(
    new RegExp(`export const ${name}[^=]*=\\s*\\[([^\\]]*)\\]`)
  );
  if (!m)
    throw new Error(
      `${POLICY} has no readable \`export const ${name} = [...]\``
    );
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

export function check({ root = ROOT } = {}) {
  const present = PLANES.filter((p) => existsSync(join(root, p)));
  if (present.length === 0) return { skipped: "no Python plane in this tree" };

  const inventories = present.map((p) => ({
    plane: p,
    tools: toolsIn(readFileSync(join(root, p), "utf8")),
  }));
  for (const inv of inventories) {
    if (inv.tools.length === 0) {
      throw new Error(
        `${inv.plane}: found no @tool declarations. The parser reads ` +
          `"@tool\\ndef name" — if the decorator form changed, this check went blind.`
      );
    }
  }
  // The planes are held byte-identical elsewhere; disagreeing here means one of
  // them moved and this check cannot say which inventory is the subject.
  const sets = inventories.map((i) => [...i.tools].sort().join(","));
  if (new Set(sets).size > 1) {
    throw new Error(
      `the Python planes declare different @tool sets, so there is no single ` +
        `inventory to check against:\n` +
        inventories
          .map((i) => `    ${i.plane}: ${i.tools.join(", ")}`)
          .join("\n")
    );
  }
  const inventory = [...inventories[0].tools].sort();

  const ts = readFileSync(join(root, POLICY), "utf8");
  const readOnly = policyIn(ts, "READ_ONLY_TOOLS");
  const gated = policyIn(ts, "GATED_TOOLS");

  const classified = [...readOnly, ...gated];
  const unclassified = inventory.filter((t) => !classified.includes(t));
  const phantom = classified.filter((t) => !inventory.includes(t));
  const both = readOnly.filter((t) => gated.includes(t));
  return {
    skipped: null,
    inventory,
    readOnly,
    gated,
    unclassified,
    phantom,
    both,
    planes: present,
  };
}

function main() {
  let r;
  try {
    r = check();
  } catch (e) {
    console.error(`REFUSING: ${e.message}`);
    process.exit(2);
  }
  if (r.skipped) {
    console.log(
      `SKIPPED: ${r.skipped}, so there is no @tool inventory to compare the ` +
        `example app's policy against. On a full ladder this check runs.`
    );
    process.exit(0);
  }
  const problems = [];
  for (const t of r.unclassified)
    problems.push(
      `${t}: declared @tool in the backend and classified in neither list. It is ` +
        `GATED BY DEFAULT, which may be right — but nobody decided it.`
    );
  for (const t of r.phantom)
    problems.push(
      `${t}: named in ${POLICY} but no longer a backend @tool. An allowlist that ` +
        `lists tools which do not exist suggests a surface was considered when it was not.`
    );
  for (const t of r.both)
    problems.push(
      `${t}: in BOTH lists — a classification that says two things.`
    );

  if (problems.length) {
    console.error(
      `FAIL: the example app's tool classification does not match the backend:\n`
    );
    for (const p of problems) console.error(`    ${p}`);
    console.error(
      `\n  backend @tool set : ${r.inventory.join(", ")}\n` +
        `  read-only (sent)  : ${r.readOnly.join(", ")}\n` +
        `  gated (declared)  : ${r.gated.join(", ")}`
    );
    process.exit(1);
  }
  console.log(
    `PASS: all ${r.inventory.length} backend @tool(s) are classified exactly once ` +
      `(${r.inventory.join(", ")}) — read-only: ${r.readOnly.join(", ")}; ` +
      `gated: ${r.gated.join(", ")}. Checked against ${
        r.planes.length
      } plane(s).`
  );
}

/*
 * REAL PATHS ON BOTH SIDES, OR THIS SCRIPT SILENTLY DOES NOTHING.
 *
 * On macOS `/var` and `/tmp` are symlinks to `/private/...`. `process.argv[1]`
 * keeps the spelling the caller used while `import.meta.url` resolves it, so the
 * two are different strings for the same file and `main()` never runs — the
 * process exits 0 having produced no output, which reads exactly like a pass.
 * Caught by the selftest, which invokes this from a mkdtemp directory.
 */
const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return real(fileURLToPath(import.meta.url)) === real(process.argv[1]);
})();
if (invokedDirectly) main();
