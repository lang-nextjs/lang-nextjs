import { describe, expect, it } from "vitest";
import { planSteps } from "./langchain.js";

/**
 * `planSteps` — the normalisation between a model's answer and a loop.
 *
 * WRITTEN BECAUSE A MUTATION SURVIVED. Making the non-array branch return
 * `["fallback"]` instead of `[]` passed every adapter-contract case: nothing
 * in that suite ever hands the planner a malformed answer, so the whole
 * filtering path was unexecuted while looking thoroughly tested. The branches
 * exist precisely for the case the happy-path suite cannot produce.
 *
 * The function guards a `for` loop that builds prompts. Anything that reaches
 * it becomes an instruction sent to a model, so "not a string" and "empty
 * string" are not pedantry — they are a step that tells the executor to do
 * nothing, once per malformed entry.
 */
describe("planSteps", () => {
  it("returns the steps a well-formed plan carries", () => {
    expect(planSteps({ steps: ["one", "two"] })).toEqual(["one", "two"]);
  });

  it.each([
    ["a missing plan", null],
    ["undefined", undefined],
    ["no steps key", {}],
    ["steps that is not an array", { steps: "one, two" }],
    ["steps that is an object", { steps: { 0: "one" } }],
  ])("%s yields no steps rather than a fabricated one", (_label, input) => {
    // THE MUTATION THIS FILE EXISTS FOR. A fallback value here would put a
    // step into the loop that the model never proposed, and the executor would
    // dutifully run it.
    expect(planSteps(input as never)).toEqual([]);
  });

  it("drops non-string entries rather than stringifying them", () => {
    // `String(undefined)` is "undefined", which would be sent to the executor
    // as a sub-step. Dropping beats coercing when the value is going into a
    // prompt.
    expect(planSteps({ steps: ["one", 2, null, "three"] as never })).toEqual([
      "one",
      "three",
    ]);
  });

  it("drops blank and whitespace-only steps", () => {
    expect(planSteps({ steps: ["one", "", "   ", "\n", "two"] })).toEqual([
      "one",
      "two",
    ]);
  });

  it("trims, so a step is not padded when it reaches the prompt", () => {
    expect(planSteps({ steps: ["  one  "] })).toEqual(["one"]);
  });

  it("an all-blank plan is empty, which is the caller's early-return case", () => {
    // Pairs with the adapter-contract case "a planner that returns no steps
    // says so and still terminates": this is the input that produces it, and
    // without this the two halves are never connected.
    expect(planSteps({ steps: ["", "  "] })).toEqual([]);
  });
});
