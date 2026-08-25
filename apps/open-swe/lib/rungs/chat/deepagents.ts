import {
  deepagentsAdapter,
  createDeepAgentsEnrichTransform,
  type SseTransform,
} from "@deepagents-nextjs/server";
import type { ChatRungEntry } from "./registry";

/**
 * RUNG-3-OWNED — see ./langchain.ts for why the named imports are safe here.
 *
 * WHY THE ENRICH TRANSFORM IS DECLARED AT RUNG 3 BUT APPLIES TO EVERY BACKEND.
 * The route applied `createDeepAgentsEnrichTransform()` unconditionally — to langchain and
 * langgraph requests as well as deepagents ones. That is arguably wrong, and it is NOT
 * changed here: a severability fix that also alters which transforms run would make any
 * resulting behaviour change impossible to attribute. Preserved as-is, and flagged.
 *
 * What DOES change is that it now leaves with rung 3. A fork below rung 3 has no deepagents
 * enrichment, which is correct — the transform maps deepagents' own tool vocabulary.
 */
export const entry: ChatRungEntry = {
  id: "deepagents",
  adapter: deepagentsAdapter,
  transforms: () => [
    createDeepAgentsEnrichTransform() as unknown as SseTransform,
  ],
};
