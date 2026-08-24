import { Hono } from "hono";
import { unifiedWebhookHandler } from "./github/unified-webhook.js";

export const app = new Hono();

// GitHub webhooks can come to either root path or /webhooks/github
app.post("/", unifiedWebhookHandler);
app.post("/webhooks/github", unifiedWebhookHandler);

// Optional: Add specific debug routes instead of catch-all
app.get("/debug/test", (c) => {
  return c.json({ message: "Debug endpoint working" });
});

// Do NOT add catch-all routes (app.all("*")) as they interfere with LangGraph API
