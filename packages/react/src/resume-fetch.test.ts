import { describe, it, expect } from "vitest";
import { createResumeFetch } from "./resume-fetch";

/**
 * THE DEDUP IS A SUPPRESSOR, AND EVERY TEST HERE EXISTS TO PIN DOWN WHAT IT MUST NOT
 * SUPPRESS. A duplicate-suppressor that suppresses too much fails silently — the surface
 * simply stops resuming — so "the second GET was 204" is the cheap assertion and not the
 * one that protects anything.
 *
 * Each case uses its OWN url. The in-flight set is module-level (deliberately: see
 * resume-fetch.ts on remounts), so distinct keys keep the cases independent and
 * incidentally assert that two streams cannot collide.
 */

const RESUME = "/api/chat/stream/resume";

/** A fetch stand-in whose responses settle only when the test says so. */
function controllable() {
  const calls: string[] = [];
  let release!: (r: Response) => void;
  const gate = new Promise<Response>((r) => {
    release = r;
  });
  const impl = (async (input: RequestInfo | URL) => {
    calls.push(typeof input === "string" ? input : String(input));
    return gate;
  }) as typeof fetch;
  return { impl, calls, release };
}

/** A body that is a real stream, so "the first one still streams" means what it says. */
function streamingResponse(text: string): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(text));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
}

describe("createResumeFetch — concurrent duplicate suppression (#856)", () => {
  /*
   * CONDITION 2. The obvious test is "the second GET gets 204", and it passes whichever
   * of the two requests got suppressed — including the wrong one. So the first response
   * is asserted all the way through its BODY, not just its status: if the dedup ever
   * suppressed the leader instead of the follower, the 204 assertion below would still
   * hold and this one would not.
   */
  it("suppresses the SECOND concurrent GET while the FIRST still delivers its body", async () => {
    const url = `${RESUME}?resumeId=concurrent-pair`;
    const { impl, calls, release } = controllable();
    const f = createResumeFetch(RESUME, impl);

    const first = f(url);
    const second = await f(url); // resolves immediately — never reaches the network

    expect(second.status, "the duplicate is answered 204, not sent").toBe(204);
    expect(calls, "only the leader reached the network").toEqual([url]);

    release(streamingResponse('data: {"type":"start"}\n\n'));
    const firstResponse = await first;
    expect(firstResponse.status).toBe(200);
    await expect(firstResponse.text()).resolves.toBe(
      'data: {"type":"start"}\n\n'
    );
  });

  /*
   * CONDITION 3, and the reason condition 1 is a property rather than a comment. If the
   * key were cached instead of scoped to the flight, this returns 204 and the surface is
   * permanently muted for that stream with nothing reporting it.
   */
  it("does NOT suppress a later resume once the first has settled", async () => {
    const url = `${RESUME}?resumeId=sequential-pair`;
    const seen: string[] = [];
    const impl = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return streamingResponse("data: one\n\n");
    }) as typeof fetch;
    const f = createResumeFetch(RESUME, impl);

    const a = await f(url);
    expect(a.status).toBe(200);

    const b = await f(url);
    expect(
      b.status,
      "a resume after the first settled must reach the server"
    ).toBe(200);
    expect(seen).toEqual([url, url]);
  });

  /*
   * THE THROWING PATH CLEARS THE KEY TOO. A network error that left the url marked would
   * mute every later resume of that stream — the same permanent mute as a cached key,
   * arriving by the route a `finally` is easy to forget.
   */
  it("clears the in-flight key when the request REJECTS, not only when it resolves", async () => {
    const url = `${RESUME}?resumeId=rejecting`;
    let attempt = 0;
    const impl = (async () => {
      attempt++;
      if (attempt === 1) throw new TypeError("network down");
      return streamingResponse("data: recovered\n\n");
    }) as typeof fetch;
    const f = createResumeFetch(RESUME, impl);

    await expect(f(url)).rejects.toThrow("network down");
    const retry = await f(url);
    expect(
      retry.status,
      "a retry after a failed resume must not be muted"
    ).toBe(200);
    expect(attempt).toBe(2);
  });

  it("keys on the url, so a different stream is not suppressed by an in-flight one", async () => {
    const { impl, calls, release } = controllable();
    const f = createResumeFetch(RESUME, impl);

    const held = f(`${RESUME}?resumeId=stream-a`);
    const other = f(`${RESUME}?resumeId=stream-b`);

    expect(calls, "a different resumeId is a different stream").toEqual([
      `${RESUME}?resumeId=stream-a`,
      `${RESUME}?resumeId=stream-b`,
    ]);

    release(streamingResponse("data: shared\n\n"));
    await Promise.all([held, other]);
  });
});

describe("createResumeFetch — the policies it must NOT apply elsewhere", () => {
  /*
   * THE CHAT ENDPOINT IS OUT OF SCOPE FOR BOTH POLICIES. A 503 there is a real outage,
   * and two concurrent POSTs are two real messages. Suppressing either would be a far
   * worse bug than the one being fixed, and neither is covered by the resume tests above.
   */
  it("passes non-resume requests through untouched, concurrently and on 503", async () => {
    const chat = "/api/chat/stream";
    let n = 0;
    const impl = (async () => {
      n++;
      return new Response(null, { status: 503 });
    }) as typeof fetch;
    const f = createResumeFetch(RESUME, impl);

    const [a, b] = await Promise.all([f(chat), f(chat)]);
    expect(n, "concurrent chat requests are both sent").toBe(2);
    expect(a.status, "a 503 from the chat endpoint stays a 503").toBe(503);
    expect(b.status).toBe(503);
  });

  /*
   * POLICY 2, kept under test after moving out of hook.ts. 503 means "reconnection is
   * disabled here" and becomes 204; a 404 is the #372 URL-contract drift and MUST stay
   * loud, so the test that matters is the pair, not the 503 alone.
   */
  it("maps a resume 503 to 204 but leaves 404 and 500 alone", async () => {
    const statuses = [503, 404, 500];
    const got: number[] = [];
    for (const status of statuses) {
      const impl = (async () => new Response(null, { status })) as typeof fetch;
      const f = createResumeFetch(RESUME, impl);
      got.push((await f(`${RESUME}?resumeId=status-${status}`)).status);
    }
    expect(got, "503 -> 204; 404 and 500 reach the SDK and stay loud").toEqual([
      204, 404, 500,
    ]);
  });

  it("accepts the URL and Request input forms, not only strings", async () => {
    const impl = (async () => streamingResponse("data: x\n\n")) as typeof fetch;
    const f = createResumeFetch(RESUME, impl);

    const asUrl = new URL(
      `${RESUME}?resumeId=url-form`,
      "http://localhost:3000"
    );
    const first = f(asUrl);
    const dup = await f(asUrl);
    expect(
      dup.status,
      "a URL object is keyed the same as its string form"
    ).toBe(204);
    await first;

    const asRequest = new Request(
      `http://localhost:3000${RESUME}?resumeId=request-form`
    );
    const r = await f(asRequest);
    expect(r.status).toBe(200);
  });
});
