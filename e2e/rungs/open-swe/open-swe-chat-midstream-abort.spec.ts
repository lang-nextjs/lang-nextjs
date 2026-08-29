import { test, expect } from "@playwright/test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { stageReady } from "./readiness-mock";

/**
 * A STREAM THAT DIES HALFWAY MUST NOT LEAVE THE UI STREAMING FOREVER (#330).
 *
 * WHAT THIS FILE IS NOT, because #330 asked for "reconnect coverage" and that
 * turned out to be the wrong thing to write.
 *
 * open-swe's chat page does NOT enable reconnect. It never passes
 * `enableReconnect`, `resumeId` or `resumeEndpoint` to `useDeepAgentsChat`, and
 * `apps/open-swe/app/api/chat/stream/` has no `resume/` route to point them at.
 * `e2e/shared/reconnect.spec.ts` covers the resume protocol against
 * `apps/example/app/reconnect-test/page.tsx` — a harness page built for it,
 * which the example app's own chat page does not use either. So the resume half
 * of #330 item 3 is a FEATURE gap, not a coverage gap, and a spec for it here
 * would either test a hook through a harness we would have to invent, or assert
 * a behaviour the app has never had. Neither is coverage.
 *
 * WHAT IS REAL, AND UNCOVERED: the socket dying mid-response. That needs no
 * feature — it is what happens when a worker is recycled, a proxy times out, or
 * a laptop lid closes, and it is the case where the page has partial content on
 * screen and a pending state to get out of.
 *
 * The existing chat specs do not reach it. `open-swe-chat-settings.spec.ts`
 * matches a grep for "abort", and every hit is `route.abort("connectionrefused")`
 * — the request refused BEFORE it starts. A stream that never opens and a
 * stream that dies at byte 400 leave the composer in different states, and only
 * the first was tested.
 *
 * Playwright's `route.fulfill` cannot express this: it delivers a complete body.
 * So the route is forwarded to a real Node server that writes some frames and
 * then destroys the socket, which is the same technique `e2e/shared/
 * reconnect.spec.ts` uses for its third case.
 */

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "x-vercel-ai-ui-message-stream": "v1",
  "Cache-Control": "no-cache",
  "Access-Control-Allow-Origin": "*",
} as const;

/**
 * A server that writes a start frame and some visible text, then kills the
 * socket without a `finish` frame — an unclean death, which is the only kind
 * worth testing. A clean close is already covered by every other spec here.
 */
function startDyingServer(): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Allow-Methods": "*",
        });
        return void res.end();
      }
      res.writeHead(200, SSE_HEADERS);
      res.write(`data: {"type":"start","messageId":"m-die"}\n\n`);
      res.write(`data: {"type":"text-start","id":"t1"}\n\n`);
      res.write(
        `data: {"type":"text-delta","id":"t1","delta":"Partial answer before the socket dies"}\n\n`
      );
      // No text-end, no finish: the connection simply goes away.
      setTimeout(() => res.socket?.destroy(), 150);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/`,
        close: () => server.close(),
      });
    });
  });
}

test.describe("open-swe /chat — the socket dies mid-response", () => {
  test("the composer leaves the pending state, and the partial text is kept", async ({
    page,
  }) => {
    const dying = await startDyingServer();
    try {
      /*
       * READINESS IS STAGED DELIBERATELY, and leaving it out cost me a false
       * bug report. The composer's `disabled` is
       * `!sendable && readiness.state !== "ready"`, and `sendable` tracks
       * readiness ALONE — not stream status. With readiness unmocked its poll
       * fails, the input goes disabled, and the failure looks exactly like
       * "a dead stream strands the composer". It is not: it is the test
       * failing to stand the app up. Stage it, and the assertion below is
       * about the stream again.
       */
      await stageReady(page);
      await page.route(
        "**/api/config*",
        (route) =>
          void route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              activeLlm: "nvidia",
              backends: { django: true, fastapi: true },
            }),
          })
      );
      await page.route(
        "**/api/chat/tools**",
        (route) =>
          void route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ tools: [], mcpServers: [] }),
          })
      );
      await page.route(
        "**/api/chat/stream",
        (route) => void route.continue({ url: dying.url })
      );

      await page.goto("/chat");
      await expect(
        page.getByTestId("chat-input"),
        "BEFORE SEND: composer never became usable"
      ).toBeEnabled();
      await page.getByTestId("chat-input").fill("say something then die");
      await page.getByTestId("chat-send").click();

      /*
       * THE ASSERTION THAT MATTERS. `chat-stop` is rendered only while a reply
       * is in flight (#323), so its disappearance is the observable for "the
       * client noticed the stream ended". If the hook never leaves the
       * streaming state, this is the expectation that fails — and the person's
       * symptom is a Stop button they can press forever on a dead stream.
       */
      await expect(page.getByTestId("chat-stop")).toBeHidden({
        timeout: 20_000,
      });

      // And the input is usable again: a dead stream must not strand the
      // composer. Being able to type the next message is the recovery.
      /*
       * THE PERSON IS TOLD. A stream that stops with no explanation is the
       * failure #323 exists to prevent, and a socket death is the case most
       * likely to produce silence.
       *
       * `chat-stream-error`, NOT `chat-error`. The latter renders a `data-error`
       * PART carried by the stream; a transport death carries no parts at all.
       * I wrote the wrong one first and it failed with "element(s) not found",
       * which reads exactly like "the person is told nothing" — and would have
       * been filed as that, had the banner not turned out to be right there in
       * page.tsx with no testid on it.
       */
      await expect(page.getByTestId("chat-stream-error")).toBeVisible({
        timeout: 20_000,
      });

      /*
       * The bytes that DID arrive stay on screen. Discarding them would be a
       * defensible-looking choice and the wrong one: the model said those
       * words, and a person who watched them appear must not see them vanish
       * because the transport failed afterwards.
       */
      await expect(
        page.getByText("Partial answer before the socket dies")
      ).toBeVisible();

      /*
       * THE COMPOSER RECOVERS, AND THE ERROR IS STILL ON SCREEN WHILE IT DOES
       * (#336). Two halves, asserted separately on purpose.
       *
       * Before #336 this surface was a dead end: computeReadiness returns
       * `error`, canSend requires `ready`, both composer controls followed it,
       * and nothing cleared it — no retry, no dismiss, and `chat-blocked` (the
       * panel that tells a person what to DO) only renders for `blocked`. The
       * only exit was a page reload. `useChat` clears its own error on the next
       * send, so the disabled composer was exactly what prevented recovery.
       *
       * The second assertion is not decoration. Enabling the composer while
       * clearing the message would pass the first one and be a DIFFERENT bug
       * wearing the same green: a person needs to see what happened while
       * deciding what to type. The error survives until they send again, which
       * is when useChat clears it — not a moment earlier.
       */
      await expect(
        page.getByTestId("chat-input"),
        "the composer must recover — a failed turn is not a dead end"
      ).toBeEnabled({ timeout: 20_000 });
      await expect(
        page.getByTestId("chat-stream-error"),
        "the error must still be readable while the person decides what to type"
      ).toBeVisible();
    } finally {
      dying.close();
    }
  });
});
