/**
 * resume-fetch.ts — the transport `fetch` the reconnect path runs through, and the
 * only place that decides what a resume GET means (#856, #372, #170).
 *
 * TWO POLICIES LIVE HERE, and they are here TOGETHER because both answer the same
 * question — "this resume request should not become a stream, and the client must not
 * treat that as an error." Splitting them put one at a seam nothing tested.
 *
 * ─── POLICY 1: A CONCURRENT DUPLICATE RESUME IS ANSWERED 204 (#856) ───
 *
 * THERE IS NO GUARD BELOW THIS LINE UNDER `ai` v6 AND EARLIER, which is why the guard had
 * to be here — and v7 added one, which is the whole of #986; read the v7 section at the end
 * of this comment before changing anything here. `@ai-sdk/react`'s resume effect is
 * unchanged across both majors and is, in full:
 *
 *     useEffect(() => { if (resume) { chatRef.current.resumeStream(); } }, [resume, chatRef]);
 *
 * No ref mark, no dedup key, no cleanup. It calls `ai`'s `makeRequest`, whose FIRST
 * statement for trigger "resume-stream" is `await transport.reconnectToStream(...)` —
 * the fetch — with `setStatus({status:"submitted"})` only AFTER it and nothing reading
 * status to bail. So two invocations of that effect produce two GETs by construction.
 * This is not a fragile mechanism being shored up; it is the first guard in the chain.
 *
 * WHY THIS SURFACED AS A NEXT BUMP, since the issue title says otherwise. Measured
 * 2026-09-06 with the page's own empty-dep effect counted independently of the SDK:
 *
 *     next     reactStrictMode      effect runs   resume GETs
 *     16.3.3   default (on)              2             2        <- fails
 *     16.2.7   default (on)              1             1
 *     16.3.3   false                     1             1
 *     16.2.7   true, EXPLICIT            1             1        <- the deciding arm
 *
 * The last row is the one that settles it: 16.2.7 does not double-invoke effects even
 * when StrictMode is asked for explicitly, and `next/dist/build/define-env.js` compiles
 * `__NEXT_STRICT_MODE_APP` from an identical expression in both versions. React (19.2.6)
 * and `ai` (6.0.197) are identical across the arms. So 16.3.3 did not break a contract:
 * 16.2.7 was silently not applying StrictMode, and our suite was green because of it.
 * Resilience to double invocation is required of the code, not promised against it.
 *
 * IN-FLIGHT, NOT CACHED — the distinction is the whole design. The key is cleared when
 * the first request SETTLES, so a genuine later resume of the same stream still goes to
 * the server. A marker that outlived its request would turn a duplicate-suppressor into
 * a permanent mute, and that failure is silent: the surface simply stops resuming and
 * nothing reports it. "Settles" means the fetch promise settling (headers), not the body
 * draining — a resume body may legitimately never finish draining, and keying on that
 * would reintroduce exactly the permanent mute this paragraph exists to prevent.
 *
 * THE MAP IS MODULE-LEVEL ON PURPOSE. StrictMode's double invocation reuses one
 * component instance (its refs survive: the probe logged `freshRef=false` on the second
 * run), so a per-transport map would have covered the observed defect. It would NOT
 * cover a genuine remount, which builds a new Chat and a new transport — and that is the
 * case that can reach production, where StrictMode never double-invokes at all. The key
 * is the resolved URL, which carries the resumeId, so unrelated streams cannot collide.
 *
 * WHAT WAS RULED OUT, so the next person does not spend the afternoon on it:
 *   - REPLAYING A CACHED `Response` to the duplicate. A resume body is a stream and can
 *     be consumed once; two readers of one body is the duplication we are preventing.
 *   - FLIPPING `resume` TO FALSE after the first call. StrictMode's second invocation
 *     lands before any state change does, so the effect sees the old value regardless.
 *   - EXEMPTING THE TEST. It asserts the property we want; it was passing for the wrong
 *     reason, which is a worse thing to keep than a red.
 *
 * ─── POLICY 2: A 503 FROM THE RESUME ENDPOINT IS NOT AN ERROR ───
 *
 * A SERVER SAYING "I DO NOT OFFER THIS" IS NOT A FAILED CONVERSATION.
 *
 * `resume: true` makes the SDK fire a GET at the resume endpoint on mount. When
 * ENABLE_STREAM_RECONNECT is unset the handler answers 503, that landed in useChat's
 * `error`, and the hook's status derivation turned it into `"error"` — so a surface that
 * merely ASKED to reconnect painted a red dot and an "Error:" banner on first paint,
 * before the user touched anything.
 *
 * That is the default configuration. `apps/example/.env.example` ships the flag COMMENTED
 * OUT, so every fork that copied it and ran `pnpm dev` got a chat that looked broken on
 * load. Three CI jobs caught it; setting the flag in those three jobs would have turned
 * them green and shipped the defect.
 *
 * 503 ONLY, AND THE OTHERS STAY LOUD. This is a swallow, and the scope is the whole
 * argument:
 *
 *   503  the server is telling us reconnection is DISABLED HERE. That is a capability
 *        statement, not a failure of this conversation, and it means exactly what 204
 *        means to this client: nothing to resume.
 *   404  MUST stay loud. It means "this route does not answer the shape I asked for" —
 *        the #372 defect, where the hook requested ?resumeId= and the only handler was a
 *        path segment. It survived the entire life of the feature because nothing
 *        surfaced it. Making 404 inert would re-hide the next URL-contract drift.
 *   5xx  stays loud. A resume endpoint that is genuinely broken should be visible.
 *
 * ─── WHY THE SLOT IS HELD BY A SIGNAL AND NOT BY A URL ALONE (#986) ───
 *
 * `ai@7` ADDED A SECOND DE-DUPLICATOR, AND IT PICKS THE OPPOSITE WINNER. `Chat.makeRequest`
 * now opens an `AbortController` per resume, ABORTS THE PREVIOUS ONE, and passes its own
 * signal down to `reconnectToStream`:
 *
 *     const abortController = new AbortController();
 *     if (activeResumeRequest) {
 *       this.activeResumeRequest?.abortController.abort();   // the OLDER request dies
 *       this.activeResumeRequest = activeResumeRequest;
 *     }
 *
 * `ai@6.0.197` has none of it — no controller, and no `abortSignal` argument at all. So the
 * two majors disagree about which of a concurrent pair survives: v7 keeps the NEWEST, and
 * the policy above keeps the OLDEST. Composed, they agree only on who dies. The request
 * that reached `fetchImpl` was the one v7 had already aborted, and the live one was
 * answered 204 here, so no GET left the browser and nine E2E specs failed with "no GET to
 * the resume endpoint on mount".
 *
 * IT IS TOTAL, NOT FLAKY, and the ordering is why: React runs StrictMode's mount/cleanup/
 * mount synchronously, so the second `makeRequest` prologue aborts the first controller
 * before the first request resumes past any await — and `reconnectToStream` awaits four
 * times (body, headers, credentials, prepare) before it calls `fetch`. The first arrival is
 * therefore ALWAYS already-aborted rather than sometimes, which is why nine specs failed
 * every run rather than intermittently.
 *
 * THE FIX IS NOT A VERSION CHECK. This package's peer range is `ai: >=4.0.0`, so it has to
 * be right against SDKs that do and do not de-duplicate themselves. Both worlds state the
 * same fact honestly through the signal, so the rule is stated over the signal:
 *
 *     THE IN-FLIGHT SLOT BELONGS TO A REQUEST THAT CAN STILL SUCCEED.
 *
 * An arrival that is already aborted claims nothing, and a slot whose holder has since been
 * aborted is yielded to the next comer. Under v6 no signal is ever passed, every clause is
 * inert, and the behaviour is what it was.
 *
 * AN ALREADY-ABORTED ARRIVAL STILL TAKES THE SLOT, and that is deliberate rather than an
 * oversight. The obvious second clause — "a request that arrives aborted claims nothing" —
 * was written, and a mutation SURVIVED it: the holder test above already covers that case,
 * because the corpse's successor reads the corpse's own signal and takes the slot from it.
 * Two mechanisms where one does the work leave a branch no test can distinguish, which
 * reads as load-bearing to the next person and is not. One rule, one clause.
 *
 * The arrival is also still SENT to `fetchImpl`. It is not this layer's place to decide the
 * SDK's request is pointless: `makeRequest` expects that rejection and maps it to
 * `status: "ready"`.
 *
 * AND THE DISPLACED HOLDER'S `finally` IS THEN HOLDING A STALE KEY. Once a successor can
 * take an occupied slot, an unconditional `delete` on settle would evict the SUCCESSOR and
 * re-open the surface to exactly the duplicate this file exists to suppress — so the
 * cleanup deletes only a slot it still owns. That hazard is created BY the fix and is
 * invisible to every test of it, so it has one of its own.
 *
 * AND 503 STAYS 503 ON THE WIRE. The handler must not answer 204 when disabled: its own
 * comment explains that overloading 204 makes "disabled" indistinguishable from "that
 * stream is finished", which is how the original bug hid. The transport distinction is
 * worth keeping. What changes is only what the CLIENT does with it.
 */

/**
 * The claim on a resume URL: an identity for the holder, carrying the signal that says
 * whether it can still succeed. An object rather than the bare signal because a v6 caller
 * passes no signal at all, and two undefined signals must still be two distinct claims.
 */
interface Claim {
  readonly signal?: AbortSignal;
}

/**
 * Resume URLs with a GET currently outstanding, mapped to their holder. Module-level so a
 * remount — which builds a fresh transport — is covered as well as StrictMode's double
 * invocation.
 */
const inFlight = new Map<string, Claim>();

/**
 * The signal governing this request. `init.signal` is what `reconnectToStream` passes; the
 * `Request` form is read too, so the rule cannot be sidestepped by the input shape.
 */
function signalOf(
  input: RequestInfo | URL,
  init?: RequestInit
): AbortSignal | undefined {
  if (init && "signal" in init) return init.signal ?? undefined;
  return input instanceof Request ? input.signal : undefined;
}

/** The resolved request URL, whichever of the three input forms `fetch` was handed. */
function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Builds the `fetch` passed to `DefaultChatTransport`. Only requests to `resumeEndpoint`
 * are subject to either policy; everything else — the chat POST above all — passes
 * through untouched, because a 503 from the CHAT endpoint is a real outage and a
 * concurrent chat POST is a real second message.
 */
export function createResumeFetch(
  resumeEndpoint: string,
  fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args)
): typeof fetch {
  const resumePath = resumeEndpoint.split("?")[0];

  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    const isResume = url.split("?")[0].endsWith(resumePath);
    if (!isResume) return fetchImpl(input, init);

    const holder = inFlight.get(url);
    if (holder && !holder.signal?.aborted) {
      /*
       * 204 rather than a thrown error or a stalled promise: `reconnectToStream` maps
       * 204 to null and `makeRequest` then returns BEFORE `setStatus`, so the duplicate
       * writes no state at all — no second message, no status flicker.
       *
       * A holder whose signal is ABORTED suppresses nothing, because it can no longer
       * succeed — under ai v7 that is the routine case, not the exotic one.
       */
      return new Response(null, { status: 204 });
    }

    const claim: Claim = { signal: signalOf(input, init) };
    inFlight.set(url, claim);

    let response: Response;
    try {
      response = await fetchImpl(input, init);
    } finally {
      // Cleared on settle, including the throwing path: a network error that left the
      // key set would mute every later resume of this stream. Only a slot still held by
      // THIS request is cleared — a displaced holder settling must not evict the
      // successor that took its place.
      if (inFlight.get(url) === claim) inFlight.delete(url);
    }

    if (response.status !== 503) return response;
    return new Response(null, { status: 204 });
  };
}
