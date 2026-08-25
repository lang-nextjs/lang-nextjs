import { langchainAdapter } from "@deepagents-nextjs/server";
import type { AdapterEntry } from "./registry";

/**
 * RUNG-1-OWNED. Declared in rungs.json under `langchain.owns.ts`, so `pnpm eject` deletes
 * this file with the rung and prunes the barrel line that re-exported it.
 *
 * Naming `langchainAdapter` here is correct precisely because this file dies with it. The
 * same import from a shared file is the defect severability.test.ts exists to catch.
 */
export const entry: AdapterEntry = {
  id: "langchain",
  adapter: langchainAdapter,
};
