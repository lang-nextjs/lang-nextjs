/**
 * Cross-package parity suite for the DELIBERATELY duplicated SseFrameAccumulator.
 *
 * ---------------------------------------------------------------------------
 * WHY THE DUPLICATION EXISTS (do not "fix" it)
 * ---------------------------------------------------------------------------
 * `SseFrameAccumulator` is copied into four packages on purpose:
 *
 *   packages/edge/src/accumulator.ts        (no framework peerDeps at all)
 *   packages/remix/src/accumulator.ts       (peerDep: @remix-run/*)
 *   packages/server/src/accumulator.ts      (peerDep: next)
 *   packages/sveltekit/src/accumulator.ts   (peerDep: @sveltejs/kit)
 *
 * Extracting a shared module would make edge/remix/sveltekit depend on a
 * package that carries the `next` peerDep, defeating the severability the
 * charter treats as load-bearing. The copies are the design, not the debt.
 *
 * This suite therefore does NOT deduplicate. It makes the duplication
 * SELF-POLICING: the copies are free to diverge where a package's constraints
 * justify it, and fail loudly where they diverge on behaviour.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE LIVES IN test-utils
 * ---------------------------------------------------------------------------
 * The four accumulator modules have ZERO import statements — they are
 * dependency-free leaves. Importing them by *relative source path* therefore
 * creates no package.json dependency edge and cannot transit `next`,
 * `@remix-run/*` or `@sveltejs/kit` into anything. The severability property
 * the duplication protects is untouched by this file.
 *
 * test-utils is the workspace's dev-only shared-testing package: `private:
 * true`, ships only `dist/` (this file is never published), and already runs
 * under `turbo test` via its own `vitest run` script — so the suite is wired
 * into CI with no new plumbing. A root-level home would need a fresh vitest
 * install and a root `test` script that collides with `test: turbo test`.
 *
 * ---------------------------------------------------------------------------
 * WHAT EACH ASSERTION IS FOR — and why it is not a proxy
 * ---------------------------------------------------------------------------
 * For every assertion the question asked was: "what would have to be true for
 * this to pass while the property is still violated?" Where that question had
 * an answer, the assertion was strengthened or another was added.
 *
 *   CENSUS      — the copies exist, and exactly these copies exist.
 *                 Guards the failure mode where a check passes because the
 *                 thing it guards was DELETED. Grounded in readdir/readFile,
 *                 which throw on absence rather than reporting "clean".
 *
 *   ARITY       — every differential below asserts it is comparing 4 impls.
 *                 Without this, a loop over an empty registry is vacuously
 *                 green: "all zero copies agree" is exactly as broken as a
 *                 check that cannot fail.
 *
 *   BEHAVIOUR   — a scripted corpus (the union of all four packages' local
 *                 suites) driven identically through all four imported
 *                 implementations, compared to EACH OTHER rather than to a
 *                 golden list. Pairwise-differential is the right relation:
 *                 a coordinated change to all four copies is the legitimate
 *                 case and should stay green; one copy moving alone is the
 *                 violation and goes red.
 *
 *   FUZZ        — a fixed corpus alone IS a proxy: the copies could differ on
 *                 an input nobody listed. Randomised differential closes that
 *                 by removing the adversary's ability to drift in a direction
 *                 the corpus happens not to look.
 *
 *   SURFACE     — TypeScript types are ERASED at runtime, so no behavioural
 *                 assertion can see that `SseMultiTransform` exists only in
 *                 server, nor catch a signature change to a shared export.
 *                 The surface check compares declarations textually against a
 *                 written ledger of justified divergence.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import * as edge from "../../edge/src/accumulator";
import * as remix from "../../remix/src/accumulator";
import * as server from "../../server/src/accumulator";
import * as sveltekit from "../../sveltekit/src/accumulator";

/** Absolute path to the workspace `packages/` directory. */
const PACKAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The packages that MUST each carry a copy. Adding or removing a copy is a
 * deliberate architectural act and must be a deliberate edit to this list.
 */
const EXPECTED_COPIES = ["edge", "remix", "server", "sveltekit"] as const;
type CopyName = (typeof EXPECTED_COPIES)[number];

/**
 * Read one copy's source, failing with an explanation rather than a bare
 * ENOENT. Deleting a copy must produce a message that says WHAT was deleted
 * and which invariant it broke — not a stack trace a reader has to decode.
 */
function readCopy(pkg: string): string {
  const path = join(PACKAGES_DIR, pkg, "src", "accumulator.ts");
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `packages/${pkg}/src/accumulator.ts is MISSING.\n` +
        `The SseFrameAccumulator duplication is deliberate (see the header of this file): ` +
        `exactly these packages must each carry a copy — ${EXPECTED_COPIES.join(", ")}.\n` +
        `If removing a copy is intentional, update EXPECTED_COPIES, the imports, and IMPLS ` +
        `in this file in the same change, so the parity guarantee shrinks deliberately ` +
        `rather than silently.`
    );
  }
}

/**
 * Shape of one accumulator module, as every copy must expose it.
 */
interface AccumulatorModule {
  MAX_FRAME_BYTES: number;
  isFrameOversized(frame: string): boolean;
  SseFrameAccumulator: new () => {
    push(chunk: string): string[];
    flush(): string[];
  };
}

const IMPLS: ReadonlyArray<readonly [CopyName, AccumulatorModule]> = [
  ["edge", edge as unknown as AccumulatorModule],
  ["remix", remix as unknown as AccumulatorModule],
  ["server", server as unknown as AccumulatorModule],
  ["sveltekit", sveltekit as unknown as AccumulatorModule],
];

/**
 * Guard against the vacuous-truth failure mode.
 *
 * Every differential in this file loops over IMPLS. A loop over an empty (or
 * short) array passes without comparing anything — the same shape as a check
 * that silently succeeds once its subject is gone. Calling this first makes
 * "nothing was compared" a FAILURE rather than a pass.
 */
function assertFullRegistry(): void {
  expect(
    IMPLS.map(([name]) => name),
    "the differential must compare every expected copy — a short registry would make the comparison vacuously true"
  ).toEqual([...EXPECTED_COPIES]);
  for (const [name, mod] of IMPLS) {
    expect(mod?.SseFrameAccumulator, `${name} must export SseFrameAccumulator`).toBeTypeOf(
      "function"
    );
  }
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

type Op = { push: string } | { flush: true };

/**
 * Run one scripted sequence of ops through one implementation and record the
 * FULL observable output — every push return and every flush return, in order.
 * Anything the accumulator does that a caller can see ends up in this trace.
 */
function trace(mod: AccumulatorModule, ops: readonly Op[]): string[][] {
  const acc = new mod.SseFrameAccumulator();
  const out: string[][] = [];
  for (const op of ops) {
    out.push("flush" in op ? acc.flush() : acc.push(op.push));
  }
  return out;
}

/**
 * Trace every implementation over the same ops and return them keyed by copy.
 */
function traceAll(ops: readonly Op[]): Array<[CopyName, string[][]]> {
  return IMPLS.map(([name, mod]) => [name, trace(mod, ops)]);
}

const MAX = edge.MAX_FRAME_BYTES;

// ---------------------------------------------------------------------------
// CENSUS — the copies exist, and exactly these copies exist
// ---------------------------------------------------------------------------

describe("accumulator duplication — census", () => {
  it("exactly the expected packages carry a copy (a deleted copy fails here, it does not silently pass)", () => {
    // Discovered from the filesystem, NOT from a hardcoded path list, so a new
    // unregistered copy in a fifth package is caught too. readdirSync throws
    // if packages/ is gone — absence surfaces as an error, never as "clean".
    const discovered = readdirSync(PACKAGES_DIR)
      .filter((pkg) => {
        const candidate = join(PACKAGES_DIR, pkg, "src", "accumulator.ts");
        try {
          return statSync(candidate).isFile();
        } catch {
          return false;
        }
      })
      .sort();

    expect(discovered).toEqual([...EXPECTED_COPIES]);
  });

  it("every expected copy is readable and non-empty", () => {
    for (const pkg of EXPECTED_COPIES) {
      // readFileSync throws on a missing file. This is deliberate: the check
      // must not have a code path where a vanished copy yields a pass.
      const src = readCopy(pkg);
      expect(src.length, `${pkg}/src/accumulator.ts is empty`).toBeGreaterThan(0);
      expect(src, `${pkg} must define SseFrameAccumulator`).toContain(
        "export class SseFrameAccumulator"
      );
    }
  });
});

// ---------------------------------------------------------------------------
// CONSTANT PARITY
// ---------------------------------------------------------------------------

describe("accumulator duplication — shared constants", () => {
  it("all copies agree on MAX_FRAME_BYTES", () => {
    assertFullRegistry();
    // Called out separately from the behavioural corpus because this is the
    // single most tempting value to "tune per runtime" (Workers memory limits,
    // Deno isolates). A corpus that never builds a MAX-sized frame would not
    // notice, so the invariant is named directly.
    const values = IMPLS.map(([name, mod]) => [name, mod.MAX_FRAME_BYTES] as const);
    for (const [name, value] of values) {
      expect(value, `${name} disagrees on MAX_FRAME_BYTES`).toBe(MAX);
    }
  });
});

// ---------------------------------------------------------------------------
// BEHAVIOURAL DIFFERENTIAL — scripted corpus
// ---------------------------------------------------------------------------

/**
 * The union of every scenario asserted by the four packages' own accumulator
 * suites (server: 21 tests, edge: 16, sveltekit: 3, remix: 1), plus the
 * boundary cases only one of them covered. Each copy is now held to the whole
 * union regardless of how thin its local suite is.
 */
const CORPUS: ReadonlyArray<{ name: string; ops: Op[] }> = [
  { name: "two complete frames in one chunk", ops: [{ push: "a\n\nb\n\n" }] },
  { name: "incomplete trailing frame stays buffered", ops: [{ push: "a\n\nb" }] },
  {
    name: "frame split across two chunks (TCP split)",
    ops: [{ push: "data: hel" }, { push: "lo\n\n" }],
  },
  {
    name: "boundary straddles the chunk edge (\\n | \\n)",
    ops: [{ push: "a\n" }, { push: "\nb\n\n" }],
  },
  {
    name: "CRLF boundary straddles the chunk edge (\\r | \\n\\r\\n)",
    ops: [{ push: "a\r" }, { push: "\n\r\nb\r\n\r\n" }],
  },
  {
    name: "three sequential partials assemble into one frame",
    ops: [{ push: "da" }, { push: "ta: x" }, { push: "yz\n\n" }],
  },
  { name: "flush returns remaining and clears", ops: [{ push: "tail" }, { flush: true }, { flush: true }] },
  { name: "flush on a fresh accumulator", ops: [{ flush: true }] },
  {
    name: "flush after a complete push emits no phantom frame",
    ops: [{ push: "a\n\n" }, { flush: true }],
  },
  { name: "whitespace-only buffer flushes as a fragment", ops: [{ push: "\n" }, { flush: true }] },
  { name: "two consecutive boundaries yield two empty frames", ops: [{ push: "\n\n\n\n" }] },
  { name: "empty push does not corrupt a pending partial", ops: [{ push: "par" }, { push: "" }, { push: "tial\n\n" }] },
  { name: "CRLFCRLF terminated frame", ops: [{ push: "data: x\r\n\r\n" }] },
  { name: "bare CR terminated frame", ops: [{ push: "data: x\r\rnext" }] },
  { name: "mixed LF and CRLF in one chunk", ops: [{ push: "a\n\nb\r\n\r\nc\n\n" }] },
  {
    name: "many tiny frames in one chunk preserve order",
    ops: [{ push: Array.from({ length: 1000 }, (_, i) => `f${i}`).join("\n\n") + "\n\n" }],
  },
  // --- MAX_FRAME_BYTES boundary: the highest-risk drift surface ---
  { name: "frame at exactly MAX is kept", ops: [{ push: "x".repeat(MAX) + "\n\n" }] },
  { name: "complete frame at MAX+1 is dropped", ops: [{ push: "x".repeat(MAX + 1) + "\n\n" }] },
  {
    name: "a preceding valid frame survives an oversized COMPLETE frame",
    ops: [{ push: "ok\n\n" + "x".repeat(MAX + 1) + "\n\ntail\n\n" }],
  },
  {
    name: "a preceding valid frame survives an oversized trailing PARTIAL",
    ops: [{ push: "ok\n\n" + "x".repeat(MAX + 1) }],
  },
  {
    name: "oversized incomplete buffer is discarded, later frames still parse",
    ops: [{ push: "x".repeat(MAX + 1) }, { push: "\n\ngood\n\n" }],
  },
  {
    name: "exactly-MAX incomplete buffer is retained across pushes",
    ops: [{ push: "x".repeat(MAX) }, { push: "\n\n" }],
  },
  { name: "multibyte content round-trips", ops: [{ push: "data: héllo — 世界 🌍\n\n" }] },
];

describe("accumulator duplication — behavioural differential (scripted)", () => {
  it.each(CORPUS.map((c) => [c.name, c.ops] as const))(
    "all four copies agree: %s",
    (_name, ops) => {
      assertFullRegistry();
      const traces = traceAll(ops);
      const [refName, refTrace] = traces[0]!;
      for (const [name, got] of traces.slice(1)) {
        expect(
          got,
          `${name}/src/accumulator.ts behaves differently from ${refName}/src/accumulator.ts`
        ).toEqual(refTrace);
      }
    }
  );

  it("all four copies agree on isFrameOversized at every boundary", () => {
    assertFullRegistry();
    const inputs = ["", "x", "x".repeat(MAX - 1), "x".repeat(MAX), "x".repeat(MAX + 1), "🌍".repeat(10)];
    for (const input of inputs) {
      const results = IMPLS.map(([name, mod]) => [name, mod.isFrameOversized(input)] as const);
      for (const [name, got] of results) {
        // Strict boolean, not just truthy — a copy returning `undefined` or a
        // number would otherwise slip through a loose comparison.
        expect(typeof got, `${name}.isFrameOversized must return a boolean`).toBe("boolean");
        expect(got, `${name}.isFrameOversized disagrees at length ${input.length}`).toBe(
          results[0]![1]
        );
      }
    }
  });

  it("copies do not share state (independent instances across packages)", () => {
    assertFullRegistry();
    // A copy that hoisted its buffer to module scope would still pass every
    // single-instance test above. This is the only assertion that catches it.
    const instances = IMPLS.map(([name, mod]) => [name, new mod.SseFrameAccumulator()] as const);
    for (const [, acc] of instances) acc.push("partial-");
    for (const [name, acc] of instances) {
      expect(acc.push("done\n\n"), `${name} leaked buffer state`).toEqual(["partial-done"]);
    }
  });
});

// ---------------------------------------------------------------------------
// BEHAVIOURAL DIFFERENTIAL — randomised
// ---------------------------------------------------------------------------

/**
 * Chunk alphabet deliberately loaded with the characters that decide framing:
 * LF, CR, and CRLF pairs alongside ordinary payload text. A generator without
 * these would never produce a boundary and the fuzz would prove nothing.
 */
const arbChunk = fc
  .array(
    fc.constantFrom("a", "b", "z", " ", ":", "{", "}", "\n", "\r", "\r\n", "\n\n", "data: "),
    { maxLength: 12 }
  )
  .map((tokens) => tokens.join(""));

const arbOps: fc.Arbitrary<Op[]> = fc.array(
  fc.oneof(
    { weight: 9, arbitrary: arbChunk.map((push) => ({ push }) as Op) },
    { weight: 1, arbitrary: fc.constant({ flush: true } as Op) }
  ),
  { minLength: 1, maxLength: 25 }
);

describe("accumulator duplication — behavioural differential (randomised)", () => {
  it("all four copies produce identical traces for arbitrary chunk/flush sequences", () => {
    assertFullRegistry();
    fc.assert(
      fc.property(arbOps, (ops) => {
        const traces = traceAll(ops);
        const ref = JSON.stringify(traces[0]![1]);
        for (const [, got] of traces.slice(1)) {
          if (JSON.stringify(got) !== ref) return false;
        }
        return true;
      }),
      { numRuns: 1000 }
    );
  });

  it("all four copies agree that pushing a whole body equals pushing it in arbitrary slices", () => {
    assertFullRegistry();
    // Re-assembly invariant, asserted ACROSS copies rather than within one.
    // Catches a copy whose chunk handling drifts only under a specific split.
    fc.assert(
      fc.property(
        fc.array(
          fc
            .array(fc.constantFrom("a", "b", "z", " ", ":", "{", "}"), {
              minLength: 1,
              maxLength: 20,
            })
            .map((t) => t.join("")),
          { minLength: 1, maxLength: 8 }
        ),
        fc.array(fc.integer({ min: 1, max: 17 }), { minLength: 1, maxLength: 30 }),
        (frames, sizes) => {
          const body = frames.map((f) => `data: ${f}`).join("\n\n") + "\n\n";
          const sliced: Op[] = [];
          let offset = 0;
          for (const size of sizes) {
            if (offset >= body.length) break;
            sliced.push({ push: body.slice(offset, offset + size) });
            offset += size;
          }
          if (offset < body.length) sliced.push({ push: body.slice(offset) });
          sliced.push({ flush: true });

          const whole: Op[] = [{ push: body }, { flush: true }];

          // Every copy must agree with every other copy on BOTH paths, and
          // each copy's two paths must agree with each other.
          const flat = (t: string[][]) => t.flat();
          const results = IMPLS.map(
            ([name, mod]) =>
              [name, flat(trace(mod, whole)), flat(trace(mod, sliced))] as const
          );
          const ref = JSON.stringify(results[0]![1]);
          for (const [, w, s] of results) {
            if (JSON.stringify(w) !== ref) return false;
            if (JSON.stringify(s) !== ref) return false;
          }
          return true;
        }
      ),
      { numRuns: 500 }
    );
  });
});

// ---------------------------------------------------------------------------
// SURFACE — justified divergence ledger
// ---------------------------------------------------------------------------

/**
 * Exports a copy is allowed to have that the others do not, with the reason.
 * An entry here is a claim someone made in writing; an unlisted extra export
 * fails, forcing the next divergence to be justified rather than absorbed.
 */
const JUSTIFIED_EXTRA_EXPORTS: Record<CopyName, ReadonlyArray<{ name: string; why: string }>> = {
  edge: [],
  remix: [],
  sveltekit: [],
  server: [
    {
      name: "SseMultiTransform",
      why:
        "server's applyTransforms (handler.ts, stream-transform.ts) implements the " +
        "N-output pipeline consumed by approvalGating/openSwe/deepagentsEnrich adapters. " +
        "edge/remix/sveltekit each implement a 1-in-1-out applyTransforms, so the type " +
        "would be unreachable surface in those packages.",
    },
    {
      name: "FrameAttribution",
      why:
        "Describes where a frame sits in a NESTED agent execution (depth, path, scopeId). " +
        "It exists only because AI SDK v6 parses standard frames with strictObject and " +
        "REJECTS unknown fields — the same constraint that forces stripMessageIdTransform — " +
        "so nesting cannot ride on the wire and must travel in-process between transforms " +
        "instead. Only server has a multi-stage N-output pipeline for it to travel THROUGH: " +
        "edge/remix/sveltekit are 1-in-1-out clean proxies with no enrich stage to read it, " +
        "so the type would be unreachable surface there exactly as SseMultiTransform is.",
    },
  ],
};

/**
 * Shared-core types one copy is allowed to WIDEN, member by member, with the reason.
 *
 * Distinct from JUSTIFIED_EXTRA_EXPORTS: that governs whole exports one copy has and
 * the others do not. This governs a type every copy MUST have, where one copy carries
 * an additional member. `SseFrame` is the first case — server adds `attribution?`.
 *
 * WHY A SEPARATE CONCEPT RATHER THAN A SPECIAL CASE FOR SseFrame.
 * The widening-subtype move (add an optional member consumed by one rung only) has been
 * used three times in this codebase — SseFrame, SandboxWorkspaceList,
 * ApprovalGatingTransform. A pattern used three times is a pattern. Special-casing
 * SseFrame here would leave the NEXT widening of a DIFFERENT shared type unguarded,
 * which is the failure this ledger exists to prevent.
 *
 * WHAT THIS DELIBERATELY DOES NOT MEAN.
 * "Superset" is not "anything goes". A naive `server ⊇ others` test would accept
 * `{ raw: Uint8Array; attribution?: X }` — a superset by member NAME whose shared
 * member has silently changed type. The assertions below therefore require the shared
 * members to be declaration-identical AND the extras to be exactly the ledgered ones.
 * The strict whole-declaration equality remains the DEFAULT for every shared-core type;
 * an entry here opens a narrow, checked exception, not a general licence.
 */
const JUSTIFIED_SUPERSETS: Record<
  CopyName,
  ReadonlyArray<{ type: string; member: string; why: string }>
> = {
  edge: [],
  remix: [],
  sveltekit: [],
  server: [
    {
      type: "SseFrame",
      member: "attribution",
      why:
        "In-process side channel for nested-agent attribution. MUST stay optional: " +
        "the other three copies never populate it, and their SseFrame has to remain " +
        "assignable to server's for a transform written against one to typecheck " +
        "against the other. A required member would break that silently. " +
        "NOTE ON SCOPE: server's handler writes only `${out.raw}` to the wire, which is " +
        "what keeps attribution off the wire and away from AI SDK's strictObject parser. " +
        "This ledger does NOT verify that — it is a property of handler.ts, not of the " +
        "accumulator copies. See the report accompanying this change: that invariant is " +
        "currently held by a code comment and one manual check, and wants a real test in " +
        "server's own suite.",
    },
  ],
};

/** Strip block/line comments so a docblock difference is not read as drift. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Exported declaration names, in source order. */
function exportedNames(src: string): string[] {
  return [
    ...stripComments(src).matchAll(
      /^export\s+(?:declare\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z0-9_$]+)/gm
    ),
  ].map((m) => m[1]!);
}

/**
 * Normalised text of one exported declaration — comments stripped, whitespace
 * collapsed. Two copies whose declarations normalise identically have the same
 * signature; a changed parameter or return type changes the normalised text.
 */
function declarationText(src: string, name: string): string | null {
  const stripped = stripComments(src);
  const start = stripped.search(
    new RegExp(
      `^export\\s+(?:declare\\s+)?(?:const|let|var|function|class|interface|type|enum)\\s+${name}\\b`,
      "m"
    )
  );
  if (start === -1) return null;
  const rest = stripped.slice(start);
  // A declaration ends at the next top-level `export` or end of file.
  const next = rest.slice(1).search(/^export\s/m);
  const body = next === -1 ? rest : rest.slice(0, next + 1);
  return body.replace(/\s+/g, " ").trim();
}

/**
 * Members of a normalised `interface X { a: T; b?: U; }` declaration, as
 * name -> { text, optional }. Returns null when the declaration is not an
 * interface body, so callers can fall back to whole-declaration equality.
 */
function interfaceMembers(
  decl: string
): Map<string, { text: string; optional: boolean }> | null {
  const open = decl.indexOf("{");
  const close = decl.lastIndexOf("}");
  if (open === -1 || close === -1 || close < open) return null;
  const out = new Map<string, { text: string; optional: boolean }>();
  for (const part of decl.slice(open + 1, close).split(";")) {
    const text = part.trim();
    if (!text) continue;
    const m = /^([A-Za-z0-9_$]+)(\?)?\s*:/.exec(text);
    if (!m) return null; // unparseable member — refuse to guess
    out.set(m[1]!, { text, optional: m[2] === "?" });
  }
  return out;
}

describe("accumulator duplication — justified divergence ledger", () => {
  const sources = Object.fromEntries(
    EXPECTED_COPIES.map((pkg) => [pkg, readCopy(pkg)])
  ) as Record<CopyName, string>;

  const surfaces = Object.fromEntries(
    EXPECTED_COPIES.map((pkg) => [pkg, exportedNames(sources[pkg])])
  ) as Record<CopyName, string[]>;

  /** Exports every copy must carry: those present in all four. */
  const sharedCore = surfaces.edge.filter((n) =>
    EXPECTED_COPIES.every((pkg) => surfaces[pkg].includes(n))
  );

  it("the shared core is non-empty and covers the documented contract", () => {
    // Without this, a mass deletion reducing every copy to zero exports would
    // make the two assertions below vacuously true.
    expect(sharedCore).toEqual(
      expect.arrayContaining([
        "MAX_FRAME_BYTES",
        "SseFrame",
        "isFrameOversized",
        "SseTransform",
        "SseFrameAccumulator",
      ])
    );
  });

  it("no copy drops a shared-core export", () => {
    for (const pkg of EXPECTED_COPIES) {
      expect(surfaces[pkg], `${pkg} is missing shared-core exports`).toEqual(
        expect.arrayContaining(sharedCore)
      );
    }
  });

  it("every extra export is justified in the ledger", () => {
    for (const pkg of EXPECTED_COPIES) {
      const extras = surfaces[pkg].filter((n) => !sharedCore.includes(n)).sort();
      const allowed = JUSTIFIED_EXTRA_EXPORTS[pkg].map((e) => e.name).sort();
      expect(
        extras,
        `${pkg}/src/accumulator.ts has unjustified extra exports. Either revert the ` +
          `divergence, or add it to JUSTIFIED_EXTRA_EXPORTS with a written reason.`
      ).toEqual(allowed);
    }
  });

  it("every ledger entry still corresponds to a real export (no stale justifications)", () => {
    // The ledger must not outlive what it describes: a justification for an
    // export that no longer exists is a claim that can never fail.
    for (const pkg of EXPECTED_COPIES) {
      for (const entry of JUSTIFIED_EXTRA_EXPORTS[pkg]) {
        expect(
          surfaces[pkg],
          `ledger justifies ${pkg}.${entry.name} but that export is gone`
        ).toContain(entry.name);
        expect(entry.why.length, `${pkg}.${entry.name} needs a real reason`).toBeGreaterThan(40);
      }
    }
  });

  /** Shared-core types that some copy is ledgered to widen. */
  const widenedTypes = new Set(
    EXPECTED_COPIES.flatMap((pkg) => JUSTIFIED_SUPERSETS[pkg].map((e) => e.type))
  );

  it("shared-core declarations are signature-identical across copies (comments may differ)", () => {
    // Types are erased at runtime, so the behavioural differentials above are
    // blind to a signature change on a shared export. This is the only
    // assertion that catches e.g. isFrameOversized widening its parameter in
    // one copy. Comments are stripped so docblock divergence stays legal.
    //
    // Strict whole-declaration equality is the DEFAULT and stays that way for
    // every type nobody has ledgered a widening for. Ledgered types are checked
    // member-wise in the tests below, which are STRICTER, not looser: they pin
    // the shared members AND the extras AND the optionality.
    for (const name of sharedCore) {
      if (widenedTypes.has(name)) continue;
      const decls = EXPECTED_COPIES.map(
        (pkg) => [pkg, declarationText(sources[pkg], name)] as const
      );
      for (const [pkg, decl] of decls) {
        expect(decl, `${pkg}.${name} declaration not found`).not.toBeNull();
        expect(
          decl,
          `${pkg}.${name} has a different declaration from ${decls[0]![0]}.${name}`
        ).toBe(decls[0]![1]);
      }
    }
  });

  it("the member parser actually parsed something (a silent parse failure would make every superset check vacuous)", () => {
    // THE vacuity risk in this section. If interfaceMembers() ever returns an
    // empty map -- a reformat it cannot read, a renamed type -- then "shared
    // members agree" and "extras match the ledger" both become trivially true
    // and this whole layer reports success while checking nothing.
    for (const type of widenedTypes) {
      for (const pkg of EXPECTED_COPIES) {
        const decl = declarationText(sources[pkg], type);
        expect(decl, `${pkg}.${type} declaration not found`).not.toBeNull();
        const members = interfaceMembers(decl!);
        expect(members, `${pkg}.${type} members could not be parsed`).not.toBeNull();
        expect(
          [...members!.keys()],
          `${pkg}.${type} parsed to zero members — the superset checks below would be vacuous`
        ).not.toHaveLength(0);
        expect(
          members!.has("raw"),
          `${pkg}.${type} lost its 'raw' member — the shared contract is gone`
        ).toBe(true);
      }
    }
  });

  it("a widened type's SHARED members are declaration-identical (superset must not mean 'anything goes')", () => {
    // The trap this closes: `{ raw: Uint8Array; attribution?: X }` is a superset
    // by member NAME while the shared member has silently changed type. A naive
    // "server has everything the others have" test accepts it. This does not.
    for (const type of widenedTypes) {
      const parsed = EXPECTED_COPIES.map(
        (pkg) => [pkg, interfaceMembers(declarationText(sources[pkg], type)!)!] as const
      );
      const shared = [...parsed[0]![1].keys()].filter((m) =>
        parsed.every(([, members]) => members.has(m))
      );
      expect(shared, `${type} has no members common to all copies`).toContain("raw");
      for (const member of shared) {
        for (const [pkg, members] of parsed) {
          expect(
            members.get(member)!.text,
            `${pkg}.${type}.${member} differs from ${parsed[0]![0]}.${type}.${member}`
          ).toBe(parsed[0]![1].get(member)!.text);
        }
      }
    }
  });

  it("a widened type's EXTRA members are exactly the ledgered ones, and every one of them is optional", () => {
    for (const type of widenedTypes) {
      const parsed = EXPECTED_COPIES.map(
        (pkg) => [pkg, interfaceMembers(declarationText(sources[pkg], type)!)!] as const
      );
      const shared = [...parsed[0]![1].keys()].filter((m) =>
        parsed.every(([, members]) => members.has(m))
      );
      for (const [pkg, members] of parsed) {
        const extras = [...members.keys()].filter((m) => !shared.includes(m)).sort();
        const allowed = JUSTIFIED_SUPERSETS[pkg]
          .filter((e) => e.type === type)
          .map((e) => e.member)
          .sort();
        expect(
          extras,
          `${pkg}.${type} has unjustified extra members. Either revert the widening, ` +
            `or add it to JUSTIFIED_SUPERSETS with a written reason.`
        ).toEqual(allowed);
        for (const member of extras) {
          // A REQUIRED added member silently breaks assignability: a transform
          // written against edge's SseFrame would stop typechecking against
          // server's. The justification depends on the other copies simply not
          // populating it, which only holds while it is optional.
          expect(
            members.get(member)!.optional,
            `${pkg}.${type}.${member} must be OPTIONAL — a required widening breaks ` +
              `assignability from the narrower copies`
          ).toBe(true);
        }
      }
    }
  });

  it("every superset ledger entry still describes a real widening (no stale justifications)", () => {
    // The M8 guard, applied to the new concept. A justification for a member
    // that no longer exists is a claim that can never be checked again.
    for (const pkg of EXPECTED_COPIES) {
      for (const entry of JUSTIFIED_SUPERSETS[pkg]) {
        expect(
          sharedCore,
          `ledger widens ${pkg}.${entry.type} but that is not a shared-core type`
        ).toContain(entry.type);
        const members = interfaceMembers(declarationText(sources[pkg], entry.type)!);
        expect(
          members?.has(entry.member),
          `ledger justifies ${pkg}.${entry.type}.${entry.member} but that member is gone`
        ).toBe(true);
        expect(
          entry.why.length,
          `${pkg}.${entry.type}.${entry.member} needs a real reason`
        ).toBeGreaterThan(40);
      }
    }
  });

  it("a widening member's type is itself a ledgered server-only export (it must not leak a shared name)", () => {
    // FrameAttribution is only defensible as server-only surface if it IS
    // server-only surface. If the widening referenced a type the other copies
    // also export, the "unreachable there" justification would be false.
    for (const pkg of EXPECTED_COPIES) {
      for (const entry of JUSTIFIED_SUPERSETS[pkg]) {
        const members = interfaceMembers(declarationText(sources[pkg], entry.type)!)!;
        const text = members.get(entry.member)!.text;
        const ledgeredExtras = JUSTIFIED_EXTRA_EXPORTS[pkg].map((e) => e.name);
        const referenced = ledgeredExtras.filter((name) =>
          new RegExp(`\\b${name}\\b`).test(text)
        );
        expect(
          referenced,
          `${pkg}.${entry.type}.${entry.member} must be typed by a ledgered ${pkg}-only ` +
            `export; found none of [${ledgeredExtras.join(", ")}] in "${text}"`
        ).not.toHaveLength(0);
        for (const name of referenced) {
          for (const other of EXPECTED_COPIES.filter((o) => o !== pkg)) {
            expect(
              surfaces[other],
              `${name} is ledgered as ${pkg}-only but ${other} exports it too`
            ).not.toContain(name);
          }
        }
      }
    }
  });
});
