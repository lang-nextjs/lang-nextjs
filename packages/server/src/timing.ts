/**
 * Edge-safe time source for observability metrics (OBS-04).
 *
 * Get the current time in milliseconds using the most reliable API available
 * in the current runtime, guarding against runtimes where `performance.now()`
 * is missing, throws, or returns a non-finite value (NaN / ±Infinity):
 *
 * - Node.js:                              performance.now() (sub-ms precision)
 * - Cloudflare Workers (nodejs_compat,    performance.now()
 *   compatibility_date >= 2025-03-17)
 * - Deno / Vercel Edge:                   performance.now()
 * - Fallback (older Cloudflare, etc.):    Date.now() (ms precision)
 *
 * Never throws — a missing or broken `performance.now()` silently falls back to
 * `Date.now()`. This keeps timing instrumentation from ever aborting a stream
 * or poisoning timestamp math (NaN propagates through every subtraction).
 */
export function getSafeCurrentTime(): number {
  try {
    if (typeof performance !== "undefined" && performance.now) {
      const t = performance.now();
      // Some broken browser polyfills / edge shims return NaN (or ±Infinity
      // from an overflow) instead of throwing. Reject any non-finite value so
      // observability timestamps stay safe for subtraction / comparison.
      if (Number.isFinite(t)) {
        return Math.round(t);
      }
    }
  } catch {
    // performance.now() threw (shouldn't happen on conformant runtimes, but
    // some edge shims do) — fall through to the Date.now() fallback below.
  }
  return Date.now();
}
