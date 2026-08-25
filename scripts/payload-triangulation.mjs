#!/usr/bin/env node
/**
 * payload-triangulation.mjs — every declared `data-*` part has a PRODUCER and a CONSUMER.
 *
 * THE GAP THIS CLOSES. `data-agents-md` and `data-task` are declared in schemas.ts, have a
 * renderer, and are emitted by NOTHING in the repository. Three existing mechanisms all pass:
 *
 *   - the severability matrix: the fork BUILDS. A card with no producer is valid code.
 *   - classification: both files ARE classified, correctly.
 *   - suite arithmetic: the tests PASS — a renderer test supplies its own props.
 *
 * The card renders correctly against a payload the system cannot produce. It is dead UI or a
 * missing producer, and nothing distinguishes those two without asking a person. This is the
 * same shape as `has-rung.mjs` exiting 0 on a missing argument: a check that passes without
 * ever computing the thing you care about. Here the "check" is the renderer's own test suite.
 *
 * WHY THIS ONE IS MECHANISABLE WHEN "WHAT IS MISSING" GENERALLY IS NOT.
 * The behaviour-gate proposal says, correctly, that you cannot mechanise absence without
 * knowing what to expect. Here we DO know: `SCHEMA_MAP` in schemas.ts is an explicit
 * declaration of every part the system claims to speak. The declaration is the oracle. Absent
 * one, this check could not exist.
 *
 * WHAT WOULD HAVE TO BE TRUE FOR THIS TO PASS WHILE THE PROPERTY IS BROKEN?
 *   1. The parse finds no declared parts -> "all zero parts are produced" passes.
 *      >>> G1 asserts a plausible minimum, the device from severability.test.ts.
 *   2. The producer or consumer scan matches nothing, so everything looks orphaned... or, with
 *      an inverted test, nothing does.
 *      >>> G2 asserts both scans found a plausible minimum.
 *   3. An allowlist entry silently stops applying and rots into decoration.
 *      >>> G3: every allowlisted part must STILL be violating. A stale entry is a hard failure
 *          that says "delete me", the same property as PENDING_RECLASSIFICATION.
 *   4. A consumer is matched by a substring — `data-todo` inside `data-todo-id`.
 *      >>> Consumers are resolved through the TYPE name (`DataTodo`) taken from
 *          `export type X = z.infer<typeof YSchema>`, never by grepping the tag. An earlier
 *          prototype of this check grepped tags and produced a false negative on TodoCard,
 *          which references only `data-todo-id` and `data-todo-seq`. A check with a known
 *          false negative teaches people to distrust it.
 *
 * Usage: node scripts/payload-triangulation.mjs [--root <dir>] [--json]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const args = process.argv.slice(2);
const rootArg = args.indexOf("--root");
const ROOT = rootArg === -1 ? process.cwd() : args[rootArg + 1];
const JSON_OUT = args.includes("--json");

/**
 * Parts that are knowingly un-produced or un-consumed today.
 *
 * NOT a mute button: G3 asserts every entry is STILL violating, so the moment a producer or
 * consumer appears the entry goes stale and this check fails telling you to delete it. An
 * exception that has silently stopped applying is how a suppression list rots into a lie.
 */
const ALLOWLIST = {
  produced: {
    // Declared and rendered, emitted by nothing. Documented in #50; #50 recorded them, it did
    // not prevent a third. That is what this check is for.
    "data-agents-md": "no emitter anywhere in the repo — dead UI or a missing producer (#50)",
    "data-task": "no emitter anywhere in the repo — dead UI or a missing producer (#50)",
  },
  consumed: {
    // Rung 5 has no implementation to exercise yet; the proposal lists this as a known
    // uncoverable. Delete when rung 5 grows a renderer.
  },
};

function walk(dir) {
  let out = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".next") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out = out.concat(walk(full));
    else if (/\.(ts|tsx)$/.test(full) && !/\.test\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

const read = (p) => readFileSync(p, "utf8");

// ── 1. DECLARED: SCHEMA_MAP is the authoritative registry of parts the system speaks. ──
const schemasPath = join(ROOT, "packages/react/src/schemas.ts");
const schemasSrc = read(schemasPath);
// Anchored on the colon so it cannot prefix-match a renamed variable. The selftest's
// "unparseable SCHEMA_MAP" case was inert against `indexOf("const SCHEMA_MAP")`, because
// that matches `SCHEMA_MAP_RENAMED` at index 0 — a no-op mutation that proved nothing.
const mapStart = schemasSrc.indexOf("const SCHEMA_MAP:");
const mapBlock = mapStart === -1 ? "" : schemasSrc.slice(mapStart);
const declared = new Map(); // part -> schema identifier
for (const m of mapBlock.matchAll(/"(data-[a-z-]+)":\s*([A-Za-z0-9_]+)/g)) {
  declared.set(m[1], m[2]);
}

// schema identifier -> exported type name, from `export type X = z.infer<typeof YSchema>`
const typeOfSchema = new Map();
for (const m of schemasSrc.matchAll(
  /export type ([A-Za-z0-9_]+)\s*=\s*z\.infer<typeof ([A-Za-z0-9_]+)>/g
)) {
  typeOfSchema.set(m[2], m[1]);
}

// ── 2. PRODUCED: any non-test module under packages/server that emits the tag. ──────────
const serverFiles = walk(join(ROOT, "packages/server/src"));
const producers = new Map(); // part -> [files]
for (const f of serverFiles) {
  const src = read(f);
  for (const part of declared.keys()) {
    if (src.includes(`"${part}"`)) {
      if (!producers.has(part)) producers.set(part, []);
      producers.get(part).push(relative(ROOT, f));
    }
  }
}

// ── 3. CONSUMED: resolved through the TYPE, never the tag. See guard 4 above. ───────────
/**
 * `index.ts` re-exports every type, so counting it would give EVERY declared part a consumer
 * and make this half of the check vacuous — `data-error` scored 1 consumer that was only the
 * barrel. Barrels are legitimately aware of everything; that is exactly why they cannot be
 * evidence that anything reads a payload. Same exclusion as severability.test.ts's
 * BARREL_SURFACE, for the same reason.
 */
const BARRELS = new Set(["index.ts", "schemas.ts"]);
const reactFiles = walk(join(ROOT, "packages/react/src")).filter(
  (f) => !BARRELS.has(f.split("/").pop())
);
const consumers = new Map(); // part -> [files]
for (const [part, schemaId] of declared) {
  const typeName = typeOfSchema.get(schemaId);
  for (const f of reactFiles) {
    const src = read(f);
    // Two legitimate idioms: import the inferred TYPE, or switch on the quoted TAG. Matching
    // only the type missed tag-dispatching consumers; matching only the tag produced a false
    // negative on TodoCard, which writes `data-todo-id` but never the bare tag. The quotes
    // make the tag match exact, so no substring collision.
    const byType = typeName ? new RegExp(`\\b${typeName}\\b`).test(src) : false;
    const byTag = src.includes(`"${part}"`);
    if (byType || byTag) {
      if (!consumers.has(part)) consumers.set(part, []);
      consumers.get(part).push(relative(ROOT, f));
    }
  }
}

// ── 4. VERDICT ──────────────────────────────────────────────────────────────────────────
const failures = [];
const note = (s) => failures.push(s);

// G1/G2 — a scan that silently matched nothing makes every assertion below vacuous.
if (declared.size < 5) note(`G1 declared parts = ${declared.size}, expected >= 5 — SCHEMA_MAP parse failed`);
if (producers.size < 3) note(`G2 parts with a producer = ${producers.size}, expected >= 3 — producer scan failed`);
if (consumers.size < 3) note(`G2 parts with a consumer = ${consumers.size}, expected >= 3 — consumer scan failed`);

const unproduced = [...declared.keys()].filter((p) => !producers.has(p));
const unconsumed = [...declared.keys()].filter((p) => !consumers.has(p));

for (const p of unproduced) {
  if (!(p in ALLOWLIST.produced)) note(`DECLARED BUT NEVER PRODUCED: ${p} — nothing emits it`);
}
for (const p of unconsumed) {
  if (!(p in ALLOWLIST.consumed)) note(`DECLARED BUT NEVER CONSUMED: ${p} — no renderer or hook reads it`);
}

// G3 — anti-rot. A stale allowlist entry is a hard failure, not a silent pass.
for (const p of Object.keys(ALLOWLIST.produced)) {
  if (producers.has(p)) note(`STALE ALLOWLIST: ${p} now HAS a producer (${producers.get(p)[0]}) — delete it from ALLOWLIST.produced`);
  if (!declared.has(p)) note(`STALE ALLOWLIST: ${p} is no longer declared — delete it from ALLOWLIST.produced`);
}
for (const p of Object.keys(ALLOWLIST.consumed)) {
  if (consumers.has(p)) note(`STALE ALLOWLIST: ${p} now HAS a consumer (${consumers.get(p)[0]}) — delete it from ALLOWLIST.consumed`);
  if (!declared.has(p)) note(`STALE ALLOWLIST: ${p} is no longer declared — delete it from ALLOWLIST.consumed`);
}

if (JSON_OUT) {
  console.log(JSON.stringify({ declared: [...declared.keys()], unproduced, unconsumed, failures }, null, 2));
} else {
  console.log(`declared ${declared.size} · produced ${producers.size} · consumed ${consumers.size}`);
  for (const p of [...declared.keys()].sort()) {
    const prod = producers.get(p)?.length ?? 0;
    const cons = consumers.get(p)?.length ?? 0;
    const flag = prod === 0 || cons === 0 ? "  <-- " + (prod === 0 ? "NO PRODUCER" : "") + (cons === 0 ? " NO CONSUMER" : "") : "";
    console.log(`  ${p.padEnd(24)} producers=${prod} consumers=${cons}${flag}`);
  }
  if (failures.length) {
    console.error("\nFAIL:");
    for (const f of failures) console.error("  - " + f);
  } else {
    console.log("\nOK — every declared part has a producer and a consumer (or a live allowlist entry).");
  }
}
process.exit(failures.length ? 1 : 0);
