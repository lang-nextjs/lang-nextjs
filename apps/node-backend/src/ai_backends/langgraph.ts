/**
 * LangGraph AI backend for the node runtime — rung 2.
 *
 * RUNG-OWNED FILE, listed under the `langgraph` rung in rungs.json alongside its
 * two Python siblings. Python parity target:
 * apps/fastapi-backend/ai_backends/langgraph.py.
 *
 *   react        → @langchain/langgraph/prebuilt's createReactAgent. The
 *                  prebuilt convenience path, and the common one.
 *   plan-execute → a hand-built StateGraph (planner → executor → replanner with
 *                  a conditional edge back). This is the rung's teaching moment:
 *                  it shows LangGraph's actual abstraction rather than the
 *                  wrapper that hides it. Rung 1 could not express this — its
 *                  plan-execute is a harness AROUND create_agent with no graph
 *                  at all — and that difference is the reason rung 2 exists.
 *
 * WIRE FORMAT: raw `streamEvents` v2 JSON, one event per `data:` line, ending
 * `data: [DONE]`. Same as `langgraph-cli dev` and LangGraph Cloud produce, and
 * the same bytes the Python emits. `langGraphAdapter` normalises it, and its
 * discriminant is `event` — NOT `type`.
 */
import { StateGraph, START, END, Annotation } from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { SYSTEM_PROMPT } from "../common/prompt.js";
import { TOOLS } from "../common/tools.js";
import { makeLlm } from "../common/llm.js";
import { runConfig } from "../common/runAxes.js";
import type { ChatMessage } from "./langchain.js";

/** The only events worth putting on the wire. Mirrors `_INTERESTING_EVENTS`. */
const INTERESTING_EVENTS = new Set([
  "on_chat_model_stream",
  "on_tool_start",
  "on_tool_end",
]);

/**
 * Nodes whose `on_chat_model_stream` events are RAW STRUCTURED-OUTPUT JSON.
 *
 * The planner and replanner call the model through `withStructuredOutput`, so
 * their token stream is the serialised schema being generated — `{"steps":["…`
 * — not prose. It is internal data-shape generation and it must not reach the
 * user; the plan surfaces through the executor's own natural-language stream
 * and through the graph state's `response` field.
 *
 * OMITTING THIS FILTER IS THE FAILURE THIS FILE IS MOST LIKELY TO HAVE. It does
 * not produce malformed frames or an adapter error: every frame is a correctly
 * shaped `on_chat_model_stream`, the adapter maps each to a valid AI SDK v6
 * `text-delta`, and the user reads a JSON object where the answer should be. A
 * wire-shape assertion cannot catch it, because the wire shape is right — see
 * langgraph.test.ts, which asserts on CONTENT for exactly that reason.
 */
const STRUCTURED_OUTPUT_NODES = new Set(["planner", "replanner"]);

export interface StreamEvent {
  event: string;
  name?: string;
  run_id?: string;
  data?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export function shouldEmit(event: StreamEvent): boolean {
  if (!INTERESTING_EVENTS.has(event.event)) return false;
  if (event.event === "on_chat_model_stream") {
    const node = (event.metadata?.langgraph_node as string) ?? "";
    if (STRUCTURED_OUTPUT_NODES.has(node)) return false;
  }
  return true;
}

/**
 * Serialise a LangChain object the way the PYTHON plane does, not the way
 * JavaScript does by default.
 *
 * THIS IS A REAL DIVERGENCE AND IT SILENTLY DELETES EVERY TOKEN IF IGNORED.
 * Measured against both sides rather than inferred:
 *
 *   Python  model_dump()      -> {"content": "Hello", "tool_calls": [], …}
 *   JS      JSON.stringify()  -> {"lc":1,"type":"constructor",
 *                                 "id":["langchain_core","messages","AIMessageChunk"],
 *                                 "kwargs":{"content":"hello", …}}
 *
 * `langGraphAdapter` reads `data.chunk.content`. Under the JS default that path
 * is `undefined`, so the adapter emits nothing — and NOTHING ANYWHERE FAILS.
 * The frames are well-formed, the `event` discriminant is correct, the adapter
 * is happy, and the reply is empty. That is the same class as an adapter whose
 * `default` branch passes gibberish through: a green over output that looks
 * like output.
 *
 * So the constructor envelope is unwrapped recursively, leaving the flat shape
 * the fixture shows and the adapter reads.
 */
export function lcSerialize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(lcSerialize);

  const obj = value as Record<string, unknown>;
  // LangChain's serialisation envelope: {lc, type: "constructor", id, kwargs}.
  if (obj.lc === 1 && obj.type === "constructor" && obj.kwargs) {
    return lcSerialize(obj.kwargs);
  }
  // Objects that know how to serialise themselves (messages, chunks) go through
  // toJSON first, which produces the envelope handled above.
  if (typeof (obj as { toJSON?: unknown }).toJSON === "function") {
    return lcSerialize((obj as { toJSON: () => unknown }).toJSON());
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = lcSerialize(v);
  return out;
}

/** One `data:` frame carrying a raw streamEvents event. */
export function eventFrame(event: StreamEvent): string {
  return `data: ${JSON.stringify(lcSerialize(event))}\n\n`;
}

export const DONE_FRAME = "data: [DONE]\n\n";

// ---------------------------------------------------------------------------
// Topology 1: ReAct (prebuilt)
// ---------------------------------------------------------------------------

type Graph = { streamEvents: (i: unknown, c: Record<string, unknown>) => AsyncIterable<StreamEvent> };

let reactGraph: Graph | null = null;

export function getReactGraph(): Graph {
  if (reactGraph === null) {
    reactGraph = createReactAgent({
      llm: makeLlm(),
      tools: TOOLS,
      stateModifier: SYSTEM_PROMPT,
      name: "node-langgraph-react",
    }) as unknown as Graph;
  }
  return reactGraph;
}

// ---------------------------------------------------------------------------
// Topology 2: Plan-and-Execute (an explicit StateGraph)
// ---------------------------------------------------------------------------

/**
 * State carried through the plan-execute graph.
 *
 * `input`      the original user request — never mutated.
 * `plan`       ordered list of REMAINING steps. Replaced by the replanner.
 * `pastSteps`  append-only log of [step, result]. Its reducer CONCATENATES,
 *              which is what lets the executor return only its own step and
 *              have LangGraph accumulate the log — the JS equivalent of
 *              Python's `Annotated[List[...], operator.add]`.
 * `response`   terminal field; non-empty means "done, leave the graph".
 */
const PlanExecuteState = Annotation.Root({
  input: Annotation<string>({ reducer: (_, b) => b, default: () => "" }),
  plan: Annotation<string[]>({ reducer: (_, b) => b, default: () => [] }),
  pastSteps: Annotation<Array<[string, string]>>({
    reducer: (a, b) => a.concat(b),
    default: () => [],
  }),
  response: Annotation<string>({ reducer: (_, b) => b, default: () => "" }),
});

/** Planner output. JSON Schema, not zod — see common/tools.ts for why. */
const PLAN_SCHEMA = {
  type: "object",
  properties: {
    steps: {
      type: "array",
      items: { type: "string" },
      description:
        "Ordered, atomic steps to accomplish the user's request. Each step " +
        "should be specific enough that an executor agent can act on it in a " +
        "single turn.",
    },
  },
  required: ["steps"],
} as const;

/**
 * Replanner output — either finish with a response, or continue with a plan.
 *
 * Python models this as `Union[_Response, _Plan]`. A JSON Schema union would be
 * `oneOf`, which providers support unevenly through tool-calling, so this is one
 * object with both fields optional and `response` taking precedence. The
 * BEHAVIOUR is identical — the branch below reads exactly what Python's
 * `isinstance(action.action, _Response)` reads — and the difference is recorded
 * rather than smoothed over.
 */
const REPLAN_SCHEMA = {
  type: "object",
  properties: {
    response: {
      type: "string",
      description:
        "Set this ONLY if the past steps already answer the user's request. " +
        "Prefer this when possible — do not repeat work.",
    },
    steps: {
      type: "array",
      items: { type: "string" },
      description:
        "The remaining steps, possibly revised. Set this only if more work " +
        "is genuinely needed.",
    },
  },
} as const;

const PLANNER_SYSTEM =
  "For the given user request, produce a concise step-by-step plan. Each step " +
  "should be a single concrete action an executor agent can perform in one " +
  "turn. Do not skip steps; do not add steps that aren't needed. The final " +
  "step should produce the answer.";

const REPLANNER_SYSTEM =
  "You are revising an in-progress plan. Given the user's original request, " +
  "the past steps already executed, and the remaining plan, either set " +
  "`response` if the past steps already answer the request, or set `steps` to " +
  "the remaining steps (you may revise them). Prefer `response` when possible " +
  "— don't repeat work.";

let planExecuteGraph: Graph | null = null;

export function buildPlanExecuteGraph(model?: BaseChatModel): Graph {
  const llm = model ?? makeLlm();

  // NAMED `planner` AND `replanner` FOR A REASON BEYOND READABILITY: those two
  // names are the keys STRUCTURED_OUTPUT_NODES matches on, via
  // metadata.langgraph_node. Rename a node and its raw JSON starts reaching the
  // user — which is why langgraph.test.ts asserts the suppression by node name
  // rather than by position.
  const planner = llm.withStructuredOutput(PLAN_SCHEMA, { name: "Plan" });
  const replanner = llm.withStructuredOutput(REPLAN_SCHEMA, {
    name: "ReplanAction",
  });

  // The executor reuses the prebuilt ReAct agent, so tool calls (increment,
  // get_counter) are handled without re-implementing the loop — the same choice
  // the Python makes, and the reason the two rungs share a tool surface.
  const executor = createReactAgent({
    llm,
    tools: TOOLS,
    stateModifier: SYSTEM_PROMPT,
    name: "node-langgraph-plan-execute-executor",
  });

  const workflow = new StateGraph(PlanExecuteState)
    .addNode("planner", async (state) => {
      const plan = (await planner.invoke([
        { role: "system", content: PLANNER_SYSTEM },
        { role: "user", content: state.input },
      ])) as { steps?: string[] };
      return { plan: plan.steps ?? [], pastSteps: [] };
    })
    .addNode("executor", async (state) => {
      if (state.plan.length === 0) {
        return { response: "Plan empty — nothing to execute." };
      }
      const task = state.plan[0];
      // BOTH THE GOAL AND THE STEP. Without the original goal the executor
      // sometimes treats a step as read-only ("get current value") instead of
      // the mutating action it is ("call increment()"). Pattern taken from the
      // LangGraph plan-execute notebook, and the Python carries the same note.
      const result = (await executor.invoke({
        messages: [
          {
            role: "user",
            content:
              `Overall user request: ${state.input}\n\n` +
              `Your current sub-step: ${task}\n\n` +
              "Use the available tools to actually perform the action. " +
              "Do not just describe — invoke the tool API.",
          },
        ],
      })) as { messages: Array<{ content?: unknown }> };
      const last = result.messages[result.messages.length - 1];
      const text =
        typeof last?.content === "string" ? last.content : String(last?.content ?? "");
      return {
        pastSteps: [[task, text]] as Array<[string, string]>,
        plan: state.plan.slice(1),
      };
    })
    .addNode("replanner", async (state) => {
      const action = (await replanner.invoke([
        { role: "system", content: REPLANNER_SYSTEM },
        {
          role: "user",
          content:
            `Request: ${state.input}\n\n` +
            `Past steps:\n${state.pastSteps
              .map(([step, result]) => `- ${step}: ${result}`)
              .join("\n")}\n\n` +
            `Remaining plan: ${JSON.stringify(state.plan)}`,
        },
      ])) as { response?: string; steps?: string[] };
      // `response` wins, mirroring Python's isinstance(_Response) branch.
      if (action.response) return { response: action.response };
      return { plan: action.steps ?? [] };
    })
    .addEdge(START, "planner")
    .addEdge("planner", "executor")
    .addEdge("executor", "replanner")
    // THE CONDITIONAL EDGE IS THE POINT OF THIS TOPOLOGY. Finish when there is
    // a response, or when the plan is empty after a replan (the replanner could
    // not produce new steps); otherwise loop back into the executor.
    .addConditionalEdges(
      "replanner",
      (state) => {
        if (state.response) return END;
        if (state.plan.length === 0) return END;
        return "executor";
      },
      { [END]: END, executor: "executor" }
    );

  return workflow.compile() as unknown as Graph;
}

export function getPlanExecuteGraph(): Graph {
  if (planExecuteGraph === null) planExecuteGraph = buildPlanExecuteGraph();
  return planExecuteGraph;
}

// ---------------------------------------------------------------------------
// Topology dispatch — each topology has its own state shape, so each has its
// own stream function rather than one shared helper. Same as the Python.
// ---------------------------------------------------------------------------

async function* streamGraph(
  graph: Graph,
  input: unknown
): AsyncGenerator<string> {
  for await (const event of graph.streamEvents(input, {
    version: "v2",
    ...runConfig(),
  })) {
    if (shouldEmit(event)) yield eventFrame(event);
  }
  yield DONE_FRAME;
}

export async function* streamChatReact(
  messages: ChatMessage[]
): AsyncGenerator<string> {
  yield* streamGraph(getReactGraph(), { messages });
}

export async function* streamChatPlanExecute(
  messages: ChatMessage[]
): AsyncGenerator<string> {
  const userText = messages.length > 0 ? messages[messages.length - 1].content : "";
  yield* streamGraph(getPlanExecuteGraph(), { input: userText });
}

export const TOPOLOGIES: Record<
  string,
  (messages: ChatMessage[]) => AsyncGenerator<string>
> = {
  react: streamChatReact,
  "plan-execute": streamChatPlanExecute,
};

export function warmup(): void {
  getReactGraph();
  getPlanExecuteGraph();
}
