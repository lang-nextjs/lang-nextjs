/**
 * The DeepAgents-flavoured handler. RUNG-OWNED entry point, not core.
 *
 * This is the two-line consumer setup the package is named for:
 *
 *   import { createDeepAgentsHandler } from '@deepagents-nextjs/server'
 *   export const POST = createDeepAgentsHandler({ backendUrl: process.env.BACKEND_URL! })
 *
 * All it does is bind `deepagentsAdapter` as the default and delegate to the transport
 * core. That binding used to live in handler.ts, which meant the core imported a rung and
 * could not be severed from it — deleting the DeepAgents rung broke the transport for the
 * four rungs that had nothing to do with DeepAgents. A convenience default belongs at a
 * rung-owned entry point; this file is that point. See issue #17.
 *
 * Behaviour is identical to before: an omitted `adapter` still resolves to
 * `deepagentsAdapter`, so the messageId strip still runs by default (SRV-04).
 */
import { createSseProxyHandler } from "./handler";
import type { DeepAgentsHandlerOptions } from "./handler";
import { deepagentsAdapter } from "./adapters/deepagents";

/**
 * Creates a Next.js App Router POST handler that proxies SSE streams from a DeepAgents
 * backend, defaulting to `deepagentsAdapter` when no adapter is supplied.
 */
export function createDeepAgentsHandler(options: DeepAgentsHandlerOptions) {
  // `?? deepagentsAdapter` rather than spreading a default first: an explicitly passed
  // `adapter: undefined` must resolve to the DeepAgents default, exactly as the previous
  // `options.adapter ?? deepagentsAdapter` in handler.ts did.
  return createSseProxyHandler({
    ...options,
    adapter: options.adapter ?? deepagentsAdapter,
  });
}
