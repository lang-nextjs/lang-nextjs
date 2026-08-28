import { test, expect } from "@playwright/test";

/**
 * Real LLM E2E test suite for DeepAgents.
 *
 * These tests validate actual LLM output flowing through the full stack
 * (Django/FastAPI backend + Next.js frontend + AI SDK v6 streaming).
 *
 * All tests are gated behind a model API key. When none is present, every test
 * skips gracefully so the suite is safe to run locally without one.
 *
 * CI: Runs only on push to main via the e2e-llm job (.github/workflows/e2e.yml).
 */

/**
 * Every provider the backend accepts, in the order `_common.make_llm()` tries
 * them.
 *
 * ASKED ABOUT OPENROUTER ALONE, AND THAT WAS WRONG IN BOTH DIRECTIONS. The
 * backend has preferred NVIDIA first for some time — it is the provider this
 * project recommends in its own setup text, because it is free. So a repository
 * configured with NVIDIA would SKIP these tests locally, and in CI it would
 * throw the "must NOT silently skip" error while a perfectly good key sat in the
 * environment. That is a false red immediately after the workflow gate said the
 * repository was configured: two checks in one pipeline disagreeing about the
 * same question.
 *
 * Measured: setting NVIDIA_API_KEY turned the gate green and left this file
 * failing all three tests with "OPENROUTER_API_KEY not set".
 */
const PROVIDER_KEYS = [
  "NVIDIA_API_KEY",
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
] as const;

const configuredProvider = PROVIDER_KEYS.find((k) => !!process.env[k]);

/**
 * Skip when no model key is set AND we're in local dev. In CI
 * (process.env.CI set), throw instead — the e2e-llm job exists precisely
 * to exercise real LLM paths and a silent skip would be a false-green.
 * The workflow has a precheck step that ALSO fails fast if no key is
 * set, but this in-spec guard is belt-and-braces for direct invocations
 * like `CI=true pnpm e2e --project=chromium-llm`.
 */
function requireApiKeyOrSkip(): void {
  if (configuredProvider) return;
  const names = PROVIDER_KEYS.join(", ");
  if (process.env.CI === "true") {
    throw new Error(
      `No model API key set (${names}) — chromium-llm tests must NOT silently skip in CI`
    );
  }
  test.skip(true, `No model API key set (${names}) — skipping real LLM tests`);
}

test.describe("DeepAgents E2E — Real LLM integration", () => {
  test("LLM stream delivers text-delta frames through full stack", async ({
    request,
  }) => {
    requireApiKeyOrSkip();

    const response = await request.post("/api/chat/stream", {
      data: {
        messages: [
          { role: "user", content: "Say exactly: Hello from real LLM test" },
        ],
      },
      headers: { "Content-Type": "application/json" },
      timeout: 60_000,
    });
    expect(response.status()).toBe(200);

    const body = await response.text();
    // Parse raw SSE: "data: {...}\n\ndata: {...}\n\n..."
    const frames = body
      .split("\n\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => {
        try {
          return JSON.parse(line.slice("data: ".length));
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    const textDeltaFrames = frames.filter(
      (f: Record<string, unknown>) => f.type === "text-delta"
    );
    expect(
      textDeltaFrames.length,
      "stream must contain at least one text-delta frame"
    ).toBeGreaterThan(0);

    // Concatenate all text deltas and verify the combined text contains a word
    // from the prompt — proves the LLM actually processed the input.
    // AI SDK v6 text-delta frames carry the chunk on `delta` (not `textDelta`).
    const combinedText = textDeltaFrames
      .map(
        (f: Record<string, unknown>) => (f as { delta?: string }).delta ?? ""
      )
      .join("");
    expect(
      combinedText.length,
      "combined text should not be empty — text-delta frames must expose `delta`"
    ).toBeGreaterThan(0);
    expect(
      combinedText.toLowerCase(),
      "combined text should contain 'hello' or 'llm' from the prompt"
    ).toMatch(/hello|llm/);
  });

  test("LLM stream terminates with finish frame and no error frames", async ({
    request,
  }) => {
    requireApiKeyOrSkip();

    const response = await request.post("/api/chat/stream", {
      data: {
        messages: [{ role: "user", content: "Say the word banana" }],
      },
      headers: { "Content-Type": "application/json" },
      timeout: 60_000,
    });
    expect(response.status()).toBe(200);

    const body = await response.text();
    const frames = body
      .split("\n\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => {
        try {
          return JSON.parse(line.slice("data: ".length));
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    // No error frames should be present
    const errorFrames = frames.filter(
      (f: Record<string, unknown>) => f.type === "error"
    );
    expect(errorFrames.length, "stream must contain no error frames").toBe(0);

    // Last frame must be a finish frame
    const lastFrame = frames[frames.length - 1];
    expect(lastFrame, "stream must have at least one frame").toBeTruthy();
    expect(lastFrame?.type, "last frame must be a finish frame").toBe("finish");

    // Finish frame should have a finishReason (typically "stop")
    expect(
      (lastFrame as Record<string, unknown>)?.finishReason,
      "finish frame should have a finishReason"
    ).toBeTruthy();

    // PROOF OF REAL LLM CALL — a canned/stubbed SSE response could trivially
    // fake text-delta + finish frames, so the assertions above don't actually
    // prove this test ran against an upstream LLM. We need a signal that's
    // genuinely hard to fake without billing a model call.
    //
    // Two independent signals, EITHER suffices (OR-gate so neither flakes
    // the suite alone):
    //
    //   (1) totalUsage.outputTokens > 0 on a finish/finish-step frame.
    //       Strong signal — real providers (OpenRouter, OpenAI, Anthropic)
    //       attach usage to streaming finish frames. But: the adapter
    //       pipeline could strip it, or a specific OpenRouter model could
    //       omit it. Without a fallback, those normal cases would flake.
    //
    //   (2) ≥3 text-delta frames. Real LLM tokenization produces multiple
    //       chunks for any non-trivial prompt — even a single short word
    //       like "banana" tokenizes into 2-3 pieces depending on the
    //       tokenizer. A canned stub typically emits 1 (single delta) or
    //       at most 2. This catches the gross-stub case even if usage is
    //       absent.
    //
    // If BOTH fail simultaneously, that's a real signal something is wrong
    // (either no LLM ran, or a misconfigured stub-like response).
    const usageFrames = frames
      .filter((f: Record<string, unknown>) =>
        ["finish", "finish-step"].includes(f.type as string)
      )
      .map((f: Record<string, unknown>) => {
        const u =
          (f as { totalUsage?: Record<string, number> }).totalUsage ??
          (f as { usage?: Record<string, number> }).usage;
        return u ?? null;
      })
      .filter((u): u is Record<string, number> => u !== null);
    const totalOutputTokens = usageFrames.reduce(
      (sum, u) => sum + (u.outputTokens ?? u.completion_tokens ?? 0),
      0
    );
    const textDeltaCount = frames.filter(
      (f: Record<string, unknown>) => f.type === "text-delta"
    ).length;

    const hasUsageProof = totalOutputTokens > 0;
    const hasChunkingProof = textDeltaCount >= 3;
    expect(
      hasUsageProof || hasChunkingProof,
      `expected at least one real-LLM signal: totalUsage.outputTokens>0 (got ${totalOutputTokens}) OR text-delta count>=3 (got ${textDeltaCount}). Both failing suggests a canned/stub response, not a real model call.`
    ).toBe(true);
  });

  test("Chat UI renders assistant message from real LLM", async ({ page }) => {
    requireApiKeyOrSkip();
    test.setTimeout(120_000);

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Find the message input
    const input = page.getByRole("textbox").first();
    await input.waitFor({ state: "visible", timeout: 15_000 });
    await input.fill("Reply with only the word testllm");
    await page.keyboard.press("Enter");

    // Wait for assistant message to appear
    await expect(
      page
        .locator(
          '[data-role="assistant"], [data-testid="ai-message"], .ai-message'
        )
        .first()
    ).toBeVisible({ timeout: 90_000 });

    // Verify the assistant bubble contains some text
    const assistantBubble = page
      .locator(
        '[data-role="assistant"], [data-testid="ai-message"], .ai-message'
      )
      .first();
    const text = await assistantBubble.textContent();
    expect(
      text?.trim().length,
      "assistant message should contain text"
    ).toBeGreaterThan(0);
  });
});
