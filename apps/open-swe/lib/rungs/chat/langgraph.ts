import { langGraphAdapter } from "@deepagents-nextjs/server";
import type { ChatRungEntry } from "./registry";

/** RUNG-2-OWNED — see ./langchain.ts for why the named import is safe here. */
export const entry: ChatRungEntry = {
  id: "langgraph",
  adapter: langGraphAdapter,
};
