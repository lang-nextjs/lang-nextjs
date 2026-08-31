import type { ReactNode } from "react";
import type { CardContext, CardPack, CardRenderer } from "./registry";
import * as registry from "./registry";

/**
 * Public face of the card registry.
 *
 * `import * as` is the point: it names no rung, so nothing here can be pruned out from under
 * it when a rung is ejected. Whatever packs the barrel still exports is what a fork renders.
 */
function packs(): readonly CardPack[] {
  return Object.values(registry as Record<string, unknown>).filter(
    (v): v is CardPack => typeof v === "object" && v !== null
  );
}

/**
 * Combine packs into one part-type → renderer map.
 *
 * THROWS ON COLLISION rather than letting the last pack win. Two rungs claiming the same
 * part type is a real modelling error — a card belongs to the lowest rung that emits its
 * payload, and higher rungs inherit it — but a silent last-write-wins would surface as the
 * wrong card rendering, which reads as a styling bug and gets investigated as one.
 */
export function mergePacks(all: readonly CardPack[]): CardPack {
  const merged: Record<string, CardRenderer> = {};
  for (const pack of all) {
    for (const [partType, renderer] of Object.entries(pack)) {
      if (partType in merged) {
        throw new Error(
          `Two rung card packs both claim "${partType}". A card belongs to the lowest rung ` +
            `that emits its payload; higher rungs inherit it through \`requires\`.`
        );
      }
      merged[partType] = renderer;
    }
  }
  return merged;
}

/** Every rung-owned part type this build can render, given what survived eject. */
export function cardRenderers(): CardPack {
  return mergePacks(packs());
}

/**
 * Render one stream part, or null if no present rung claims its type.
 *
 * NULL, NOT A THROW. A fork that dropped a rung should render a smaller conversation, not a
 * broken page — the backend may still emit a part whose card left with its rung. That is the
 * same "unknown type renders nothing" behaviour the surface had before the registry existed,
 * so degrading is not a new failure mode.
 */
export function renderPart(
  partType: string,
  data: unknown,
  ctx?: CardContext
): ReactNode {
  const renderer = cardRenderers()[partType];
  return renderer ? renderer(data, ctx) : null;
}

export type { CardContext, CardPack, CardRenderer };
