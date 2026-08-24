/**
 * The published schema must be TRUTHFUL ABOUT A FORK, BY CONSTRUCTION.
 *
 * Every `data-*` entry in docs/sse-frame-schema.json carries `x-emitted-by`,
 * naming which rung emits it. That exists because of a severability wrinkle
 * (#59): after `pnpm eject langchain`, the fork's copy of the schema still
 * declares `data-approval` — a frame that fork can never emit, because the
 * producer (openSweEnrich.ts, rung 4) was ejected. Without the annotation,
 * that is issue #50's declared-but-unproduced state made permanent by
 * construction, and a reader cannot tell whether the absence is a bug.
 *
 * With it, a reader sees `data-approval` is rung-4-owned and their fork has no
 * rung 4. No post-eject regeneration step, and no fork ships a schema that lies
 * about itself.
 *
 * This test stops the annotation drifting from reality. It DERIVES the expected
 * attribution rather than restating it:
 *
 *   1. scan this package's source for what actually emits each tag
 *   2. map each emitting file to its owning rung via rungs.json `owns`
 *   3. expected = the LOWEST-ordinal owning rung (higher rungs inherit through
 *      `requires`, so the lowest emitter is the one whose eject removes it),
 *      "core" when no rung owns the emitter, or null when nothing emits it
 *
 * Both a rung's ownership changing in rungs.json and a producer moving between
 * files will fail this, which is the point: three surfaces, one derivation.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = path.resolve(__dirname, "../../..");
const schema = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "docs/sse-frame-schema.json"), "utf8")
) as { oneOf: Array<Record<string, unknown>> };
const manifest = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "rungs.json"), "utf8")
) as {
  rungs: Array<{
    id: string;
    ordinal: number;
    owns: { ts: string[]; py: string[]; docs: string[] };
  }>;
};

/** Repo-relative paths of every non-test source file in this package. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "__fixtures__" && e.name !== "benchmark") sourceFiles(full, acc);
    } else if (e.name.endsWith(".ts") && !e.name.includes(".test.")) {
      acc.push(path.relative(repoRoot, full));
    }
  }
  return acc;
}

/** tag -> repo-relative files that CONSTRUCT that frame. */
function findProducers(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const rel of sourceFiles(path.join(repoRoot, "packages/server/src"))) {
    const text = fs.readFileSync(path.join(repoRoot, rel), "utf8");
    for (const m of text.matchAll(
      /(?:dataFrame\(\s*"(data-[a-z-]+)"|"type"\s*:\s*"(data-[a-z-]+)"|\btype:\s*"(data-[a-z-]+)")/g
    )) {
      const tag = m[1] ?? m[2] ?? m[3];
      (out[tag] ??= []).push(rel);
    }
  }
  for (const k of Object.keys(out)) out[k] = [...new Set(out[k])];
  return out;
}

function owningRung(file: string): { id: string; ordinal: number } | null {
  for (const r of manifest.rungs) {
    for (const pat of [...r.owns.ts, ...r.owns.py, ...r.owns.docs]) {
      const hit = pat.endsWith("/**")
        ? file.startsWith(pat.slice(0, -2))
        : file === pat;
      if (hit) return { id: r.id, ordinal: r.ordinal };
    }
  }
  return null;
}

/** The derivation. Exported shape so the reject case can drive it too. */
function expectedAttribution(
  producers: Record<string, string[]>,
  tag: string
): string | null {
  const files = producers[tag] ?? [];
  if (files.length === 0) return null;
  const owners = files
    .map(owningRung)
    .filter((r): r is { id: string; ordinal: number } => r !== null);
  if (owners.length === 0) return "core";
  return owners.sort((a, b) => a.ordinal - b.ordinal)[0].id;
}

function mismatches(
  entries: Array<Record<string, unknown>>,
  producers: Record<string, string[]>
): string[] {
  const bad: string[] = [];
  for (const e of entries) {
    const tag = e.title as string;
    if (!tag?.startsWith("data-")) continue;
    if (!("x-emitted-by" in e)) {
      bad.push(`${tag}: missing x-emitted-by`);
      continue;
    }
    const declared = e["x-emitted-by"] as string | null;
    const derived = expectedAttribution(producers, tag);
    if (declared !== derived) {
      bad.push(`${tag}: schema says ${JSON.stringify(declared)}, source says ${JSON.stringify(derived)}`);
    }
  }
  return bad;
}

describe("sse-frame-schema x-emitted-by matches rungs.json + real producers", () => {
  const producers = findProducers();

  it("the producer scan finds a known emitter (control — a silent zero would pass everything)", () => {
    // Without this, a broken regex yields zero producers, every tag derives to
    // null, and the accept case below would only pass if the schema also said
    // null everywhere. Pin a known-positive so the probe is proven to fire.
    expect(producers["data-plan"]).toContain(
      "packages/server/src/adapters/openSweEnrich.ts"
    );
    expect(Object.keys(producers).length).toBeGreaterThanOrEqual(8);
  });

  it("ACCEPT: every data-* entry's attribution matches what the source actually emits", () => {
    expect(mismatches(schema.oneOf, producers)).toEqual([]);
  });

  it("every data-* entry carries the annotation", () => {
    const tags = schema.oneOf.filter((e) =>
      (e.title as string)?.startsWith("data-")
    );
    expect(tags.length).toBeGreaterThan(0);
    for (const e of tags) expect(e).toHaveProperty("x-emitted-by");
  });

  it("REJECT: a wrong rung is caught", () => {
    const mutated = schema.oneOf.map((e) =>
      e.title === "data-plan" ? { ...e, "x-emitted-by": "langchain" } : e
    );
    const bad = mismatches(mutated, producers);
    expect(bad).toHaveLength(1);
    expect(bad[0]).toContain("data-plan");
    expect(bad[0]).toContain("open-swe");
  });

  it("REJECT: claiming a producer exists when none does is caught", () => {
    // data-task and data-agents-md are deliberately unproduced. If someone
    // attributes one to a rung without writing an emitter, that is the #50
    // defect re-entering through the annotation.
    const mutated = schema.oneOf.map((e) =>
      e.title === "data-task" ? { ...e, "x-emitted-by": "deepagents" } : e
    );
    const bad = mismatches(mutated, producers);
    expect(bad).toHaveLength(1);
    expect(bad[0]).toContain("data-task");
    expect(bad[0]).toContain("null");
  });

  it("REJECT: a missing annotation is caught", () => {
    const mutated = schema.oneOf.map((e) => {
      if (e.title !== "data-error") return e;
      const { ["x-emitted-by"]: _drop, ...rest } = e;
      return rest;
    });
    const bad = mismatches(mutated, producers);
    expect(bad).toEqual(["data-error: missing x-emitted-by"]);
  });
});
