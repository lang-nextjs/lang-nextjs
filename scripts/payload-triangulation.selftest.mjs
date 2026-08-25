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
  // The G1/G2 floors are DERIVED from the published schema, so the fixture must carry it.
  cpSync(join(REPO, "docs/sse-frame-schema.json"), join(root, "docs/sse-frame-schema.json"), { recursive: true });
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

// ── the case DEV9's measurement is about: a correctly PRUNED fork must PASS ───────────────
withFixture(
  "a pruned rung-1 fork (core+null parts only) PASSES — no full-ladder assumption",
  (root) => {
    // Simulate what eject will produce once it prunes declarations: only the tags that survive
    // every eject remain registered, and the rung adapters that emitted the rest are gone.
    // A constant floor of `>= 5` passed this by exactly one entry and `>= 3` by exactly zero;
    // the derived floor passes it for the right reason instead of by luck.
    const KEEP = new Set([
      "data-error", "data-approval-required", "data-human-response", // x-emitted-by: core
      "data-agents-md", "data-task",                                 // x-emitted-by: null
    ]);
    const sp = join(root, "packages/react/src/schemas.ts");
    let src = readFileSync(sp, "utf8");
    for (const tag of ["data-plan", "data-file", "data-approval", "data-sub-agent", "data-todo", "data-testing"]) {
      if (KEEP.has(tag)) continue;
      src = src.replace(new RegExp(`^\\s*"${tag}":\\s*\\w+,\\s*$`, "m"), "");
    }
    writeFileSync(sp, src);
    // Drop the rung-owned emitters, as eject does.
    for (const f of ["adapters/openSweEnrich.ts", "adapters/deepagentsEnrich.ts", "adapters/sdaEnrich.ts"]) {
      rmSync(join(root, "packages/server/src", f), { force: true });
    }
    // AND prune the published schema, which is the other half of what eject will do (#89).
    // An earlier version of this case pruned only SCHEMA_MAP, and the check correctly failed
    // with "data-testing is unregistered but still published" — a half-pruned fork IS
    // inconsistent, and the fixture was the unfaithful part, not the rule.
    const jp = join(root, "docs/sse-frame-schema.json");
    const doc = JSON.parse(readFileSync(jp, "utf8"));
    doc.oneOf = doc.oneOf.filter((e) => {
      const emitter = e["x-emitted-by"];
      return emitter === undefined || emitter === null || emitter === "core";
    });
    writeFileSync(jp, JSON.stringify(doc, null, 2));

    const prunedRegistry = !readFileSync(sp, "utf8").includes('"data-plan":');
    const prunedSchema = !readFileSync(jp, "utf8").includes('"data-plan"');
    return prunedRegistry && prunedSchema;
  },
  "pass"
);

console.log(failures ? `\n${failures} selftest case(s) FAILED` : "\nall selftest cases passed");
process.exit(failures ? 1 : 0);