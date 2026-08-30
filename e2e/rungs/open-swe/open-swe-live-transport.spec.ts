import { test, expect, type APIRequestContext } from "@playwright/test";

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
async function chat(
  request: APIRequestContext,
  opts: { aiBackend: string; topology: string; runtime?: string }
): Promise<{ status: number; body: string }> {
  const res = await request.post("/api/chat/stream", {
    data: {
      messages: [
        { role: "user", content: "Reply with the single word: ready" },
      ],
      aiBackend: opts.aiBackend,
      runtime: opts.runtime ?? RUNTIME,
      topology: opts.topology,
    },
    // Measured SERIALLY (see the describe.configure below): the slowest pair
    // is ~21s against a live NVIDIA-backed FastAPI. 180s is deliberate
    // headroom for a CI runner slower than a laptop, not a fitted number.
    //
    // An earlier draft cited ~81s for deepagents x react and that figure was
    // WRONG — it was measured while a parallel run was still in flight, so it
    // described contention rather than the pair. Serialised, the same pair is
    // 14s. Recorded because sizing a timeout from a number taken under
    // unrelated load is how timeouts end up mysterious.
    timeout: 180_000,
  });
  return { status: res.status(), body: await res.text() };
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
        request,
      }) => {
        test.slow(); // a real model call, not a fixture

        const { status, body } = await chat(request, {
          aiBackend: rung,
          topology,
        });

        expect(
          status,
          `${rung}/${topology} proxied to the live ${RUNTIME} backend`
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
        expect(
          body,
          `${rung}/${topology} returned an in-band error frame`
        ).not.toMatch(/"type"\s*:\s*"(data-)?error"/);

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
    request,
  }) => {
    // The runtime NOT under test in this job has no URL configured, so this
    // exercises the real 502 path rather than a mocked one. The message must
    // name the variable — a 502 that says "not configured" without saying what
    // to set is a dead end for whoever hits it.
    const other = RUNTIME === "django" ? "fastapi" : "django";
    const expectedVar = other === "django" ? "DJANGO_URL" : "FASTAPI_URL";

    const { status, body } = await chat(request, {
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
    request,
  }) => {
    const { status, body } = await chat(request, {
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
