/**
 * WHAT THE ADAPTER EMITS MUST BE WHAT THE CARD'S SCHEMA PARSES (#429).
 *
 * #420 was built by two people across a package boundary: the adapter turns
 * LangChain's `event: approval_pending` into a `data-approval-pause` part
 * (packages/server), and the card parses it with `ApprovalPauseSchema`
 * (packages/react). Each side has its own tests, and each side's tests use its
 * OWN fixture. So until this file existed, the only thing making the two agree
 * was that two people had read each other's code.
 *
 * THE FAILURE IS SILENT, WHICH IS WHY IT NEEDS A GUARD RATHER THAN CARE.
 * `partsToMessages` console.warns and DROPS a `data-*` part that does not match
 * its registered schema. A rename on either side — the wrapper key, the part
 * type, `action_requests` to `actionRequests` — produces no red anywhere. It
 * produces a card that never renders, which is the shape #420 exists to remove,
 * one layer up.
 *
 * This is the same instrument as approval-frame-conformance.test.ts beside it,
 * pointed at a second boundary. Its header states the general case exactly:
 * "between those two readers sits a whole class of change that passes every test
 * and reaches nobody."
 *
 * BOTH REAL IMPLEMENTATIONS, NO COPIED FIXTURE. A fixture copied from either
 * package into the other would assert nothing about the other side — it would be
 * two packages agreeing with themselves while looking like coverage.
 *
 * Cross-package by necessity, like its neighbours: packages/server has no
 * dependency on packages/react and should not grow one to hold a test. Both
 * files are excluded from the package tsconfig's `rootDir` program and
 * typechecked by tsconfig.parity.json instead.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { createLangchainTransform } from "../../server/src/adapters/langchain";
import type { SseFrame } from "../../server/src/accumulator";
import { ApprovalPauseSchema } from "../../react/src/schemas";

/**
 * The frame as the Python backends put it on the wire.
 *
 * `apps/fastapi-backend/ai_backends/langchain.py` emits
 *
 *     event: approval_pending
 *     data: {"interrupt": <upstream interrupt value>}
 *
 * with the interrupt carried verbatim — snake_case keys and upstream's four-way
 * vocabulary, neither of which is ours to rename at this boundary.
 */
function approvalPendingFrame(interrupt: unknown): SseFrame {
  return {
    raw: `event: approval_pending\ndata: ${JSON.stringify({ interrupt })}`,
  };
}

/**
 * The FIRST part the adapter produced, parsed back off the wire.
 *
 * Reads the `data:` lines rather than slicing the raw string — some branches of
 * this adapter emit more than one part in a single frame (a token becomes
 * text-start plus text-delta), and a naive slice turns that into a JSON parse
 * error that reads like a failed assertion about the schema.
 */
function emittedPart(frame: SseFrame | null): Record<string, unknown> {
  expect(frame, "the adapter emitted nothing for this event").not.toBeNull();
  const dataLines = frame!.raw
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice(6));
  expect(dataLines.length, `no data line in: ${frame!.raw}`).toBeGreaterThan(0);
  return JSON.parse(dataLines[0]!) as Record<string, unknown>;
}

/** An interrupt in the shape upstream's HITL middleware actually raises. */
const UPSTREAM_INTERRUPT = {
  action_requests: [
    {
      name: "increment",
      args: { by: 1 },
      description: "Tool execution requires approval",
    },
  ],
  review_configs: [
    {
      action_name: "increment",
      allowed_decisions: ["approve", "edit", "reject", "respond"],
    },
  ],
};

describe("the adapter's pause frame and the card's schema agree (#429)", () => {
  it("a frame the adapter really emits PARSES with the real schema", () => {
    const transform = createLangchainTransform();
    const part = emittedPart(
      transform(approvalPendingFrame(UPSTREAM_INTERRUPT))
    );

    // The part TYPE is half the contract — the card registers a schema against
    // this exact string, and a rename here is as silent as a shape change.
    expect(part.type).toBe("data-approval-pause");

    const parsed = ApprovalPauseSchema.safeParse(part.data);
    expect(
      parsed.success,
      `the card's schema rejected what the adapter emitted: ${
        parsed.success ? "" : JSON.stringify(parsed.error.issues)
      }`
    ).toBe(true);
  });

  it("the payload survives the crossing intact, keys and vocabulary", () => {
    // Not merely "it parses". A schema with every field optional would also
    // parse. These are the values the card renders from: the tool it names, the
    // arguments the decision is made against, and the controls it may offer.
    const transform = createLangchainTransform();
    const part = emittedPart(
      transform(approvalPendingFrame(UPSTREAM_INTERRUPT))
    );
    const parsed = ApprovalPauseSchema.parse(part.data);

    expect(parsed.interrupt.action_requests[0]!.name).toBe("increment");
    expect(parsed.interrupt.action_requests[0]!.args).toEqual({ by: 1 });
    expect(parsed.interrupt.review_configs?.[0]!.allowed_decisions).toEqual([
      "approve",
      "edit",
      "reject",
      "respond",
    ]);
  });

  it("MULTI-ACTION: a pause carrying several calls crosses without collapsing", () => {
    // Measured upstream: one AI message with two gated calls raises ONE
    // interrupt carrying both, with action_requests and review_configs appended
    // in lockstep. The card pairs them BY INDEX, so an adapter that collapsed or
    // reordered either list would mis-associate decisions with calls.
    const transform = createLangchainTransform();
    const part = emittedPart(
      transform(
        approvalPendingFrame({
          action_requests: [
            { name: "increment", args: { by: 1 }, description: null },
            { name: "wipe", args: { path: "/" }, description: null },
          ],
          review_configs: [
            { action_name: "increment", allowed_decisions: ["approve"] },
            { action_name: "wipe", allowed_decisions: ["reject"] },
          ],
        })
      )
    );
    const parsed = ApprovalPauseSchema.parse(part.data);

    expect(parsed.interrupt.action_requests.map((a) => a.name)).toEqual([
      "increment",
      "wipe",
    ]);
    expect(parsed.interrupt.review_configs?.map((c) => c.action_name)).toEqual([
      "increment",
      "wipe",
    ]);
  });
});

describe("the schema REJECTS what is not that shape (#429 positive control)", () => {
  /*
   * THE HALF THAT KEEPS THE GREEN MEANINGFUL, and the reason this file replaces
   * a `JSON.parse` reader rather than adding to one.
   *
   * Every assertion above is satisfied by a schema that accepts anything —
   * which is precisely what the two sides had before: each parsed its own
   * fixture with `JSON.parse`, which accepts any object at all. These cases
   * demonstrate on every run that the validator DOES reject, so a green above
   * means the payload passed rather than that nothing was checked.
   */
  it("a camelCased envelope is rejected — the rename this file exists to catch", () => {
    const drifted = {
      interrupt: {
        actionRequests: [{ name: "increment", args: {} }],
        reviewConfigs: [
          { actionName: "increment", allowedDecisions: ["approve"] },
        ],
      },
    };
    expect(ApprovalPauseSchema.safeParse(drifted).success).toBe(false);
  });

  it("a decision outside upstream's four is rejected", () => {
    // The AI SDK's `{id, approved, reason}` vocabulary, leaking back in.
    const collapsed = {
      interrupt: {
        action_requests: [{ name: "increment", args: {} }],
        review_configs: [
          { action_name: "increment", allowed_decisions: ["approved"] },
        ],
      },
    };
    expect(ApprovalPauseSchema.safeParse(collapsed).success).toBe(false);
  });

  it("a different part from the same adapter does not pass as a pause", () => {
    // Drives the REAL adapter down another branch and shows its output is not
    // accepted here — so the schema is discriminating between this adapter's
    // own frames, not merely rejecting nonsense.
    const transform = createLangchainTransform();
    const token = transform({
      raw: `event: token\ndata: ${JSON.stringify({
        type: "token",
        text: "hi",
      })}`,
    });
    const part = emittedPart(token);
    expect(part.type).not.toBe("data-approval-pause");
    expect(ApprovalPauseSchema.safeParse(part.data).success).toBe(false);
  });
});

/*
 * EVERY GATING RUNG'S ADAPTER, NOT ONLY THE FIRST ONE (#332 steps C2-C5).
 *
 * Everything above drives `createLangchainTransform`, because when this file was
 * written langchain was the only rung that gated. #332 arms the others one rung
 * at a time, and each newly armed rung emits `event: approval_pending` from its
 * Python backend into an adapter that was never asked whether it handles one.
 *
 * MEASURED, and it is why this block exists rather than a note on the issue:
 * `packages/server/src/adapters/langgraph.ts` contains zero references to
 * `approval_pending` or `interrupt`, and its parser opens with
 * `if (!line.startsWith("data: ")) return frame;` — so the event line is skipped
 * and the pause is dropped before any component could see it. The backend
 * withholds the tool correctly and the person is told nothing, which is the
 * defect #413 held the whole gate disarmed to avoid, and #448 is the same frame
 * being emitted and consumed while parsed by nothing.
 *
 * THE LIST IS DELIBERATE AND MUST GROW WITH THE DECLARATION. It cannot be
 * derived here — the source of truth is `GATED_TOPOLOGIES` in the Python
 * backends, on the other side of a language boundary. What keeps it honest is
 * that arming a rung already requires editing a tripwire test in both Python
 * planes; this is the third edit that arming costs, and it is the one that makes
 * the pause reach a person.
 */
/**
 * The adapter directory, read from disk.
 *
 * NOT `import.meta.glob`, which the first version used: it is a Vite/Vitest
 * transform rather than a member of the standard `ImportMeta`, so it runs
 * correctly and does not typecheck — TS2339 on a package whose typecheck is a
 * gate. Adding `vite/client` to the tsconfig types would have silenced it by
 * widening what this package's types admit, for one call.
 *
 * NOT rungs.json EITHER, and that is the more interesting of the two rejected
 * options. The manifest is already the totality source below; deriving the
 * discovered set from it too would make the two sides of that comparison the
 * same reading, and an equality check between a thing and itself cannot fail.
 * The check is worth having precisely BECAUSE the filesystem and the manifest
 * are independent: it catches an adapter deleted while the manifest still lists
 * its rung, and a rung pruned from the manifest while its adapter survives.
 */
const ADAPTER_DIR = fileURLToPath(
  new URL("../../server/src/adapters/", import.meta.url)
);
const ADAPTER_FILES = readdirSync(ADAPTER_DIR);

/**
 * The rungs whose Python backend gates, as a deliberate list.
 *
 * The source of truth is `GATED_TOPOLOGIES` in the backends, on the other side of
 * a language boundary, so it cannot be derived here. What keeps it honest is the
 * totality check below and the fact that arming a rung already requires editing a
 * tripwire test in both Python planes.
 */
const GATING_RUNGS = ["langchain", "langgraph"] as const;

/** The rung ids this tree still contains, from the manifest the eject rewrites. */
function rungsInThisTree(): Set<string> {
  const manifest = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../../rungs.json", import.meta.url)),
      "utf8"
    )
  ) as { rungs: { id: string }[] };
  return new Set(manifest.rungs.map((r) => r.id));
}

const PRESENT_RUNGS = rungsInThisTree();
const EXPECTED = GATING_RUNGS.filter((r) => PRESENT_RUNGS.has(r));
const DISCOVERED = GATING_RUNGS.filter((rung) =>
  ADAPTER_FILES.includes(`${rung}.ts`)
);

/** The one `create*Transform` an adapter module exports. */
async function transformFactoryFor(
  rung: string
): Promise<() => (f: SseFrame) => SseFrame | null> {
  expect(
    ADAPTER_FILES.includes(`${rung}.ts`),
    `no adapter module discovered for ${rung}`
  ).toBe(true);
  // A COMPUTED SPECIFIER, WHICH IS ALSO WHAT KEEPS THIS FILE FORKABLE. A literal
  // `import("../../server/src/adapters/langgraph")` is a static dependency —
  // eject's coherence check matches dynamic imports with literal paths too, and
  // correctly refused this file when it had one: packages/test-utils is shared and
  // that adapter is rung-2-owned (#588). Built from the discovered filename, the
  // dependency does not exist for a fork that lacks the rung.
  const mod = (await import(join(ADAPTER_DIR, `${rung}.ts`))) as Record<
    string,
    unknown
  >;
  const names = Object.keys(mod).filter((n) => /^create\w*Transform$/.test(n));
  expect(
    names,
    `${rung}'s adapter must export exactly one create*Transform; found ${
      names.join(", ") || "none"
    }`
  ).toHaveLength(1);
  return mod[names[0]!] as () => (f: SseFrame) => SseFrame | null;
}

describe("every gating rung's adapter carries the pause across", () => {
  /*
   * A SUITE THAT DISCOVERS ITS SUBJECTS CAN DISCOVER ZERO AND REPORT SUCCESS.
   *
   * That is this repo's favourite failure and it is the whole risk of the change
   * that made this file forkable: a glob that silently stops matching leaves a
   * green conformance suite asserting nothing at all. So the discovered set is
   * checked against what rungs.json says is HERE — which the eject rewrites, so a
   * rung-1 fork legitimately expects one and the full tree expects two. "Found
   * nothing" and "nothing to find" then have different verdicts.
   */
  it("discovers exactly the gating adapters this tree contains", () => {
    expect(DISCOVERED).toEqual(EXPECTED);
    expect(
      DISCOVERED.length,
      "no gating adapter was discovered, so every case below would silently not run"
    ).toBeGreaterThan(0);
  });

  for (const rung of DISCOVERED) {
    it(`${rung}: an approval_pending frame becomes a schema-valid pause part`, async () => {
      const transform = (await transformFactoryFor(rung))();
      const part = emittedPart(
        transform(approvalPendingFrame(UPSTREAM_INTERRUPT))
      );

      expect(
        part.type,
        `${rung}'s adapter emitted ${JSON.stringify(part.type)} for an ` +
          `approval_pending frame. The tool is withheld and the client is told ` +
          `nothing — a 200 whose only distinguishing feature is an absence.`
      ).toBe("data-approval-pause");

      const parsed = ApprovalPauseSchema.safeParse(part.data);
      expect(
        parsed.success,
        `the card's schema rejected what ${rung}'s adapter emitted: ${
          parsed.success ? "" : JSON.stringify(parsed.error.issues)
        }`
      ).toBe(true);

      // The values the card actually renders from. "It parses" is satisfied by a
      // schema with every field optional.
      const value = ApprovalPauseSchema.parse(part.data);
      expect(value.interrupt.action_requests[0]!.name).toBe("increment");
      expect(value.interrupt.review_configs?.[0]!.allowed_decisions).toEqual([
        "approve",
        "edit",
        "reject",
        "respond",
      ]);
    });
  }
});
