#!/usr/bin/env node
/**
 * Proof for assert-no-manifest-rung-coupling.mjs.
 *
 * TWO LAYERS, because they answer different questions.
 *
 *   PURE      the discriminators — comment vs code, which rung is removable,
 *             whether the symbol is bound to the generated package. These are
 *             what stop the checker firing on a clean tree, and a checker that
 *             fires on a clean tree gets deleted rather than fixed.
 *   LIVE      the real repository, both ways: it passes today, and it FAILS
 *             when rungs.json is put back the way it was when #374 was found.
 *
 * The live-failing case is the one the acceptance bar asks for. It reproduces
 * the instance by removing `apps/open-swe/lib/routes.ts` from rung 4's `owns`,
 * which is exactly the state DEV3 found by hand — the file shared, the index
 * unchanged — then restores rungs.json and verifies the restore.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  stripComments,
  manifestBindings,
  couplings,
} from "./assert-no-manifest-rung-coupling.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const CHECKER = join(HERE, "assert-no-manifest-rung-coupling.mjs");
const MANIFEST = join(ROOT, "rungs.json");
const INSTANCE = "apps/open-swe/lib/routes.ts";

let failed = 0;
const rows = [];
function check(name, fn) {
  let ok = false;
  let detail = "";
  try {
    const r = fn();
    ok = r === true;
    if (!ok && typeof r === "string") detail = r;
  } catch (e) {
    detail = `raised ${String(e.message).split("\n")[0]}`;
  }
  if (!ok) failed++;
  rows.push([ok, name, detail]);
}

const REMOVABLE = ["langgraph", "deepagents", "open-swe"];
const hits = (src) =>
  couplings(
    stripComments(src),
    manifestBindings(stripComments(src)),
    REMOVABLE
  );

const IMPORT = 'import { RUNG_BY_ID } from "@deepagents-nextjs/rungs";\n';

// ── PURE: the finding ──────────────────────────────────────────────────────
check(
  "REJECT: a shared file indexing a removable rung",
  () => hits(IMPORT + 'const t = RUNG_BY_ID["open-swe"].target;').length === 1
);

check(
  "REJECT: single quotes and whitespace do not evade it",
  () => hits(IMPORT + "const t = RUNG_BY_ID [ 'deepagents' ];").length === 1
);

check(
  "REJECT: an aliased import is still tracked",
  () =>
    hits(
      'import { RUNG_BY_ID as byId } from "@deepagents-nextjs/rungs";\n' +
        'const t = byId["langgraph"];'
    ).length === 1
);

// ── PURE: the discriminators that keep it quiet on a clean tree ────────────
check(
  "ACCEPT: the id appears only in a COMMENT",
  () =>
    hits(
      IMPORT +
        '// RUNG_BY_ID["open-swe"] used to be hardcoded here\nconst t = 1;'
    ).length === 0
);

check(
  "ACCEPT: the id appears only in a BLOCK comment",
  () =>
    hits(
      IMPORT +
        '/*\n * RUNG_BY_ID["deepagents"] was the old shape.\n */\nconst t = 1;'
    ).length === 0
);

check(
  "ACCEPT: the LOWEST rung is not removable, so naming it couples nothing",
  () => hits(IMPORT + 'const t = RUNG_BY_ID["langchain"];').length === 0
);

check(
  "ACCEPT: an identically-named symbol NOT from the generated package",
  () =>
    hits(
      'import { RUNG_BY_ID } from "./local-map";\nconst t = RUNG_BY_ID["open-swe"];'
    ).length === 0
);

check(
  "ACCEPT: the rung id as a plain string, not an index",
  () => hits(IMPORT + 'const label = "open-swe";').length === 0
);

// The four ACCEPTs above are what stop the three REJECTs scoring identically to
// a checker that flags every file mentioning a rung.

// ── PURE: comment stripping keeps strings intact ──────────────────────────
check(
  "stripComments leaves string contents alone",
  () =>
    stripComments('const u = "http://x/a//b"; // trailing').trim() ===
    'const u = "http://x/a//b";'
);

// ── LIVE ──────────────────────────────────────────────────────────────────
const run = () => {
  try {
    execFileSync("node", [CHECKER, "--cwd", ROOT], {
      stdio: "pipe",
      encoding: "utf8",
    });
    return { code: 0, out: "" };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
};

check("LIVE: this repository passes today", () => {
  const r = run();
  return r.code === 0
    ? true
    : `checker rejected a clean tree:\n${r.out.slice(0, 400)}`;
});

const before = readFileSync(MANIFEST, "utf8");
let restored = false;
try {
  const m = JSON.parse(before);
  const rung = m.rungs.find((r) => r.id === "open-swe");
  const had = rung.owns.ts.includes(INSTANCE);
  check("the instance is rung-owned today, which is what fixed it", () => had);
  rung.owns.ts = rung.owns.ts.filter((g) => g !== INSTANCE);
  writeFileSync(MANIFEST, `${JSON.stringify(m, null, 2)}\n`);

  check(
    "LIVE: it FAILS on the instance as #374 found it, naming file and rung",
    () => {
      const r = run();
      if (r.code === 0)
        return "the checker passed over the very coupling it exists for";
      if (!r.out.includes(INSTANCE))
        return `did not name the file:\n${r.out.slice(0, 300)}`;
      if (!r.out.includes('RUNG_BY_ID["open-swe"]'))
        return `did not name the reference:\n${r.out.slice(0, 300)}`;
      return true;
    }
  );
} finally {
  writeFileSync(MANIFEST, before);
  restored = readFileSync(MANIFEST, "utf8") === before;
}

check("the manifest was restored byte-for-byte", () => restored);

for (const [ok, name, detail] of rows) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok && detail) console.log(`        ${detail}`);
}
if (failed) {
  console.log(`\nFAIL: ${failed}/${rows.length} case(s).`);
  process.exit(1);
}
console.log(
  `\nPASS: ${rows.length}/${rows.length}. The checker was watched failing on the real ` +
    `instance and passing on the tree that fixed it, and the discriminators that keep ` +
    `it quiet are pinned.`
);
