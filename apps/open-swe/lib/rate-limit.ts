export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

export const STRICT: RateLimitConfig = { windowMs: 60_000, maxRequests: 10 };
export const STANDARD: RateLimitConfig = { windowMs: 60_000, maxRequests: 60 };

interface CheckResult {
  allowed: boolean;
  retryAfterMs: number;
}

const MAX_ENTRIES = 10_000;

export class RateLimiter {
  private hits = new Map<string, number[]>();

  check(ip: string, config: RateLimitConfig): CheckResult {
    const now = Date.now();
    const windowStart = now - config.windowMs;

    if (this.hits.size > MAX_ENTRIES) {
      this.cleanup(now);
    }

    let timestamps = this.hits.get(ip);
    if (!timestamps) {
      timestamps = [];
      this.hits.set(ip, timestamps);
    }

    // Prune expired timestamps for this IP
    let firstValid = 0;
    for (let i = 0; i < timestamps.length; i++) {
      if (timestamps[i] > windowStart) {
        firstValid = i;
        break;
      }
      firstValid = i + 1;
    }
    if (firstValid > 0) {
      timestamps = timestamps.slice(firstValid);
      this.hits.set(ip, timestamps);
    }

    if (timestamps.length >= config.maxRequests) {
      // When there are no prior requests in-window (e.g. maxRequests=0),
      // fall back to the full window so retryAfterMs is finite, not NaN.
      const retryAfterMs =
        timestamps.length === 0
          ? config.windowMs
          : timestamps[0] + config.windowMs - now;
      return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 1000) };
    }

    timestamps.push(now);
    return { allowed: true, retryAfterMs: 0 };
  }

  cleanup(now = Date.now()): void {
    for (const [ip, timestamps] of this.hits) {
      const cutoff = now - 60_000 * 5; // keep last 5 min max
      const firstValid = timestamps.findIndex((t) => t > cutoff);
      if (firstValid === -1) {
        this.hits.delete(ip);
      } else if (firstValid > 0) {
        this.hits.set(ip, timestamps.slice(firstValid));
      }
    }
  }

  reset(ip?: string): void {
    if (ip) {
      this.hits.delete(ip);
    } else {
      this.hits.clear();
    }
  }
}

// Singleton for middleware use — survives HMR in dev, shared across requests
// in single-instance deployments.
const GLOBAL_KEY = "__open_swe_rate_limiter" as const;

function getLimiter(): RateLimiter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new RateLimiter();
  }
  return g[GLOBAL_KEY];
}

export { getLimiter };

export function extractIp(request: { headers: Headers }): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0].trim();
    if (first) return first;
  }
  const realIp = request.headers.get("x-real-ip");
  if (realIp) {
    const trimmed = realIp.trim();
    if (trimmed) return trimmed;
  }
  return "unknown";
}
