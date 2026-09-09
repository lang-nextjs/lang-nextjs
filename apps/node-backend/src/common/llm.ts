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
 * NOTE ON #7's TEXT, AND WHY ITS EARLIER RESOLUTION EXPIRED. The issue says
 * "OpenRouter, `openrouter/free` default, `OPENROUTER_MODEL` override — match the
 * Python behaviour exactly". Those two halves disagreed once the Python default
 * had drifted to `openai/gpt-4o-mini`, and the disagreement was resolved in favour
 * of "match the Python behaviour exactly", on the ground that THE CODE IS THE SPEC.
 *
 * That resolution expired ON ITS OWN TERMS. `openai/gpt-4o-mini` was retired, and
 * CI's own live transport returned sixteen `upstream_404` frames carrying
 * `OpenAIModelNotFoundError` (#1152). A default that 404s is not a spec of
 * anything, so "the code is the spec" no longer selects a value.
 *
 * WHAT THE REPOSITORY DECIDED, AND WHY IT IS RESTORED RATHER THAN REPLACED.
 * `.planning/PROJECT.md` records `openrouter/free` as the default with the reason
 * "auto-routes to best available free model; NO MANUAL MODEL PINNING", assessed as
 * "resilient to individual model deprecations". A single model was then pinned by
 * drift, and the deprecation the note warned about is exactly what took main down.
 *
 * So the drift is undone rather than re-aimed. Pinning a different id would buy
 * determinism and would CONTRADICT the recorded decision while citing it — and it
 * would make PROJECT.md's two statements of the default wrong, which is the same
 * divergence that caused this outage. `openrouter/free` is also the only value
 * this repository has verified end to end: `.planning/MILESTONES.md` records all
 * five E2E tests passing live against both backends with it.
 *
 * Whether to pin for reproducible E2E is a real question with a written precedent
 * to overturn. It is not this change.
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
      model: process.env.OPENROUTER_MODEL ?? "openrouter/free",
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
  if (env.ANTHROPIC_API_KEY) return { configured: true, provider: "anthropic" };
  return { configured: false, provider: null };
}
