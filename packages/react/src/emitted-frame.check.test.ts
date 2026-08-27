import { describe, expect, it } from "vitest";
import { DataErrorSchema } from "./schemas";

/**
 * THE FRAME THE PYTHON BACKEND ACTUALLY EMITS, VALIDATED HERE.
 *
 * #247 added `guarded_stream` on the FastAPI side, which builds a data-error
 * payload by hand in Python. Nothing in the TypeScript test suite would notice
 * if the two drifted — and a rejected part is indistinguishable from an absent
 * one to a person watching the screen (#140), so the failure mode of drift is
 * silence, not an error.
 *
 * This payload is copy-pasted from a real run against a dead model, not
 * hand-written to match the schema.
 */
describe("the data-error frame the FastAPI backend emits", () => {
  it("satisfies the schema the client validates against", () => {
    const emitted = {
      id: "stream-error",
      seq: 0,
      code: "upstream_404",
      message: "404 page not found",
      retryable: false,
      cause: { exception: "OpenAIModelNotFoundError" },
    };
    expect(DataErrorSchema.safeParse(emitted).success).toBe(true);
  });
});
