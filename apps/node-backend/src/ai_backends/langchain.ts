/**
 * LangChain AI backend for the node runtime — rung 1.
 *
 * RUNG-OWNED FILE. It is listed in rungs.json under the `langchain` rung's
 * `owns.ts`, so `pnpm eject` treats it the way it treats the two Python
 * langchain modules beside it. Rung 1 is the bottom of the ladder and survives
 * every ejection, which is why the registry can reference it directly where
 * main.py must go through `_MODULES` — see registry.ts, which explains what
 * changes the day a second rung lands here.
 *
 * TOPOLOGIES: react and plan-execute, matching the Python planes (#8). Both
 * are registered in TOPOLOGIES below, which `/health` derives from — so the
 * advertised set cannot drift from the served set, and a topology this runtime
 * cannot serve still 404s naming what exists.
 *
 * WIRE FORMAT: LangChain native SSE, byte-identical to
 * apps/fastapi-backend/ai_backends/langchain.py. The acceptance criterion for
 * this whole backend is that `langchainAdapter` consumes it UNMODIFIED, so the
 * frames are built by common/sse.ts and nothing here invents a shape.
 */
import { createAgent } from "langchain";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import type { CompiledStateGraph } from "@langchain/langgraph";
import { SYSTEM_PROMPT } from "../common/prompt.js";
import { TOOLS } from "../common/tools.js";
import { makeLlm } from "../common/llm.js";
import { runConfig } from "../common/runAxes.js";
import {
  messageTerminator,
  tokenEvent,
  toolCallEvent,
  toolEndEvent,
} from "../common/sse.js";

type Agent = ReturnType<typeof createAgent>;

let executor: Agent | null = null;

/**
 * Lazy-init the agent graph.
 *
 * Named `getExecutor` rather than `getGraph` to match the Python module's
 * public API, which chose that name so callers need not know about LangChain's
 * 1.x rename.
 */
export function getExecutor(): Agent {
  if (executor === null) {
    executor = createAgent({
      model: makeLlm(),
      tools: TOOLS,
      systemPrompt: SYSTEM_PROMPT,
      name: "node-langchain-react",
    });
  }
  return executor;
}

export interface ChatMessage {
  role: string;
  content: string;
}

/**
 * The tool input, as an object.
 *
 * A REAL JS/PYTHON DIVERGENCE, handled rather than assumed away. Python's
 * `on_tool_start` carries the argument dict directly; LangChain JS wraps it as
 * `{ input: "<json string>" }`. Measured, not read from docs — a probe against
 * this exact version printed `{"input":{"input":"{\"q\":\"abc\"}"}}`.
 *
 * It matters because `langchainAdapter` forwards `tool_input` straight into the
 * AI SDK `tool-input-available` part, which the UI renders as the call's
 * arguments. Passing the wrapper through would show every tool as having been
 * called with a single string field named `input`, on every rung, forever —
 * wrong in a way that looks like data.
 *
 * Falls back to the value as-is when it is not the wrapper shape or not
 * parseable, because a best-effort object beats dropping the frame.
 */
export function unwrapToolInput(raw: unknown): unknown {
  if (raw && typeof raw === "object" && "input" in raw) {
    const inner = (raw as { input: unknown }).input;
    if (typeof inner === "string") {
      try {
        return JSON.parse(inner);
      } catch {
        return inner;
      }
    }
    return inner;
  }
  return raw ?? {};
}

/**
 * Emit LangChain SSE frames from a single AGENT run.
 *
 * NOT FOR THE PLANNER, AND THIS IS THE MOST IMPORTANT SENTENCE IN THE FILE.
 * See `getPlanner` below: the plan-execute planner is a
 * `withStructuredOutput` chain, and streaming it puts the raw JSON of the Plan
 * object onto the wire as `event: token` frames. Every frame would be
 * well-formed, the `event:` header assertion would pass, `langchainAdapter`
 * would accept all of it, and the user would read a serialised object where a
 * plan should be.
 *
 * The Python has the same rule and states it nowhere — it is expressed only as
 * `await planner.ainvoke(...)` rather than `astream_events`, which reads like
 * an incidental choice between two ways to call a chain. There is no filter to
 * copy and no constant to forget, so a port that asks "what must I reproduce
 * here" finds nothing, and the idiomatic answer — reuse the streaming helper
 * that is right there — is the broken one.
 */
export async function* streamAgentEvents(
  agent: Agent,
  input: { messages: ChatMessage[] }
): AsyncGenerator<string> {
  const stream = (
    agent as unknown as {
      streamEvents: (
        i: unknown,
        c: Record<string, unknown>
      ) => AsyncIterable<{
        event: string;
        name?: string;
        run_id?: string;
        data?: {
          chunk?: { content?: unknown };
          input?: unknown;
          output?: unknown;
        };
      }>;
    }
  ).streamEvents(input, { version: "v2", ...runConfig() });

  for await (const ev of stream) {
    if (ev.event === "on_chat_model_stream") {
      const content = ev.data?.chunk?.content;
      // `content` is a string for text chunks and an array of content blocks
      // for providers that use them. Only the string case is a token; the
      // Python does the same `isinstance(content, str) and content` test.
      if (typeof content === "string" && content) {
        yield tokenEvent(content);
      }
    } else if (ev.event === "on_tool_start") {
      yield toolCallEvent(
        ev.name ?? "unknown",
        unwrapToolInput(ev.data?.input),
        ev.run_id ?? ""
      );
    } else if (ev.event === "on_tool_end") {
      // The SAME run_id as on_tool_start, which is what makes the pairing free.
      yield toolEndEvent(ev.run_id ?? "", ev.data?.output);
    }
  }
}

/** ReAct topology — a single agent invocation. */
export async function* streamChatReact(
  messages: ChatMessage[]
): AsyncGenerator<string> {
  yield* streamAgentEvents(getExecutor(), { messages });
  yield messageTerminator();
}

// ---------------------------------------------------------------------------
// Topology 2: Plan-Execute — a custom harness, because LC 1.x ships no
// PlanAndExecute primitive (deprecated in 0.x). This is the rung's point:
// expressing a non-prebuilt topology WITHOUT the graph runtime rung 2 adds.
// ---------------------------------------------------------------------------

/**
 * Structured output for the planner — the JSON-schema twin of Python's `_Plan`.
 *
 * A RAW JSON SCHEMA RATHER THAN ZOD, deliberately. `withStructuredOutput`
 * accepts either, and this file is rung-owned: after `pnpm eject langchain` it
 * is the only agent code left, so every dependency it names is one a fork
 * cannot drop. The description text is carried across verbatim because it is
 * prompt content — the model reads it, so paraphrasing it is changing the
 * planner's behaviour, not tidying a comment.
 */
const PLAN_SCHEMA = {
  title: "Plan",
  description:
    "Structured output for the planner — ordered list of atomic steps.",
  type: "object",
  properties: {
    steps: {
      type: "array",
      items: { type: "string" },
      description:
        "Ordered, atomic steps to accomplish the user's request. Each step " +
        "should be a single concrete action an executor agent can perform in " +
        "one turn (e.g. 'call increment()').",
    },
  },
  required: ["steps"],
} as const;

interface Plan {
  steps?: unknown;
}

let planExecuteExecutor: Agent | null = null;
let planner: ReturnType<typeof buildPlanner> | null = null;

/** The executor agent — same as ReAct's, renamed for trace clarity. */
export function getPlanExecuteExecutor(): Agent {
  if (planExecuteExecutor === null) {
    planExecuteExecutor = createAgent({
      model: makeLlm(),
      tools: TOOLS,
      systemPrompt: SYSTEM_PROMPT,
      name: "node-langchain-plan-execute-executor",
    });
  }
  return planExecuteExecutor;
}

function buildPlanner() {
  const prompt = ChatPromptTemplate.fromMessages([
    [
      "system",
      "You are a planner. Given a user request, produce a concise ordered " +
        "list of atomic steps the executor agent can perform. Each step " +
        "should be a single concrete action (e.g. 'call increment()'). Do " +
        "not skip; do not add steps that aren't needed.",
    ],
    ["user", "{input}"],
  ]);
  // `.withConfig({ runName })` is the JS spelling of Python's
  // `.with_config({"run_name": ...})`: it names the sub-run in the trace
  // dashboard instead of leaving it as a generic RunnableSequence.
  return prompt
    .pipe(makeLlm().withStructuredOutput<Plan>(PLAN_SCHEMA))
    .withConfig({ runName: "node-langchain-plan-execute-planner" });
}

/**
 * The planner — a model-with-structured-output chain. No graph, no tools.
 *
 * WHAT CALLERS MUST NOT DO IS INVISIBLE FROM HERE, so it is written down:
 * this chain is INVOKED, never streamed. See streamAgentEvents above for what
 * streaming it would put on the wire.
 */
export function getPlanner(): ReturnType<typeof buildPlanner> {
  if (planner === null) planner = buildPlanner();
  return planner;
}

/**
 * The plan, as a list of non-empty strings.
 *
 * A DELIBERATE, NARROW DIVERGENCE FROM PYTHON, on an error path only. Python
 * reads `plan.steps` straight into a comprehension, so a planner that returned
 * no steps raises mid-generator and the stream dies WITHOUT its
 * `event: message` terminator. The adapter's `isTerminal` predicate never
 * fires, and guardedStream reports the run as `upstream_disconnect` — which
 * blames the transport for a modelling failure and sends whoever debugs it to
 * the wrong layer.
 *
 * So a malformed plan is normalised here and reported in-band below. The happy
 * path is byte-identical; only the failure gets a better name.
 */
export function planSteps(plan: Plan | null | undefined): string[] {
  const raw = plan?.steps;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is string => typeof s === "string")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Plan-Execute topology — the planner produces steps, the executor runs each.
 *
 * A `for` LOOP, NOT A GRAPH, AND THAT IS A DECISION (#8). Modelling this as a
 * LangGraph would buy interruptibility: the loop's position lives in a local
 * variable that no checkpointer holds, so this is the one cell on the matrix
 * that cannot be resumed mid-plan. It is reproduced anyway, for two reasons.
 *
 * The acceptance bar for this rung is PARITY — the same prompt through the
 * Python and TypeScript backends yielding equivalent UI behaviour — and a
 * graph would diverge on exactly the axis being measured.
 *
 * More importantly, rung 1 exists to demonstrate expressing a non-prebuilt
 * topology WITHOUT the graph runtime. Rung 2 is where the checkpointer story
 * lives. A ladder whose first rung already has the second rung's mechanism is
 * not a ladder, so the limitation is documented rather than engineered away.
 */
export async function* streamChatPlanExecute(
  messages: ChatMessage[]
): AsyncGenerator<string> {
  const userText = messages.length ? messages[messages.length - 1].content : "";

  // 1. Plan. INVOKED, NOT STREAMED — see streamAgentEvents and getPlanner.
  yield tokenEvent("Planning…\n");
  const plan = (await getPlanner().invoke(
    { input: userText },
    runConfig()
  )) as Plan;
  const steps = planSteps(plan);

  if (steps.length === 0) {
    // In-band and terminated, so the adapter sees a complete stream and the
    // user is told what happened rather than watching a run vanish.
    yield tokenEvent(
      "The planner returned no steps, so there is nothing to run.\n"
    );
    yield messageTerminator();
    return;
  }

  yield tokenEvent(
    "Plan:\n" + steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n") + "\n\n"
  );

  // 2. Execute each step with the executor agent.
  const executor = getPlanExecuteExecutor();
  for (const [i, step] of steps.entries()) {
    yield tokenEvent(`Step ${i + 1}: ${step}\n`);
    yield* streamAgentEvents(executor, {
      messages: [
        {
          role: "user",
          content:
            `Overall user request: ${userText}\n\n` +
            `Your current sub-step: ${step}\n\n` +
            "Use the available tools to actually perform the action. " +
            "Do not just describe — invoke the tool API.",
        },
      ],
    });
    yield tokenEvent("\n");
  }

  // 3. One terminator for the whole run, not one per step.
  yield messageTerminator();
}

/** Public dispatch surface — the router reads this to route by body.topology. */
export const TOPOLOGIES: Record<
  string,
  (messages: ChatMessage[]) => AsyncGenerator<string>
> = {
  react: streamChatReact,
  "plan-execute": streamChatPlanExecute,
};

/**
 * Eager-init so first-request latency and construction errors surface at boot.
 *
 * Called through the registry, never by name — the same rule main.py learned
 * the hard way when `pnpm eject langchain` left it calling modules it had just
 * deleted.
 */
export function warmup(): void {
  getExecutor();
  // The plan-execute pair too: warming only react would leave the first
  // plan-execute request paying construction cost AND surfacing any
  // construction error as a mid-stream failure rather than at boot, which is
  // the thing warmup exists to prevent.
  getPlanExecuteExecutor();
  getPlanner();
}

export type { CompiledStateGraph };
