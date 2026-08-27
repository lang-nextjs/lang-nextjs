import { describe, it, expect } from "vitest";
import { probeLlm, probeSandbox } from "./useQueueReadiness";
import { computeReadiness, canSend } from "../readiness";

/**
 * #124. The distinction under test is null-vs-false, because that is the whole
 * bug: the queue rendered a hardcoded environment string, so it had no way to
 * be wrong — and wiring it up is only a fix if "could not determine" stays
 * distinct from "determined to be no".
 */

function jsonFetch(body: unknown, ok = true, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
}
const throwingFetch = (async () => {
  throw new Error("ECONNREFUSED");
}) as unknown as typeof fetch;

describe("probeSandbox — a 503 is an ANSWER, not a failure to answer", () => {
  it("503 with available:false reports FALSE, not null", async () => {
    // The health route answers 503 when the daemon is down and still carries
    // { available: false }. Treating !res.ok as unknown would turn a definite
    // no into a shrug — the mirror of the bug this issue is about.
    const r = await probeSandbox(jsonFetch({ available: false }, false, 503));
    expect(r.available).toBe(false);
    expect(r.error).toBeUndefined();
  });

  it("200 with available:true reports TRUE", async () => {
    expect((await probeSandbox(jsonFetch({ available: true }))).available).toBe(true);
  });

  it("an unreachable endpoint reports NULL and says why", async () => {
    const r = await probeSandbox(throwingFetch);
    expect(r.available).toBeNull();
    expect(r.error).toMatch(/unreachable/i);
  });

  it("a response missing `available` is NULL, not false", async () => {
    // Shape drift is not evidence of unavailability.
    const r = await probeSandbox(jsonFetch({ provider: "docker" }));
    expect(r.available).toBeNull();
    expect(r.error).toMatch(/available/);
  });
});

describe("probeLlm", () => {
  it("activeLlm present reports TRUE", async () => {
    expect((await probeLlm(jsonFetch({ activeLlm: "openrouter" }))).configured).toBe(true);
  });

  it("activeLlm null reports FALSE — the endpoint answered", async () => {
    expect((await probeLlm(jsonFetch({ activeLlm: null }))).configured).toBe(false);
  });

  it("an unreachable /api/config reports NULL, not false", async () => {
    const r = await probeLlm(throwingFetch);
    expect(r.configured).toBeNull();
    expect(r.error).toMatch(/unreachable/i);
  });

  it("a response missing activeLlm entirely is NULL, not false", async () => {
    const r = await probeLlm(jsonFetch({ backends: {} }));
    expect(r.configured).toBeNull();
  });
});

describe("what the queue does with those probes", () => {
  const q = (llm: boolean | null, sandbox: boolean | null, status = "idle") =>
    computeReadiness({
      llmConfigured: llm,
      sandboxRequired: true, // the queue EXECUTES code — /chat passes false
      sandboxAvailable: sandbox,
      streamStatus: status,
    });

  it("both probes in flight is UNKNOWN — never an optimistic green", () => {
    expect(q(null, null).state).toBe("unknown");
    expect(canSend(q(null, null))).toBe(false);
  });

  it("a dead sandbox is BLOCKED and names the sandbox", () => {
    const r = q(true, false);
    expect(r.state).toBe("blocked");
    expect(r.reasons.join(" ")).toMatch(/sandbox/i);
  });

  it("no model is BLOCKED and names the model", () => {
    expect(q(false, true).reasons.join(" ")).toMatch(/model|llm|key/i);
  });

  it("BOTH missing reports BOTH reasons — fixing one at a time is slow", () => {
    expect(q(false, false).reasons.length).toBeGreaterThanOrEqual(2);
  });

  it("only both-true is READY and sendable", () => {
    const r = q(true, true);
    expect(r.state).toBe("ready");
    expect(canSend(r)).toBe(true);
  });

  it("UNKNOWN is not sendable — an unverified environment is not a ready one", () => {
    expect(canSend(q(null, true))).toBe(false);
    expect(canSend(q(true, null))).toBe(false);
  });

  it("the queue and /chat DISAGREE on the same probes, and that is correct", () => {
    // Identical inputs; only sandboxRequired differs. /chat does not execute
    // code, so a dead sandbox does not block it. The queue does.
    const chat = computeReadiness({
      llmConfigured: true,
      sandboxRequired: false,
      sandboxAvailable: false,
      streamStatus: "idle",
    });
    const queue = q(true, false);
    expect(chat.state).toBe("ready");
    expect(queue.state).toBe("blocked");
  });
});

/**
 * `llmSource` MUST SURVIVE THE PROBE.
 *
 * readiness.test.ts covers `computeReadiness` and passes it a source
 * directly — so it is right about the function and blind to the boundary
 * where the argument is gathered. That is the third time this exact gap has
 * produced a user-visible defect in this codebase:
 *
 *   mapStatus          tested with both arguments; production supplies one
 *   consoleFor         tested with a host; /api/config dropped it
 *   computeReadiness   tested with a source; probeLlm never read it
 *
 * A well-tested pure function plus untested wiring is this repo's
 * characteristic failure, and each time the tests were correct and useless.
 */
describe("probeLlm carries who answered", () => {
  const respond = (body: unknown) =>
    (async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

  it("A BACKEND ANSWER IS REPORTED AS SUCH", async () => {
    const r = await probeLlm(respond({ activeLlm: "nvidia", llmSource: "backend" }));
    expect(r).toMatchObject({ configured: true, source: "backend" });
  });

  it("A FALLBACK READING IS REPORTED AS SUCH", async () => {
    // The reported case: the backend was stopped, so /api/config read this
    // process's env instead and found nothing.
    const r = await probeLlm(respond({ activeLlm: null, llmSource: "local-env" }));
    expect(r).toMatchObject({ configured: false, source: "local-env" });
  });

  it("an ABSENT source is null, not guessed", async () => {
    // An older payload. Guessing "backend" would restore exactly the wrong
    // message for the case this fixes.
    const r = await probeLlm(respond({ activeLlm: null }));
    expect(r.configured).toBe(false);
    expect(r.source ?? null).toBeNull();
  });

  it("an UNRECOGNISED source is null, not passed through", async () => {
    // Anything but the two known values is not a source; forwarding it would
    // put an unhandled string into a branch that tests two.
    const r = await probeLlm(respond({ activeLlm: null, llmSource: "wat" }));
    expect(r.source ?? null).toBeNull();
  });

  it("an unreachable /api/config is still unknown, not false", async () => {
    // Unchanged behaviour, asserted so the new field cannot alter it: a probe
    // that could not run is not evidence of absence.
    const boom = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const r = await probeLlm(boom);
    expect(r.configured).toBeNull();
    expect(r.error).toMatch(/unreachable/);
  });
})
