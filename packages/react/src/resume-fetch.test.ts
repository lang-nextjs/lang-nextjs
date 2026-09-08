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

/**
 * ─── THE COMPOSITION WITH ai v7's OWN DE-DUPLICATOR (#986) ───
 *
 * `ai@7` added `activeResumeRequest` to `Chat.makeRequest`: starting a resume ABORTS the
 * previous resume's controller and passes the new one's signal to `reconnectToStream`.
 * `ai@6` had neither — it passed no `abortSignal` at all (`grep activeResumeRequest` on
 * 6.0.197 returns nothing), which is why the suppressor below was the only thing standing
 * between StrictMode and a duplicate GET.
 *
 * Both layers implement "one resume at a time" and they pick OPPOSITE WINNERS. v7 keeps
 * the NEWEST and kills the older; the suppressor keeps the OLDEST and 204s the newer.
 * Composed, the request that reaches the network is the one v7 already killed and the
 * live one is answered 204 — so nothing resumes at all. Nine E2E specs went red on the
 * v7 bump with "no GET to the resume endpoint on mount", and the CI instrumentation shows
 * the pair exactly:
 *
 *     rf ENTERED ... inFlightHas=false inFlightSize=0 signalPresent=true aborted=true
 *     rf CALLING fetchImpl
 *     rf ENTERED ... inFlightHas=true  inFlightSize=1 signalPresent=true aborted=false
 *     rf SHORT-CIRCUIT-204
 *     rf fetchImpl THREW AbortError: signal is aborted without reason
 *
 * The rule that resolves it is not "detect v7". The package's peer range is `ai >=4.0.0`,
 * so it must be right against SDKs that do and do not de-duplicate themselves. The rule is
 * about the signal, which both worlds express honestly:
 *
 *     THE IN-FLIGHT SLOT BELONGS TO A REQUEST THAT CAN STILL SUCCEED.
 *
 * An arrival that is already aborted claims nothing, and a slot whose holder has since
 * been aborted is yielded to the next comer. Under v6, where no signal is ever passed,
 * every arm below is inert and the four cases above are unchanged.
 */
describe("createResumeFetch — a suppressed duplicate must not be the only live request (#986)", () => {
  /**
   * THE CI FAILURE, AT UNIT SCALE. Ordering is what makes it total rather than flaky:
   * v7 aborts the first controller synchronously in the second `makeRequest`'s prologue,
   * and `reconnectToStream` awaits four times before it calls `fetch`, so the first
   * request ALWAYS arrives already-aborted. Before the fix the leader claims the slot,
   * the follower is answered 204, and `calls` is empty.
   */
  it("does not let an ALREADY-ABORTED arrival claim the slot the live request needs", async () => {
    const url = `${RESUME}?resumeId=aborted-leader`;
    const { impl, calls, release } = controllable();
    const f = createResumeFetch(RESUME, impl);

    const dead = new AbortController();
    dead.abort();
    const live = new AbortController();

    // The leader is the request v7 has already killed. It is still ISSUED — the SDK
    // calls fetch regardless — so passing it through is what the SDK expects.
    const leader = f(url, { signal: dead.signal });
    const follower = f(url, { signal: live.signal });

    expect(
      calls,
      "the live request never reached the network: the corpse took the slot"
    ).toEqual([url, url]);

    release(streamingResponse("data: resumed\n\n"));
    const res = await follower;
    expect(
      res.status,
      "the live resume was answered 204 by our own guard"
    ).toBe(200);
    await leader.catch(() => {});
  });

  /**
   * THE REMOUNT CASE, WHICH STRICTMODE DOES NOT COVER AND PRODUCTION DOES. Here the
   * leader arrives LIVE and is aborted afterwards — the ordering a genuine remount
   * produces, where the first resume is a real in-flight request when the second Chat
   * kills it. An "aborted on arrival" check alone passes the test above and fails this
   * one, which is why the slot tracks its holder's signal rather than the entry state.
   */
  it("yields the slot when the holder is aborted AFTER claiming it", async () => {
    const url = `${RESUME}?resumeId=aborted-holder`;
    const { impl, calls, release } = controllable();
    const f = createResumeFetch(RESUME, impl);

    const first = new AbortController();
    const leader = f(url, { signal: first.signal });
    expect(calls, "the leader is the one on the wire").toEqual([url]);

    first.abort(); // the second Chat supersedes the first

    const follower = f(url, { signal: new AbortController().signal });
    expect(
      calls,
      "the successor must reach the network — the holder can no longer succeed"
    ).toEqual([url, url]);

    release(streamingResponse("data: resumed\n\n"));
    await expect(follower).resolves.toHaveProperty("status", 200);
    await leader.catch(() => {});
  });

  /**
   * AND THE SUPPRESSOR STILL SUPPRESSES. The two arms above only ever relax the guard,
   * so the way they go wrong is by relaxing it into nothing — a live leader must still
   * 204 its duplicate. This is the #856 property restated against a signal-bearing
   * caller, because that is the shape the arms above introduce and the four original
   * cases never exercise.
   */
  it("still answers 204 to a duplicate while the holder's signal is LIVE", async () => {
    const url = `${RESUME}?resumeId=live-holder`;
    const { impl, calls, release } = controllable();
    const f = createResumeFetch(RESUME, impl);

    const first = new AbortController();
    const leader = f(url, { signal: first.signal });
    const dup = await f(url, { signal: new AbortController().signal });

    expect(dup.status, "a live holder still owns the slot").toBe(204);
    expect(calls, "only the leader reached the network").toEqual([url]);

    release(streamingResponse("data: resumed\n\n"));
    await expect(leader).resolves.toHaveProperty("status", 200);
  });

  /**
   * THE EVICTION HAZARD THE FIX CREATES. Once a successor can take an occupied slot,
   * the displaced holder's own `finally` is holding a stale key: an unconditional
   * `delete` would evict the SUCCESSOR and re-open the surface to the duplicate the
   * whole file exists to suppress. Nothing in the arms above can see that, because they
   * all end before the loser settles.
   */
  it("a displaced holder settling does not evict its successor's claim", async () => {
    const url = `${RESUME}?resumeId=displaced-then-settles`;
    const calls: string[] = [];
    const gates: Array<(r: Response) => void> = [];
    const impl = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Promise<Response>((r) => gates.push(r));
    }) as typeof fetch;
    const f = createResumeFetch(RESUME, impl);

    const first = new AbortController();
    const displaced = f(url, { signal: first.signal });
    first.abort();
    const successor = f(url, { signal: new AbortController().signal });
    expect(calls).toEqual([url, url]);

    // The loser settles LAST, which is the ordering that makes the stale key dangerous.
    gates[0](new Response(null, { status: 204 }));
    await displaced;

    const late = await f(url, { signal: new AbortController().signal });
    expect(
      late.status,
      "the successor still holds the slot: its duplicate is suppressed"
    ).toBe(204);
    expect(calls, "no third request went out").toEqual([url, url]);

    gates[1](streamingResponse("data: resumed\n\n"));
    await successor;
  });
});
