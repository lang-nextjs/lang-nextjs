/**
 * Entry point. Warms the backends, then listens.
 *
 * WARMUP GOES THROUGH THE REGISTRY, never by naming a module — main.py's
 * lifespan learned that when `pnpm eject` left it calling a module it had just
 * deleted, and the whole backend died at boot rather than one rung.
 */
import { createApp } from "./server.js";
import { AI_BACKENDS, topologiesByBackend, warmAll } from "./registry.js";

const PORT = Number(process.env.PORT ?? 8003);

// Eager-init so first-request latency stays low and any construction error
// surfaces at startup rather than on the first user's message. A missing model
// key is NOT a construction error here — makeLlm() falls through to Anthropic
// and only fails on use — so this is about wiring, not configuration.
warmAll();

createApp().listen(PORT, () => {
  console.log(
    `node backend ready on :${PORT} ai_backends=${JSON.stringify(
      Object.keys(AI_BACKENDS)
    )} topologies=${JSON.stringify(topologiesByBackend())}`
  );
});
