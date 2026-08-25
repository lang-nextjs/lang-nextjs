import { describe, it, expect } from "vitest";
import {
  requiresApproval,
  approvalPolicy,
  READ_ONLY_TOOLS,
  APPROVAL_TIMEOUT_MS,
} from "./approval-policy";

describe("approval policy — gate what mutates, fail closed on the unknown", () => {
  it("gates the mutating tools named in the ruling", () => {
    for (const tool of ["write_file", "edit_file", "delete", "bash_execute"]) {
      expect(requiresApproval(tool), `${tool} must be gated`).toBe(true);
    }
  });

  it("lets known read-only tools through", () => {
    for (const tool of READ_ONLY_TOOLS) {
      expect(requiresApproval(tool), `${tool} must not prompt`).toBe(false);
    }
    // A gate that fires on every read is one people learn to click through,
    // and a safety control users habituate to manufactures consent.
    expect(requiresApproval("read_file")).toBe(false);
  });

  it("GATES a tool it has never heard of", () => {
    // The uncomfortable direction, on purpose. A new read-only MCP tool will
    // prompt until someone adds it to the allow-list; an unrecognised
    // DESTRUCTIVE tool would otherwise run unprompted. Of the two mistakes only
    // one is unrecoverable.
    expect(requiresApproval("mcp__unknown__do_something")).toBe(true);
    expect(requiresApproval("")).toBe(true);
  });

  it("is case- and substring-exact, so a lookalike name does not slip through", () => {
    // "read_file_and_delete" must not inherit read_file's pass.
    expect(requiresApproval("read_file_and_delete")).toBe(true);
    expect(requiresApproval("READ_FILE")).toBe(true);
  });

  it("carries the approval timeout, not the drain grace", () => {
    const policy = approvalPolicy({ toolName: "write_file" });
    expect(policy).toEqual({ require: true, timeoutMs: APPROVAL_TIMEOUT_MS });
    // 5 minutes is a business rule about how long a human may take. The proxy's
    // drain grace is an infrastructure cost and is deliberately much shorter —
    // conflating them pins a worker for five minutes when a tab closes.
    expect(APPROVAL_TIMEOUT_MS).toBe(300_000);
  });

  it("returns require:false rather than undefined for a read", () => {
    // `undefined` is also treated as "no approval required" by the transform,
    // but returning it would make the policy silent about reads rather than
    // explicit, and a reader could not tell a decision from an omission.
    expect(approvalPolicy({ toolName: "read_file" })).toEqual({
      require: false,
      timeoutMs: APPROVAL_TIMEOUT_MS,
    });
  });
});
