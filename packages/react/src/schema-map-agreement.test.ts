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
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = path.resolve(__dirname, "../../..");

type Frame = { title?: string; "x-emitted-by"?: string | null };
const schema = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "docs/sse-frame-schema.json"), "utf8"),
) as { oneOf: Frame[] };

const declaredInSchema = new Set(
  (schema.oneOf ?? [])
    .map((f) => f.title)
    .filter((t): t is string => typeof t === "string" && t.startsWith("data-")),
);

const coreFrames = new Set(
  (schema.oneOf ?? [])
    .filter((f) => f["x-emitted-by"] === "core")
    .map((f) => f.title)
    .filter((t): t is string => typeof t === "string"),
);

// Same anchor and same entry regex as scripts/payload-triangulation.mjs, deliberately: a
// second dialect for reading this map would drift from the CI check's, and the drift would
// show up as the two disagreeing about a file they both parse.
const schemasSrc = fs.readFileSync(
  path.join(repoRoot, "packages/react/src/schemas.ts"),
  "utf8",
);
const mapStart = schemasSrc.indexOf("const SCHEMA_MAP:");
const mapBlock = schemasSrc.slice(mapStart, schemasSrc.indexOf("};", mapStart));
const declaredInMap = new Set(
  [...mapBlock.matchAll(/"(data-[a-z-]+)":\s*[A-Za-z0-9_]+/g)].map((m) => m[1]),
);

describe("protocol declarations agree across both artifacts", () => {
  it("G1 — the published schema parsed and declares data-* frames", () => {
    expect(mapStart).toBeGreaterThan(-1);
    expect(declaredInSchema.size).toBeGreaterThan(0);
  });

  it("G2 — SCHEMA_MAP parsed and registers data-* frames", () => {
    expect(declaredInMap.size).toBeGreaterThan(0);
  });

  it("G3 — every core-emitted frame is in both (survives every eject)", () => {
    // Derived, not a count: core frames are exactly the ones no eject can remove, so this
    // holds at 11 declarations and at 5. If either parse broke, coreFrames is empty and the
    // first assertion fires rather than letting the loop pass over nothing.
    expect(coreFrames.size).toBeGreaterThan(0);
    for (const t of coreFrames) {
      expect(declaredInSchema, `${t} missing from docs/sse-frame-schema.json`).toContain(t);
      expect(declaredInMap, `${t} missing from SCHEMA_MAP`).toContain(t);
    }
  });

  it("declares the same set of parts in both directions", () => {
    const onlyInSchema = [...declaredInSchema].filter((t) => !declaredInMap.has(t)).sort();
    const onlyInMap = [...declaredInMap].filter((t) => !declaredInSchema.has(t)).sort();
    expect(
      { onlyInSchema, onlyInMap },
      "a part declared in one artifact and not the other — a frame consumers can validate " +
        "but not parse, or parse but not validate",
    ).toEqual({ onlyInSchema: [], onlyInMap: [] });
  });
});
