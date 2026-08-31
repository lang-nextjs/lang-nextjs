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
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

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
  /*
   * The closing brace is found by INDENTATION-AGNOSTIC search (#420).
   *
   * This was `indexOf("\n    },")` — four spaces, exactly. Adding one key to
   * the generic type argument above made prettier wrap the call differently and
   * re-indent this literal to six, so the reader found no end, returned nothing,
   * and the suite refused. It refused CORRECTLY — "both readers actually found
   * something" is what turned a silently-empty comparison into a red — but the
   * brittleness was in the reader rather than in the property, and a guard that
   * has to be repaired every time a formatter moves a block is a guard people
   * learn to edit rather than read.
   */
  const end = source.slice(start).search(/\n\s*},/);
  if (end === -1) return [];
  const block = source.slice(start, start + end);
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

describe("chat page: schema map and render dispatch agree", () => {
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

  /*
   * EJECTION LEGITIMATELY LEAVES A SHARED FILE OVER-REGISTERING, and the subject
   * has to be decidable in a fork or this case is false there by construction.
   *
   * MEASURED on `pnpm eject langchain`: SCHEMA_MAP loses the rung's entries and
   * the rung's cards are deleted, while `page.tsx` — which no rung owns — keeps
   * registering them. `PlanSchema` itself is RETAINED so the shared file still
   * compiles. That accommodation is deliberate and predates this test: the
   * orphan check below already filters through `receivableTypes()` for exactly
   * this reason.
   *
   * So a registered key being undeclared is not itself the defect. The defect is
   * a key that is undeclared while STILL BEING RENDERED — declared on no wire
   * contract, yet reachable — which is `data-approval-pause`'s exact state on
   * main before this PR: emitted by the adapter, mounted by #458, declared
   * nowhere. Ejection can never produce that pairing, because it prunes the
   * declaration and the renderer together.
   */
  const KNOWN_UNDECLARED_BUT_RENDERED: Record<string, string> = {
    "data-approval":
      "FORK-ONLY, AND A FINDING RATHER THAN AN ACCOMMODATION. `data-approval` is " +
      "rung 4's plan-mode gate, so ejecting below rung 4 prunes its SCHEMA_MAP " +
      "entry — but its render branch is INLINE in page.tsx, which no rung owns, " +
      "so the branch survives into forks that can never receive the frame. That " +
      "is a shared file naming a rung-owned part, the #154 class, and it is a " +
      "severability question rather than a test one. Exempted here so this PR " +
      "stays narrow; the branch itself is not this file's to move.",
  };

  it("NO KEY IS BOTH UNDECLARED AND RENDERED (#459)", () => {
    /*
     * THE CASE THAT CLOSES #472'S KNOWN MISS: a part registered with the hook and
     * declared on NO wire contract, while something renders it. Nothing else
     * catches that — the orphan check exempts undeclared keys, which is how
     * `data-approval-pause` slipped past the guard that existed to protect it.
     */
    const undeclared = registeredKeys().filter(
      (k) => !receivableTypes().includes(k)
    );
    const undeclaredButRendered = undeclared
      .filter((k) => dispatchedTypes().includes(k))
      .filter((k) => !(k in KNOWN_UNDECLARED_BUT_RENDERED));

    expect(
      undeclaredButRendered,
      `these parts are rendered but declared on no wire contract, so a consumer ` +
        `validating against the schema would reject a frame this app renders: ` +
        `${undeclaredButRendered.join(", ")}`
    ).toEqual([]);
  });

  it("the fork exception is still real, not stale cover", () => {
    /*
     * The exception above is allowed to exist and not to rot. On the FULL ladder
     * `data-approval` IS declared, so this case asserts the entry only describes
     * trees where it is genuinely absent — and fails if someone declares it and
     * leaves the exemption behind.
     */
    for (const [key, reason] of Object.entries(KNOWN_UNDECLARED_BUT_RENDERED)) {
      expect(
        reason.length,
        `${key} is exempted without a reason`
      ).toBeGreaterThan(80);
      if (receivableTypes().includes(key)) {
        // Declared in THIS tree — then it is not undeclared here, and the
        // exemption must not be doing any work.
        expect(
          registeredKeys().filter((k) => !receivableTypes().includes(k))
        ).not.toContain(key);
      }
    }
  });

  it("every registered schema key has a render branch", () => {
    const receivable = receivableTypes();
    const orphans = registeredKeys()
      // A part this build cannot receive needs no renderer — see receivableTypes().
      // The exemption is legitimate ONLY for ejection: the case above asserts
      // that nothing reaches this filter merely by being undeclared (#459).
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
});
