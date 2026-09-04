/**
 * DeepAgents AI backend — the TypeScript plane's rung 3 (#10).
 *
 * Parity target: apps/fastapi-backend/ai_backends/deepagents.py. Two topologies,
 * both emitting AI SDK v6 wire format natively:
 *
 *   "react"        -> createDeepAgent({ model, tools, systemPrompt })
 *   "plan-execute" -> the same, plus declarative `subagents`, where the
 *                     orchestrator has NO direct tools and must delegate
 *                     through the auto-injected `task()` tool.
 *
 * PARITY WAS MEASURED BEFORE THIS WAS WRITTEN, not assumed (#10). Against
 * deepagents 1.13.2 (JS) and 0.7.11 (Python): the injected builtin tools are
 * identical (`ls read_file write_file edit_file delete glob grep task`),
 * subagents and `task` delegation are present on both, and `interruptOn` +
 * `checkpointer` withhold execution on both — including for a SUBAGENT's tool
 * call, which inherits the top-level config. The one capability difference is
 * that JS declares three HITL decisions to Python's four: it has no `respond`.
 *
 * "deep-research" IS DELIBERATELY ABSENT, and its absence is advertised rather
 * than silent — see TOPOLOGIES. The Python topology adds DuckDuckGo web search
 * via `ddgs`, which has no direct JS equivalent. That is a TOOL decision, not a
 * DeepAgents one, and blocking rung 3 on it would misattribute the gap.
 */

import { createDeepAgent } from "deepagents";
import { AIMessageChunk, ToolMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";

import { makeLlm } from "../common/llm.js";
import { SYSTEM_PROMPT } from "../common/prompt.js";
import { TOOLS } from "../common/tools.js";
import { runConfig } from "../common/runAxes.js";
import type { ChatMessage } from "./langchain.js";

/* -------------------------------------------------------------------------- */
/*  THE PREDICATE THIS RUNG TURNS ON                                          */
/* -------------------------------------------------------------------------- */

/**
 * Is this stream chunk coming from a SUBAGENT rather than the root agent?
 *
 * THE ONE LINE THAT DOES NOT SURVIVE TRANSLATION FROM PYTHON, and the reason
 * this rung was assessed by running it rather than reading it (#10).
 *
 * deepagents.py asks `subagent = bool(namespace)`. That is correct in Python,
 * where the root agent's own messages arrive with an EMPTY namespace:
 *
 *   Python 0.7.11   root: ns = ()                      subagent: ns = ('tools:<uuid>',)
 *   JS     1.13.2   root: ns = ["model_request:<uuid>"] subagent: ns = ["tools:<uuid>", "model_request:<uuid>"]
 *
 * In JS the root's namespace is NEVER empty — measured `nonEmpty=2, empty=0`
 * over a two-agent run. So the faithful port of that line inverts: every
 * root-agent message is classified as subagent prose and dropped.
 *
 * AND THE FAILURE IS WELL-FORMED, which is what makes it dangerous. Tool calls
 * still flow (they are emitted for subagents deliberately, see below), the
 * terminal `finish` still arrives, every frame validates, and the adapter
 * accepts all of it. The assistant simply never speaks — which reads as a quiet
 * model, not a broken filter. No code review catches it: the line is faithful
 * to its source and the output is valid.
 *
 * Nesting under a TOOL node is what makes something a subagent, in both
 * runtimes. Python's `bool(ns)` merely coincides with that.
 */
export function isSubagentNamespace(ns: readonly unknown[]): boolean {
  return ns.some((seg) => String(seg).startsWith("tools:"));
}

/* -------------------------------------------------------------------------- */
/*  Topologies                                                                */
/* -------------------------------------------------------------------------- */

type DeepAgent = ReturnType<typeof createDeepAgent>;

let reactGraph: DeepAgent | null = null;
let planExecuteGraph: DeepAgent | null = null;

/** Topology 1 — the library's default flavour. */
export function getGraph(): DeepAgent {
  reactGraph ??= createDeepAgent({
    model: makeLlm(),
    tools: TOOLS,
    systemPrompt: SYSTEM_PROMPT,
  });
  return reactGraph;
}

/**
 * Topology 2 — plan-execute via declarative subagents.
 *
 * The orchestrator is given NO direct tools, exactly as in the Python. Without
 * that it takes the shortest path and calls `increment` itself, which passes a
 * test asserting the counter moved while demonstrating none of the pattern.
 */
export function getPlanExecuteGraph(): DeepAgent {
  planExecuteGraph ??= createDeepAgent({
    model: makeLlm(),
    tools: [],
    systemPrompt:
      SYSTEM_PROMPT +
      "\n\nWhen the user makes a request:\n" +
      "1. First delegate to the `planner` subagent via the task() tool to " +
      "produce a step-by-step plan.\n" +
      "2. Then for each step in the plan, delegate to the `executor` subagent " +
      "via task() with that step's description.\n" +
      "3. After all steps, summarize what was done in a brief final reply.\n" +
      "Do NOT call increment/get_counter directly — always delegate to the " +
      "executor subagent.",
    subagents: [
      {
        name: "planner",
        description:
          "Generates a step-by-step plan for the user's request as a numbered " +
          "list. Does NOT execute any actions — only plans.",
        systemPrompt:
          "You are a planner. Given a user request, produce a concise numbered " +
          "list of atomic steps that the executor subagent can perform. Do not " +
          "call any tools yourself — your job is to plan.",
        tools: [],
      },
      {
        name: "executor",
        description:
          "Executes a single step from the plan by calling the appropriate " +
          "tool. Receives the step description as input.",
        systemPrompt:
          "You are an executor. You will receive a description of a single step " +
          "to perform. Use the tools available to actually perform the action. " +
          "Do not just describe — invoke the tool API. Report what you did " +
          "concisely.",
        tools: TOOLS,
      },
    ],
  });
  return planExecuteGraph;
}

/* -------------------------------------------------------------------------- */
/*  AI SDK v6 wire format                                                     */
/* -------------------------------------------------------------------------- */

const frame = (o: Record<string, unknown>): string =>
  `data: ${JSON.stringify(o)}\n\n`;

/** Normalise a tool result's content the way the Python does. */
export function coerceOutput(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && "text" in part
          ? String((part as { text: unknown }).text ?? "")
          : String(part)
      )
      .join(" ");
  }
  return String(content ?? "");
}

/**
 * Translate a deep agent's stream into AI SDK v6 frames.
 *
 * SUBAGENT PROSE IS HIDDEN; SUBAGENT TOOL CALLS ARE NOT. Inherited verbatim
 * from the Python, including the reason, because it was learned the expensive
 * way there: hiding subagent text matches the canonical deepagents CLI and the
 * reasoning is still in the trace, but a subagent tool call MUTATES SHARED
 * STATE. Suppressing it means the UI reports work it did not do and omits work
 * it did — measured on the live matrix as "reported 0 increment call(s) but the
 * counter moved from 5 to 6". Prose is noise; a state change is not.
 */
export async function* emitAiSdkV6(
  graph: DeepAgent,
  messages: ChatMessage[]
): AsyncGenerator<string> {
  let textCounter = 0;
  let textId: string | null = null;
  let inText = false;
  const seenToolCallIds = new Set<string>();

  /*
   * WHAT THE TURN COST (#727). #300 added this to fastapi and django and not
   * here, so on this runtime every layer above the model said a turn was free —
   * the misreport #232 opened. The agreement between the three planes is
   * asserted from scripts/fixtures/turn-usage-cases.json by
   * turn-usage-contract.test.ts, which read RED for exactly the four cases that
   * require a report and GREEN for the two that require its absence before this
   * existed.
   *
   * SUMMED, NOT OVERWRITTEN. A turn is not one model call — plan-execute makes
   * several — and taking the last call's usage as the turn's is wrong in the
   * direction that looks plausible, because a smaller number is one nobody
   * questions.
   */
  const turnUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

  const startText = (): string => {
    textCounter += 1;
    textId = `text-${textCounter}`;
    inText = true;
    return frame({ type: "text-start", id: textId });
  };
  const endText = (): string | null => {
    if (!inText || !textId) return null;
    inText = false;
    return frame({ type: "text-end", id: textId });
  };

  const stream = await (
    graph as unknown as {
      stream: (
        i: unknown,
        c: Record<string, unknown>
      ) => AsyncIterable<unknown>;
    }
  ).stream(
    { messages },
    { streamMode: ["messages", "updates"], subgraphs: true, ...runConfig() }
  );

  for await (const chunk of stream) {
    if (!Array.isArray(chunk) || chunk.length !== 3) continue;
    const [ns, mode, data] = chunk as [unknown[], string, unknown];
    if (mode !== "messages") continue;
    if (!Array.isArray(data) || data.length === 0) continue;

    const message = data[0] as BaseMessage;
    const subagent = isSubagentNamespace(ns);

    // A tool RESULT. Emitted for subagents too — see the header.
    if (message instanceof ToolMessage || message?.getType?.() === "tool") {
      const close = endText();
      if (close) yield close;
      const toolCallId = (message as ToolMessage).tool_call_id ?? "";
      yield frame({
        type: "tool-output-available",
        toolCallId,
        output: coerceOutput((message as ToolMessage).content),
      });
      continue;
    }

    if (!(message instanceof AIMessageChunk) && !message?.content) continue;
    const ai = message as AIMessageChunk;

    // ACCUMULATED BEFORE THE SUBAGENT TEST, deliberately. A subagent's prose is
    // dropped from the transcript because the user did not ask for it — but its
    // tokens were still bought, and a cost report that omits the work it hid is
    // the same understatement as overwriting. `?? 0` per field: a provider that
    // reports some fields and not others has still told us about the ones it
    // sent, and dropping the whole report would lose the half that was real.
    const usage = (ai as { usage_metadata?: Record<string, number> })
      .usage_metadata;
    if (usage) {
      turnUsage.inputTokens += usage.input_tokens ?? 0;
      turnUsage.outputTokens += usage.output_tokens ?? 0;
      turnUsage.totalTokens += usage.total_tokens ?? 0;
    }

    // Text. Subagent prose is dropped; the root agent's is not.
    const content = ai.content;
    const text = typeof content === "string" ? content : "";
    if (text && !subagent) {
      if (!inText) yield startText();
      yield frame({ type: "text-delta", id: textId, delta: text });
    }

    // Tool calls. `tool_calls` carries complete calls; `tool_call_chunks`
    // carries partial ones. Only complete calls with a name and an id are
    // announced — a call we cannot name is one we cannot describe.
    for (const call of ai.tool_calls ?? []) {
      const id = call.id;
      const name = call.name;
      if (!id || !name || seenToolCallIds.has(id)) continue;
      seenToolCallIds.add(id);
      const close = endText();
      if (close) yield close;
      /*
       * SPLIT, NOT ONE FRAME. AI SDK v6 parses standard frames with
       * strictObject and REJECTS a `tool-input-start` carrying `input` —
       * measured against ai@6.0.197, and the reason packages/server's approval
       * drain splits the same pair (#325). The announcement is the start frame
       * plus an available frame; the input rides on the second.
       */
      yield frame({ type: "tool-input-start", toolCallId: id, toolName: name });
      yield frame({
        type: "tool-input-available",
        toolCallId: id,
        toolName: name,
        input: call.args ?? {},
      });
    }
  }

  const close = endText();
  if (close) yield close;
  /*
   * OMITTED ENTIRELY WHEN THE PROVIDER REPORTED NOTHING. A zeroed usage block is
   * a claim that the turn was free, which the backend has no basis for and which
   * is indistinguishable downstream from a real zero. The condition matches the
   * Python planes' exactly, so an all-zero report and silence are the same thing
   * on all three — the `zeros-are-not-a-report` case.
   *
   * IT RIDES UNDER messageMetadata, AND IT HAS TO (#714). AI SDK v6 builds the
   * UI-message chunk union out of `z.strictObject()`, so a top-level
   * `totalUsage` does not arrive as an extra field — it REJECTS the terminal
   * frame and the client discards the whole turn. deepagents.test.ts validates
   * every frame emitted here against the SDK's own `uiMessageChunkSchema`, so
   * the wrong location cannot pass review here even once.
   */
  const reported = turnUsage.totalTokens || turnUsage.outputTokens;
  yield frame(
    reported
      ? {
          type: "finish",
          finishReason: "stop",
          messageMetadata: { totalUsage: turnUsage },
        }
      : { type: "finish", finishReason: "stop" }
  );
}

/* -------------------------------------------------------------------------- */

export async function* streamChatReact(
  messages: ChatMessage[]
): AsyncGenerator<string> {
  yield* emitAiSdkV6(getGraph(), messages);
}

export async function* streamChatPlanExecute(
  messages: ChatMessage[]
): AsyncGenerator<string> {
  yield* emitAiSdkV6(getPlanExecuteGraph(), messages);
}

/**
 * Public dispatch surface.
 *
 * `deep-research` IS ABSENT AND THAT IS THE POINT. The Python serves three
 * topologies; this runtime serves two, and the router's 404 names the ones it
 * has. An advertised-but-broken topology would be worse than a missing one —
 * #10's explicit anti-goal is a shim that misrepresents what the framework can
 * do on this plane.
 */
export const TOPOLOGIES: Record<
  string,
  (messages: ChatMessage[]) => AsyncGenerator<string>
> = {
  react: streamChatReact,
  "plan-execute": streamChatPlanExecute,
};

export function warmup(): void {
  getGraph();
}
