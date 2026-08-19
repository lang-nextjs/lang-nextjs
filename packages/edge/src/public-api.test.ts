/**
 * Public API type tests for @deepagents-nextjs/edge.
 * See packages/server/src/public-api.test.ts for the regression-protection rationale.
 */
import { describe, it, expectTypeOf } from "vitest";
import {
  createDenoHandler,
  createCloudflareHandler,
  SseFrameAccumulator,
  createHealthProbe,
  createReadinessProbe,
} from "./index";
import type {
  SseFrame,
  SseTransform,
  EdgeHandlerOptions,
  DenoHandlerOptions,
  CloudflareHandlerOptions,
  ProbeCheck,
  HealthProbeResult,
  ReadinessProbeConfig,
  ReadinessProbeResult,
  ObservabilityHooks,
} from "./index";

describe("@deepagents-nextjs/edge — public API surface", () => {
  it("createDenoHandler is a factory taking DenoHandlerOptions", () => {
    expectTypeOf(createDenoHandler).toBeFunction();
    expectTypeOf(createDenoHandler)
      .parameter(0)
      .toMatchTypeOf<DenoHandlerOptions>();
  });

  it("createCloudflareHandler is a factory taking CloudflareHandlerOptions", () => {
    expectTypeOf(createCloudflareHandler).toBeFunction();
    expectTypeOf(createCloudflareHandler)
      .parameter(0)
      .toMatchTypeOf<CloudflareHandlerOptions>();
  });

  it("SseFrameAccumulator is a class with push/flush methods", () => {
    expectTypeOf(SseFrameAccumulator).toBeConstructibleWith();
    const instance = new SseFrameAccumulator();
    expectTypeOf(instance.push).toBeFunction();
    expectTypeOf(instance.flush).toBeFunction();
  });

  it("SseFrame and SseTransform have the expected shape", () => {
    expectTypeOf<SseFrame>().toHaveProperty("raw");
    expectTypeOf<SseTransform>().toBeFunction();
  });

  it("DenoHandlerOptions + CloudflareHandlerOptions both extend EdgeHandlerOptions", () => {
    expectTypeOf<DenoHandlerOptions>().toMatchTypeOf<EdgeHandlerOptions>();
    expectTypeOf<CloudflareHandlerOptions>().toMatchTypeOf<EdgeHandlerOptions>();
  });

  // ADVERSARIAL (iter 2): Exports surface — verify ALL documented exports are
  // reachable from the package entry. A missing re-export in index.ts is a
  // silent API break for downstream consumers. This test pins every export
  // declared in index.ts so an accidental removal fails the build.
  it("exposes all documented exports: handlers, accumulator, health probes, and observability types", () => {
    // Runtime values — must be defined and callable
    expectTypeOf(createHealthProbe).toBeFunction();
    expectTypeOf(createReadinessProbe).toBeFunction();

    // Types — must be assignable to the documented shapes
    expectTypeOf<ProbeCheck>().toHaveProperty("name");
    expectTypeOf<ProbeCheck>().toHaveProperty("check");
    expectTypeOf<HealthProbeResult>().toHaveProperty("ok");
    expectTypeOf<HealthProbeResult>().toHaveProperty("status");
    expectTypeOf<ReadinessProbeConfig>().toHaveProperty("draining");
    expectTypeOf<ReadinessProbeResult>().toHaveProperty("ready");
    expectTypeOf<ReadinessProbeResult>().toHaveProperty("status");
    expectTypeOf<ObservabilityHooks>().toHaveProperty("onRequest");
    expectTypeOf<ObservabilityHooks>().toHaveProperty("onFetchStart");
    expectTypeOf<ObservabilityHooks>().toHaveProperty("onFetchEnd");
    expectTypeOf<ObservabilityHooks>().toHaveProperty("onStreamStart");
    expectTypeOf<ObservabilityHooks>().toHaveProperty("onTransformBegin");
    expectTypeOf<ObservabilityHooks>().toHaveProperty("onTransformEnd");
    expectTypeOf<ObservabilityHooks>().toHaveProperty("onError");
    expectTypeOf<ObservabilityHooks>().toHaveProperty("onStreamEnd");
  });
});
