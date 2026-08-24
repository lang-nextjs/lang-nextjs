import { test, expect } from "@playwright/test";

/**
 * Shared E2E test suite for DeepAgents backends.
 *
 * Run against Django:   PLAYWRIGHT_BASE_URL=http://localhost:3001 pnpm e2e
 * Run against FastAPI:  PLAYWRIGHT_BASE_URL=http://localhost:3002 pnpm e2e
 *
 * The BACKEND_URL inside the Next.js app is injected by docker compose.
 * These tests only know about the Next.js frontend URL.
 *
 * Key assertion: the finish event must NOT have a messageId field on the
 * client side — this proves defaultTransforms in @deepagents-nextjs/server
 * stripped it before forwarding to the AI SDK.
 */

test.describe("DeepAgents E2E — SSE transport and defaultTransforms", () => {
  test("POST /api/chat/stream returns 200 with text/event-stream", async ({
    request,
  }) => {
    const response = await request.post("/api/chat/stream", {
      data: { messages: [{ role: "user", content: "Hello" }] },
      headers: { "Content-Type": "application/json" },
      timeout: 30_000,
    });
    expect(response.status()).toBe(200);
    const contentType = response.headers()["content-type"];
    expect(contentType).toContain("text/event-stream");
  });

  test("SSE stream delivers at least one text-delta frame", async ({
    request,
  }) => {
    const response = await request.post("/api/chat/stream", {
      data: { messages: [{ role: "user", content: "Say hello" }] },
      headers: { "Content-Type": "application/json" },
      timeout: 45_000,
    });
    const body = await response.text();
    // body is raw SSE: "data: {...}\n\ndata: {...}\n\n..."
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

    const textDeltaFrames = frames.filter((f: any) => f.type === "text-delta");
    expect(textDeltaFrames.length).toBeGreaterThan(0);
  });

  test("finish frame has no messageId on the client side (defaultTransforms stripped it)", async ({
    request,
  }) => {
    const response = await request.post("/api/chat/stream", {
      data: { messages: [{ role: "user", content: "Test messageId strip" }] },
      headers: { "Content-Type": "application/json" },
      timeout: 45_000,
    });
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

    const finishFrame = frames.find((f: any) => f.type === "finish");
    expect(
      finishFrame,
      "finish frame must be present in the stream"
    ).toBeTruthy();
    expect(
      (finishFrame as any).messageId,
      "finish frame must NOT have messageId (defaultTransforms must strip it)"
    ).toBeUndefined();
  });

  test("stream closes cleanly — no error frames", async ({ request }) => {
    const response = await request.post("/api/chat/stream", {
      data: { messages: [{ role: "user", content: "Test clean close" }] },
      headers: { "Content-Type": "application/json" },
      timeout: 45_000,
    });
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

    const errorFrames = frames.filter((f: any) => f.type === "error");
    expect(errorFrames.length, "stream must contain no error frames").toBe(0);

    // An empty stream would have satisfied the lastFrame check below via
    // undefined !== "finish" → assertion fails, which masked the actual
    // condition we care about. Guard explicitly so a regression that
    // emits zero frames fails with a clear "stream was empty" message
    // instead of "expected 'finish' to equal undefined".
    expect(frames.length, "stream produced no frames at all").toBeGreaterThan(
      0
    );

    // Stream must end with a finish frame
    const lastFrame = frames[frames.length - 1];
    expect(lastFrame?.type).toBe("finish");
  });

  test("chat UI renders an AIMessage with non-empty assistant text after stream ends", async ({
    page,
  }) => {
    // This test uses a real LLM — allow generous time for navigation + LLM response
    test.setTimeout(120_000);
    await page.goto("/");
    // Wait for React hydration — button becomes enabled once status === 'idle'
    await page.waitForLoadState("networkidle");
    // Find the message input (type="text" → implicit ARIA role "textbox")
    const input = page.getByRole("textbox").first();
    await input.waitFor({ state: "visible", timeout: 15_000 });
    await input.fill("Hello from E2E test");
    await page.keyboard.press("Enter");

    // Wait until the page returns to idle — i.e. the stream finished cleanly.
    // header-status text format is `{status}` (see apps/example/app/page.tsx)
    // and ranges through submitted → streaming → idle. An error would surface
    // as "error", which won't satisfy this exact-text matcher.
    await expect(page.getByTestId("header-status")).toHaveText("idle", {
      timeout: 90_000,
    });

    // Assert an assistant bubble exists AND contains non-whitespace text.
    // The earlier version only checked toBeVisible(), so an empty bubble passed.
    const assistant = page.locator('[data-role="assistant"]').first();
    await expect(assistant).toBeVisible({ timeout: 5_000 });

    // poll: assistant text must contain at least 2 word characters (proves real
    // tokens reached the DOM, not just the wrapper render). The streaming caret
    // span has no text content of its own, so this is robust against it.
    await expect
      .poll(async () => ((await assistant.textContent()) ?? "").trim(), {
        timeout: 15_000,
      })
      .toMatch(/\w{2,}/);
  });
});
