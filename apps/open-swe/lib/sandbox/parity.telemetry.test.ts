/**
 * PROVIDER PARITY — health / capacity.
 *
 * Third parity suite. Same rule as the others: one body, both providers, assertions only on
 * the contract.
 *
 * WHY THESE MATTER MORE THAN THEY LOOK
 * These are the two methods an orchestrator POLLS to decide placement. A divergence here
 * does not fail loudly — it misroutes work. If one provider reports capacity the way the
 * contract describes and the other passes through whatever its API said, a scheduler will
 * happily send work to a full backend and only find out downstream.
 *
 * `SandboxCapacity.available` is documented as "max - used, floored at 0". That is an
 * invariant, not a suggestion: a caller comparing `available > 0` before dispatching has to
 * be able to trust it identically on both providers.
 */

import { describe, expect, it } from "vitest";
import { BlazingSandbox } from "./blazing-sandbox";
import { DockerSandbox } from "./docker-sandbox";
import type { SandboxCapacity, SandboxHealth } from "./types";

interface ProviderCase {
  name: "blazing" | "docker";
  make(opts?: {
    down?: boolean;
    /** used/max the underlying source reports. */
    used?: number;
    max?: number;
    /** An `available` the source claims that does NOT match max - used. */
    bogusAvailable?: number;
  }): {
    health(): Promise<SandboxHealth>;
    capacity(): Promise<SandboxCapacity>;
  };
}

const blazingCase: ProviderCase = {
  name: "blazing",
  make(opts = {}) {
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

    const fetchFn = (async (url: string | URL) => {
      const u = String(url);
      if (opts.down) return json({ detail: "upstream is gone" }, 503);
      if (u.includes("/v1/health")) {
        return json({ status: "healthy", version: "blazing 1.2.3" });
      }
      if (u.includes("/capacity")) {
        const body: Record<string, unknown> = {
          used: opts.used ?? 2,
          max: opts.max ?? 8,
        };
        if (opts.bogusAvailable !== undefined) {
          body.available = opts.bogusAvailable;
        }
        return json(body);
      }
      return json({ detail: "unexpected" }, 500);
    }) as unknown as typeof fetch;

    return new BlazingSandbox({ baseUrl: "http://blazing.test", fetchFn });
  },
};

const dockerCase: ProviderCase = {
  name: "docker",
  make(opts = {}) {
    const exec = (async (args: string[]) => {
      if (opts.down) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "Cannot connect to the Docker daemon",
          timedOut: false,
        };
      }
      if (args[0] === "version") {
        return { exitCode: 0, stdout: "27.1.0", stderr: "", timedOut: false };
      }
      return { exitCode: 0, stdout: "cid-abc", stderr: "", timedOut: false };
    }) as never;

    const sandbox = new DockerSandbox({ exec, maxWorkspaces: opts.max ?? 8 });
    // Docker derives `used` from its registry, so occupy it to reach the same state the
    // blazing fake reports numerically.
    const reg = (sandbox as unknown as { workspaces: Map<string, unknown> })
      .workspaces;
    for (let i = 0; i < (opts.used ?? 2); i++) {
      reg.set(`ws-${i}`, { id: `ws-${i}` });
    }
    return sandbox;
  },
};

const PROVIDERS: ProviderCase[] = [blazingCase, dockerCase];

describe.each(PROVIDERS)("telemetry parity — $name", (provider) => {
  it("health reports available:true and a non-empty detail when up", async () => {
    const h = await provider.make().health();

    expect(h.provider).toBe(provider.name);
    expect(h.available).toBe(true);
    expect(typeof h.detail).toBe("string");
    expect(h.detail.length).toBeGreaterThan(0);
  });

  it("health RETURNS available:false when the provider is down — it does not throw", async () => {
    // This is the property that matters. A health check that throws is useless to the thing
    // polling it: callers would need provider-specific try/catch just to learn "it's down".
    const h = await provider.make({ down: true }).health();

    expect(h.available).toBe(false);
    expect(h.provider).toBe(provider.name);
    expect(h.detail.length).toBeGreaterThan(0);
  });

  it("capacity is tagged with its own provider and reports numbers", async () => {
    const c = await provider.make({ used: 3, max: 10 }).capacity();

    expect(c.provider).toBe(provider.name);
    expect(c.used).toBe(3);
    expect(c.max).toBe(10);
  });

  it("available === max - used", async () => {
    const c = await provider.make({ used: 3, max: 10 }).capacity();
    expect(c.available).toBe(7);
  });

  it("available is floored at 0 when used exceeds max", async () => {
    // Over-subscription is not hypothetical: max can be lowered by config while workspaces
    // are already running. A negative `available` breaks every `available > 0` check.
    const c = await provider.make({ used: 12, max: 8 }).capacity();
    expect(c.available).toBe(0);
  });

  it("available stays consistent with max - used even if the source claims otherwise", async () => {
    // A provider must not pass through an `available` that contradicts its own used/max.
    // Docker computes it; blazing trusts `dto.available` when present.
    const c = await provider
      .make({ used: 2, max: 8, bogusAvailable: -5 })
      .capacity();

    expect(c.available).toBeGreaterThanOrEqual(0);
    expect(c.available).toBe(Math.max(0, c.max - c.used));
  });
});
