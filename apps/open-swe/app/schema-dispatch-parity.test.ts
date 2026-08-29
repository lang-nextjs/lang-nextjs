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
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(__dirname, "page.tsx"), "utf-8");

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
    ...new Set(
      [...source.matchAll(/msg\.type === "(data-[a-z-]+)"/g)].map((m) => m[1])
    ),
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
    expect(
      dispatchedTypes().length,
      "dispatch reader matched nothing — the regex has drifted from page.tsx"
    ).toBeGreaterThanOrEqual(9);
  });

  it("every registered schema key has a render branch", () => {
    const orphans = registeredKeys().filter(
      (k) => !dispatchedTypes().includes(k)
    );
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
