import { test, expect } from "@playwright/test";
import { errorFrameEvidence, inBandErrorFrame } from "../error-frame";
import {
  streamAnsweringApprovals,
  describeApprovals,
} from "../approval-stream";

/**
 * open-swe /chat against a LIVE Python backend (#153).
 *
 * THE GAP THIS CLOSES. open-swe is the app people work in, its /chat proxies to
 * django or fastapi, and #133 made that a user-facing runtime selector — but no
 * e2e had ever run it against a live backend. `buildBackendUrl`'s django
 * trailing-slash rule, per-runtime token forwarding, and the 502-names-the-
 * right-env-var path were covered by unit tests and mocked e2e only, and the
 * one thing neither can prove is that the app talks to a real Django and a real
 * FastAPI.
 *
 * WHICH RUNTIME IS LIVE. Each CI job stands up exactly one Python backend, so
 * this spec is told which one via LIVE_RUNTIME. It does NOT skip when that is
 * missing — a silent skip is how a suite reports green having run nothing, and
 * this file exists because of a coverage hole nobody could see.
 *
 * EXPECTATIONS ARE LITERALS. rungs.json says which (rung, runtime) pairs exist;
 * the expected list below is written out. Deriving both sides from the manifest
 * gives a test that passes for ANY manifest — which is exactly how a stale
 * generated.ts survived in a branch until an independent literal caught it
 * (#145). The manifest is checked AGAINST the literal here, so a manifest that
 * grows a pair fails this test until someone decides the pair is real.
 */

/**
 * The in-band error frame, if the body carries one — the raw line, unclassified.
 *
 * DELIBERATELY NOT CLASSIFIED HERE (#400). Whether a failure is the provider's
 * or ours is decided ONCE, in scripts/classify-live-failure.mjs, which is unit
 * tested against frames this repo's real error path actually produced. A second
 * copy of that rule inside a spec that only runs against a live model would be
 * the half nobody could test — and two classifiers that agree until they do not
 * is the shape #377 is open about.
 *
 * So the spec's job is to FAIL and to quote the frame verbatim. The script reads
 * it out of the run output and decides how the step presents it.
 */
const RUNTIME = process.env.LIVE_RUNTIME as "django" | "fastapi" | undefined;

/** The backend's own health endpoint, so a missing model is named as such. */
const HEALTH_URL = process.env.LIVE_HEALTH_URL;

/**
 * The pairs this suite expects to exist, written out rather than derived.
 * If rungs.json gains or loses one, the assertion below fails and a human
 * decides whether the new pair is real — which is the whole point.
 */
const EXPECTED_RUNGS = ["langchain", "langgraph", "deepagents"] as const;

/** Topologies per rung, again literal. deepagents is the only one with deep-research. */
const EXPECTED_TOPOLOGIES: Record<string, string[]> = {
  langchain: ["react", "plan-execute"],
  langgraph: ["react", "plan-execute"],
  deepagents: ["react", "plan-execute", "deep-research"],
};

test.beforeAll(() => {
  // Loud, not skipped. If this project is ever wired into a job without a live
  // backend, that must be a failure rather than a quietly empty run.
  expect(
    RUNTIME,
    "LIVE_RUNTIME must be django or fastapi — this project only runs in the live-backend jobs"
  ).toBeTruthy();
  expect(["django", "fastapi"]).toContain(RUNTIME);
});

/** POST a chat turn through open-swe's proxy and return status + body text. */
/*
 * ANSWERS THE APPROVALS IT RAISES, WHICH IS THE WHOLE OF #887.
 *
 * `topology: react` is gated on every rung — the comment below already says so — and the
 * open-swe route OVERWRITES `approvalPolicy` unconditionally (route.ts:233) with an allowlist,
 * so a caller cannot opt out of gating. Any tool the live model chooses to call therefore
 * raises an approval, and nothing here used to answer it. The stream closed, the close-time
 * sweep found a result in hand with the approval unresolved, and emitted
 * `tool_executed_without_approval` — an in-band error frame, which the negative assertion
 * below correctly fails on.
 *
 * That red said nothing about the transport, which is this suite's actual subject. It said the
 * approval surface had been exercised by a test with no approver.
 *
 * IT CANNOT BE A SECOND REQUEST AFTER THE BODY ARRIVES. The decision must land inside
 * `drainGraceMs`, and awaiting a full body returns only after the sweep has already run — see
 * ../approval-stream.ts, which is why that helper reads incrementally and why it is verified
 * against the mocked HITL surface in e2e/api/approval-stream.spec.ts, where gating is
 * deterministic and no model is involved.
 */
async function chat(
  baseURL: string,
  opts: { aiBackend: string; topology: string; runtime?: string }
): Promise<{
  status: number;
  body: string;
  approvals: { decisionStatus: number | null }[];
  describe: string;
}> {
  const res = await streamAnsweringApprovals({
    url: `${baseURL}/api/chat/stream`,
    approvalUrl: (id) => `${baseURL}/api/approval/${id}`,
    /*
     * Measured SERIALLY (see the describe.configure below): the slowest pair is ~21s against a
     * live NVIDIA-backed FastAPI. 180s is deliberate headroom for a CI runner slower than a
     * laptop, not a fitted number.
     *
     * An earlier draft cited ~81s for deepagents x react and that figure was WRONG — it was
     * measured while a parallel run was still in flight, so it described contention rather than
     * the pair. Serialised, the same pair is 14s. Recorded because sizing a timeout from a
     * number taken under unrelated load is how timeouts end up mysterious.
     *
     * IT NOW ALSO BOUNDS THE DRAIN. The exchange includes the post-upstream grace this helper
     * answers approvals inside, so the ceiling covers both halves rather than the request alone.
     */
    timeoutMs: 180_000,
    payload: {
      messages: [
        { role: "user", content: "Reply with the single word: ready" },
      ],
      aiBackend: opts.aiBackend,
      runtime: opts.runtime ?? RUNTIME,
      topology: opts.topology,
      /*
       * NAMED PER CALL, NOT HOISTED (#652, and #171 is why).
       *
       * `react` is gated on every rung, and a gated call is paused until someone
       * answers it — on a LATER request that has to find the same conversation.
       * Without a sessionId the backend refuses with 400 rather than pausing
       * un-resumably, which is what this job has been failing on.
       *
       * The shipped surface already sends one: ConversationSurface mints
       * `newSessionId("example")` and passes it to the hook. This helper builds a
       * body by hand and bypasses that component, so it has to do the same thing.
       *
       * A SHARED CONSTANT WOULD REPRODUCE #171 WITH A LONGER STRING — that defect
       * was a client sending a fixed id, so the backend grouped every turn into one
       * conversation and told nobody. Minting per call keeps each pair's round trip
       * its own conversation, which is what the assertions below assume.
       */
      sessionId: `live-transport-${crypto.randomUUID()}`,
    },
  });
  return {
    status: res.status,
    body: res.body,
    approvals: res.approvals,
    describe: describeApprovals(res),
  };
}

/*
 * SERIAL, and not as a flake workaround. Every test below is a real model call
 * against a single backend process, so running them in parallel makes each one
 * slower and the timings unpredictable. Measured both ways: deepagents x react
 * exceeded 120s in parallel and takes 14s serialised — the contention, not the
 * pair, was the cost. Serialising makes the timeout a statement about the
 * slowest pair rather than about how many workers happened to be competing.
 */
test.describe.configure({ mode: "serial" });

test.describe("open-swe /chat — live transport to a real Python backend", () => {
  test("the manifest declares exactly the pairs this suite covers", async () => {
    // The literal is the expectation; the manifest is the thing under test.
    // Reading the manifest for BOTH sides would pass for any manifest at all.
    const manifest = JSON.parse(
      await (await import("node:fs/promises")).readFile("rungs.json", "utf8")
    ) as {
      rungs: {
        id: string;
        runtimes?: Record<string, { topologies?: string[] }>;
      }[];
    };

    const pythonRungs = manifest.rungs
      .filter((r) => r.runtimes && (r.runtimes.django || r.runtimes.fastapi))
      .map((r) => r.id);

    expect(
      pythonRungs.sort(),
      "a rung gained or lost a Python runtime — decide whether the new pair is real, then update this literal"
    ).toEqual([...EXPECTED_RUNGS].sort());

    for (const rung of EXPECTED_RUNGS) {
      const declared = manifest.rungs.find((r) => r.id === rung)!.runtimes![
        RUNTIME!
      ]?.topologies;
      expect(
        declared,
        `${rung} must declare topologies for ${RUNTIME}`
      ).toBeTruthy();
      expect(
        [...declared!].sort(),
        `${rung} x ${RUNTIME} topologies drifted from the literal`
      ).toEqual([...EXPECTED_TOPOLOGIES[rung]].sort());
    }
  });

  /**
   * PRECONDITION — and it is a named test rather than a beforeAll so that it
   * appears in the report as its own result.
   *
   * When this suite first ran in CI every pair failed with
   *   {"type":"data-error","data":{"code":"upstream_disconnect",...}}
   * about 150ms in, against a ~4s baseline for a real streamed response. That
   * reads exactly like a transport bug, and it is not one: the job had no
   * OPENROUTER_API_KEY, so the backend had no model to call and closed the
   * stream immediately. "The backend has no model" and "the transport is
   * broken" must not be indistinguishable, because the one people chase is the
   * wrong one.
   *
   * THREE-STATE, because the two backends do not answer the same question.
   * FastAPI's /health carries `llm: { configured }`; Django's carries only
   * status / ai_backends / topologies and has no llm field at all. Asserting
   * `configured === true` unconditionally would make Django permanently red for
   * a reason that has nothing to do with its LLM. So an ABSENT field is
   * reported as unanswerable rather than read as false — absence of evidence is
   * not evidence of absence, and collapsing the two is how a check starts lying
   * about a backend it cannot actually see.
   */
  test("the backend reports a configured LLM, so an empty stream is not misread as a transport fault", async ({
    request,
  }) => {
    expect(
      HEALTH_URL,
      "LIVE_HEALTH_URL must be set — without it this precondition cannot run and the suite goes back to blaming the transport"
    ).toBeTruthy();

    const res = await request.get(HEALTH_URL!);
    expect(
      res.status(),
      `${RUNTIME} /health must be reachable at ${HEALTH_URL}`
    ).toBe(200);

    const health = (await res.json()) as { llm?: { configured?: boolean } };

    if (health.llm === undefined) {
      // Not a pass and not a failure: this backend cannot answer the question.
      // Recorded on the result so the gap is visible rather than inferred from
      // a green tick. Django's /health growing an llm field is its own issue.
      test.info().annotations.push({
        type: "unanswerable",
        description: `${RUNTIME}'s /health exposes no llm field, so this precondition could not be checked. A stream that ends immediately in this job will still surface as upstream_disconnect with no hint that a missing key caused it.`,
      });
      /*
       * AND TO STDOUT, BECAUSE THIS BRANCH RETURNS BEFORE ITS ASSERTION.
       *
       * The annotation above is the structured record and it does NOT reach the log on a
       * green run. Measured on this repo's playwright 1.60: for a PASSING test, `list`
       * prints the test title and this `console.log` and NOT the annotation, and `github`
       * splits the same way. The title is the control -- the reporter ran, so the
       * annotation is what it omitted rather than the run being silent.
       *
       * IT MATTERS MORE HERE THAN AT THE APPROVALS LINE BELOW, because that one records a
       * green that DID assert. This block skips the `expect` beneath it entirely, so
       * without this line the test passes having checked nothing and leaves a reader
       * exactly the green tick the comment above says it prevents.
       */
      console.log(
        `  unanswerable ${RUNTIME}: /health exposes no llm field — the configured-LLM precondition did NOT run`
      );
      return;
    }

    expect(
      health.llm.configured,
      `${RUNTIME} reports no configured LLM. The backend has no model to call, so an empty stream here is NOT a transport fault — set OPENROUTER_API_KEY. This assertion exists so that cause is named instead of rediscovered.`
    ).toBe(true);
  });

  // One live round-trip per (rung, topology) pair for the runtime under test.
  for (const rung of EXPECTED_RUNGS) {
    for (const topology of EXPECTED_TOPOLOGIES[rung]) {
      test(`${rung} x ${topology}: a real streamed response comes back`, async ({
        baseURL,
      }) => {
        test.slow(); // a real model call, not a fixture

        const { status, body, approvals, describe } = await chat(
          baseURL as string,
          { aiBackend: rung, topology }
        );

        /*
         * RECORDED UNCONDITIONALLY, BECAUSE A GREEN IS WHERE THIS IS UNREADABLE.
         *
         * `describe` carries the approvals and their decisions, and every other use of it is an
         * assertion message — which Playwright prints ONLY ON FAILURE. So on a green run these
         * two were indistinguishable:
         *
         *     the model called a tool, an approval was raised and answered  -> the fix worked
         *     the model called no tool                                      -> the fix never ran
         *
         * That is the residual this change names as unretireable, and its stated discriminator
         * is "a green whose log shows zero approvals" — a line that did not exist until here.
         * Same idiom and same reason as the `unanswerable` annotation above: recorded on the
         * result so the gap is visible rather than inferred from a green tick, which matters
         * more in this job than anywhere, since it runs only on pushes to main and re-running
         * destroys the diagnosis.
         */
        test.info().annotations.push({
          type: "approvals",
          description: `${rung}/${topology}: ${describe}`,
        });
        /*
         * AND TO STDOUT, BECAUSE THE ANNOTATION DOES NOT REACH THE LOG ON A GREEN RUN.
         *
         * Measured under this repo's playwright: for a PASSING test, `list` prints the test
         * title and NOT the annotation, and `github` prints neither. The HTML report carries
         * it verbatim. The control is the title — `list` printed that, so the reporter ran
         * and the annotation is what it omitted rather than the run being silent.
         *
         * The two are not redundant. The annotation is the structured record in the report;
         * this line is what the discriminator above actually reads, since "a green whose log
         * shows zero approvals" is a claim about STDOUT and this job runs only on pushes to
         * main — so its log is the whole evidence and a re-run destroys the diagnosis.
         */
        console.log(`  approvals ${rung}/${topology}: ${describe}`);

        /*
         * ASSERTED BEFORE THE ERROR-FRAME CHECK, BECAUSE A REFUSED DECISION AND A BROKEN
         * TRANSPORT PRODUCE THE SAME RED. If the approval route rejected us, the close-time
         * sweep strands the approval and emits `tool_executed_without_approval` — an in-band
         * error frame — and the negative assertion below would fail while naming the transport.
         * This one fails first and names the decision and its status, so the log says which half
         * broke without a re-run. That matters more here than anywhere else in the suite: this
         * job runs only on pushes to main, so its log is the entire evidence and re-running
         * destroys the diagnosis.
         *
         * It passes vacuously when the model called no tool, and that is correct rather than
         * weak — there is nothing to answer. e2e/api/approval-stream.spec.ts is where the
         * answering path is exercised deterministically.
         */
        expect(
          approvals.every((a) => a.decisionStatus === 200),
          `${rung}/${topology}: every approval this call raised must have been answered — ${describe}`
        ).toBe(true);

        // THE BODY IS IN THE MESSAGE, NOT READ AFTER THE ASSERTION (#654's lesson,
        // applied here). `chat()` already returns it, so a non-200 carried its own
        // reason all along and the assertion discarded it: every failure read
        // `Expected: 200 / Received: 400` and said nothing about why. This job has
        // failed 64% of main pushes since 08-31 with that as its entire evidence.
        expect(
          status,
          `${rung}/${topology} proxied to the live ${RUNTIME} backend. ` +
            `Response body:\n${body.slice(0, 1000)}`
        ).toBe(200);

        // A 200 with an empty body would satisfy a status-only assertion, and
        // an empty stream is exactly what a misrouted proxy produces.
        expect(
          body.length,
          "the response body must not be empty"
        ).toBeGreaterThan(0);

        // SSE frames, not an error page. Asserting the frame shape rather than
        // any particular text keeps this about transport rather than about
        // what the model happened to say.
        expect(body, `${rung}/${topology} must return SSE data frames`).toMatch(
          /(^|\n)data: /
        );

        // NEGATIVE: no in-band error frame. The proxy surfaces upstream
        // failures as data frames with a 200, so status alone cannot tell a
        // working pair from a broken one.
        //
        // The pattern covers BOTH `error` and `data-error`. An earlier draft
        // matched only `"type":"error"` and passed against a Django that was
        // returning nothing but
        //   {"type":"data-error","data":{"code":"upstream_disconnect",...}}
        // — a 200, one data frame, zero content, and a green test. That is the
        // exact failure this suite was written to catch, produced by the suite
        // itself.
        /*
         * STILL A FAILURE — WHOSE failure is the only thing that changed (#400).
         *
         * A 200 carrying an error frame is not a working transport, and this
         * assertion is not weakened: every error frame still fails. What it now
         * does is SAY WHICH KIND, because the two were indistinguishable and no
         * policy can treat them differently while they look the same.
         *
         * Measured on run 33315368062: an upstream overload arrived as
         * code=backend_error, retryable=false — the FALL-THROUGH branch, because
         * a provider APIError carries no HTTP status. A KeyError from our own
         * emitter produces the identical two values. `origin` is the field that
         * separates them, decided at the source by isinstance against the
         * provider SDKs' base error classes, never by the message text.
         *
         * ABSENT `origin` IS TREATED AS OURS. An older backend, or a frame from
         * the Node proxy rather than the Python one, carries no origin — and
         * "we could not attribute this" must not read as "not our problem".
         */
        const errorFrame = inBandErrorFrame(body);
        expect(
          errorFrame,
          errorFrameEvidence(`${rung}/${topology}`, errorFrame)
        ).toBeNull();

        // POSITIVE: at least one frame from the normal streaming vocabulary.
        // Without this, a single non-error frame of any kind would satisfy the
        // checks above — absence of an error is not evidence of a response.
        expect(
          body,
          `${rung}/${topology} produced no actual stream content`
        ).toMatch(
          /"type"\s*:\s*"(text-start|text-delta|tool-input-start|finish)"/
        );
      });
    }
  }

  test("an unconfigured runtime 502s and names the env var that would fix it", async ({
    baseURL,
  }) => {
    // The runtime NOT under test in this job has no URL configured, so this
    // exercises the real 502 path rather than a mocked one. The message must
    // name the variable — a 502 that says "not configured" without saying what
    // to set is a dead end for whoever hits it.
    const other = RUNTIME === "django" ? "fastapi" : "django";
    const expectedVar = other === "django" ? "DJANGO_URL" : "FASTAPI_URL";

    const { status, body } = await chat(baseURL as string, {
      aiBackend: "langchain",
      topology: "react",
      runtime: other,
    });

    expect(status, `${other} is not configured in this job`).toBe(502);
    expect(body).toContain(expectedVar);
  });
});

/**
 * The django trailing-slash rule, against a server that actually 404s without
 * it (#153 item 3).
 *
 * `buildBackendUrl` appends `/` for django and withholds it for fastapi. That
 * was asserted only against a STRING — a unit test comparing one function's
 * output to a literal proves the function is self-consistent, not that Django's
 * URLconf agrees with it. These run only in the django job, where a real
 * URLconf is there to disagree.
 */
test.describe("django trailing slash — asserted against a real URLconf", () => {
  test.skip(
    () => process.env.LIVE_RUNTIME !== "django",
    "the trailing-slash rule is a Django URLconf behaviour; only meaningful in the django job"
  );

  test("the proxy reaches Django, which means the slash was appended", async ({
    baseURL,
  }) => {
    const { status, body } = await chat(baseURL as string, {
      aiBackend: "langchain",
      topology: "react",
      runtime: "django",
    });
    // If buildBackendUrl stopped appending the slash, Django's URLconf would
    // 404 and this would not be a 200 carrying SSE frames.
    expect(status).toBe(200);
    expect(body).toMatch(/(^|\n)data: /);
    // Same lesson as above: reaching Django means real frames, not an
    // upstream_disconnect error frame that also happens to be a data frame.
    expect(body).not.toMatch(/"type"\s*:\s*"(data-)?error"/);
    expect(body).toMatch(
      /"type"\s*:\s*"(text-start|text-delta|tool-input-start|finish)"/
    );
  });

  test("the same URL WITHOUT the trailing slash is rejected by Django itself", async ({
    request,
  }) => {
    // The control that makes the test above mean something. Without this, a
    // Django configured with APPEND_SLASH redirects would make the rule
    // unnecessary and the assertion above would pass either way — proving the
    // proxy works, not that the rule is load-bearing.
    const base = process.env.DJANGO_URL;
    expect(base, "DJANGO_URL must be set in the django job").toBeTruthy();
    const root = base!.endsWith("/") ? base!.slice(0, -1) : base!;

    const res = await request.post(`${root}/langchain`, {
      data: { messages: [{ role: "user", content: "hi" }], topology: "react" },
      timeout: 60_000,
      maxRedirects: 0,
    });

    expect(
      res.status(),
      "Django must NOT serve this path without the trailing slash — if it does, " +
        "buildBackendUrl's django branch is no longer load-bearing and the rule " +
        "should be re-examined rather than kept on faith"
    ).not.toBe(200);
  });
});
