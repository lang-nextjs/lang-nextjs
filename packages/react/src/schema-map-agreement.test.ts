/**
 * SCHEMA_MAP and docs/sse-frame-schema.json must declare THE SAME SET OF PARTS.
 *
 * WHY THIS EXISTS. `pnpm eject` prunes both artifacts when a rung is dropped (#89), keyed on
 * `x-emitted-by`. Of the two, only the JSON has a downstream verifier —
 * packages/server/src/sse-frame-rung-attribution.test.ts derives attribution from rungs.json
 * and survives every eject. SCHEMA_MAP has none: it is typed `Record<string, z.ZodTypeAny>`,
 * so tsc sees a smaller record and shrugs, and every test still passes. **Half the pruning was
 * checked and half was not, and the unchecked half is the half that fails silently.**
 *
 * An AGREEMENT PROPERTY closes that without testing the pruner harder. It catches a
 * mis-prune from either direction and in either artifact, including cases nobody predicted,
 * and it says the same thing on main as in a fork — so it is a property rather than a
 * fork-specific patch.
 *
 * IT ALSO CLOSES THE ORPHAN TRAP STRUCTURALLY. `data-task` and `data-agents-md` have
 * `x-emitted-by: null` and are retained deliberately (#50): a consumer's own backend may emit
 * that shape. Pruning by "no producer in the retain set" would delete exactly those two. With
 * this property, dropping one from either artifact fails on the spot — correctness no longer
 * depends on the pruner being right about which entries to spare.
 *
 * WHAT WOULD MAKE THIS PASS WHILE THE PROPERTY IS BROKEN?
 *   Both parses returning nothing: two empty sets compare equal. G1/G2 assert each side found
 *   something, and G3 asserts the CORE-attributed frames — the ones that survive every eject —
 *   appear in both. G3 is a correspondence rather than a count, so it means the same thing in
 *   the monorepo and in a one-rung fork. A count floor would be right here and wrong there.
 */
import { describe, it, expect } from "vitest";
import { SCHEMA_MAP } from "./schemas";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = path.resolve(__dirname, "../../..");

type Frame = { title?: string; "x-emitted-by"?: string | null };
const schema = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "docs/sse-frame-schema.json"), "utf8")
) as { oneOf: Frame[] };

const declaredInSchema = new Set(
  (schema.oneOf ?? [])
    .map((f) => f.title)
    .filter((t): t is string => typeof t === "string" && t.startsWith("data-"))
);

const coreFrames = new Set(
  (schema.oneOf ?? [])
    .filter((f) => f["x-emitted-by"] === "core")
    .map((f) => f.title)
    .filter((t): t is string => typeof t === "string")
);

// Same anchor and same entry regex as scripts/payload-triangulation.mjs, deliberately: a
// second dialect for reading this map would drift from the CI check's, and the drift would
// show up as the two disagreeing about a file they both parse.
const schemasSrc = fs.readFileSync(
  path.join(repoRoot, "packages/react/src/schemas.ts"),
  "utf8"
);
const mapStart = schemasSrc.indexOf("const SCHEMA_MAP:");
const mapBlock = schemasSrc.slice(mapStart, schemasSrc.indexOf("};", mapStart));
const declaredInMap = new Set(
  [...mapBlock.matchAll(/"(data-[a-z-]+)":\s*[A-Za-z0-9_]+/g)].map((m) => m[1])
);

/*
 * ── G4: THE AGREEMENT IS ALSO ABOUT FIELDS, NOT ONLY ABOUT PARTS (#951) ─────────────────
 *
 * G1-G3 compare the SET OF FRAME TYPES the two artifacts declare. They were green while
 * `data-approval-required` declared `toolCallId`, `toolName` and `input` in the document
 * and none of the three existed on the reader — because a type-set comparison is one level
 * coarser than where that defect lives, and NOTHING ABOUT A GREEN SAYS AT WHAT GRANULARITY
 * IT LOOKED.
 *
 * THE PROPERTY IS A SUBSET, NOT AN EQUALITY, and that is a measurement rather than a
 * softening. Of 21 declared variants, EIGHTEEN declare no `data` properties at all: the
 * document is silent about payload shape almost everywhere. An equality would report those
 * eighteen silences as divergences and need an exception list the size of the contract,
 * which is a snapshot wearing a property's clothes. What is assertable is the direction
 * that can actually be wrong: A FIELD THE DOCUMENT DECLARES MUST BE ONE THE READER KNOWS.
 * The reverse — a reader field the document omits — is the document being incomplete, which
 * is true of eighteen variants today and is #944's separate question.
 *
 * WHAT THIS CANNOT SEE, and it is the reason this is the cheap half rather than the whole
 * answer: it compares the document to THE CLIENT, not to the EMITTER. If a frame's document
 * entry and this map were both wrong in the same direction, they would agree and this would
 * pass. Closing that needs a document-to-emitter conformance test, which needs generated
 * instances, and a generator wrong in the permissive direction rebuilds #951's own defect
 * one layer up — so it belongs in its own change with its own control.
 */
const KNOWN_DOC_ONLY_FIELDS: Record<string, { fields: string[]; why: string }> =
  {
    "data-approval-required": {
      fields: ["input", "toolCallId", "toolName"],
      why:
        "#944: the document declares these three as REQUIRED and approval-gating.ts emits " +
        "none of them — it emits actionName/arguments/createdAt/description/seq/status " +
        "alongside id and expiresAt, which is what this reader expects. They are real " +
        "fields of `tool-input-start`, which approval-gating.ts reads at :584-586, so the " +
        "likeliest history is a copy from the wrong frame. Whether the fix is to correct " +
        "the document turns on whether anything outside this repo reads it, which is open.",
    },
  };

describe("protocol declarations agree across both artifacts", () => {
  it("G1 — the published schema parsed and declares data-* frames", () => {
    expect(mapStart).toBeGreaterThan(-1);
    expect(declaredInSchema.size).toBeGreaterThan(0);
  });

  it("G2 — SCHEMA_MAP parsed and registers data-* frames", () => {
    expect(declaredInMap.size).toBeGreaterThan(0);
  });

  it("G4 — a field the document declares is a field this reader knows", () => {
    const docFields = new Map<string, string[]>();
    for (const f of (schema.oneOf ?? []) as any[]) {
      const t = f?.properties?.type?.const;
      if (typeof t !== "string") continue;
      const props = f?.properties?.data?.properties;
      if (props && Object.keys(props).length)
        docFields.set(t, Object.keys(props));
    }

    /*
     * VACUITY GUARD. If the document ever stops declaring `data` properties anywhere, every
     * subset below holds over nothing and this passes having compared no field at all —
     * which is the failure this whole file exists to make impossible one level down.
     */
    expect(docFields.size).toBeGreaterThan(0);

    const unexplained: string[] = [];
    const staleExceptions: string[] = [];
    for (const [type, declared] of docFields) {
      const sch = SCHEMA_MAP[type] as
        | { shape?: Record<string, unknown> }
        | undefined;
      // A union (data-testing) has no single shape; it is out of this property's reach and
      // says so here rather than being silently skipped.
      if (!sch?.shape) continue;
      const known = new Set(Object.keys(sch.shape));
      const missing = declared.filter((k) => !known.has(k));
      const allowed = KNOWN_DOC_ONLY_FIELDS[type]?.fields ?? [];
      for (const k of missing)
        if (!allowed.includes(k)) unexplained.push(`${type}.${k}`);
      // A recorded exception that no longer applies is a claim about a defect that is fixed;
      // it must be deleted, not left to describe a tree that has moved on.
      for (const k of allowed)
        if (known.has(k)) staleExceptions.push(`${type}.${k}`);
    }

    expect(
      unexplained,
      "the document declares fields this reader does not know; either the document is " +
        "wrong or the reader is missing a field"
    ).toEqual([]);
    expect(
      staleExceptions,
      "KNOWN_DOC_ONLY_FIELDS names fields the reader now knows — delete those entries"
    ).toEqual([]);
  });

  it("G3 — every core-emitted frame is in both (survives every eject)", () => {
    // Derived, not a count: core frames are exactly the ones no eject can remove, so this
    // holds at 11 declarations and at 5. If either parse broke, coreFrames is empty and the
    // first assertion fires rather than letting the loop pass over nothing.
    expect(coreFrames.size).toBeGreaterThan(0);
    for (const t of coreFrames) {
      expect(
        declaredInSchema,
        `${t} missing from docs/sse-frame-schema.json`
      ).toContain(t);
      expect(declaredInMap, `${t} missing from SCHEMA_MAP`).toContain(t);
    }
  });

  it("declares the same set of parts in both directions", () => {
    const onlyInSchema = [...declaredInSchema]
      .filter((t) => !declaredInMap.has(t))
      .sort();
    const onlyInMap = [...declaredInMap]
      .filter((t) => !declaredInSchema.has(t))
      .sort();
    expect(
      { onlyInSchema, onlyInMap },
      "a part declared in one artifact and not the other — a frame consumers can validate " +
        "but not parse, or parse but not validate"
    ).toEqual({ onlyInSchema: [], onlyInMap: [] });
  });
});
