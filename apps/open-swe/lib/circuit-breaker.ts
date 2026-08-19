import { vi } from "vitest";

export enum CircuitState {
  CLOSED = "CLOSED",
  OPEN = "OPEN",
  HALF_OPEN = "HALF_OPEN",
}

export interface CircuitBreakerConfig {
  failureThreshold: number;
  resetTimeoutMs: number;
  halfOpenMaxProbes: number;
}

export class CircuitOpenError extends Error {
  retryAfterSeconds: number;
  state: CircuitState;

  constructor(
    retryAfterSeconds: number,
    state: CircuitState,
    message?: string
  ) {
    super(
      message ||
        `Circuit is ${state} and open. Retry after ${retryAfterSeconds} seconds.`
    );
    this.name = "CircuitOpenError";
    this.retryAfterSeconds = retryAfterSeconds;
    this.state = state;
    Object.setPrototypeOf(this, CircuitOpenError.prototype);
  }
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount: number = 0;
  private lastFailureTime: number | null = null;
  private halfOpenProbeCount: number = 0;

  private readonly config: Required<CircuitBreakerConfig>;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = {
      failureThreshold: config.failureThreshold ?? 5,
      resetTimeoutMs: config.resetTimeoutMs ?? 30_000,
      halfOpenMaxProbes: config.halfOpenMaxProbes ?? 1,
    };
  }

  getState(): CircuitState {
    // Transition OPEN to HALF_OPEN if reset timeout has elapsed
    if (this.state === CircuitState.OPEN && this.lastFailureTime !== null) {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.config.resetTimeoutMs) {
        this.state = CircuitState.HALF_OPEN;
        this.halfOpenProbeCount = 0;
      }
    }
    return this.state;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const currentState = this.getState();

    if (currentState === CircuitState.OPEN) {
      const retryAfter = this.getRetryAfterSeconds();
      throw new CircuitOpenError(retryAfter, CircuitState.OPEN);
    }

    if (currentState === CircuitState.HALF_OPEN) {
      if (this.halfOpenProbeCount >= this.config.halfOpenMaxProbes) {
        this.state = CircuitState.OPEN;
        this.lastFailureTime = Date.now();
        const retryAfter = this.getRetryAfterSeconds();
        throw new CircuitOpenError(retryAfter, CircuitState.OPEN);
      }
      this.halfOpenProbeCount++;
    }

    try {
      const result = await fn();

      // Success resets counters
      this.failureCount = 0;
      this.lastFailureTime = null;

      if (this.state === CircuitState.HALF_OPEN) {
        // Successful probe in half-open state closes the circuit
        this.state = CircuitState.CLOSED;
        this.halfOpenProbeCount = 0;
      }

      return result;
    } catch (error) {
      // Any error counts as a failure
      this.failureCount++;
      this.lastFailureTime = Date.now();

      if (
        this.state === CircuitState.CLOSED &&
        this.failureCount >= this.config.failureThreshold
      ) {
        // Open the circuit after threshold consecutive failures
        this.state = CircuitState.OPEN;
      }

      if (this.state === CircuitState.HALF_OPEN) {
        // Failed probe reopens the circuit
        this.state = CircuitState.OPEN;
        this.halfOpenProbeCount = 0;
      }

      // Rethrow the original error
      throw error;
    }
  }

  getStatus() {
    return {
      state: this.getState(),
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime,
    };
  }

  reset() {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.lastFailureTime = null;
    this.halfOpenProbeCount = 0;
  }

  getRetryAfterSeconds(): number {
    if (
      this.getState() !== CircuitState.OPEN ||
      this.lastFailureTime === null
    ) {
      return 0;
    }

    const elapsed = Date.now() - this.lastFailureTime;
    const remaining = Math.max(0, this.config.resetTimeoutMs - elapsed);
    return Math.ceil(remaining / 1000);
  }
}
