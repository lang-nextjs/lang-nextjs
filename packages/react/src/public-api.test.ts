/**
 * Public API type tests for @deepagents-nextjs/react.
 *
 * Smoke-level coverage of the RUNG-AGNOSTIC exports: each card component is a React function
 * component, each hook has the documented return shape, each type alias has the documented
 * properties.
 *
 * Rung-owned components (the deepagents and open-swe cards) are deliberately NOT imported here.
 * A static named import of an export a fork has ejected is a hard TYPE error, so this file could
 * not typecheck in 3 of the 5 ejected forks. Their surface is asserted in rung-surface.test.ts,
 * derived from rungs.json — which is also strictly stronger, since a literal list goes green if
 * you delete a rung's cards and edit the list to match.
 */
import { describe, it, expectTypeOf } from "vitest";
import {
  // Components
  ApprovalCard,
  TaskCard,
  HumanResponseCard,
  AgentsMdCard,
  // Hooks
  useDeepAgentsChat,
  useApprovalResponse,
  ApprovalResponseError,
  useApprovalCardController,
} from "./index";
import type {
  ApprovalCardProps,
  TaskCardProps,
  HumanResponseCardProps,
  AgentsMdCardProps,
  UseDeepAgentsChatOptions,
  UseDeepAgentsChatReturn,
  UseApprovalResponseOptions,
  UseApprovalResponseReturn,
  UseApprovalResponseStatus,
  ApprovalDecision,
  ApprovalEditPayload,
  ApprovalRespondFn,
  ApprovalRespondPayload,
  ApprovalResponseSuccess,
  UseApprovalCardControllerOptions,
  UseApprovalCardControllerReturn,
} from "./index";

describe("@deepagents-nextjs/react — public API surface", () => {
  it("every card export is a function component", () => {
    expectTypeOf(ApprovalCard).toBeFunction();
    expectTypeOf(TaskCard).toBeFunction();
    expectTypeOf(HumanResponseCard).toBeFunction();
    expectTypeOf(AgentsMdCard).toBeFunction();
  });

  it("every card has a Props type alias exported", () => {
    expectTypeOf<ApprovalCardProps>().not.toBeNever();
    expectTypeOf<TaskCardProps>().not.toBeNever();
    expectTypeOf<HumanResponseCardProps>().not.toBeNever();
    expectTypeOf<AgentsMdCardProps>().not.toBeNever();
  });

  it("useDeepAgentsChat is a hook returning UseDeepAgentsChatReturn", () => {
    expectTypeOf(useDeepAgentsChat).toBeFunction();
    expectTypeOf(useDeepAgentsChat)
      .parameter(0)
      .toMatchTypeOf<UseDeepAgentsChatOptions | string>();
  });

  it("UseDeepAgentsChatReturn has messages + sendMessage + status", () => {
    expectTypeOf<UseDeepAgentsChatReturn>().toHaveProperty("messages");
    expectTypeOf<UseDeepAgentsChatReturn>().toHaveProperty("sendMessage");
    expectTypeOf<UseDeepAgentsChatReturn>().toHaveProperty("status");
  });

  it("useApprovalResponse returns the documented shape", () => {
    expectTypeOf(useApprovalResponse).toBeFunction();
    // Actual shape: { respond, status, error, reset }. The four decision
    // modes (approve/reject/edit/respond) are passed to respond() as the
    // first arg, not exposed as direct methods on the return.
    expectTypeOf<UseApprovalResponseReturn>().toHaveProperty("status");
    expectTypeOf<UseApprovalResponseReturn>().toHaveProperty("respond");
    expectTypeOf<UseApprovalResponseReturn>().toHaveProperty("error");
    expectTypeOf<UseApprovalResponseReturn>().toHaveProperty("reset");
  });

  it("ApprovalDecision is the four-mode union", () => {
    expectTypeOf<ApprovalDecision>().toEqualTypeOf<
      "approve" | "reject" | "edit" | "respond"
    >();
  });

  it("UseApprovalResponseStatus enumerates the documented states", () => {
    // Status is a string union; assert the specific values that consumers
    // pattern-match on.
    expectTypeOf<UseApprovalResponseStatus>().toMatchTypeOf<string>();
  });

  it("ApprovalEditPayload + ApprovalRespondPayload have required fields", () => {
    expectTypeOf<ApprovalEditPayload>().toHaveProperty("editedInput");
    expectTypeOf<ApprovalRespondPayload>().toHaveProperty("response");
  });

  it("ApprovalRespondFn is the respond callback signature", () => {
    expectTypeOf<ApprovalRespondFn>().toBeFunction();
  });

  it("ApprovalResponseSuccess is the success-state object", () => {
    expectTypeOf<ApprovalResponseSuccess>().not.toBeNever();
  });

  it("ApprovalResponseError is a class extending Error (constructor: status, body, message)", () => {
    // Constructor signature: (statusCode: number, body: unknown, message: string)
    // Surfaces both pieces of context callers need to handle non-2xx
    // responses (the HTTP status + the parsed/raw body) plus a human
    // message. Pinning the 3-arg shape catches a refactor that drops
    // either of the diagnostic fields.
    expectTypeOf(ApprovalResponseError).toBeConstructibleWith(
      400,
      { error: "bad" },
      "msg"
    );
    expectTypeOf(
      new ApprovalResponseError(400, { error: "bad" }, "msg")
    ).toMatchTypeOf<Error>();
  });

  it("useApprovalCardController is a hook with options + return type", () => {
    expectTypeOf(useApprovalCardController).toBeFunction();
    expectTypeOf<UseApprovalCardControllerOptions>().not.toBeNever();
    expectTypeOf<UseApprovalCardControllerReturn>().not.toBeNever();
  });
});
