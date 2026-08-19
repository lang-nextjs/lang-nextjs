/**
 * Public API type tests for @deepagents-nextjs/test-utils.
 */
import { describe, it, expect, expectTypeOf } from "vitest";
import * as PublicApi from "./index";
import { createMockDeepAgentsServer } from "./index";
import type { MockDeepAgentsServerOptions } from "./index";

describe("@deepagents-nextjs/test-utils — public API surface", () => {
  it("createMockDeepAgentsServer is a function", () => {
    expectTypeOf(createMockDeepAgentsServer).toBeFunction();
  });

  it("exports the full documented surface: createMockDeepAgentsServer named export + options type", () => {
    // Adversarial: catch accidental renames / removals / under-named exports.
    // We assert on runtime keys of the module namespace, which is what real
    // consumers see when they `import * as T from '@deepagents-nextjs/test-utils'`.
    const exportedKeys = Object.keys(PublicApi).sort();
    expect(exportedKeys).toContain("createMockDeepAgentsServer");
    // The options interface is re-exported type-only (`export type` in the
    // barrel), so by design it has NO runtime key — asserting on
    // exportedKeys above would wrongly fail. Its contract is compile-time:
    // the name must still resolve by-name from the barrel, which the
    // type-level assertion below pins. A rename or removal fails typecheck.
    expectTypeOf<MockDeepAgentsServerOptions>().toBeObject();
  });
});
