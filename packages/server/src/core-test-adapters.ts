/**
 * Core-owned adapters for testing the transport. SHARED — depends on no rung.
 *
 * WHY THIS EXISTS (issue #17b). Eleven core transport tests reached for
 * `createDeepAgentsHandler`, the rung-3 wrapper. `severability.test.ts` proved the SOURCE
 * reaches no rung and said nothing about the tests, because it filters `*.test.ts` out of the
 * walk — my omission. So `eject langchain` produced a fork whose core transport had zero
 * working tests while every check stayed green.
 *
 * THE TRAP IN THE OBVIOUS FIX. Swapping to `createSseProxyHandler` and passing
 * `deepagentsAdapter` explicitly makes the dangling-import grep go quiet while the rung
 * dependency survives in a different syntax — the same proxy failure as the original
 * `from "./adapters/` close condition. The property is not "no import of the wrapper", it is
 * **"survives `eject langchain`"**: a fork containing the LOWEST rung and nothing above it.
 * Anything a core test injects must therefore come from core.
 *
 * WHY `defaultTransforms` RATHER THAN AN EMPTY PIPELINE.
 * `deepagentsAdapter` is `{ name: "deepagents", transforms: [stripMessageIdTransform] }`, and
 * `stripMessageIdTransform` lives in ./transforms — CORE. `transforms.ts` documents
 * `defaultTransforms` as "equivalent to `deepagentsAdapter.transforms`". So the behaviour
 * these tests currently exercise is already core-owned; only the NAMED BUNDLE was rung-owned.
 * `coreDefaultAdapter` is therefore byte-identical in behaviour to what the tests get today,
 * which makes the migration provably semantics-preserving. An empty pipeline would silently
 * drop the messageId strip and flip assertions that have nothing to do with this refactor.
 *
 * (The strip is an AI-SDK-v6 `strictObject` compatibility concern, not a DeepAgents one — the
 * rung-3 name on that adapter is historical. Renaming it is #3's scope, not this one's.)
 */
import { defaultTransforms } from "./transforms";
import type { SseAdapter } from "./adapter-contract";

/**
 * Behaviour-identical to `deepagentsAdapter`, built entirely from core.
 * Use this when migrating a test that previously called `createDeepAgentsHandler`.
 */
export const coreDefaultAdapter: SseAdapter = {
  name: "core-default",
  transforms: defaultTransforms,
};

/**
 * No transforms at all. Use when the test is about the TRANSPORT — backpressure, cleanup,
 * resilience — and any transform behaviour would be noise rather than subject.
 */
export const neutralAdapter: SseAdapter = {
  name: "core-neutral",
  transforms: [],
};

/**
 * A STATEFUL adapter whose `transforms` getter mints a fresh closure per access.
 *
 * Exists so core can test a genuine TRANSPORT property — that the handler re-reads
 * `adapter.transforms` per request, rather than capturing one closure at factory time and
 * sharing its counters across every request. Two tests in handler.test.ts asserted exactly
 * that and reached for `langchainAdapter` to do it, because it happened to be the stateful
 * adapter lying around. That made a core transport test rung-1-dependent for a property that
 * has nothing to do with LangChain. (Issue #17b.)
 *
 * langchain's OWN id determinism stays covered where it belongs, in
 * adapters/langchain.test.ts ("deterministic toolCallId — two tool_call frames from same
 * request"), so nothing is lost by testing the transport property with a core vehicle.
 *
 * Feed it `data: {"type":"probe"}`; it emits a tool-input-start whose id carries the
 * per-closure counter, so a leaked closure shows up as `fx-probe-1` on a second request.
 */
export const statefulFixtureAdapter: SseAdapter = {
  name: "core-stateful-fixture",
  get transforms(): SseAdapter["transforms"] {
    let n = 0;
    return [
      (frame) => {
        if (!frame.raw.startsWith("data: ")) return frame;
        try {
          const parsed = JSON.parse(frame.raw.slice(6)) as { type?: string };
          if (parsed.type !== "probe") return frame;
        } catch {
          return frame;
        }
        return {
          raw: `data: ${JSON.stringify({
            type: "tool-input-start",
            toolCallId: `fx-probe-${n++}`,
            toolName: "probe",
            input: {},
          })}`,
        };
      },
    ];
  },
};
