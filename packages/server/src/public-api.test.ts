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
  createDeepAgentsHandler,
  defaultTransforms,
  deepagentsAdapter,
  langGraphAdapter,
  langchainAdapter,
  createLangchainTransform,
  openSweAdapter,
  createOpenSweTransform,
  createHeartbeatStream,
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
  HeartbeatOptions,
  ApprovalGatingConfig,
} from "./index";

describe("@deepagents-nextjs/server — public API surface", () => {
  it("createDeepAgentsHandler returns a NextRequest → Promise<Response> handler", () => {
    expectTypeOf(createDeepAgentsHandler).toBeFunction();
    expectTypeOf(createDeepAgentsHandler)
      .parameter(0)
      .toEqualTypeOf<DeepAgentsHandlerOptions>();
    type Handler = ReturnType<typeof createDeepAgentsHandler>;
    expectTypeOf<Handler>().toBeFunction();
    expectTypeOf<Handler>().parameter(0).toEqualTypeOf<NextRequest>();
    // Handler returns Promise<NextResponse>, not a plain Promise<Response>.
    // NextResponse extends Response with the Next.js-specific cookies/url
    // helpers; pinning the more specific type catches a refactor that
    // drops NextResponse for plain Response (which would lose the helpers
    // downstream callers may depend on).
    expectTypeOf<Handler>().returns.resolves.toEqualTypeOf<NextResponse>();
  });

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

  it("adapter exports are objects implementing SseAdapter", () => {
    expectTypeOf(deepagentsAdapter).toMatchTypeOf<SseAdapter>();
    expectTypeOf(langGraphAdapter).toMatchTypeOf<SseAdapter>();
    expectTypeOf(langchainAdapter).toMatchTypeOf<SseAdapter>();
    expectTypeOf(openSweAdapter).toMatchTypeOf<SseAdapter>();
    expectTypeOf(createLangchainTransform).toBeFunction();
    expectTypeOf(createOpenSweTransform).toBeFunction();
  });

  it("createHeartbeatStream wraps a ReadableStream<Uint8Array>", () => {
    expectTypeOf(createHeartbeatStream).toBeFunction();
    expectTypeOf(createHeartbeatStream)
      .parameter(0)
      .toEqualTypeOf<ReadableStream<Uint8Array>>();
    expectTypeOf(createHeartbeatStream).returns.toEqualTypeOf<
      ReadableStream<Uint8Array>
    >();
  });

  it("HeartbeatOptions has an intervalMs field", () => {
    expectTypeOf<HeartbeatOptions>().toHaveProperty("intervalMs");
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
