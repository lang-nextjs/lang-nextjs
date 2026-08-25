import { langchainAdapter } from "@deepagents-nextjs/server";
import type { ChatRungEntry } from "./registry";

/**
 * RUNG-1-OWNED.
 *
 * The named import is safe here precisely because this module is rung-owned: `eject` deletes
 * this file whenever it prunes `langchainAdapter` from the server barrel, so the two can
 * never disagree. That is the whole reason the edge lives in a rung-owned file rather than
 * in the route.
 */
export const entry: ChatRungEntry = {
  id: "langchain",
  adapter: langchainAdapter,
};
