/**
 * EVERY PARSED PART MUST HAVE SOMEWHERE TO GO (#330).
 *
 * The chat page declares a schema map for `useDeepAgentsChat` and, separately,
 * a dispatch of `msg.type === "data-..."` branches that renders each one. The
 * two lists are written by hand, ~370 lines apart, and nothing has ever
 * compared them. A key present in the first and absent from the second is a
 * frame that is received, validated, and then silently dropped.
 *
 * THIS HAS ALREADY HAPPENED TWICE IN THIS FILE. `data-agents-md` was
 * registered and never rendered; the comment beside its branch still records
 * the diagnosis:
 *
 *     Nothing failed, which is why nothing caught it — a part that is dropped
 *     and a part that never arrived produce the same screen.
 *
 * `data-human-response` was in the identical state when this test was written,
 * and it was reachable by a person: ApprovalCard shows a Respond affordance
 * whenever `onRespond` is wired (useApprovalCardController.tsx), answering it
 * resolves the approval as `responded`, and the gating transform emits
 * `data-human-response` (packages/server/src/approval-gating.ts). Someone typed
 * a reply to the agent and the screen did not change.
 *
 * The first fix addressed the instance. This one addresses the shape, which is
 * why it is a parity assertion over the two lists rather than one more branch.
 *
 * AND IT WAS STILL HALF A SHAPE (#459). The two lists above are both read out of page.tsx,
 * so between them they catch a branch or a registration that is REMOVED — and nothing that
 * was never wired up at all, because a part missing from both lists is missing from both
 * SUBJECTS. `data-approval-pause` sat in exactly that hole (#420) and the suite was green
 * the whole time. The name of this block used to say the two lists "agree", which reads as
 * symmetric and told a reader nothing about which half was enforced; it now states the
 * property instead. The third case reads a third artifact — the published contract, which
 * eject maintains — so the subject is what can ARRIVE rather than what someone remembered
 * to type twice.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { RUNGS } from "@deepagents-nextjs/rungs";
import { FRAMEWORKS } from "../lib/frameworks";

const source = readFileSync(join(__dirname, "page.tsx"), "utf-8");

/**
 * THE DISPATCH LIVES IN TWO PLACES NOW (#154), and this file's own vacuity guard is what
 * said so: when the rung-owned branches moved into lib/rungs/cards, `dispatchedTypes()`
 * fell below its floor and this suite went RED rather than green. The guard worked exactly
 * as its comment promised — "the dispatch moves to a lookup table" is listed there as a
 * drift it must catch.
 *
 *   app/page.tsx           the core/shared cards, still inline `msg.type === "..."` branches
 *   lib/rungs/cards/*.tsx  the rung-owned packs, `"data-plan": (data) => …`
 *
 * Both are read. A pack file that is not present has been ejected with its rung, and the
 * `receivable` filter below is what keeps that from reading as a dropped part.
 */
const CARD_PACK_DIR = join(__dirname, "..", "lib", "rungs", "cards");

/** Part types the rung packs present in THIS tree render. */
function packTypes(): string[] {
  const out: string[] = [];
  for (const f of readdirSync(CARD_PACK_DIR)) {
    // registry.tsx is the barrel and index.tsx the facade; neither declares a part type.
    if (f === "registry.tsx" || f === "index.tsx" || !f.endsWith(".tsx"))
      continue;
    const src = readFileSync(join(CARD_PACK_DIR, f), "utf-8");
    for (const m of src.matchAll(/"(data-[a-z-]+)":\s*\(/g)) out.push(m[1]);
  }
  return [...new Set(out)];
}

/**
 * Part types this BUILD can receive at all.
 *
 * `pnpm eject` prunes `packages/react/src/schemas.ts` by rung attribution, so in a fork that
 * dropped rung 4 there is no `"data-plan"` entry and no frame of that shape can ever arrive
 * parsed. Registering a schema for it is then harmless and having no renderer is CORRECT —
 * without this filter, every ejected tree would report the rung's own cards as silently
 * dropped parts, which is the opposite of what this suite is for.
 *
 * Derived from the artifact eject already maintains rather than from a list here, so the two
 * cannot disagree.
 */
function receivableTypes(): string[] {
  const map = readFileSync(
    join(__dirname, "..", "..", "..", "packages", "react", "src", "schemas.ts"),
    "utf-8"
  );
  return [...map.matchAll(/^\s*"(data-[a-z-]+)":\s*[A-Za-z0-9_]+,\s*$/gm)].map(
    (m) => m[1]
  );
}

/**
 * Keys of the `schemas: { ... }` literal passed to useDeepAgentsChat.
 *
 * Sliced from `schemas:` to the closing brace rather than matched globally:
 * the same `"data-x": Schema` shape appears in the generic type argument
 * directly above, and counting both would double every key and mask a
 * genuine mismatch behind a symmetric one.
 */
function registeredKeys(): string[] {
  const start = source.indexOf("schemas: {");
  if (start === -1) return [];
  const end = source.indexOf("\n    },", start);
  if (end === -1) return [];
  const block = source.slice(start, end);
  return [...block.matchAll(/"(data-[a-z-]+)":/g)].map((m) => m[1]).sort();
}

/** Part types the render dispatch has a branch for. */
function dispatchedTypes(): string[] {
  return [
    ...new Set([
      ...[...source.matchAll(/msg\.type === "(data-[a-z-]+)"/g)].map(
        (m) => m[1]
      ),
      ...packTypes(),
    ]),
  ].sort();
}

/* -------------------------------------------------------------------------- */
/*  #459 — the direction that was missing, and the artifact that makes it      */
/*         answerable in a fork                                               */
/* -------------------------------------------------------------------------- */

/**
 * THE PUBLISHED CONTRACT, READ AS THE ATTRIBUTION AUTHORITY.
 *
 * `docs/sse-frame-schema.json` names every `data-*` frame this build declares and, per frame,
 * `x-emitted-by`: the rung that emits it, "core" for frames that survive every eject, or null
 * for a shape nothing in this repository emits and that #50 retains DELIBERATELY, because a
 * consumer's own backend may send it.
 *
 * WHY THIS FILE AND NOT ONE OF THE TWO ALREADY READ ABOVE. Both directions asserted before
 * #459 compare `page.tsx` against itself — the `schemas: {}` literal against the render
 * branches. `page.tsx` is SHARED: `pnpm eject` never touches it, so the literal is
 * byte-identical in a rung-1 fork while the rung-owned card packs are deleted. A fork
 * therefore registers `data-plan`, `data-file`, `data-sub-agent` and `data-todo` with nothing
 * to render them, and that is CORRECT there. Measured, not assumed — see the eject run
 * recorded in the PR.
 *
 * That is why "every registered key has a render branch" cannot be asserted flatly: in a fork
 * the four legitimate orphans are shape-identical to a real dropped part, and nothing inside
 * page.tsx distinguishes them. `x-emitted-by` does, and eject maintains it: scripts/eject.mjs
 * prunes both this file and SCHEMA_MAP by the SAME `doomedParts` set, so a part whose rung is
 * gone is absent from here rather than present and misleading.
 */
function declaredFrames(): { title: string; emitter: string | null }[] {
  const doc = JSON.parse(
    readFileSync(
      join(__dirname, "..", "..", "..", "docs", "sse-frame-schema.json"),
      "utf-8"
    )
  ) as { oneOf?: { title?: string; "x-emitted-by"?: string | null }[] };
  return (doc.oneOf ?? [])
    .filter(
      (f): f is { title: string } & typeof f =>
        typeof f?.title === "string" && f.title.startsWith("data-")
    )
    .map((f) => ({ title: f.title, emitter: f["x-emitted-by"] ?? null }));
}

/**
 * The rung ids THIS SURFACE can actually be pointed at.
 *
 * Imported rather than restated: `FRAMEWORKS` is the app's own answer to "which backends does
 * the chat surface offer", derived in lib/frameworks.ts from `RUNGS.filter(shape ===
 * "conversation")`. Reading it here means the reachability question and the dropdown can never
 * disagree — if someone widens the surface to run-shaped rungs, the requirement widens with it
 * on the same commit, with no list here to update.
 */
const SELECTABLE = new Set(FRAMEWORKS.map((f) => f.id));

/**
 * Parts that can arrive AT THIS SURFACE, and therefore must have somewhere to go.
 *
 * Three cases, and the third is the one that keeps `data-testing` off the list honestly:
 *   null     nothing here emits it, retained for a consumer's own backend (#50) -> REQUIRED
 *   "core"   survives every eject, every tree can receive it                    -> REQUIRED
 *   a rung   required only if the chat surface can be pointed at that rung
 *
 * `data-testing` is emitted by rung 5, whose `shape` is "run" and whose `target.kind` is
 * "none": it is not in FRAMEWORKS, so this page cannot be pointed at it and a frame of that
 * shape cannot arrive here. Not required, DERIVED — not excused by name. The moment rung 5
 * becomes selectable this list grows and the assertion below turns red on its own.
 *
 * Having a consumer is never a violation, so an over-broad renderer costs nothing: `data-plan`
 * and `data-approval` are rung-4-attributed and rendered here anyway. This is a floor on what
 * must be consumable, not a ceiling on what may be.
 */
function reachableHere(): string[] {
  return declaredFrames()
    .filter(
      (f) =>
        f.emitter === null || f.emitter === "core" || SELECTABLE.has(f.emitter)
    )
    .map((f) => f.title)
    .sort();
}

describe("chat page: a part that can arrive has somewhere to go", () => {
  /*
   * THE VACUITY GUARD, AND IT IS NOT DECORATION. Both readers above are
   * regexes over source. If either stops matching — the literal is reformatted,
   * `schemas:` is renamed, the dispatch moves to a lookup table — it returns an
   * empty list, two empty lists are trivially equal, and this file goes green
   * while checking nothing. That failure mode is the exact one it exists to
   * catch, so it must be impossible for BOTH lists to be empty and passing.
   *
   * The floor is a floor, not the count: asserting the exact number would fail
   * every time someone adds a card, which trains people to edit the number
   * rather than read the test.
   */
  it("both readers actually found something", () => {
    expect(
      registeredKeys().length,
      "schema-map reader matched nothing — the regex has drifted from page.tsx"
    ).toBeGreaterThanOrEqual(9);
    /*
     * FLOORED ON THE INLINE BRANCHES ONLY (#154).
     *
     * `dispatchedTypes()` is now the union of page.tsx's branches and the rung packs, and a
     * fork that ejected rungs 3 and 4 legitimately has fewer packs — 9 was a whole-ladder
     * number. The core/shared branches, though, are in every tree by construction: they render
     * parts emitted by approval-gating.ts, which #30 moved into core, or parts with no emitter
     * at all (#50). So the inline reader is the half that can be floored everywhere, and it is
     * the half most likely to drift, since it is a regex over a 1200-line component.
     */
    const inline = [
      ...new Set(
        [...source.matchAll(/msg\.type === "(data-[a-z-]+)"/g)].map((m) => m[1])
      ),
    ];
    expect(
      inline.length,
      "dispatch reader matched nothing — the regex has drifted from page.tsx"
    ).toBeGreaterThanOrEqual(4);
  });

  it("the pack reader found the rung-owned cards too", () => {
    // The second half of the vacuity guard, for the second half of the dispatch. If the pack
    // regex drifts, `packTypes()` returns [] and the orphan check below starts reporting
    // every rung card as dropped — loud, but for the wrong reason. This says which it is.
    // Floored at 1 rather than at today's count: a fork legitimately has fewer, and rung 1
    // has none at all, so the assertion is scoped to trees that have any.
    const packs = packTypes();
    const anyRungCardsHere = receivableTypes().some(
      (t) => !source.includes(`msg.type === "${t}"`)
    );
    if (anyRungCardsHere) {
      expect(
        packs.length,
        "pack reader matched nothing — the regex has drifted from lib/rungs/cards"
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it("every registered schema key has a render branch", () => {
    const receivable = receivableTypes();
    const orphans = registeredKeys()
      // A part this build cannot receive needs no renderer — see receivableTypes().
      .filter((k) => receivable.includes(k))
      .filter((k) => !dispatchedTypes().includes(k));
    expect(
      orphans,
      `these parts are parsed and then silently dropped: ${orphans.join(", ")}`
    ).toEqual([]);
  });

  it("every render branch has a registered schema", () => {
    /*
     * The other direction, and it fails differently: an unregistered part type
     * never arrives parsed, so the branch is dead code that looks like support.
     * Cheaper to assert than to notice.
     */
    const unreachable = dispatchedTypes().filter(
      (t) => !registeredKeys().includes(t)
    );
    expect(
      unreachable,
      `these branches can never fire — no schema registers them: ${unreachable.join(
        ", "
      )}`
    ).toEqual([]);
  });

  /* ------------------------------------------------------------------------ */
  /*  #459 — a part that can arrive must have somewhere to go                  */
  /* ------------------------------------------------------------------------ */

  /*
   * THE EXEMPTION MUST NOT BE GRANTABLE BY A TYPO.
   *
   * `reachableHere()` drops any frame whose `x-emitted-by` names a rung this surface cannot
   * select. Ask the question this repo insists on — what would have to be true for that filter
   * to pass while parts are still being dropped? Answer: one misspelt attribution.
   * `"x-emitted-by": "open-sw"` matches no rung, fails `SELECTABLE.has`, and the frame quietly
   * stops being required. The check would go green by shrinking its own subject.
   *
   * So attribution has to RESOLVE. Every non-core, non-null value must name a rung the
   * manifest declares; a value that resolves to nothing is a broken annotation, not an
   * exemption. Note this cannot fire on a fork's own pruning: eject deletes the frame ENTRY
   * when it deletes the rung, so a surviving entry naming an absent rung is drift either way.
   */
  it("every x-emitted-by resolves to a rung this tree declares", () => {
    // Widened to Set<string> deliberately: `RungId` is a union of the ids the manifest
    // declares, so a Set<RungId> cannot be asked about an arbitrary string — which is
    // precisely the question here. The cast would have to go somewhere; putting it on the
    // set keeps the frame's value untouched, so a typo is compared as written.
    const declared = new Set<string>(RUNGS.map((r) => r.id));
    const unresolved = declaredFrames()
      .filter((f) => f.emitter !== null && f.emitter !== "core")
      .filter((f) => !declared.has(f.emitter as string));
    expect(
      unresolved.map((f) => `${f.title} <- ${f.emitter}`),
      "an attribution naming no rung silently exempts its frame from the check below"
    ).toEqual([]);
  });

  /*
   * THE DIRECTION #459 ADDS, AND WHY IT IS THE DANGEROUS ONE.
   *
   * The two cases above compare page.tsx against page.tsx. Both fire on a branch or a
   * registration that is REMOVED — measured, not assumed: deleting `msg.type === "data-task"`
   * reddens the first, deleting `"data-task": TaskSchema` reddens the second. Neither fires on
   * a part that was never wired up at all, because neither iterates a set that contains it:
   * one starts from the registrations, the other from the branches, and a part missing from
   * both is missing from both subjects.
   *
   * That is not a hypothetical. `data-approval-pause` sat in exactly that state (#420):
   * emitted by adapters/langchain.ts since #428 and registered nowhere, so `partsToMessages`
   * dropped it — no error, no warning, nothing on screen. A frame that is received, validated
   * and discarded is INDISTINGUISHABLE from a backend that never sent it, which is why it
   * survived. #458 mounts it and fixes the instance; this fixes the shape.
   *
   * So the subject here is neither list: it is the published contract, filtered to what this
   * surface can be pointed at. A part that can ARRIVE must be both registered (or
   * partsToMessages drops it) and rendered (or the message is built and shown to no one).
   * Both halves are named separately in the failure, because they are different repairs.
   *
   * WHAT THIS STILL DOES NOT CATCH, stated because a reader will otherwise assume it does.
   * A key registered with the hook that is declared on NO wire contract and has no branch
   * stays green here, because it never enters this subject. That is not an oversight, it is
   * undecidable from inside the tree: page.tsx is shared, so a rung-1 fork registers exactly
   * four such keys legitimately, and they are byte-for-byte the same shape as the defect.
   * Both were mutated and both stayed green; the record is in the PR. The composition that
   * closes it is #448 — once every registered payload must be declared, such a key acquires
   * an `x-emitted-by`, becomes reachable here if its rung is selectable, and this case turns
   * red on it with no change to this file.
   */
  it("every part this surface can receive is registered and rendered", () => {
    const reachable = reachableHere();
    const registered = registeredKeys();
    const dispatched = dispatchedTypes();

    /*
     * THE FLOOR, AND IT IS DERIVED RATHER THAN A NUMBER.
     *
     * If the JSON moves, `oneOf` is renamed, or `x-emitted-by` is dropped, `reachable` comes
     * back empty and an empty subject satisfies every assertion below — the exact green-by-
     * absence this file exists to refuse, arriving through the reader that was added to refuse
     * it. Frames attributed to null or "core" survive every eject by construction, so a tree
     * with a readable contract always has some; zero means the reader broke, not that the
     * contract is empty. Asserting containment rather than a count keeps it from becoming a
     * number people edit.
     */
    const alwaysReachable = declaredFrames()
      .filter((f) => f.emitter === null || f.emitter === "core")
      .map((f) => f.title);
    expect(
      alwaysReachable.length,
      "frame-schema reader matched nothing — docs/sse-frame-schema.json moved or changed shape"
    ).toBeGreaterThan(0);
    expect(
      alwaysReachable.filter((t) => !reachable.includes(t)),
      "core/unattributed frames must always be reachable — the reachability filter has drifted"
    ).toEqual([]);

    const unregistered = reachable.filter((t) => !registered.includes(t));
    const unrendered = reachable.filter((t) => !dispatched.includes(t));

    /*
     * NAME THE SUBJECT ON SUCCESS. A count is falsifiable and a green tick is not: "11
     * reachable, 11 registered, 11 rendered" is a claim a reader can check against the tree,
     * and it is the line that would have read "1 reachable and 0 registered" for
     * data-approval-pause. Compared as one string so both halves have to hold at once and the
     * failure prints all three numbers rather than the first that differs.
     */
    expect(
      `${reachable.length} reachable, ${
        reachable.length - unregistered.length
      } registered, ${reachable.length - unrendered.length} rendered`,
      `parts that can arrive here and go nowhere — not registered: [${unregistered.join(
        ", "
      )}]; no render branch: [${unrendered.join(", ")}]`
    ).toBe(
      `${reachable.length} reachable, ${reachable.length} registered, ${reachable.length} rendered`
    );
  });
});
