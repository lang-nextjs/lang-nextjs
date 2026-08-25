import { deepagentsAdapter } from "@deepagents-nextjs/server";
import type { AdapterEntry } from "./registry";

/** RUNG-3-OWNED — see ./langchain.ts for why the named import is safe here. */
export const entry: AdapterEntry = {
  id: "deepagents",
  adapter: deepagentsAdapter,
};
