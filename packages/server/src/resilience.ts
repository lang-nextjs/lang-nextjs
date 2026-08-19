/**
 * Stateless resilience gate for the DeepAgents SSE handler (RESIL-02/03/05/06).
 *
 * This module holds ZERO module-scope state. All persistence (rate-limit counts,
 * circuit-breaker state) is consumer-provided via the async store interfaces
 * below, so the library is correct under serverless/edge invocation isolation —
 * there is no shared singleton, no module-level Map, and no default global store.
 * The check helpers take the store as a parameter; two independent stores can
 * never interfere.
 *
 * The library only READS state and RECORDS outcomes. All state-machine
 * transition logic (e.g. enough failures → "open", reset-after window →
 * "half-open") lives inside the consumer-provided store implementation, which can
 * be backed by Redis, DynamoDB, an in-memory Map, or any other backend.
 */
import type { NextRequest } from "next/server";

/**
 * Consumer-provided rate-limit store. `check` reports whether the key is still
 * under its limit; `record` accounts a hit against the key within a window. The
 * window/limit semantics are entirely owned by the store implementation.
 */
export interface RateLimitStore {
  /** Returns true if the key is under the limit (request allowed). */
  check: (key: string) => Promise<boolean>;
  /** Accounts one hit for the key within the given window. */
  record: (key: string, windowMs: number) => Promise<void>;
}

/**
 * Consumer-provided circuit-breaker store. `getState` returns the current state
 * for a key; `recordEvent` reports a request outcome and (optionally) the reset
 * window. All transition logic — failure threshold → "open", reset window →
 * "half-open", success in half-open → "closed" — lives in the store.
 */
export interface CircuitBreakerStore {
  /** Returns the current breaker state for the key. */
  getState: (key: string) => Promise<"closed" | "open" | "half-open">;
  /** Records a request outcome, driving the store's state machine. */
  recordEvent: (
    key: string,
    outcome: "success" | "failure",
    resetAfterMs?: number
  ) => Promise<void>;
}

/**
 * Resilience configuration passed via handler options. Every field is optional —
 * a feature is active only when its store is provided. `timeoutMs` is declared
 * here so the config type is complete; it is consumed in Plan 04 (request
 * timeout) and is accepted without error here.
 */
export interface ResilienceConfig {
  /** Enable rate limiting. Active only when a store is provided. */
  rateLimitStore?: RateLimitStore;
  /** Derive the rate-limit key from the request. Defaults to the sessionId. */
  rateLimitKey?: (req: NextRequest) => string;
  /** Window passed to store.record on each allowed request. @default 60000 */
  rateLimitWindowMs?: number;
  /** Informational max — enforcement lives in the store. */
  rateLimitMax?: number;

  /** Enable the circuit breaker. Active only when a store is provided. */
  circuitBreakerStore?: CircuitBreakerStore;
  /** Derive the breaker key from the request. Defaults to the sessionId. */
  circuitBreakerKey?: (req: NextRequest) => string;
  /** Informational failure threshold — enforcement lives in the store. */
  circuitBreakerFailureThreshold?: number;
  /** Reset window passed to store.recordEvent (open → half-open after this). */
  circuitBreakerResetMs?: number;

  /** Request timeout in ms. Consumed in Plan 04; accepted here for type completeness. */
  timeoutMs?: number;
}

/**
 * Thin, pure wrapper over a RateLimitStore. Returns true if the request is under
 * the limit (allowed). Carries no state — the store is the sole source of truth.
 */
export async function checkRateLimit(
  store: RateLimitStore,
  key: string
): Promise<boolean> {
  return store.check(key);
}

/**
 * Thin, pure wrapper over a CircuitBreakerStore. Returns the current state and
 * whether the request is allowed (allowed only when the breaker is not "open").
 * Carries no state — the store is the sole source of truth.
 */
export async function checkCircuit(
  store: CircuitBreakerStore,
  key: string
): Promise<{ allowed: boolean; state: string }> {
  const state = await store.getState(key);
  return { allowed: state !== "open", state };
}
