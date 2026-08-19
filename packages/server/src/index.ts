/**
 * @deepagents-nextjs/server
 *
 * Next.js App Router SSE proxy handler for DeepAgents backends.
 *
 * Usage (two-line consumer setup):
 *   import { createDeepAgentsHandler } from '@deepagents-nextjs/server'
 *   export const POST = createDeepAgentsHandler({ backendUrl: process.env.BACKEND_URL! })
 */
export { createDeepAgentsHandler } from "./handler";
export type { DeepAgentsHandlerOptions } from "./handler";
export { defaultTransforms } from "./transforms";
export type { SseFrame, SseTransform, SseMultiTransform } from "./accumulator";
// NEW: adapter system
export { deepagentsAdapter } from "./adapters/deepagents";
export type { SseAdapter } from "./adapters/deepagents";
export { langGraphAdapter } from "./adapters/langgraph";
export {
  langchainAdapter,
  createLangchainTransform,
} from "./adapters/langchain";
export { openSweAdapter, createOpenSweTransform } from "./adapters/openSwe";
export { createOpenSweEnrichTransform } from "./adapters/openSweEnrich";
export { createDeepAgentsEnrichTransform } from "./adapters/deepagentsEnrich";
export { transformSseStream } from "./stream-transform";
export { createHeartbeatStream } from "./adapters/openSweHeartbeat";
export type { HeartbeatOptions } from "./adapters/openSweHeartbeat";
export { getCookieToken } from "./get-cookie-token";
export {
  createDeepAgentsResumeHandler,
  isStreamReconnectEnabled,
} from "./reconnect";
// Approval gating (ADAPT-05)
export { createApprovalRoutes } from "./approval-routes";
export { createApprovalGatingTransform } from "./adapters/approvalGating";
export type { ApprovalGatingConfig } from "./adapters/approvalGating";
// Observability (OBS-01..04)
export type {
  ObservabilityHooks,
  OnRequestContext,
  OnFetchStartContext,
  OnFetchEndContext,
  OnStreamStartContext,
  OnTransformBeginContext,
  OnTransformEndContext,
  OnErrorContext,
  OnStreamEndContext,
} from "./observability";
export { getSafeCurrentTime } from "./timing";
// Health & readiness probes (PROBE-01..05)
export { createHealthProbe, createReadinessProbe } from "./health";
export type {
  ProbeCheck,
  HealthProbeResult,
  ReadinessProbeConfig,
  ReadinessProbeResult,
} from "./health";
// Resilience: stateless rate-limit + circuit-breaker stores (RESIL-02/03/05/06)
export { checkRateLimit, checkCircuit } from "./resilience";
export type {
  RateLimitStore,
  CircuitBreakerStore,
  ResilienceConfig,
} from "./resilience";
// Graceful shutdown (OPS-01, Node-only/opt-in) — wire isDraining() into createReadinessProbe
export { createGracefulShutdown } from "./shutdown";
export type { ShutdownConfig, GracefulShutdown } from "./shutdown";
