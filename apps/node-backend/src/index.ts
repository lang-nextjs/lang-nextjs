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

// Eager-init so first-request latency stays low and a wiring error is named at startup
// rather than on the first user's message.
//
// IT DOES NOT GATE STARTUP. The previous note here claimed a missing model key was not a
// construction error; ChatAnthropic validates its key in the constructor, so it was, and this
// line killed the process before listen(). Django and FastAPI both boot without a key — that
// is why the routing suite needs none — and a backend that calls itself a translation of
// main.py has to boot on the same inputs (#360).
for (const result of warmAll()) {
  if (!result.ok) {
    console.warn(
      `warmup skipped for ai_backend '${result.backend}': ${result.error}. ` +
        `The server is starting anyway; requests to this backend will fail with that reason.`
    );
  }
}

createApp().listen(PORT, () => {
  console.log(
    `node backend ready on :${PORT} ai_backends=${JSON.stringify(
      Object.keys(AI_BACKENDS)
    )} topologies=${JSON.stringify(topologiesByBackend())}`
  );
});
