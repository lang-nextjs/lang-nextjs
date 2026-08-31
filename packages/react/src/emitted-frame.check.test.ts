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
 *
 * AND THE COPY HAS ALREADY DRIFTED ONCE, which is worth recording where it
 * happened. This file exists to catch the Python emitter and the TS schema
 * diverging, and it did not notice that the emitter gained an `origin` field
 * (`_common.py`: `"origin": _error_origin(exc)`) — a copied payload cannot
 * notice a field the producer STARTED sending. #433 surfaced it only because
 * making `origin` required turned the omission into a parse failure.
 *
 * `origin` below is derived from the producer's RULE rather than observed in
 * that run, which predates the field: `_error_origin` returns "provider" for an
 * `openai.APIError` subclass and "backend" otherwise, and the cause recorded
 * here is an OpenAI model-not-found. Said out loud because it is the one value
 * in this fixture that was not copied.
 */
describe("the data-error frame the FastAPI backend emits", () => {
  it("satisfies the schema the client validates against", () => {
    const emitted = {
      id: "stream-error",
      seq: 0,
      code: "upstream_404",
      message: "404 page not found",
      retryable: false,
      origin: "provider",
      cause: { exception: "OpenAIModelNotFoundError" },
    };
    expect(DataErrorSchema.safeParse(emitted).success).toBe(true);
  });
});
