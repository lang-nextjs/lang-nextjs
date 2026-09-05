/**
 * The two things about this rung that a wire-shape assertion CANNOT catch.
 *
 * #348 established that "the adapter consumed it" is satisfiable by gibberish,
 * because langchainAdapter's default branch passes unknown frames through. This
 * rung has the same failure one level in, and it is worse: BOTH defects below
 * produce frames that are correctly shaped, correctly discriminated, and
 * happily consumed. The adapter cannot object, so the assertions have to be
 * about CONTENT — what a person ends up reading.
 */
import { describe, expect, it, vi } from "vitest";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import {
  DONE_FRAME,
  buildPlanExecuteGraph,
  eventFrame,
  lcSerialize,
  shouldEmit,
} from "./langgraph.js";

describe("the structured-output filter", () => {
  const streamFrom = (node: string) => ({
    event: "on_chat_model_stream",
    name: "ChatOpenAI",
    run_id: "r1",
    data: { chunk: { content: '{"steps":["a"' } },
    metadata: { langgraph_node: node },
  });

  it("suppresses planner and replanner tokens", () => {
    // These are raw with_structured_output JSON. Emitted, they reach the user
    // as a serialised schema where the answer should be — every frame valid.
    expect(shouldEmit(streamFrom("planner"))).toBe(false);
    expect(shouldEmit(streamFrom("replanner"))).toBe(false);
  });

  it("CONTROL: lets every other node's tokens through", () => {
    // Without this the filter could suppress everything and still pass above.
    // `agent` is the node name the prebuilt ReAct graph uses, and it is the one
    // carrying the user-facing prose in the react topology.
    expect(shouldEmit(streamFrom("executor"))).toBe(true);
    expect(shouldEmit(streamFrom("agent"))).toBe(true);
    expect(shouldEmit(streamFrom(""))).toBe(true);
  });

  it("filters by NODE, not by event type — tools from any node still pass", () => {
    // The suppression is narrow on purpose: a planner that called a tool would
    // still need that tool call on the wire. Only its token stream is noise.
    for (const node of ["planner", "replanner"]) {
      expect(
        shouldEmit({
          event: "on_tool_start",
          metadata: { langgraph_node: node },
        })
      ).toBe(true);
      expect(
        shouldEmit({ event: "on_tool_end", metadata: { langgraph_node: node } })
      ).toBe(true);
    }
  });

  it("drops the events the wire has no use for", () => {
    for (const event of ["on_chain_start", "on_chain_end", "on_chain_stream"]) {
      expect(shouldEmit({ event })).toBe(false);
    }
  });
});

describe("lcSerialize — the shape the adapter actually reads", () => {
  /**
   * THE DIVERGENCE THAT DELETES EVERY TOKEN WITHOUT FAILING ANYTHING.
   *
   *   Python model_dump()     -> {"content": "Hello", …}
   *   JS default stringify    -> {"lc":1,"type":"constructor","kwargs":{"content":"hello"}}
   *
   * langGraphAdapter reads `data.chunk.content`. Under the JS default that is
   * undefined, so the adapter emits nothing and the reply is empty — with
   * well-formed frames, a correct `event` discriminant, and no error anywhere.
   */
  it("unwraps LangChain's constructor envelope so content is where Python puts it", () => {
    const envelope = {
      lc: 1,
      type: "constructor",
      id: ["langchain_core", "messages", "AIMessageChunk"],
      kwargs: { content: "Hello", tool_calls: [] },
    };
    expect(lcSerialize(envelope)).toEqual({ content: "Hello", tool_calls: [] });
  });

  it("reaches envelopes nested inside an event", () => {
    const frame = eventFrame({
      event: "on_chat_model_stream",
      data: {
        chunk: {
          lc: 1,
          type: "constructor",
          id: ["langchain_core", "messages", "AIMessageChunk"],
          kwargs: { content: "Hi" },
        },
      },
    });
    const parsed = JSON.parse(frame.slice(6).trim());
    // The exact path langGraphAdapter reads. Asserting the whole object would
    // pass on a shape that merely CONTAINS the content somewhere.
    expect(parsed.data.chunk.content).toBe("Hi");
    expect(parsed.data.chunk.kwargs).toBeUndefined();
  });

  it("leaves plain values alone", () => {
    // The control. A serialiser that flattened everything would satisfy the
    // assertions above and destroy ordinary payloads.
    expect(lcSerialize({ a: 1, b: [{ c: "x" }] })).toEqual({
      a: 1,
      b: [{ c: "x" }],
    });
    expect(lcSerialize("plain")).toBe("plain");
    expect(lcSerialize(null)).toBe(null);
  });
});

describe("the plan-execute StateGraph", () => {
  /**
   * A REAL GRAPH RUN. The topology is what rung 2 is FOR, and asserting it by
   * reading the source would prove nothing.
   *
   * SCRIPTED, NOT MOCKED AT THE GRAPH LEVEL: the model is a fake, the graph is
   * the real compiled StateGraph, and the assertions are about what came out of
   * it. Note the executor's inner node reports as `agent` — that is
   * createReactAgent's own node name, and it is why STRUCTURED_OUTPUT_NODES
   * lists planner/replanner and not "everything except executor".
   */
  function scriptedModel() {
    return new FakeListChatModel({
      responses: [
        JSON.stringify({ steps: ["call increment()"] }),
        JSON.stringify({ response: "The counter was incremented." }),
      ],
    });
  }

  it("runs planner -> executor -> replanner and the conditional edge ends it", async () => {
    const graph = buildPlanExecuteGraph(scriptedModel() as never);
    const nodes: string[] = [];
    let emitted = 0;
    let leaked: string[] = [];

    for await (const ev of graph.streamEvents(
      { input: "increment once" },
      { version: "v2" }
    )) {
      if (
        ev.event === "on_chain_start" &&
        typeof ev.name === "string" &&
        ["planner", "executor", "replanner"].includes(ev.name)
      ) {
        nodes.push(ev.name);
      }
      if (shouldEmit(ev)) {
        emitted++;
        const node = (ev.metadata?.langgraph_node as string) ?? "";
        if (
          ev.event === "on_chat_model_stream" &&
          ["planner", "replanner"].includes(node)
        ) {
          leaked.push(node);
        }
      }
    }

    // The declared topology ran in order, and the run TERMINATED — the
    // conditional edge saw `response` and returned END instead of looping back
    // into the executor. A graph that looped forever would never reach here.
    expect(nodes.slice(0, 3)).toEqual(["planner", "executor", "replanner"]);

    // ANTI-VACUITY FIRST. "Nothing leaked" is trivially true of a run that
    // emitted nothing at all, which is exactly what a broken filter that
    // suppressed everything would produce.
    expect(emitted, "the run put nothing on the wire").toBeGreaterThan(0);

    // THE PROPERTY. Not one token from a structured-output node survived the
    // filter on a real run — the frames exist, they are well-formed, and the
    // adapter would happily render them as the user's answer.
    expect(
      leaked,
      "a structured-output node's raw JSON survived shouldEmit on a real graph run"
    ).toEqual([]);
  });

  it("CONTENT: the planner's schema is dropped and the executor's prose is kept", async () => {
    /*
     * The assertion a wire-shape check cannot make. Both frames below are
     * valid `on_chat_model_stream` events that langGraphAdapter turns into
     * valid text-deltas; the only thing separating them is which node they came
     * from and therefore what a person ends up reading.
     *
     * Shapes taken from a real run of the graph above, not invented.
     */
    const planner = {
      event: "on_chat_model_stream",
      name: "ChatOpenAI",
      run_id: "r1",
      data: { chunk: { content: '{"steps":["call increment()"]}' } },
      metadata: { langgraph_node: "planner" },
    };
    const agent = {
      event: "on_chat_model_stream",
      name: "ChatOpenAI",
      run_id: "r2",
      data: { chunk: { content: "I incremented it." } },
      metadata: { langgraph_node: "agent" },
    };

    const wire = [planner, agent].filter(shouldEmit).map(eventFrame).join("");

    expect(
      wire,
      "the planner's serialised schema reached the wire — a user would read a " +
        "plan object where the answer should be"
    ).not.toContain('"steps"');
    expect(wire).toContain("I incremented it.");
  });
});

describe("the wire format", () => {
  it("is one raw event per data: line, terminated by [DONE]", () => {
    // langGraphAdapter's discriminant is `event`, NOT `type` — a frame that
    // renamed it would be unrecognisable and this pins it.
    const frame = eventFrame({
      event: "on_tool_start",
      name: "increment",
      run_id: "r",
    });
    expect(frame.startsWith("data: ")).toBe(true);
    expect(frame.endsWith("\n\n")).toBe(true);
    expect(JSON.parse(frame.slice(6).trim()).event).toBe("on_tool_start");
    expect(DONE_FRAME).toBe("data: [DONE]\n\n");
  });
});
