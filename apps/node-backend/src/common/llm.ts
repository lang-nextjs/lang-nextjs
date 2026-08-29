/**
 * Build the model — NVIDIA NIM, then OpenRouter, then Anthropic.
 *
 * MIRRORS apps/fastapi-backend/ai_backends/_common.py's `make_llm()`, INCLUDING
 * THE ORDER AND THE DEFAULT MODEL NAMES. NVIDIA is first because it is the one
 * anyone can get: build.nvidia.com issues a free key with no card, which is
 * what makes this repo runnable by a forker with no OpenRouter balance and no
 * Anthropic account. The order is a fallback CHAIN, not a preference —
 * whichever key is present wins.
 *
 * NOTE ON #7's TEXT. The issue says "OpenRouter, `openrouter/free` default,
 * `OPENROUTER_MODEL` override — match the Python behaviour exactly". Those two
 * halves disagree today: `make_llm()` has since become NVIDIA-first and its
 * OpenRouter default is `openai/gpt-4o-mini`. The instruction that survives is
 * "match the Python behaviour exactly", so THE CODE IS THE SPEC and the issue's
 * literal default is stale. Recorded here rather than silently resolved.
 *
 * THE KEY IS READ FROM THE ENVIRONMENT AND NOWHERE ELSE, for the same reason
 * Python gives: these graphs are lazily-built singletons, so a key arriving in
 * a request body would either be ignored or force a rebuild per message.
 */
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

export function makeLlm(): BaseChatModel {
  const nvidiaKey = process.env.NVIDIA_API_KEY;
  if (nvidiaKey) {
    // NIM speaks the OpenAI wire format, so ChatOpenAI drives it directly.
    return new ChatOpenAI({
      apiKey: nvidiaKey,
      model: process.env.NVIDIA_MODEL ?? "nvidia/nemotron-3-super-120b-a12b",
      configuration: { baseURL: "https://integrate.api.nvidia.com/v1" },
      // STREAMING HIDES USAGE UNLESS YOU ASK FOR IT (#232). The OpenAI wire
      // format omits the usage block from a streamed response by default, so
      // every layer above reports a turn as costing nothing.
      streamUsage: true,
    });
  }

  const openrouterKey = process.env.OPENROUTER_API_KEY;
  if (openrouterKey) {
    return new ChatOpenAI({
      apiKey: openrouterKey,
      model: process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini",
      configuration: { baseURL: "https://openrouter.ai/api/v1" },
      streamUsage: true,
    });
  }

  return new ChatAnthropic({ model: "claude-3-5-haiku-20241022" });
}

export interface LlmStatus {
  configured: boolean;
  provider: string | null;
}

/**
 * Which provider `makeLlm()` WOULD pick, without building anything.
 *
 * Presence only, never the key. The reference app's readiness indicator needs
 * this BEFORE the first send, and it must come from the process that builds the
 * model — a key present only in the Next.js app would read as configured while
 * every send failed.
 *
 * MIRRORS makeLlm()'s FALLBACK ORDER and must keep mirroring it. If that chain
 * changes and this does not, the UI gets a confident wrong answer, which is
 * worse than the no answer it had before. `llmStatus.test.ts` asserts the two
 * agree on every subset of the three keys, so they cannot drift silently.
 */
export function llmStatus(env: NodeJS.ProcessEnv = process.env): LlmStatus {
  if (env.NVIDIA_API_KEY) return { configured: true, provider: "nvidia" };
  if (env.OPENROUTER_API_KEY)
    return { configured: true, provider: "openrouter" };
  if (env.ANTHROPIC_API_KEY)
    return { configured: true, provider: "anthropic" };
  return { configured: false, provider: null };
}
