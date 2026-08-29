import { langchainAdapter } from "@deepagents-nextjs/server";
import type { ChatRungEntry } from "./registry";

/**
 * RUNG-1-OWNED. Declared in rungs.json under `langchain.owns.ts`, so `pnpm eject` deletes
 * this file with the rung and prunes the barrel line that re-exported it.
 *
 * Naming `langchainAdapter` here is correct precisely because this file dies with it. The
 * same import from a shared file is the defect this registry exists to remove.
 */
export const entry: ChatRungEntry = {
  id: "langchain",
  adapter: langchainAdapter,
};
