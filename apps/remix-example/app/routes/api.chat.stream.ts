import { createDeepAgentsHandler } from "@deepagents-nextjs/remix";

export const action = createDeepAgentsHandler({
  backendUrl: process.env.BACKEND_URL || "http://localhost:8000/stream",
});
