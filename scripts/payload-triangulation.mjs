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
 *   5. A COMPONENT EXISTS AND NOTHING MOUNTS IT — and this one shipped (#422).
 *      >>> CONSUMED now means MOUNTED. See below.
 *
 * WHY "A COMPONENT EXISTS" WAS THE WRONG SUBJECT, AND THE ARGUMENT WAS ALREADY IN THIS FILE.
 *
 * This check used to compute CONSUMED by walking `packages/react/src` alone: does a component
 * reference this payload? It never asked whether any app mounts that component, and it did not
 * read `apps/` at all.
 *
 * That is why rung 5 looked finished. `data-testing` sat on ALLOWLIST.consumed as knowingly
 * un-consumed — this check put it there on its first run. #91 landed `TestingCard.tsx`, the
 * entry went stale, and G3 correctly demanded its deletion. But no app imports TestingCard.
 * Creating the component satisfied "consumed" BY CONSTRUCTION, and the instrument that should
 * have held rung 5 open is the reason it looked closed.
 *
 * The refutation was already written here, one level down, about barrels:
 *
 *     "Barrels are legitimately aware of everything; that is exactly why they cannot be
 *      evidence that anything reads a payload."
 *
 * An unmounted component is the same case one notch further out. A component nobody renders is
 * legitimately aware of its payload — that is what it is FOR — and that is exactly why it
 * cannot be evidence a user sees it. The reasoning was right and stopped one level short.
 *
 * WHAT COUNTS AS A MOUNT, in descending strength, and each is reported by NAME so that a part
 * resting on the weakest form is visible rather than averaged in:
 *
 *   registry  a card pack under `apps/*\/lib/rungs/cards/*.tsx` maps the tag to a renderer.
 *             Strongest: it is the repo's own answer to "does an app render this", it names
 *             the TAG, and it lives in a rung-owned file that `pnpm eject` deletes with the
 *             rung — so the evidence and the payload disappear together.
 *   jsx       an app file mounts `<Card …>` where that component is exported by a module that
 *             reads the payload. This is how the SHARED cards reach a user: cards/registry.tsx
 *             says in so many words that ApprovalCard, HumanResponseCard, TaskCard and
 *             AgentsMdCard are deliberately NOT in the packs, because filing them under a rung
 *             would make `eject langgraph` delete the UI for a core feature. A registry-only
 *             rule would report all four unmounted and be wrong about rungs 1-2.
 *   tag       an app file names the quoted tag in its own code. `data-error` has NO component
 *             anywhere — its only consumer is converter.ts — and reaches the user through
 *             `msg.type === "data-error"` in apps/open-swe/app/page.tsx. Weakest of the three
 *             and still real, which is why it is reported as `tag` rather than folded in.
 *
 * WHAT IS NOT EVIDENCE. Comments. `apps/example/lib/rungs/cards/registry.tsx` names
 * ApprovalCard, HumanResponseCard, TaskCard and AgentsMdCard ONLY in a comment explaining why
 * they are absent from the packs — so a name-grep would read the file that says "these are not
 * here" as proof that they are. Every app source is comment-stripped before it is searched.
 * Prose is not an invocation; the pairing gate learned the same thing about YAML.
 *
 * Usage: node scripts/payload-triangulation.mjs [--root <dir>] [--json]
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
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
    "data-agents-md":
      "no emitter anywhere in the repo — dead UI or a missing producer (#50)",
    "data-task":
      "no emitter anywhere in the repo — dead UI or a missing producer (#50)",
  },
  consumed: {
    /*
     * BACK, AND SAYING WHY — because putting it back silently is what hid rung 5 (#422).
     *
     * The history matters and is the reason this entry is worded at length. `data-testing` sat
     * here once already, as emitted-by-sdaEnrich-and-rendered-by-nothing. #91 landed
     * TestingCard.tsx; the entry went stale under the OLD rule and G3 demanded its deletion.
     * Deleting it was correct by that rule and wrong about the world: no app mounts TestingCard
     * — verified, every reference to it is packages/react/src/index.ts re-exporting it, plus
     * docs and rungs.json. The allowlist emptied, the check went green, and rung 5 read as
     * finished.
     *
     * Under the rule this file now applies, the entry is live again, and it is live for the
     * ACCURATE reason: the component exists and NOTHING MOUNTS IT. That is a different claim
     * from the original one and the fix is different too — rung 5 needs a mount, not a card.
     *
     * G3 now goes stale on a MOUNT, not on a component. So this entry cannot be cleared by
     * writing more unrendered UI; only by an app actually rendering the payload. #12 is
     * reopened for exactly that work, and this entry is its marker.
     */
    "data-testing":
      "TestingCard.tsx exists and no app mounts it — rung 5 renders nothing a user sees. " +
      "Clearing this needs a MOUNT, not another component (#12, reopened; refs #91, #422)",
  },
};

function walk(dir) {
  let out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".next")
      continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out = out.concat(walk(full));
    else if (/\.(ts|tsx)$/.test(full) && !/\.test\.tsx?$/.test(full))
      out.push(full);
  }
  return out;
}

const read = (p) => readFileSync(p, "utf8");

/**
 * Source with comments blanked out, quotes respected.
 *
 * Load-bearing, not hygiene. `apps/example/lib/rungs/cards/registry.tsx` names ApprovalCard,
 * HumanResponseCard, TaskCard and AgentsMdCard in a comment whose entire content is that those
 * cards are NOT in the packs. Searching the raw text reads the file that says "these are not
 * here" as evidence that they are. A string-aware pass is needed rather than a line regex
 * because `//` inside a string literal is not a comment.
 */
export function stripComments(src) {
  let out = "";
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") {
        out += src[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      out += " ";
      continue;
    }
    if (c === "/" && n === "/") {
      const end = src.indexOf("\n", i);
      i = end === -1 ? src.length : end;
      out += " ";
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

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

// ── 3b. MOUNTED: is a consumer of this payload reachable from an app? (#422) ────────────
/**
 * The apps are the subject this check never had. `walk()` skips node_modules/.next/dist and
 * test files, so this is app SOURCE — the code a build actually ships.
 */
const APPS_DIR = join(ROOT, "apps");
const appRoots = existsSync(APPS_DIR)
  ? readdirSync(APPS_DIR).filter((d) => statSync(join(APPS_DIR, d)).isDirectory())
  : [];
const appFiles = appRoots.flatMap((a) => walk(join(APPS_DIR, a)));
/** Comment-stripped once; every search below reads THIS, never the raw text. */
const appCode = new Map(appFiles.map((f) => [f, stripComments(read(f))]));

/** The rung card packs: `apps/<app>/lib/rungs/cards/<pack>.tsx`, excluding the two plumbing files. */
const PACK_PLUMBING = new Set(["index.tsx", "registry.tsx"]);
const packFiles = appFiles.filter((f) => {
  const rel = relative(ROOT, f).split("/");
  return (
    rel[0] === "apps" &&
    rel.slice(2, 5).join("/") === "lib/rungs/cards" &&
    rel.length === 6 &&
    !PACK_PLUMBING.has(rel[5])
  );
});

/**
 * Component exports of each consumer module, for the `jsx` evidence form.
 *
 * PascalCase only, and only `export function|const|class`. A payload's consumer may be plumbing
 * rather than UI — `data-error`'s only consumer is converter.ts, which exports
 * `partsToMessages` — and plumbing has no `<Tag>` form, which is precisely why the tag evidence
 * form exists rather than being folded in here.
 */
const componentsOf = new Map();
for (const f of reactFiles) {
  const names = new Set();
  for (const m of stripComments(read(f)).matchAll(
    /export\s+(?:default\s+)?(?:function|const|class)\s+([A-Z][A-Za-z0-9_]*)/g
  ))
    names.add(m[1]);
  componentsOf.set(f, names);
}

/** part -> [{ form, where, what }] */
const mounts = new Map();
const addMount = (part, form, where, what) => {
  if (!mounts.has(part)) mounts.set(part, []);
  mounts.get(part).push({ form, where: relative(ROOT, where), what });
};

for (const part of declared.keys()) {
  // registry — the tag is mapped to a renderer in a rung-owned card pack.
  for (const f of packFiles) {
    if (new RegExp(`"${part}"\\s*:`).test(appCode.get(f))) addMount(part, "registry", f, part);
  }
  // jsx — an app mounts a component exported by a module that reads this payload.
  const comps = new Set(
    (consumers.get(part) ?? []).flatMap((rel) => [
      ...(componentsOf.get(join(ROOT, rel)) ?? []),
    ])
  );
  for (const c of comps) {
    for (const f of appFiles) {
      if (new RegExp(`<${c}\\b`).test(appCode.get(f))) addMount(part, "jsx", f, c);
    }
  }
  // tag — an app names the quoted tag in its own code.
  for (const f of appFiles) {
    if (appCode.get(f).includes(`"${part}"`)) addMount(part, "tag", f, part);
  }
}

const formsFor = (part) => [...new Set((mounts.get(part) ?? []).map((m) => m.form))];

// ── 4. VERDICT ──────────────────────────────────────────────────────────────────────────
const failures = [];
const note = (s) => failures.push(s);

/**
 * REFUSALS — exit 2, the established code for "could not be checked".
 *
 * Distinct from a violation on purpose. Every condition here means the instrument had an EMPTY
 * SUBJECT, and an empty subject returns the verdict for it: "no unmounted payloads found"
 * computed over no payloads, or over no apps, is the vacuous green this whole file exists to
 * prevent. It is also #422's own defect stated generally — the old consumer walk never read
 * `apps/` at all and reported success about a question it never asked. A moved directory or a
 * renamed glob must stop this check, not quietly switch it off.
 */
const refusals = [];
const refuse = (s) => refusals.push(s);

if (declared.size === 0)
  refuse(
    `SCHEMA_MAP yielded ZERO declared parts — nothing was examined. "Every declared part has a ` +
      `producer and a consumer" is trivially true of no parts.`
  );
if (appFiles.length === 0)
  refuse(
    `no application sources found under ${relative(ROOT, APPS_DIR) || "apps"}/ — mounting ` +
      `cannot be computed, and "no unmounted payloads" over zero apps is not an answer.`
  );

/**
 * G1/G2 floors, DERIVED rather than constant.
 *
 * A scan that silently matched nothing makes every assertion below vacuous, so a floor is
 * needed. But a CONSTANT floor is a full-ladder assumption wearing a guard's clothing: the
 * first version of this check used `>= 5` and `>= 3`, obviously safe against the monorepo's 11
 * and 9, and coinciding EXACTLY with the true value in a pruned rung-1 fork. One core part
 * away from failing on a correct fork — and failing as "SCHEMA_MAP parse failed", which is the
 * one thing that would not have happened.
 *
 * `sse-frame-rung-attribution.test.ts` already learned this and records it: it replaced a
 * hardcoded `>= 8` tag count because "any floor tuned on the full ladder is a full-ladder
 * assumption", and moved its control anchor off a rung-4 file because "a control is still an
 * assertion, and 'the full ladder is present' is not something a fork must exhibit." This
 * check did not inherit that lesson; DEV9 measured the margin and flagged it (#89).
 *
 * The correspondence version: parts annotated `x-emitted-by: "core"` or `null` survive EVERY
 * eject, so they are the floor that holds in the monorepo and in every fork alike, and it
 * fails for the reason the guard is actually about.
 */
function derivedFloors() {
  const schemaPath = join(ROOT, "docs/sse-frame-schema.json");
  let doc;
  try {
    doc = JSON.parse(read(schemaPath));
  } catch {
    // Absent or unparseable oracle is itself a failure — not a licence to skip the guard.
    return {
      floorDeclared: null,
      floorProduced: null,
      why: `cannot read ${schemaPath}`,
    };
  }
  const attrs =
    JSON.stringify(doc).match(/"x-emitted-by":\s*(?:"([a-z-]+)"|null)/g) ?? [];
  const core = attrs.filter((a) => a.includes('"core"')).length;
  const nul = attrs.filter((a) => a.includes("null")).length;
  return { floorDeclared: core + nul, floorProduced: core, why: null };
}

/** Tags the PUBLISHED schema still claims. Distinguishes "ejected" from "stale" below. */
function publishedTags() {
  try {
    const doc = read(join(ROOT, "docs/sse-frame-schema.json"));
    return new Set([...doc.matchAll(/"(data-[a-z-]+)"/g)].map((m) => m[1]));
  } catch {
    return null;
  }
}
const published = publishedTags();

const { floorDeclared, floorProduced, why } = derivedFloors();
if (why) {
  note(`G1 floor is underivable — ${why}`);
} else {
  if (declared.size < floorDeclared)
    note(
      `G1 declared parts = ${declared.size}, expected >= ${floorDeclared} (core+null in sse-frame-schema.json) — SCHEMA_MAP parse failed`
    );
  if (producers.size < floorProduced)
    note(
      `G2 parts with a producer = ${producers.size}, expected >= ${floorProduced} (core in sse-frame-schema.json) — producer scan failed`
    );
  if (consumers.size < floorProduced)
    note(
      `G2 parts with a consumer = ${consumers.size}, expected >= ${floorProduced} — consumer scan failed`
    );
}

const unproduced = [...declared.keys()].filter((p) => !producers.has(p));
const unread = [...declared.keys()].filter((p) => !consumers.has(p));
const unmounted = [...declared.keys()].filter((p) => !mounts.has(p));

/*
 * THE MOUNT SCAN'S OWN VACUITY FLOOR, and it is the guard this change most needs.
 *
 * If the scan matches nothing, EVERY part is unmounted and the check fails loudly — but it
 * fails saying "10 payloads render nothing", which sends someone to look at the UI when the
 * truth is that the scanner stopped working. Worse, paired with a fully populated allowlist it
 * would go GREEN over a scan that examined nothing, which is exactly #422 again.
 *
 * The floor is ONE, deliberately, and not a tuned count. Any tree with apps in it mounts at
 * least one payload; a pruned rung-1 fork still renders the core parts through apps/example.
 * A larger floor would be a full-ladder assumption of the kind derivedFloors() exists to
 * refuse, and this file has already been bitten by one.
 */
if (declared.size > 0 && appFiles.length > 0 && mounts.size === 0)
  refuse(
    `the mount scan examined ${appFiles.length} app file(s) across ${appRoots.length} app(s) ` +
      `and matched NOTHING for any of ${declared.size} declared part(s). No tree with apps in ` +
      `it renders zero payloads, so this is the scanner failing, not the tree.`
  );

for (const p of unproduced) {
  if (!(p in ALLOWLIST.produced))
    note(`DECLARED BUT NEVER PRODUCED: ${p} — nothing emits it`);
}
/*
 * READ AND MOUNTED ARE TWO PROPERTIES, NOT ONE, and the first draft of #422 collapsed them.
 *
 * Replacing "never read" with "never mounted" looked like a strict improvement and was not: a
 * part can be MOUNTED WITHOUT BEING READ — an app names the tag while no schema-typed module
 * in packages/react handles it, so the payload reaches a renderer that does not understand it.
 * The pre-existing selftest case caught this within a minute of the change, which is the
 * argument for keeping cases that predate your idea about them.
 *
 * So both are asserted. A part must be read by a typed consumer AND mounted by an app.
 */
for (const p of unread) {
  if (p in ALLOWLIST.consumed) continue;
  note(
    `DECLARED BUT NEVER READ: ${p} — no schema-typed renderer or hook in packages/react ` +
      `references it${
        mounts.has(p)
          ? `, though an app names it (${formsFor(p).join("+")}) — the tag reaches a surface ` +
            `that has no typed reader for it`
          : ""
      }`
  );
}
for (const p of unmounted) {
  if (p in ALLOWLIST.consumed) continue;
  if (!consumers.has(p)) continue; // already reported as NEVER READ; one defect, one message
  /*
   * The two cases need DIFFERENT fixes, so they are not one message. "No card exists" is
   * missing UI; "a card exists and nothing mounts it" is UI that reaches no user — the second
   * is #422 itself, and reporting it as the first sends someone to write another component,
   * which is the move that closed the last one.
   */
  const readers = consumers.get(p) ?? [];
  note(
    `DECLARED BUT NEVER MOUNTED: ${p} — ${readers.join(", ")} reads it, and no app mounts it. ` +
      `A component that nothing renders is not evidence a user sees the payload; writing ` +
      `another one will not clear this.`
  );
}

// G3 — anti-rot. A stale allowlist entry is a hard failure, not a silent pass.
/**
 * "No longer declared" is only STALE if the ladder still claims the tag.
 *
 * In an ejected fork a rung's tag is correctly pruned from BOTH SCHEMA_MAP and the published
 * schema, and an allowlist entry naming it is inert, not rotten — `data-testing` is exactly
 * this after `eject langchain`. Flagging it would make a guard against rot the sole reason a
 * VALID fork went red, which is the same defect sse-frame-rung-attribution.test.ts removed
 * from its own control anchor. Absent from the registry but PRESENT in the published schema is
 * a genuine inconsistency and still fails.
 */
const stillClaimed = (p) => published === null || published.has(p);

for (const p of Object.keys(ALLOWLIST.produced)) {
  if (producers.has(p))
    note(
      `STALE ALLOWLIST: ${p} now HAS a producer (${
        producers.get(p)[0]
      }) — delete it from ALLOWLIST.produced`
    );
  if (!declared.has(p) && stillClaimed(p))
    note(
      `STALE ALLOWLIST: ${p} is unregistered but still published — delete it from ALLOWLIST.produced, or register it`
    );
}
/*
 * G3 RE-POINTED (#422). This asked `consumers.has(p)` — so the entry went stale the moment a
 * COMPONENT appeared, and writing an unmounted card was enough to clear it. That is the exact
 * sequence that emptied this allowlist and let rung 5 read as finished. It now goes stale on a
 * MOUNT, so an entry can only be cleared by an app actually rendering the payload.
 */
for (const p of Object.keys(ALLOWLIST.consumed)) {
  if (mounts.has(p))
    note(
      `STALE ALLOWLIST: ${p} now HAS a mount (${formsFor(p).join("+")} — ${
        mounts.get(p)[0].where
      }) — delete it from ALLOWLIST.consumed`
    );
  if (!declared.has(p) && stillClaimed(p))
    note(
      `STALE ALLOWLIST: ${p} is unregistered but still published — delete it from ALLOWLIST.consumed, or register it`
    );
}

/**
 * THE SUBJECT IS PART OF THE ANSWER, and it prints on SUCCESS as well as on failure.
 *
 * "PASS" is not falsifiable — it is the same string whether the scan read four trees or none,
 * which is how a check that stopped looking keeps reporting that it looked. Naming what was
 * walked and what was found lets a reader see the scan shrink. #422 was invisible partly
 * because the old success line said `declared 11 · produced 9 · consumed 11` and nothing about
 * WHERE consumed was computed, so "apps/ is not in that number" was not a readable fact.
 */
const byForm = (form) =>
  [...declared.keys()].filter((p) => formsFor(p).includes(form)).length;
const scanned =
  `scanned ${appRoots.length} app(s) + 2 package tree(s) · ` +
  `${appFiles.length} app file(s), ${packFiles.length} card pack(s), ` +
  `${reactFiles.length} react module(s), ${serverFiles.length} server module(s)`;

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      {
        declared: [...declared.keys()],
        unproduced,
        unread,
        unmounted,
        mounts: Object.fromEntries([...mounts].map(([k, v]) => [k, v])),
        scanned: {
          apps: appRoots,
          appFiles: appFiles.length,
          packFiles: packFiles.map((f) => relative(ROOT, f)),
          reactFiles: reactFiles.length,
          serverFiles: serverFiles.length,
        },
        refusals,
        failures,
      },
      null,
      2
    )
  );
} else {
  console.log(scanned);
  console.log(
    `declared ${declared.size} · produced ${producers.size} · read ${consumers.size} · mounted ${mounts.size}`
  );
  for (const p of [...declared.keys()].sort()) {
    const prod = producers.get(p)?.length ?? 0;
    const cons = consumers.get(p)?.length ?? 0;
    const forms = formsFor(p);
    const flags = [];
    if (prod === 0) flags.push("NO PRODUCER");
    if (cons === 0) flags.push("NO READER");
    if (forms.length === 0) flags.push("NO MOUNT");
    console.log(
      `  ${p.padEnd(24)} producers=${prod} readers=${cons} mount=${
        forms.join("+") || "none"
      }${flags.length ? "  <-- " + flags.join(", ") : ""}`
    );
  }
  /*
   * The forms are NOT summed into one number. They are not equal evidence: `registry` maps the
   * tag to a renderer in a file that dies with its rung, while `tag` is only an app naming the
   * string. `data-error` rests on `tag` alone because no component for it exists anywhere —
   * that is a real mount and a thin one, and a reader has to be able to see which.
   */
  console.log(
    `\nmount evidence, strongest first — not summed, because they are not equal:\n` +
      `  registry  ${byForm("registry")}  a card pack maps the tag to a renderer\n` +
      `  jsx       ${byForm("jsx")}  an app mounts a component that reads the payload\n` +
      `  tag       ${byForm("tag")}  an app names the tag in its own code (weakest)`
  );
  const allowed = Object.keys(ALLOWLIST.consumed).filter((p) => declared.has(p));
  if (allowed.length)
    console.log(
      `\nknowingly unmounted (${allowed.length}), each still unmounted or this fails:\n` +
        allowed.map((p) => `  ${p} — ${ALLOWLIST.consumed[p]}`).join("\n")
    );

  if (refusals.length) {
    console.error("\nREFUSING TO REPORT:");
    for (const r of refusals) console.error("  - " + r);
    console.error(
      "      Exit 2, not 0 — this check had an EMPTY SUBJECT, which is a different answer\n" +
        "      from \"every declared part is produced and mounted\"."
    );
  } else if (failures.length) {
    console.error("\nFAIL:");
    for (const f of failures) console.error("  - " + f);
  } else {
    console.log(
      `\nOK — ${declared.size} declared part(s): each has a producer and is mounted by an app ` +
        `(or has a live allowlist entry saying it is not).`
    );
  }
}
process.exit(refusals.length ? 2 : failures.length ? 1 : 0);
