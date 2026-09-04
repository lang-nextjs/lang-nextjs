import { test, expect, type APIRequestContext } from "@playwright/test";
import { errorFrameEvidence, inBandErrorFrame } from "../error-frame";
import {
  readTurn,
  classifyTurn,
  describeTurn,
  type Turn,
} from "../../packages/test-utils/src/live-turn-outcome";

/**
 * THE MATRIX, EXECUTED — framework × runtime × mode, driving the real tools.
 *
 * `e2e/matrix/matrix.spec.ts` covers all twelve cells and is honest about its
 * subject: it mocks `/api/chat/stream` and asserts the selected cell reaches the
 * proxy body. That is the right test for a selector and it is not this one.
 *
 * What nothing covered is whether a cell, once dispatched, WORKS. The only place
 * the tools appeared was a curl step in the workflow asserting HTTP 200 and that
 * some frame carries a `type` field — which passes if the model ignores the tool
 * entirely and streams a polite refusal.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS INVARIANT DOES AND DOES NOT CATCH, corrected after review.
 *
 * It asserts: the counter advanced by exactly the number of `increment`
 * invocations THE STREAM REPORTED. That catches a tool advertised but not wired
 * (calls reported, counter still), and a counter moving without any reported
 * call (state changing behind the UI's back).
 *
 * An earlier version of this header claimed it also catches a tool that fires
 * twice per request. IT DOES NOT, and the difference matters: `increments` is
 * derived from the same stream that caused the movement, so a double-fire that
 * reports two frames and moves the counter twice satisfies the equation. That is
 * a live shape here — plan-execute has a replanner loop that can re-issue a step
 * — and asserting `increments === 1` instead would trade a real invariant for a
 * flaky one against a non-deterministic model. The narrower claim is the true
 * one: STREAM-REPORTED CALLS AGREE WITH OBSERVED STATE.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHERE THIS RUNS, STATED RATHER THAN IMPLIED. It is wired into
 * e2e-live-transport, which is gated on a model key this repository does not
 * have — so it does not execute in CI today. That is the same gate its sibling
 * suite sits behind and the same reason. It runs by hand against a local
 * backend, and it will start running in CI the day the key exists. Written down
 * because a suite that names a workflow and never executes is the failure this
 * file's first version already made once.
 *
 * SERIALISATION IS NOT ISOLATION. `mode: "serial"` plus `workers: 1` orders the
 * cells within this file. It does NOT stop another project from touching the
 * same counter — `open-swe-platform-routes.spec.ts` POSTs `/api/counter` — so
 * this project must not run concurrently with the mocked suite. Every overlap
 * direction produces a delta LARGER than the reported increments, i.e. red, so
 * contention is a flake source rather than a false green. Stated because the
 * config cannot enforce it.
 */

/*
 * NOT `mode: "serial"`, DELIBERATELY.
 *
 * Serial mode gives ordering AND abort-on-first-failure, and the second half is
 * expensive here: one cell failing SKIPPED the remaining four tests, including
 * both deepagents cells and the whole inventory describe. A run that reports
 * "1 failed, 3 passed" while silently declining to execute half the matrix tells
 * you less than it appears to.
 *
 * Ordering is what the shared counter actually needs, and `workers: 1` on this
 * project already provides it (fullyParallel is not set, so a file's tests run
 * in declaration order). Each cell also reads its own baseline immediately
 * before incrementing, so a neighbour that failed midway cannot corrupt it.
 */

const FRAMEWORKS = ["langchain", "langgraph", "deepagents"] as const;
const TOPOLOGIES = ["react", "plan-execute"] as const;

/**
 * The runtime under test, validated against the exact set — not merely for
 * presence.
 *
 * `asPythonBackend` in lib/frameworks.ts silently coerces ANY unrecognised value
 * to "fastapi". So `LIVE_RUNTIME=Django`, or a trailing space from a YAML edit,
 * would produce six green cells that exercised FastAPI while reporting Django's
 * tool wiring sound. A presence check cannot see that; this one can.
 *
 * The same file's #211 work says exactly this about frameworks — "present but
 * unknown is not absent" — and the runtime coercion four screens above it does
 * the opposite. The spec refuses to inherit that hole.
 */
const RUNTIMES = ["django", "fastapi"] as const;
const RUNTIME = process.env.LIVE_RUNTIME;

interface Observed {
  tools: string[];
  text: string;
  /**
   * THE RAW STREAM, KEPT SO A FAILURE CAN BE ATTRIBUTED (#742).
   *
   * `readTurn` parses the body and this file used to drop the original. That is
   * enough to describe a failure and not enough to say WHOSE it is: the
   * classifier in scripts/classify-live-failure.mjs attributes a red by reading
   * `origin` out of the raw error frame, and it only ever sees what an assertion
   * MESSAGE puts in the log.
   *
   * Without it these tests were unclassifiable by construction. Measured: main's
   * live-transport job was red for 55 consecutive runs, and the newest failures —
   * all in this file — carried no verdict of any kind, while the same job's
   * live-transport steps reported "UPSTREAM_UNAVAILABLE … not a defect in this
   * repository". Two steps in one job, one attributable and one not.
   */
  sse: string;
  /**
   * THE WHOLE TURN, not the two fields this file used to keep (#530).
   *
   * The old reader collected `tool-input-available` names and `text-delta` deltas and dropped
   * every other frame, `data-error` included. So an upstream failure reached the assertion as
   * an empty string with nothing to say about it, and was reported as "called the tool but
   * reported a different number" — a state the evidence ruled out, for 34 consecutive runs.
   */
  turn: Turn;
}

async function ask(
  request: APIRequestContext,
  prompt: string,
  framework: string,
  topology: string
): Promise<Observed> {
  const res = await request.post("/api/chat/stream", {
    data: {
      messages: [{ role: "user", parts: [{ type: "text", text: prompt }] }],
      aiBackend: framework,
      runtime: RUNTIME,
      topology,
    },
    timeout: 120_000,
  });
  // Catches the 502 the route returns when this runtime's env var is unset —
  // which is what "the runtime is configured" actually means here.
  expect(res.status(), `${framework} × ${topology} should dispatch`).toBe(200);

  // Read EVERY frame, including the ones this suite does not act on. What it drops it cannot
  // report, and what it cannot report gets attributed to whatever the assertion happens to say.
  const sse = await res.text();
  const turn = readTurn(sse);
  return { tools: turn.toolCalls, text: turn.text, turn, sse };
}

/**
 * The classifier's evidence line for a failing cell.
 *
 * Appended to an assertion MESSAGE rather than logged, because only a failing
 * assertion's message reaches the job log, and the log is the classifier's only
 * input. `cell` names the case: frames are de-duplicated on `cell::frame`, so a
 * shared label would collapse distinct failures into one.
 *
 * Emitted even when the stream carried NO error frame — that is a different
 * fact from a stream that carried one, and the classifier needs to see the
 * absence to report FAILED_UNCLASSIFIED rather than quietly finding nothing.
 */
function frameEvidence(o: Observed, cell: string): string {
  return errorFrameEvidence(cell, inBandErrorFrame(o.sse));
}

/**
 * The endpoint the TOOL itself reads and writes.
 *
 * `ai_backends/_common.py` defines COUNTER_URL (default
 * http://host.docker.internal:3000/api/counter) and both tools are plain HTTP
 * calls to it. So the counter is directly observable, and this suite observes
 * it rather than asking the model what it is.
 *
 * THE FIRST VERSION PARSED THE MODEL'S PROSE, AND IT WAS WRONG IN PRACTICE, not
 * merely in principle. It took the last integer in the reply because
 * plan-execute narrates step numbers; a real run then produced:
 *
 *   langchain × plan-execute: reported 1 increment call(s)
 *   but the counter moved from 14 to 2
 *
 * The counter did not move backwards — the parser read a step number. Any
 * heuristic over generated text has this shape, and the fix is not a better
 * regex: it is to stop asking a language model to be a measuring instrument
 * when the quantity is available over HTTP.
 */
const COUNTER_URL =
  process.env.COUNTER_URL ?? "http://localhost:3000/api/counter";

async function readCounter(request: APIRequestContext): Promise<number> {
  const res = await request.get(COUNTER_URL);
  expect(
    res.status(),
    `the counter endpoint the tools use (${COUNTER_URL}) must be reachable — ` +
      "if this fails the tools are writing somewhere this test cannot see, and " +
      "every cell below would be measuring the wrong number"
  ).toBe(200);
  const body = (await res.json()) as { counter?: unknown };
  expect(
    typeof body.counter,
    `unexpected counter payload: ${JSON.stringify(body)}`
  ).toBe("number");
  return body.counter as number;
}

test.beforeAll(() => {
  // FAILS rather than skips, for the reason llm.spec.ts gives: a silent skip in
  // a job that exists to exercise a live path is a false green.
  expect(
    RUNTIMES as readonly string[],
    `LIVE_RUNTIME must be one of ${RUNTIMES.join(" | ")}, got ${JSON.stringify(
      RUNTIME
    )}. ` +
      "An unrecognised value is silently coerced to fastapi downstream, which " +
      "would report this runtime's cells green having tested another one."
  ).toContain(RUNTIME);
});

for (const framework of FRAMEWORKS) {
  for (const topology of TOPOLOGIES) {
    test(`cell ${framework} × ${topology}: the counter advances by exactly the increments reported`, async ({
      request,
    }, testInfo) => {
      test.setTimeout(300_000);

      // NO `test.fail()` ON deepagents, AND THAT IS A CORRECTION.
      //
      // I marked both deepagents cells expected-to-fail on the reasoning behind
      // #256: `increment` is not in READ_ONLY_TOOLS, the approval gate keys on
      // `tool-input-start`, and only this adapter's backend emits one — so the
      // gate fires, nobody approves, and the tool frames are dropped after the
      // drain grace while the tool has already run.
      //
      // Then `deepagents × react` PASSED, and Playwright reported "expected to
      // fail, but passed". The gate does not fire every time. Asserting a
      // failure I cannot reproduce is the same error as asserting a success I
      // have not measured — it just fails in the more flattering direction.
      //
      // So these cells run like the others. When they fail, #256 is the first
      // place to look, and the failure message names what the stream reported.

      const before = await readCounter(request);

      const run = await ask(
        request,
        "Call the increment tool exactly once. Do not call any other tool.",
        framework,
        topology
      );
      const increments = run.tools.filter((t) => t === "increment").length;
      const after = await readCounter(request);

      /*
       * THE INVARIANT, ASSERTED UNCONDITIONALLY — AND THAT IS THE CHANGE.
       *
       * This used to require `increments > 0` FIRST, and fail there. That is an
       * assertion about the MODEL, not about this system, and the header above
       * already rejects exactly that trade for the count case:
       *
       *   asserting `increments === 1` instead would trade a real invariant for
       *   a flaky one against a non-deterministic model
       *
       * `increments > 0` is the same trade one notch weaker, and it fired ahead
       * of the real check. Observed on the first real run of this job:
       * deepagents × plan-execute reported `tools seen: ["task"]` — the model
       * delegated to a subagent instead of calling the named tool — and the cell
       * went red without the invariant ever being evaluated.
       *
       * BOTH DANGEROUS DIRECTIONS ARE STILL CAUGHT, and one of them BETTER than
       * before:
       *
       *   reported > 0, counter still   a tool advertised but not wired
       *   reported = 0, counter MOVED   state changing behind the UI's back
       *
       * The second is the delegation case, and the old ordering could never
       * reach it: it failed on the report before looking at the counter, so
       * "delegated and did nothing" and "delegated and changed state invisibly"
       * were indistinguishable. Only one of those is a defect in this system.
       */
      expect(
        after - before,
        `${framework} × ${topology}: reported ${increments} increment call(s) ` +
          `but the counter moved from ${before} to ${after}. ` +
          `Tools seen: ${JSON.stringify(run.tools)}\n` +
          frameEvidence(run, `${framework}/${topology}`)
      ).toBe(increments);

      /*
       * A CELL THAT DID NOTHING MUST NOT PASS SILENTLY.
       *
       * With the invariant alone, `0 === 0` is satisfied by a model that
       * declined, delegated, or was never wired at all — and a green tick over a
       * cell that exercised nothing is the shape this repo keeps finding.
       * Annotated rather than failed: which tool a non-deterministic model picks
       * is not this suite's subject, but it must stay visible in the report.
       */
      if (increments === 0) {
        testInfo.annotations.push({
          type: "no-increment-reported",
          description:
            `${framework} × ${topology}: the model reported no increment call ` +
            `(tools seen: ${JSON.stringify(
              run.tools
            )}) and the counter did not ` +
            `move. The invariant holds; nothing was exercised. See #303.`,
        });
      }
    });
  }
}

test.describe("get_counter reaches the same number the endpoint reports", () => {
  for (const framework of FRAMEWORKS) {
    test(`${framework} reads the counter through the tool, not from context`, async ({
      request,
    }) => {
      test.setTimeout(180_000);
      // This assertion used to live inside the read mechanism, where it was
      // load-bearing for every cell and made the whole suite hostage to the
      // model's willingness to call a tool. It belongs here: one case that owns
      // the claim, so a model declining to call get_counter fails ONE test
      // instead of six, and names what it did instead.
      const truth = await readCounter(request);

      /*
       * AN EMPTY RESPONSE IS THE PROVIDER, NOT A REFUSAL — AND THE TWO MUST NOT
       * SHARE A FAILURE MESSAGE.
       *
       * This project's config already records the shape: "a cell returned HTTP
       * 200 with an empty stream and no tool call, which is the provider's
       * service-temporarily-overloaded shape. That is not a defect in the app."
       * Observed again on main:
       *
       *   Error: deepagents answered without calling get_counter: ""
       *
       * The old code could not tell that from a model answering from context
       * instead of calling the tool — which IS the thing under test — because
       * both arrive as "no get_counter in tools". Reported as the latter, it
       * accuses the app of a defect the provider caused.
       *
       * Re-asked ONLY when the stream came back completely empty. This is not
       * retry-until-green: a model that answers WITHOUT calling the tool still
       * fails on the first sample, because it produced text. Only the shape the
       * provider owns — nothing at all — is re-asked, and if it is empty twice
       * the failure says so rather than blaming the model.
       */
      const askOnce = () =>
        ask(
          request,
          "Use the get_counter tool to read the counter. Reply with only the number.",
          framework,
          "react"
        );
      /*
       * ONE ASSERTION, AND IT NAMES WHICH OUTCOME OCCURRED (#530).
       *
       * This used to be three assertions ending in "called the tool but reported a different
       * number than N", printed with `Received string: ""`. A WRONG NUMBER IS NOT AN EMPTY
       * STRING: that sentence described a state the evidence ruled out, and it did so for 34
       * consecutive runs on main while the job skipped on every pull request.
       *
       * `classifyTurn` separates the states the old message conflated — an upstream error, a
       * stream with nothing in it, a model that never called the tool, a model that called it
       * and produced no text, and a model that answered with the wrong number — and
       * `describeTurn` prints the turn beneath it, so the next red is readable without
       * re-running anything.
       *
       * The re-ask is narrower than before, and deliberately. It fires ONLY on a stream with
       * no frames whatsoever, which is the provider's overloaded shape and carries no
       * information. A `data-error` frame is no longer swept in with it: that one is now
       * legible, so it is REPORTED rather than retried away.
       */
      let o = await askOnce();
      let verdict = classifyTurn(o.turn, {
        tool: "get_counter",
        expect: String(truth),
      });
      if (verdict.outcome === "empty_stream") {
        o = await askOnce();
        verdict = classifyTurn(o.turn, {
          tool: "get_counter",
          expect: String(truth),
        });
      }

      expect(
        verdict.outcome,
        `${framework} × react: ${verdict.why}\n` +
          `  the assistant turn, as received:\n${describeTurn(o.turn)}\n` +
          frameEvidence(o, `${framework}/react/get_counter`)
      ).toBe("ok");
    });
  }
});

/**
 * The floor the cells stand on.
 *
 * NOT TITLED "for this runtime", which the request cannot carry: the route reads
 * FASTAPI_URL unconditionally and takes no runtime parameter. Claiming otherwise
 * would be a verdict about something never measured — so this says FastAPI, and
 * `topology` IS passed, because the route accepts it and inventory is
 * topology-dependent (RESEARCH_TOOLS once REPLACED rather than extended TOOLS
 * and silently dropped both counter tools).
 *
 * NO `continue` GUARD. An earlier version skipped the body on a non-200,
 * ostensibly because "not every app exposes this route" — in this app that
 * branch is dead (the route answers 200 on every path) and it was live exactly
 * where it should not have been: pointed at the wrong app, every iteration 404s,
 * the loop body never runs, and the test passes having asserted nothing.
 */
test.describe("tool inventory (FastAPI only — the route takes no runtime)", () => {
  for (const topology of TOPOLOGIES) {
    test(`every framework advertises increment and get_counter under ${topology}`, async ({
      request,
    }) => {
      // REPORTED AS SKIPPED WITH A REASON, not silently absent. The tools route
      // reads FASTAPI_URL unconditionally and the Django job deliberately
      // leaves it unset, so running this there produces a FALSE RED about
      // Django's inventory using FastAPI's endpoint. Playwright prints the
      // reason, so a reader sees that this was declined rather than passed.
      test.skip(
        RUNTIME !== "fastapi",
        "the tools route takes no runtime and reads FASTAPI_URL; under " +
          `${RUNTIME} it would report FastAPI's inventory or none at all`
      );
      for (const framework of FRAMEWORKS) {
        const res = await request.get(
          `/api/chat/tools?aiBackend=${framework}&topology=${topology}`
        );
        expect(res.status(), `${framework} tools route`).toBe(200);
        const body = (await res.json()) as
          | string[]
          | { tools?: Array<string | { name?: string }> };
        const names = (Array.isArray(body) ? body : body.tools ?? []).map((t) =>
          typeof t === "string" ? t : t?.name
        );
        expect(
          names,
          `${framework} × ${topology} advertises no tools at all — either the ` +
            `route is pointed at the wrong app or FASTAPI_URL is unset`
        ).not.toHaveLength(0);
        expect(names, `${framework} × ${topology}`).toContain("increment");
        expect(names, `${framework} × ${topology}`).toContain("get_counter");
      }
    });
  }
});
