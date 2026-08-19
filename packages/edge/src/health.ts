// Copied from @deepagents-nextjs/server — avoids cross-package dep that would pull in Next.js
//
// SOURCE OF TRUTH: packages/server/src/health.ts
// This is a verbatim copy (copy-not-import, mirrors SseFrameAccumulator). The
// factories use only Web-standard APIs (Promise, setTimeout) so the same source
// is safe in edge runtimes. Update this copy whenever the server source changes.

/**
 * Stateless liveness/readiness probe factories (PROBE-01..05).
 *
 * Source of truth: this file. Copied verbatim (copy-not-import) into
 * @deepagents-nextjs/{sveltekit,remix,edge} so probes are framework-agnostic
 * and the edge package never pulls in a Next.js dependency.
 *
 * Design constraints:
 * - STATELESS: no module-scope mutable state. Draining is supplied per-call
 *   (a `draining` boolean or an `isDraining()` callback), forward-compatible
 *   with Phase 19 graceful shutdown flipping it.
 * - CHEAP readiness by default: the default path performs NO backend
 *   round-trip. Dependency checks are OPTIONAL and consumer-supplied.
 * - NO info leak: responses contain only minimal status fields — no version,
 *   backend URL, env, or per-dependency detail.
 * - Web-API only: uses Promise/setTimeout. Any fetch/AbortController usage
 *   lives in consumer-supplied checks, so the same source copies cleanly to
 *   edge with no modification.
 */

/**
 * A consumer-supplied probe check. Returns true when healthy/ready.
 * Bounded by `timeoutMs` (default 5000); a timeout or thrown error is
 * recorded as `false` rather than propagated.
 */
export interface ProbeCheck {
  name: string;
  check: () => Promise<boolean>;
  timeoutMs?: number;
}

/** Result of a liveness probe. Minimal — no leaked internals. */
export interface HealthProbeResult {
  ok: boolean;
  status: "ok" | "error";
  checks: Record<string, boolean>;
  timestamp: number;
}

/** Configuration for a readiness probe. */
export interface ReadinessProbeConfig {
  /** Static draining flag — when true, readiness is false. */
  draining?: boolean;
  /**
   * Dynamic draining signal. Preferred over `draining` for Phase 19 shutdown
   * where a shared flag is flipped at runtime. May be sync or async.
   */
  isDraining?: () => boolean | Promise<boolean>;
  /**
   * Optional, consumer-supplied dependency checks. OMITTED by default —
   * readiness stays cheap with no backend round-trip unless opted in.
   */
  checks?: ProbeCheck[];
}

/** Result of a readiness probe. Minimal — no per-dependency detail leaked. */
export interface ReadinessProbeResult {
  ready: boolean;
  status: "ok" | "draining" | "error";
  timestamp: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Run a single check bounded by its timeout. A timeout or thrown error
 * resolves to `false` — never rejects.
 */
async function runCheck(check: ProbeCheck): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), check.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    });
    return await Promise.race([check.check(), timeout]);
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Liveness probe (PROBE-01). Returns ok:true with a minimal `{status:"ok"}`-shaped
 * payload when all (optional) checks pass. Each check is bounded by `timeoutMs`;
 * a timeout or error records that check as `false` and flips ok:false.
 *
 * The response object contains ONLY `{ ok, status, checks, timestamp }` —
 * no version, backend URL, env, or other internal detail (PROBE-05).
 */
export async function createHealthProbe(
  checks: ProbeCheck[] = [],
): Promise<HealthProbeResult> {
  const timestamp = Date.now();
  const results: Record<string, boolean> = {};

  await Promise.all(
    checks.map(async (c) => {
      results[c.name] = await runCheck(c);
    }),
  );

  const ok = Object.values(results).every((v) => v === true);
  return {
    ok,
    status: ok ? "ok" : "error",
    checks: results,
    timestamp,
  };
}

/**
 * Readiness probe (PROBE-02, PROBE-03). Returns ready:false when draining or
 * when any opted-in dependency check fails; ready:true otherwise.
 *
 * CHEAP BY DEFAULT: with no checks supplied this performs NO fetch / no backend
 * round-trip. Dependency checks are optional and consumer-supplied.
 *
 * The response object contains ONLY `{ ready, status, timestamp }` — no
 * per-dependency detail, version, backend URL, or env (PROBE-05).
 */
export async function createReadinessProbe(
  config: ReadinessProbeConfig = {},
): Promise<ReadinessProbeResult> {
  const timestamp = Date.now();

  const draining =
    config.draining === true ||
    (config.isDraining ? (await config.isDraining()) === true : false);

  if (draining) {
    return { ready: false, status: "draining", timestamp };
  }

  const checks = config.checks ?? [];
  if (checks.length > 0) {
    const results = await Promise.all(checks.map(runCheck));
    if (!results.every((v) => v === true)) {
      return { ready: false, status: "error", timestamp };
    }
  }

  return { ready: true, status: "ok", timestamp };
}
