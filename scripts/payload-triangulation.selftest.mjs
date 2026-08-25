#!/usr/bin/env node
/**
 * Selftest for payload-triangulation.mjs.
 *
 * A checker that has only ever been observed passing is not evidence — it may be incapable of
 * failing. `has-rung.mjs` printing `usage:` and exiting 0 is the cautionary case: the CI guard
 * tested its output, the check never computed a verdict, and every job went green.
 *
 * So this plants each defect the checker claims to catch, in a throwaway copy of the tree, and
 * asserts a NON-ZERO exit. Every case also asserts the mutation actually landed before running
 * the checker — a mutation that silently did not apply proves nothing either, and this repo has
 * been bitten by that twice.
 */
import { cpSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const CHECKER = join(HERE, "payload-triangulation.mjs");

let failures = 0;
const ok = (name) => console.log(`  PASS  ${name}`);
const bad = (name, why) => {
  console.error(`  FAIL  ${name}\n        ${why}`);
  failures += 1;
};

/** Copy the two source trees the checker reads into a scratch root. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "payload-tri-"));
  cpSync(join(REPO, "packages/react/src"), join(root, "packages/react/src"), { recursive: true });
  cpSync(join(REPO, "packages/server/src"), join(root, "packages/server/src"), { recursive: true });
  return root;
}

function run(root) {
  try {
    execFileSync("node", [CHECKER, "--root", root], { encoding: "utf8", stdio: "pipe" });
    return { code: 0, out: "" };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

function withFixture(name, mutate, expect) {
  const root = fixture();
  try {
    const landed = mutate(root);
    if (landed === false) return bad(name, "MUTATION DID NOT APPLY — the case proves nothing");
    const { code, out } = run(root);
    if (expect === "fail" && code === 0) return bad(name, "checker exited 0; it cannot detect this");
    if (expect === "pass" && code !== 0) return bad(name, `checker exited ${code}:\n${out}`);
    ok(name);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("payload-triangulation selftest");

// ── the tree as it stands must pass, or every negative case below is meaningless ──────────
withFixture("clean tree passes", () => true, "pass");

// ── ACCEPT/REJECT 1: a THIRD orphan must be caught ────────────────────────────────────────
withFixture(
  "a newly declared part with no producer FAILS",
  (root) => {
    const p = join(root, "packages/react/src/schemas.ts");
    let s = readFileSync(p, "utf8");
    // Declare a part and give it a schema + exported type, but no emitter anywhere.
    s = s.replace(
      'const SCHEMA_MAP: Record<string, z.ZodTypeAny> = {',
      'export type DataGhost = z.infer<typeof PlanSchema>;\nconst SCHEMA_MAP: Record<string, z.ZodTypeAny> = {\n  "data-ghost": PlanSchema,'
    );
    writeFileSync(p, s);
    return readFileSync(p, "utf8").includes('"data-ghost"');
  },
  "fail"
);

// ── ACCEPT/REJECT 2: a declared part losing its only consumer must be caught ──────────────
withFixture(
  "a declared part losing its only renderer FAILS",
  (root) => {
    // Remove EVERY consumer of data-human-response, both idioms — the inferred type and the
    // quoted tag — across all non-barrel react files. An earlier version of this case renamed
    // the type in HumanResponseCard.tsx alone and the checker still passed, because index.ts
    // also referenced it. The mutation was insufficient, not the checker wrong; a partial
    // mutation is indistinguishable from a checker that cannot detect the defect.
    const dir = join(root, "packages/react/src");
    let touched = false;
    for (const name of readdirSync(dir)) {
      if (name === "index.ts" || name === "schemas.ts") continue;
      const p = join(dir, name);
      if (!statSync(p).isFile()) continue;
      const s = readFileSync(p, "utf8");
      if (!s.includes("DataHumanResponse") && !s.includes('"data-human-response"')) continue;
      writeFileSync(
        p,
        s.replace(/DataHumanResponse/g, "DataGoneAway").replace(/"data-human-response"/g, '"data-gone-away"')
      );
      touched = true;
    }
    return touched;
  },
  "fail"
);

// ── the anti-rot property: a stale allowlist entry must be a hard failure ─────────────────
withFixture(
  "a STALE allowlist entry FAILS (data-task gains a producer)",
  (root) => {
    const p = join(root, "packages/server/src/handler.ts");
    const s = readFileSync(p, "utf8");
    writeFileSync(p, s + '\nconst __planted = "data-task";\n');
    return readFileSync(p, "utf8").includes('"data-task"');
  },
  "fail"
);

// ── G1: a parse that finds nothing must not report success ────────────────────────────────
withFixture(
  "an unparseable SCHEMA_MAP FAILS rather than passing vacuously",
  (root) => {
    const p = join(root, "packages/react/src/schemas.ts");
    const s = readFileSync(p, "utf8");
    // Must defeat the ANCHOR, which is `const SCHEMA_MAP:`. Renaming to SCHEMA_MAP_RENAMED
    // was inert against the old prefix anchor `const SCHEMA_MAP` — a no-op mutation that
    // reported the checker as broken when the mutation was the broken part.
    writeFileSync(p, s.replace("const SCHEMA_MAP:", "const RENAMED_AWAY_MAP:"));
    return !readFileSync(p, "utf8").includes("const SCHEMA_MAP:");
  },
  "fail"
);

console.log(failures ? `\n${failures} selftest case(s) FAILED` : "\nall selftest cases passed");
process.exit(failures ? 1 : 0);
