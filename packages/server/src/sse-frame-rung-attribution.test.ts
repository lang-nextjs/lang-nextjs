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
  // CORE IS NOT A LOW RUNG — IT IS BELOW EVERY RUNG.
  //
  // `rungs.json`'s `_rendererNote` says to assign a payload to the LOWEST rung that
  // emits it, since higher rungs inherit through `requires`. That rule is
  // rung-vs-rung, and core is not in its domain: core is present at EVERY eject, so
  // it sits beneath the whole ladder. Modelling that as ordinal -1 keeps this a
  // single comparison instead of a rule plus a "core wins" special case.
  //
  // This previously `.filter()`ed unowned producers out BEFORE taking the minimum,
  // which did not merely deprioritise core — it deleted core from the comparison,
  // letting a rung outrank it. Latent until `adapters/sdaEnrich.ts` (rung 5) began
  // emitting `data-approval-required` alongside core's `approval-gating.ts`, which
  // derived "software-developer-agent" for a frame every ejected fork still emits.
  //
  // The old `owners.length === 0` branch is now unreachable: all-unowned is simply
  // every element mapping to core. The `files.length === 0 → null` guard above is
  // still load-bearing — it is what makes data-task and data-agents-md derive null.
  //
  // The rule is SOUND for a genuinely shared producer: `shared` survives every
  // eject, so a tag emitted by shared code really is reachable at every rung. What
  // is imperfect is DIAGNOSIS — `rungs.json` lists `packages/server/**` in
  // `shared.paths`, so a new adapter is shared-by-default and SILENT, and a file en
  // route to a rung looks identical to a permanently-shared one. See the
  // culprit-naming branch in mismatches() below.
  const owners = files
    .map(owningRung)
    .map((r) => r ?? { id: "core", ordinal: -1 });
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

    // A FORK BELOW THE DECLARED RUNG IS THE STATE THIS ANNOTATION EXISTS FOR.
    //
    // After `eject langchain`, this schema still declares data-plan as "open-swe"
    // — deliberately. #62's whole design is that the fork keeps the entry and the
    // annotation tells the reader "rung-4-owned, and your fork has no rung 4", so
    // no post-eject regeneration is needed and no fork ships a schema that lies.
    //
    // Comparing declared-vs-derived unconditionally turns that intended state into
    // five failures: the producers are ejected, so everything derives to null. The
    // check would be asserting that the full ladder is present, which is the one
    // thing a fork is entitled not to be.
    //
    // So: skip an entry whose declared rung is not in THIS tree's manifest. Note
    // what is deliberately NOT skipped — an entry whose rung IS present but has no
    // producer still fails, because that is issue #50's declared-but-unproduced
    // defect and it is real at every rung.
    const rungIds = new Set(manifest.rungs.map((r) => r.id));
    if (declared !== null && declared !== "core" && !rungIds.has(declared)) {
      continue;
    }

    const derived = expectedAttribution(producers, tag);
    if (declared !== derived) {
      // A tag sliding to "core" when the schema names a rung almost always means an
      // emitter was added before its file was claimed in rungs.json — NOT that
      // several unrelated tags broke at once. `packages/server/**` is in
      // shared.paths, so a new adapter is absorbed silently and this test is the
      // first thing that notices. Name the culprit so the failure says what to do.
      const unowned = (producers[tag] ?? []).filter(
        (f) => owningRung(f) === null
      );
      if (derived === "core" && declared !== "core" && unowned.length > 0) {
        bad.push(
          `${tag}: schema says ${JSON.stringify(declared)}, source says "core" — ` +
            `because these producers are claimed by no rung in rungs.json: ` +
            `${unowned.join(", ")}. If one belongs to a rung, add it to that rung's ` +
            `owns.ts. A new file under packages/server/** is absorbed by the shared ` +
            `allowlist, so nothing else objects.`
        );
        continue;
      }
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
    //
    // The anchor must be a producer EVERY fork retains. This previously named
    // adapters/openSweEnrich.ts, which is rung-4-owned: in a rung-1 fork that file
    // is ejected, the control fails, and the guard against a vacuous pass became
    // the only reason a valid fork went red. A control is still an assertion, and
    // "the full ladder is present" is not something a fork must exhibit.
    //
    // approval-gating.ts is claimed by no rung, so it is shared and survives every
    // eject. The `owningRung` assertion below is not decoration: if someone later
    // claims this file for a rung, the anchor becomes ejectable again and this
    // says so, rather than silently reintroducing the same defect.
    const anchor = "packages/server/src/approval-gating.ts";
    expect(owningRung(anchor), `${anchor} must stay shared to anchor this control`)
      .toBeNull();
    expect(producers["data-approval-required"]).toContain(anchor);

    // Replaces a hardcoded `>= 8` tag count, which was the same assumption wearing
    // a different hat — a rung-1 fork retains fewer adapters and so emits fewer
    // tags, and any floor tuned on the full ladder is a full-ladder assumption.
    //
    // Derived instead: every entry the schema attributes to "core" is emitted by
    // code no rung owns, so it survives every eject and MUST have a producer in
    // any fork. Entries annotated with a rung are skipped (that rung may be gone)
    // and entries annotated null are skipped by definition.
    const coreTags = schema.oneOf
      .filter((e) => (e.title as string)?.startsWith("data-"))
      .filter((e) => e["x-emitted-by"] === "core")
      .map((e) => e.title as string);
    expect(coreTags.length).toBeGreaterThan(0);
    for (const tag of coreTags) {
      expect(producers[tag] ?? [], `core tag ${tag} must have a producer`)
        .not.toHaveLength(0);
    }
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

  /**
   * The reject cases below are driven by a SYNTHETIC entry + producer map built
   * from whatever rungs this tree actually has, rather than by naming `data-plan`
   * and `open-swe` literally.
   *
   * Naming them literally made these full-ladder assertions: in a rung-1 fork
   * `data-plan`'s producer is ejected and `open-swe` is not in the manifest, so
   * both failed — a guard against a vacuous pass becoming the reason a valid fork
   * went red. Deriving the subject keeps them meaningful at one rung and at five.
   */
  const lowestRung = () => manifest.rungs[0];
  const someOwnedFile = (r: { owns: { ts: string[] } }) =>
    r.owns.ts.find((p) => !p.endsWith("/**")) ?? r.owns.ts[0];

  it("REJECT: a wrong rung is caught", () => {
    const rung = lowestRung();
    const synthetic = { "data-plan": [someOwnedFile(rung)] };
    // Declared "core", but the producer is owned by a real rung in this tree.
    const entries = [{ title: "data-plan", "x-emitted-by": "core" }];
    const bad = mismatches(entries, synthetic);
    expect(bad).toHaveLength(1);
    expect(bad[0]).toContain("data-plan");
    expect(bad[0]).toContain(rung.id);
  });

  it("REJECT: claiming a producer exists when none does is caught", () => {
    // Attributing a tag to a rung without writing an emitter is issue #50's
    // declared-but-unproduced defect re-entering through the annotation. The rung
    // must be one this tree HAS, or the new skip would (correctly) ignore it —
    // which is exactly the distinction being pinned here.
    const rung = lowestRung();
    const entries = [{ title: "data-task", "x-emitted-by": rung.id }];
    const bad = mismatches(entries, {});
    expect(bad).toHaveLength(1);
    expect(bad[0]).toContain("data-task");
    expect(bad[0]).toContain("null");
  });

  it("REJECT: a rung PRESENT in this tree with no producer still fails", () => {
    // The counterpart to the skip added in mismatches(). A missing producer is
    // only forgivable when the fork lacks that rung; if the rung is here, the
    // frame is declared-but-unproduced and that is a defect at every rung.
    const rung = lowestRung();
    const entries = [{ title: "data-plan", "x-emitted-by": rung.id }];
    const bad = mismatches(entries, {});
    expect(bad).toHaveLength(1);
    expect(bad[0]).toContain("null");
  });

  it("ACCEPT: an entry for a rung this tree does NOT have is skipped", () => {
    const absent = "a-rung-this-tree-does-not-have";
    expect(manifest.rungs.map((r) => r.id)).not.toContain(absent);
    const entries = [{ title: "data-plan", "x-emitted-by": absent }];
    // No producer, and the rung is gone — the annotation already explains that.
    expect(mismatches(entries, {})).toEqual([]);
  });

  /**
   * Core-vs-rung precedence. Driven by a SYNTHETIC producers map rather than the
   * real scan, so these pin the derivation RULE and keep pinning it however the
   * real producer set changes.
   */
  // A file owned by a rung EVERY fork retains, and a path no rung will ever own.
  // Naming `adapters/openSweEnrich.ts` here made these full-ladder assertions: in a
  // rung-1 fork the open-swe rung is gone from the manifest, so that file reads as
  // unowned, derives "core", and the mismatch being asserted never appears. Caught
  // by ejecting, not by reading — a synthetic producer map pins the rule only if the
  // RUNG IDENTITY is derived too, not just the file list.
  // Reuses lowestRung()/someOwnedFile() declared above for the same reason.
  const ownedByLowest = () => someOwnedFile(lowestRung());
  const NEVER_OWNED = "packages/server/src/adapters/__unclaimed__.ts";

  it('ACCEPT: a tag emitted by BOTH core and a rung derives "core"', () => {
    // data-approval-required declares "core", so agreeing means core won over the
    // rung producer rather than merely that both were core.
    const synthetic = {
      "data-approval-required": [
        "packages/server/src/approval-gating.ts", // unowned → core
        ownedByLowest(), // a rung this fork really has
      ],
    };
    expect(
      mismatches(
        schema.oneOf.filter((e) => e.title === "data-approval-required"),
        synthetic
      )
    ).toEqual([]);
  });

  it("REJECT: core does NOT win when no producer is unowned", () => {
    // Guards the opposite error — over-correcting into "always core", which would
    // make every rung-owned frame look eject-proof and defeat the annotation.
    const rung = lowestRung();
    const synthetic = { "data-approval-required": [ownedByLowest()] };
    const bad = mismatches(
      schema.oneOf.filter((e) => e.title === "data-approval-required"),
      synthetic
    );
    expect(bad).toHaveLength(1);
    expect(bad[0]).toContain(rung.id);
  });

  it("ACCEPT: a slide to core NAMES the unclaimed producer, not just the tag", () => {
    // The branch fires only when the schema names a rung THIS TREE HAS and the
    // source slid to core — a rung the tree lacks is skipped earlier, by design.
    // So the entry is synthetic too, declaring the lowest retained rung.
    const rung = lowestRung();
    const entries = [{ title: "data-plan", "x-emitted-by": rung.id }];
    const synthetic = { "data-plan": [ownedByLowest(), NEVER_OWNED] };
    const bad = mismatches(entries, synthetic);
    expect(bad).toHaveLength(1);
    expect(bad[0]).toContain(NEVER_OWNED);
    expect(bad[0]).toContain("owns.ts");
    expect(bad[0]).toContain("data-plan");
  });

  it("REJECT: no culprit line when core is the DECLARED value too", () => {
    const synthetic = {
      "data-approval-required": ["packages/server/src/approval-gating.ts"],
    };
    expect(
      mismatches(
        schema.oneOf.filter((e) => e.title === "data-approval-required"),
        synthetic
      )
    ).toEqual([]);
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
