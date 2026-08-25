/**
 * Graceful shutdown orchestrator (OPS-01) — Node-only, OPT-IN.
 *
 * `createGracefulShutdown()` returns a per-instance handle that, on disposal
 * (typically a SIGTERM/SIGINT handler), flips a draining flag, waits for
 * in-flight SSE streams to finish up to a configurable timeout, then exits.
 *
 * Design constraints:
 * - NODE-ONLY / OPT-IN: importing this module registers NO signal listener.
 *   A listener is installed ONLY when the consumer calls
 *   `installSignalHandlers()` (which uses `process.once` to avoid a
 *   MaxListeners leak) or wires `process.on('SIGTERM', () => s.dispose())`
 *   themselves. This file is therefore never copied into the edge package.
 * - NO MODULE-SCOPE MUTABLE STATE: the draining flag and the active-stream Set
 *   live inside the object returned by the factory. Every call yields an
 *   independent instance.
 * - SAFETY TIMEOUT: dispose() always terminates — if streams never release it
 *   force-exits with code 1 after `drainTimeoutMs`, so a hung stream can never
 *   block exit forever.
 * - TESTABLE EXIT: exit is injectable via `onExit` (default
 *   `(code) => process.exit(code)`); unit tests pass a spy and never run the
 *   real `process.exit`.
 *
 * Phase 18 integration: pass `isDraining` straight into the readiness probe —
 *   `createReadinessProbe({ isDraining: () => shutdown.isDraining() })` — so
 *   readiness returns 503 (`status: "draining"`) the moment shutdown begins
 *   and the load balancer stops routing new traffic.
 */

/** Configuration for {@link createGracefulShutdown}. */
export interface ShutdownConfig {
  /**
   * Maximum time (ms) to wait for in-flight streams to drain before
   * force-exiting. Default 30000.
   */
  drainTimeoutMs?: number;
  /**
   * Exit hook. Default `(code) => process.exit(code)`. Injectable so unit
   * tests can assert exit codes without terminating the test runner.
   */
  onExit?: (code: number) => void;
  /** Optional log sink. Default `console.warn`. */
  logger?: (msg: string) => void;
}

/** Per-instance handle returned by {@link createGracefulShutdown}. */
export interface GracefulShutdown {
  /** True once dispose() has begun — wire into createReadinessProbe. */
  isDraining(): boolean;
  /** Register an in-flight stream by id (Set semantics — duplicates dedupe). */
  trackStream(streamId: string): void;
  /** Mark an in-flight stream finished. Unknown ids are ignored. */
  releaseStream(streamId: string): void;
  /** Number of currently active streams. */
  activeCount(): number;
  /**
   * Begin graceful shutdown: flip draining, wait for streams to drain up to
   * `drainTimeoutMs`, then exit. Idempotent — a second call is a no-op.
   * Resolves after `onExit` has been invoked.
   */
  dispose(): Promise<void>;
  /**
   * Install `process.once` SIGTERM + SIGINT handlers that call dispose().
   * Returns an uninstall fn that removes both listeners.
   */
  installSignalHandlers(): () => void;
}

const DEFAULT_DRAIN_TIMEOUT_MS = 30000;
const POLL_INTERVAL_MS = 50;

/** Resolve after `ms`, driven by setTimeout so fake timers can advance it. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a per-instance graceful-shutdown orchestrator. See module doc for the
 * Node-only / opt-in / safety-timeout contract.
 */
export function createGracefulShutdown(
  config: ShutdownConfig = {}
): GracefulShutdown {
  const drainTimeoutMs = config.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const onExit = config.onExit ?? ((code: number) => process.exit(code));
  const log = config.logger ?? ((msg: string) => console.warn(msg));

  // Per-instance state — no module-scope mutability.
  let draining = false;
  let disposed = false;
  const activeStreams = new Set<string>();

  async function dispose(): Promise<void> {
    if (disposed) return; // idempotent — duplicate SIGTERM is ignored
    disposed = true;
    draining = true; // flip first so readiness returns 503 immediately
    log("[graceful-shutdown] draining started");

    const deadline = Date.now() + drainTimeoutMs;
    // Poll until streams drain or the safety deadline passes.
    while (activeStreams.size > 0 && Date.now() < deadline) {
      const remaining = deadline - Date.now();
      await delay(Math.min(POLL_INTERVAL_MS, remaining));
    }

    if (activeStreams.size > 0) {
      log(
        `[graceful-shutdown] drain timeout — ${activeStreams.size} stream(s) still active, forcing exit`
      );
      onExit(1);
      return;
    }

    log("[graceful-shutdown] drain complete");
    onExit(0);
  }

  function installSignalHandlers(): () => void {
    const handler = () => {
      dispose().catch((err) => {
        log(`[graceful-shutdown] dispose error: ${String(err)}`);
      });
    };
    // process.once avoids accumulating listeners across repeated signals
    // (RESEARCH Pitfall 5: MaxListeners leak).
    process.once("SIGTERM", handler);
    process.once("SIGINT", handler);
    return () => {
      process.removeListener("SIGTERM", handler);
      process.removeListener("SIGINT", handler);
    };
  }

  return {
    isDraining: () => draining,
    trackStream: (streamId: string) => {
      activeStreams.add(streamId);
    },
    releaseStream: (streamId: string) => {
      activeStreams.delete(streamId);
    },
    activeCount: () => activeStreams.size,
    dispose,
    installSignalHandlers,
  };
}
