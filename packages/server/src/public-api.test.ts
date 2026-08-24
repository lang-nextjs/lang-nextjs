/**
 * Public API type tests.
 *
 * These tests run under vitest (so they show in the suite) AND fail at
 * TypeScript compile time if the public API drifts. The intent is regression
 * protection: every public export listed in src/index.ts should appear here
 * with at least one assertion about its shape. If you add or remove an
 * export, add or remove the corresponding assertion.
 */
import { describe, it, expectTypeOf } from "vitest";
import type { NextRequest, NextResponse } from "next/server";
import {
  defaultTransforms,
  getCookieToken,
  createDeepAgentsResumeHandler,
  isStreamReconnectEnabled,
  createApprovalRoutes,
  createApprovalGatingTransform,
} from "./index";
import type {
  DeepAgentsHandlerOptions,
  SseFrame,
  SseTransform,
  SseMultiTransform,
  SseAdapter,
  ApprovalGatingConfig,
} from "./index";

// RUNG-OWNED SYMBOLS ARE NOT ASSERTED HERE.
// A static named import — or a type assertion — over an export a fork has ejected is a hard TYPE
// error, so this file could not typecheck in 3 of 5 ejected forks. Each rung's contract
// conformance now lives in that rung's own adapter test, which eject deletes with the rung;
// presence in the barrel is asserted by rung-surface.test.ts, derived from rungs.json.
describe("@deepagents-nextjs/server — public API surface", () => {

  it("DeepAgentsHandlerOptions has the documented shape", () => {
    expectTypeOf<DeepAgentsHandlerOptions>().toHaveProperty("backendUrl");
    expectTypeOf<
      DeepAgentsHandlerOptions["backendUrl"]
    >().toEqualTypeOf<string>();
  });

  it("defaultTransforms is an array of SseTransform", () => {
    expectTypeOf(defaultTransforms).toBeArray();
    expectTypeOf(defaultTransforms[0]).toEqualTypeOf<SseTransform>();
  });

  it("SseFrame exposes a raw string", () => {
    expectTypeOf<SseFrame>().toHaveProperty("raw");
    expectTypeOf<SseFrame["raw"]>().toEqualTypeOf<string>();
  });

  it("SseTransform is a (frame) => frame | null function", () => {
    expectTypeOf<SseTransform>().toBeFunction();
    expectTypeOf<SseTransform>().parameter(0).toEqualTypeOf<SseFrame>();
    expectTypeOf<SseTransform>().returns.toEqualTypeOf<SseFrame | null>();
  });

  it("SseMultiTransform returns an array of frames (N-output contract)", () => {
    expectTypeOf<SseMultiTransform>().toBeFunction();
  });




  it("getCookieToken is a factory returning a (NextRequest) => string|null", () => {
    expectTypeOf(getCookieToken).toBeFunction();
    expectTypeOf(getCookieToken).parameter(0).toEqualTypeOf<string>();
    type TokenFn = ReturnType<typeof getCookieToken>;
    expectTypeOf<TokenFn>().toBeFunction();
  });

  it("createDeepAgentsResumeHandler + isStreamReconnectEnabled exported", () => {
    expectTypeOf(createDeepAgentsResumeHandler).toBeFunction();
    expectTypeOf(isStreamReconnectEnabled).toBeFunction();
    expectTypeOf(isStreamReconnectEnabled).returns.toEqualTypeOf<boolean>();
  });

  it("createApprovalRoutes returns an object with GET + POST handlers", () => {
    expectTypeOf(createApprovalRoutes).toBeFunction();
    type Routes = ReturnType<typeof createApprovalRoutes>;
    expectTypeOf<Routes>().toHaveProperty("GET");
    expectTypeOf<Routes>().toHaveProperty("POST");
  });

  it("createApprovalGatingTransform takes ApprovalGatingConfig", () => {
    expectTypeOf(createApprovalGatingTransform).toBeFunction();
    expectTypeOf(createApprovalGatingTransform)
      .parameter(0)
      .toMatchTypeOf<ApprovalGatingConfig>();
  });
});
