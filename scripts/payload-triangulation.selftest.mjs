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
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const CHECKER = join(HERE, "payload-triangulation.mjs");

let failures = 0;
let ran = 0;
const ok = (name) => console.log(`  PASS  ${name}`);
const bad = (name, why) => {
  console.error(`  FAIL  ${name}\n        ${why}`);
  failures += 1;
};

/** Build artefacts and deps are not app SOURCE; copying them would take minutes. */
const COPYABLE = (src) =>
  !/(^|\/)(node_modules|\.next|\.turbo|dist|coverage|test-results)(\/|$)/.test(src);

/**
 * Copy the trees the checker reads into a scratch root.
 *
 * `apps/` IS ONE OF THEM NOW (#422), and it did not used to be — which is the fixture wearing
 * the same blind spot as the checker. Every case below was previously judged against a tree
 * with no apps in it, so nothing here could have noticed that mounting was never asked about.
 * A fixture that omits the subject cannot fail for the reason the check exists.
 */
function fixture({ apps = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "payload-tri-"));
  cpSync(join(REPO, "packages/react/src"), join(root, "packages/react/src"), {
    recursive: true,
  });
  cpSync(join(REPO, "packages/server/src"), join(root, "packages/server/src"), {
    recursive: true,
  });
  if (apps)
    cpSync(join(REPO, "apps"), join(root, "apps"), {
      recursive: true,
      filter: COPYABLE,
    });
  // The G1/G2 floors are DERIVED from the published schema, so the fixture must carry it.
  cpSync(
    join(REPO, "docs/sse-frame-schema.json"),
    join(root, "docs/sse-frame-schema.json"),
    { recursive: true }
  );
  return root;
}

function run(root) {
  try {
    const out = execFileSync("node", [CHECKER, "--root", root], {
      encoding: "utf8",
      stdio: "pipe",
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

/** Every non-test app source in a fixture. */
function appSources(root) {
  const out = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      if (["node_modules", ".next", "dist", ".turbo"].includes(n)) continue;
      const f = join(d, n);
      if (statSync(f).isDirectory()) walk(f);
      else if (/\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f)) out.push(f);
    }
  };
  walk(join(root, "apps"));
  return out;
}

/**
 * `expect` is an EXIT CODE now, not pass/fail.
 *
 * 0 the property holds · 1 it is violated · 2 it could not be checked. Collapsing 1 and 2 into
 * "non-zero" is how a case that meant to watch a violation is satisfied by the checker
 * refusing instead — a different verdict about a different thing, wearing the same red.
 */
function withFixture(name, mutate, expect, { pattern = null, apps = true } = {}) {
  const root = fixture({ apps });
  try {
    const landed = mutate(root);
    if (landed === false)
      return bad(name, "MUTATION DID NOT APPLY — the case proves nothing");
    const { code, out } = run(root);
    if (code !== expect)
      return bad(name, `expected exit ${expect}, got ${code}:\n${out.slice(0, 900)}`);
    if (pattern && !pattern.test(out))
      return bad(name, `exit ${code} was right but the message was not:\n${out.slice(0, 900)}`);
    ok(name);
  } finally {
    ran++;
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("payload-triangulation selftest");

// ── the tree as it stands must pass, or every negative case below is meaningless ──────────
withFixture("clean tree passes", () => true, 0);

// ── ACCEPT/REJECT 1: a THIRD orphan must be caught ────────────────────────────────────────
withFixture(
  "a newly declared part with no producer FAILS",
  (root) => {
    const p = join(root, "packages/react/src/schemas.ts");
    let s = readFileSync(p, "utf8");
    // Declare a part and give it a schema + exported type, but no emitter anywhere.
    s = s.replace(
      "const SCHEMA_MAP: Record<string, z.ZodTypeAny> = {",
      'export type DataGhost = z.infer<typeof PlanSchema>;\nconst SCHEMA_MAP: Record<string, z.ZodTypeAny> = {\n  "data-ghost": PlanSchema,'
    );
    writeFileSync(p, s);
    return readFileSync(p, "utf8").includes('"data-ghost"');
  },
  1
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
      if (
        !s.includes("DataHumanResponse") &&
        !s.includes('"data-human-response"')
      )
        continue;
      writeFileSync(
        p,
        s
          .replace(/DataHumanResponse/g, "DataGoneAway")
          .replace(/"data-human-response"/g, '"data-gone-away"')
      );
      touched = true;
    }
    return touched;
  },
  1
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
  1
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
  // REFUSES (2), not fails (1): zero declared parts is an EMPTY SUBJECT, not a violation.
  // Under the old pass/fail harness this case could not tell those apart.
  2,
  { pattern: /ZERO declared parts/ }
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
      "data-error",
      "data-approval-required",
      "data-human-response", // x-emitted-by: core
      "data-agents-md",
      "data-task", // x-emitted-by: null
    ]);
    const sp = join(root, "packages/react/src/schemas.ts");
    let src = readFileSync(sp, "utf8");
    for (const tag of [
      "data-plan",
      "data-file",
      "data-approval",
      "data-sub-agent",
      "data-todo",
      "data-testing",
    ]) {
      if (KEEP.has(tag)) continue;
      src = src.replace(new RegExp(`^\\s*"${tag}":\\s*\\w+,\\s*$`, "m"), "");
    }
    writeFileSync(sp, src);
    // Drop the rung-owned emitters, as eject does.
    for (const f of [
      "adapters/openSweEnrich.ts",
      "adapters/deepagentsEnrich.ts",
      "adapters/sdaEnrich.ts",
    ]) {
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
  0
);

/* ══ MOUNTING (#422) ═════════════════════════════════════════════════════════════════════
 *
 * The defect these cases exist for: CONSUMED was computed from packages/react alone, so a
 * component that no app renders satisfied it by construction. Rung 5 shipped unrendered under
 * a green check whose whole purpose was to prevent that.
 *
 * The ACCEPT half is not decoration. A rule of "nothing is ever mounted" would satisfy every
 * REJECT case below; rungs 1-4 are genuinely mounted and the clean-tree case above is what
 * makes the rejects mean something.
 */

/** Strip every app-side reference to one part: the tag, and the components that read it. */
function unmountEverywhere(root, tag, components) {
  let touched = 0;
  for (const f of appSources(root)) {
    const src = readFileSync(f, "utf8");
    let out = src.split(`"${tag}"`).join('"data-unmounted-by-selftest"');
    for (const c of components) out = out.split(`<${c}`).join("<GoneCard");
    if (out !== src) {
      writeFileSync(f, out);
      touched++;
    }
  }
  return touched;
}

// ── REJECT: the #422 defect itself — the component survives, the mount does not ───────────
withFixture(
  "a part whose card EXISTS but no app mounts FAILS",
  (root) => unmountEverywhere(root, "data-human-response", ["HumanResponseCard"]) > 0,
  1,
  {
    pattern:
      /DECLARED BUT NEVER MOUNTED: data-human-response[\s\S]*writing\s+another one will not clear this/,
  }
);

// ── NOT EVIDENCE: prose is not an invocation ──────────────────────────────────────────────
withFixture(
  "a tag named only in a COMMENT is not a mount",
  (root) => {
    if (unmountEverywhere(root, "data-human-response", ["HumanResponseCard"]) === 0)
      return false;
    // Put the tag back, in a comment, in the file whose real reference we just removed. This
    // is the shape that exists on main: cards/registry.tsx names four shared cards ONLY in a
    // comment saying they are deliberately NOT in the packs. A raw-text scan reads the file
    // that says "these are not here" as proof that they are.
    const f = appSources(root).find((x) => x.endsWith("ConversationSurface.tsx"));
    if (!f) return false;
    writeFileSync(
      f,
      `// mounted? no: "data-human-response" and <HumanResponseCard /> appear only here\n` +
        `/* also "data-human-response" in a block comment */\n` +
        readFileSync(f, "utf8")
    );
    return readFileSync(f, "utf8").includes('"data-human-response"');
  },
  1,
  { pattern: /DECLARED BUT NEVER MOUNTED: data-human-response/ }
);

// ── ACCEPT: the regression that closed #422 the first time must not reopen it ─────────────
withFixture(
  "writing ANOTHER unmounted component does NOT clear the allowlist entry",
  (root) => {
    // Exactly what #91 did: land a card that reads the payload, mount it nowhere. Under the
    // old rule this made data-testing "consumed", the entry went stale, and G3 demanded its
    // deletion — which is how rung 5 came to look finished. It must now change nothing.
    const f = join(root, "packages/react/src/TestingCardTwo.tsx");
    writeFileSync(
      f,
      `import type { DataTesting } from "./schemas";\n` +
        `export function TestingCardTwo({ testing }: { testing: DataTesting }) {\n` +
        `  return null;\n}\n`
    );
    return readFileSync(f, "utf8").includes("DataTesting");
  },
  0,
  { pattern: /data-testing\s+producers=1 readers=2 mount=none/ }
);

// ── REJECT: the allowlist goes stale on a MOUNT, which is the re-pointed G3 ────────────────
withFixture(
  "the allowlist entry goes stale when an app MOUNTS the payload",
  (root) => {
    const f = appSources(root).find((x) =>
      x.replace(/\\/g, "/").endsWith("apps/example/lib/rungs/cards/open-swe.tsx")
    );
    if (!f) return false;
    const src = readFileSync(f, "utf8");
    writeFileSync(
      f,
      src.replace(
        'export const pack: CardPack = {',
        'export const pack: CardPack = {\n  "data-testing": (data) => <TestingCard testing={data as never} />,'
      )
    );
    return readFileSync(f, "utf8").includes('"data-testing":');
  },
  1,
  { pattern: /STALE ALLOWLIST: data-testing now HAS a mount \(registry/ }
);

// ── REFUSE: no apps at all — the subject the old checker never had ────────────────────────
withFixture(
  "NO apps/ tree REFUSES (exit 2) rather than reporting zero unmounted payloads",
  () => true,
  2,
  { apps: false, pattern: /no application sources found/ }
);

// ── REFUSE: apps present, scan matches nothing. THE GUARD FOR A MOVED DIRECTORY ───────────
withFixture(
  "a mount scan that matches NOTHING REFUSES rather than blaming the tree",
  (root) => {
    // Every app source replaced by one inert file. This is what a renamed glob or a moved
    // directory looks like from inside the checker — and reporting "11 payloads render
    // nothing" would send someone to the UI while the scanner is the broken part. It is also
    // #422 stated generally: the old walk never read apps/ and reported success regardless.
    rmSync(join(root, "apps"), { recursive: true, force: true });
    writeFileSync(join(root, "apps-tmp.txt"), "");
    rmSync(join(root, "apps-tmp.txt"));
    const dir = join(root, "apps", "ghost");
    cpSync(join(REPO, "docs/sse-frame-schema.json"), join(dir, "keep.json"), {
      recursive: true,
    });
    writeFileSync(join(dir, "inert.ts"), "export const nothing = 1;\n");
    return readFileSync(join(dir, "inert.ts"), "utf8").includes("nothing");
  },
  2,
  { pattern: /matched NOTHING for any of \d+ declared part\(s\)/ }
);

/*
 * THE HARNESS COUNTS ITSELF. A case that stops running — an early `return`, a rename, a
 * fixture that throws before the assertion — subtracts silently, and a shrinking suite reports
 * the same "all cases passed" as a whole one. This file is a proof; a proof that quietly got
 * smaller is the shape everything here exists to catch.
 */
const EXPECTED_CASES = 12;
if (ran !== EXPECTED_CASES) {
  console.error(
    `\nFAIL: ran ${ran} case(s), expected ${EXPECTED_CASES} — the harness is broken, ` +
      `whatever the cases said.`
  );
  process.exit(1);
}
console.log(
  failures
    ? `\n${failures} of ${ran} selftest case(s) FAILED`
    : `\nall ${ran} selftest cases passed. Watched: a card that exists with nothing mounting ` +
      `it REJECTED,\n      a tag named only in a comment NOT counted as a mount, another ` +
      `unmounted component NOT\n      clearing the allowlist, the entry going stale on a real ` +
      `mount, and both empty-subject\n      paths REFUSING with exit 2 rather than reporting ` +
      `zero problems.`
);
process.exit(failures ? 1 : 0);
