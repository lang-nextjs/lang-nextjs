export interface RateLimitConfig {
  /**
   * BUCKET CLASS. Two configs with different names never share a counter.
   *
   * Required, deliberately: before #127 the bucket was keyed on IP alone, so
   * `check(ip, STANDARD)` and `check(ip, STRICT)` read and wrote ONE timestamp
   * array. The dashboard's 5s poll (12 GETs/min, well inside STANDARD's 60)
   * therefore drained the 10/min STRICT budget that task submission needs, and
   * every POST 429'd about 50s after the page was opened — permanently, since
   * the poll kept refilling the window.
   *
   * Making this required rather than optional is the point: a config with no
   * declared class IS that defect, so it should not compile. There is no
   * default and no fallback to a shared bucket.
   */
  name: string;
  windowMs: number;
  maxRequests: number;
}

export const STRICT: RateLimitConfig = {
  name: "strict",
  windowMs: 60_000,
  maxRequests: 10,
};
export const STANDARD: RateLimitConfig = {
  name: "standard",
  windowMs: 60_000,
  maxRequests: 60,
};

/**
 * Bucket key. The class goes FIRST because the IP half can be attacker-supplied
 * (extractIp reads x-forwarded-for). Leading with the class means no header
 * value can spoof its way into another class's bucket.
 */
function bucketKey(ip: string, config: RateLimitConfig): string {
  return `${config.name}|${ip}`;
}

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
    const key = bucketKey(ip, config);

    if (this.hits.size > MAX_ENTRIES) {
      this.cleanup(now);
    }

    let timestamps = this.hits.get(key);
    if (!timestamps) {
      timestamps = [];
      this.hits.set(key, timestamps);
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
      this.hits.set(key, timestamps);
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
    for (const [key, timestamps] of this.hits) {
      const cutoff = now - 60_000 * 5; // keep last 5 min max
      const firstValid = timestamps.findIndex((t) => t > cutoff);
      if (firstValid === -1) {
        this.hits.delete(key);
      } else if (firstValid > 0) {
        this.hits.set(key, timestamps.slice(firstValid));
      }
    }
  }

  reset(ip?: string): void {
    if (ip) {
      // Keys are `${class}|${ip}`, so one IP now spans several buckets.
      // Deleting the bare IP would silently clear nothing.
      const suffix = `|${ip}`;
      for (const key of this.hits.keys()) {
        if (key.endsWith(suffix)) this.hits.delete(key);
      }
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
