import { test, expect, type APIRequestContext } from "@playwright/test";

/**
 * THE RUNTIME SELECTOR ROUTES TO THE PROCESS IT NAMES (#153).
 *
 * #157 closed items 1–3 of #153: open-swe now runs against a live Django and a
 * live FastAPI in `e2e-live-transport`. What that suite cannot show is the one
 * thing the selector is FOR — that picking a runtime changes WHICH PROCESS
 * answers. It stands up one open-swe per runtime, each with only that
 * runtime's URL set, so the other backend is unreachable by construction and
 * "django was asked and django answered" is indistinguishable from "django was
 * the only thing configured".
 *
 * This suite runs against ONE open-swe with BOTH DJANGO_URL and FASTAPI_URL
 * set — the deployment a user with a selector actually has — and asks which
 * process answered each request.
 *
 * ── HOW "IT REACHED THAT BACKEND" IS PROVEN ────────────────────────────────
 *
 * Not by the status code, and not by the UI. By a reply only that process can
 * author. Both backends 404 an unknown topology from inside their own view,
 * and their error envelopes differ because their frameworks differ:
 *
 *   Django   JsonResponse({"error":  "unknown topology …"})   views.py
 *   FastAPI  HTTPException(detail=…) -> {"detail": "unknown topology …"}
 *
 * So a 404 carrying `"error":` came out of the Django view, and one carrying
 * `"detail":` came out of the FastAPI one. That is stronger than a 200: a 200
 * proves something streamed, while this names the process that composed the
 * body, and it does so WITHOUT A MODEL KEY — which is what lets this run on
 * every pull request instead of only on push to main.
 *
 * The probe reaches the view, not merely the port. A wrong host would refuse
 * the connection; a wrong path would be answered by the URLconf/router rather
 * than by the dispatch, and neither produces this body.
 *
 * ── THE DISCRIMINATOR IS ITSELF UNDER TEST ─────────────────────────────────
 *
 * `error` vs `detail` is an incidental difference between two web frameworks.
 * Nothing stops someone harmonising the two error envelopes — and on the day
 * they do, every assertion below would keep passing while distinguishing
 * nothing, which is this repository's most-tracked defect class. So the first
 * test probes both processes DIRECTLY, off the proxy, and fails if their
 * replies have stopped being telling apart. A discriminator that cannot
 * discriminate must go red, not quiet.
 *
 * ── WHAT THIS SUITE DOES NOT CLAIM ─────────────────────────────────────────
 *
 * These are TRANSPORT assertions: given a `pythonBackend` field, which process
 * answers. The other half of the chain — that the on-screen control is what
 * puts that field in the request — is NOT asserted here, deliberately. #158 is
 * rewriting those three controls from buttons into dropdowns right now, so a
 * test pinned to today's markup would be written against a control that is
 * being replaced. Reach is the half that no test covers at all; the selector's
 * own wiring belongs with #158, where the markup is settled.
 */

/** The open-swe under test must have BOTH runtimes configured. */
const DJANGO_URL = process.env.DJANGO_URL;
const FASTAPI_URL = process.env.FASTAPI_URL;

/**
 * A topology no backend declares. Both reject it from inside the dispatch,
 * which is the point: the reply is the view's, so it names the process.
 *
 * Deliberately not a real topology — a real one calls a model, which costs
 * seconds, needs a key, and answers a question this suite is not asking.
 */
const PROBE_TOPOLOGY = "__routing_probe__";

/** The JSON key each framework's error envelope uses. See the header. */
const ENVELOPE_KEY = { django: "error", fastapi: "detail" } as const;

type Runtime = keyof typeof ENVELOPE_KEY;
const RUNTIMES: Runtime[] = ["django", "fastapi"];

const probeBody = (pythonBackend?: Runtime) => ({
  messages: [{ role: "user", content: "routing probe — never reaches a model" }],
  aiBackend: "langchain",
  topology: PROBE_TOPOLOGY,
  ...(pythonBackend ? { pythonBackend } : {}),
});

/**
 * The first JSON object in a response body.
 *
 * The proxy streams the upstream body through and then appends its own
 * `data: {"type":"data-error",…upstream_disconnect}` frame, because from where
 * it sits a 404 with no SSE is a stream that ended early. So the body is the
 * backend's JSON followed by an SSE frame, and only the first part is the
 * backend's own words.
 */
function firstJsonObject(body: string): Record<string, unknown> {
  const line = body.split("\n").find((l) => l.trim().startsWith("{"));
  expect(
    line,
    `no JSON object in the response body — got: ${body.slice(0, 300)}`
  ).toBeTruthy();
  return JSON.parse(line!.trim()) as Record<string, unknown>;
}

/** Which process authored this reply, judged only by its error envelope. */
function authorOf(body: string): Runtime | "indeterminate" {
  const obj = firstJsonObject(body);
  const hasDjango = typeof obj[ENVELOPE_KEY.django] === "string";
  const hasFastapi = typeof obj[ENVELOPE_KEY.fastapi] === "string";
  if (hasDjango && !hasFastapi) return "django";
  if (hasFastapi && !hasDjango) return "fastapi";
  return "indeterminate";
}

/** POST a routing probe through open-swe's proxy. */
async function probeThroughProxy(
  request: APIRequestContext,
  runtime: Runtime
): Promise<{ status: number; body: string }> {
  const res = await request.post("/api/chat/stream", {
    data: probeBody(runtime),
    timeout: 30_000,
  });
  return { status: res.status(), body: await res.text() };
}

test.beforeAll(() => {
  // Loud, never skipped. A silent skip is how a suite reports green having run
  // nothing, which is the hole #153 was filed about in the first place.
  expect(
    DJANGO_URL,
    "DJANGO_URL must be set — this suite needs an open-swe with BOTH runtimes configured, which is the whole point of it"
  ).toBeTruthy();
  expect(
    FASTAPI_URL,
    "FASTAPI_URL must be set — this suite needs an open-swe with BOTH runtimes configured, which is the whole point of it"
  ).toBeTruthy();
});

test.describe("open-swe runtime selector — which process actually answers", () => {
  test("CONTROL: the two backends can still be told apart at all", async ({
    request,
  }) => {
    // Straight at each process, bypassing open-swe entirely. This establishes
    // the ground truth every other test in this file reads. If it fails, the
    // failures below are not about routing.
    const direct: Record<Runtime, { status: number; body: string }> =
      {} as never;

    for (const runtime of RUNTIMES) {
      const base = runtime === "django" ? DJANGO_URL! : FASTAPI_URL!;
      const root = base.endsWith("/") ? base.slice(0, -1) : base;
      // The trailing slash is Django's URLconf requirement and FastAPI's
      // dislike — the same rule buildBackendUrl applies. Applied by hand here
      // so this control does not depend on the code it is a control for.
      const url = `${root}/langchain${runtime === "django" ? "/" : ""}`;
      const res = await request.post(url, {
        data: probeBody(),
        timeout: 30_000,
        maxRedirects: 0,
      });
      direct[runtime] = { status: res.status(), body: await res.text() };
    }

    for (const runtime of RUNTIMES) {
      expect(
        direct[runtime].status,
        `${runtime} must reject the probe topology from inside its own dispatch`
      ).toBe(404);
      expect(
        authorOf(direct[runtime].body),
        `${runtime}'s 404 envelope no longer identifies it. The two backends have ` +
          `stopped being distinguishable by their error shape, so every routing ` +
          `assertion in this file would pass while proving nothing. Fix the ` +
          `discriminator before trusting the rest of this suite.`
      ).toBe(runtime);
    }

    expect(
      direct.django.body,
      "django and fastapi returned byte-identical bodies for the same probe — there is nothing left to route by"
    ).not.toBe(direct.fastapi.body);
  });

  for (const runtime of RUNTIMES) {
    test(`pythonBackend="${runtime}" is answered by the ${runtime} process`, async ({
      request,
    }) => {
      const { status, body } = await probeThroughProxy(request, runtime);

      expect(
        status,
        `the ${runtime} view's own 404 must survive the proxy`
      ).toBe(404);

      const other: Runtime = runtime === "django" ? "fastapi" : "django";
      const obj = firstJsonObject(body);

      // POSITIVE — the envelope this framework produces.
      expect(
        obj[ENVELOPE_KEY[runtime]],
        `expected ${runtime}'s "${ENVELOPE_KEY[runtime]}" envelope; got ${JSON.stringify(obj)}`
      ).toEqual(expect.stringContaining("unknown topology"));

      // NEGATIVE — and the other one, absent. Without this a body carrying
      // BOTH keys would satisfy the check above, and "both" is exactly what a
      // harmonised error format would look like.
      expect(
        obj[ENVELOPE_KEY[other]],
        `the reply also carries ${other}'s "${ENVELOPE_KEY[other]}" envelope, so it does not identify a process`
      ).toBeUndefined();
    });
  }

  test("mid-session, switching the runtime moves the next turn to the OTHER process", async ({
    request,
  }) => {
    /*
     * The failure this catches is a runtime resolved once and cached — per
     * process, per module, per connection. Every single-runtime job passes
     * with that bug present, because there is no other backend to be stuck on.
     *
     * ALTERNATING, and back again. django -> fastapi is satisfied by a route
     * that simply follows the last value it saw; the return to django is what
     * makes each turn's answer a function of that turn's request.
     *
     * One APIRequestContext throughout, so this is one client, one cookie jar
     * and one keep-alive connection — a session, not three unrelated calls.
     */
    const sequence: Runtime[] = ["django", "fastapi", "django"];
    const answered: string[] = [];

    for (const runtime of sequence) {
      const { status, body } = await probeThroughProxy(request, runtime);
      expect(status, `turn asking for ${runtime}`).toBe(404);
      answered.push(authorOf(body));
    }

    expect(
      answered,
      "each turn must be answered by the runtime that turn asked for"
    ).toEqual(sequence);
  });

  test("the django trailing slash is load-bearing against this Django, on this PR", async ({
    request,
  }) => {
    /*
     * #153 item 3, per-PR. `e2e-live-transport` asserts this too, but that job
     * is gated on a model key and runs only on push to main — so the rule was
     * checked against a real URLconf a day after it could have broken. This
     * probe needs no model, so it can be checked before merge.
     *
     * The control that makes the positive mean something: without it, a Django
     * with APPEND_SLASH redirects would make the rule unnecessary and the
     * proxy would pass either way.
     */
    const root = DJANGO_URL!.endsWith("/")
      ? DJANGO_URL!.slice(0, -1)
      : DJANGO_URL!;

    const withSlash = await request.post(`${root}/langchain/`, {
      data: probeBody(),
      timeout: 30_000,
      maxRedirects: 0,
    });
    expect(
      withSlash.status(),
      "with the slash, Django's dispatch answers — this is the path buildBackendUrl builds"
    ).toBe(404);
    expect(authorOf(await withSlash.text())).toBe("django");

    const withoutSlash = await request.post(`${root}/langchain`, {
      data: probeBody(),
      timeout: 30_000,
      maxRedirects: 0,
    });
    expect(
      withoutSlash.status(),
      "Django must NOT serve this path without the trailing slash. If it does, " +
        "buildBackendUrl's django branch has stopped being load-bearing and the " +
        "rule should be re-examined rather than kept on faith."
    ).not.toBe(404);
  });
});
