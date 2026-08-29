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
 * TOPOLOGY: react ONLY. The Python planes also serve `plan-execute`, and this
 * one deliberately does not yet: #7 is the scaffold and rung parity is #8. The
 * gap is not hidden — `/health` reports `{"langchain": ["react"]}`, and asking
 * for `plan-execute` gets the same 404-naming-what-exists that FastAPI gives
 * for any undeclared topology. A runtime that advertised a topology it cannot
 * serve would be the worse failure, and it is the one `/health` exists to
 * prevent.
 *
 * WIRE FORMAT: LangChain native SSE, byte-identical to
 * apps/fastapi-backend/ai_backends/langchain.py. The acceptance criterion for
 * this whole backend is that `langchainAdapter` consumes it UNMODIFIED, so the
 * frames are built by common/sse.ts and nothing here invents a shape.
 */
import { createAgent } from "langchain";
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

/** Emit LangChain SSE frames from a single agent run. */
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
        data?: { chunk?: { content?: unknown }; input?: unknown; output?: unknown };
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

/** Public dispatch surface — the router reads this to route by body.topology. */
export const TOPOLOGIES: Record<
  string,
  (messages: ChatMessage[]) => AsyncGenerator<string>
> = {
  react: streamChatReact,
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
}

export type { CompiledStateGraph };
