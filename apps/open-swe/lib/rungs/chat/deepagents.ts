import {
  createDeepAgentsEnrichTransform,
  deepagentsAdapter,
  type SseTransform,
} from "@deepagents-nextjs/server";
import type { ChatRungEntry } from "./registry";

/**
 * RUNG-3-OWNED — see ./langchain.ts for why the named imports are safe here.
 *
 * TWO rung-3 symbols, not one. The enrichment transform maps deepagents' built-in tool calls
 * (write_todos / write_file / edit_file / read_file / task) into data-* parts, which is what
 * makes the Tasks / Files / Sub-agents cards appear. It came from
 * packages/server/src/adapters/deepagentsEnrich.ts, which rung 3 owns — so the shared route
 * naming it was the same defect as the adapter table, one line further down.
 *
 * The transform pairs with lib/rungs/cards/deepagents.tsx: this rung emits those parts and
 * that pack renders them. Ejecting rung 3 removes both halves together.
 */
export const entry: ChatRungEntry = {
  id: "deepagents",
  adapter: deepagentsAdapter,
  transforms: () => [
    createDeepAgentsEnrichTransform() as unknown as SseTransform,
  ],
};
