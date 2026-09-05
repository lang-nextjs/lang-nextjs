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
 * These are TRANSPORT assertions: given a `runtime` field, which process
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
const NODE_URL = process.env.NODE_URL;

/**
 * A topology no backend declares. Both reject it from inside the dispatch,
 * which is the point: the reply is the view's, so it names the process.
 *
 * Deliberately not a real topology — a real one calls a model, which costs
 * seconds, needs a key, and answers a question this suite is not asking.
 */
const PROBE_TOPOLOGY = "__routing_probe__";

/**
 * The JSON key each PYTHON framework's error envelope uses. See the header.
 *
 * Two entries, not three, and that is the point of the next constant.
 */
const ENVELOPE_KEY = { django: "error", fastapi: "detail" } as const;

const RUNTIMES = ["django", "fastapi", "node"] as const;
type Runtime = (typeof RUNTIMES)[number];

/**
 * NODE NAMES ITSELF, and is not told apart by envelope shape (#360).
 *
 * node-backend answers `{"detail": …}` — FastAPI's key, deliberately, because those two are
 * the ones a reader compares and a third arbitrary spelling would be a difference that means
 * nothing. So shape alone cannot separate node from fastapi and this suite would have been
 * unable to prove which of them answered.
 *
 * Its error bodies now carry `runtime: "node"`. That is what the server's own header
 * prescribed for this moment — "something that IS about node … rather than an error-shape
 * accident" — and it is strictly better than the django/fastapi discriminator this file
 * already admits it cannot defend: a field whose VALUE is the runtime cannot be harmonised
 * away without changing what it says.
 *
 * A self-declaration is believed over an inference, so it is checked FIRST. The envelope
 * fallback stays for the two that have not been given one, and the CONTROL below fails if any
 * pair stops being separable by either route.
 */
const SELF_DECLARED = "runtime";

/** Where each runtime's process lives, direct — not through the proxy. */
const DIRECT_BASE: Record<Runtime, string | undefined> = {
  django: DJANGO_URL,
  fastapi: FASTAPI_URL,
  node: NODE_URL,
};

/** Django's URLconf wants the trailing slash; FastAPI and node reject it. */
const TRAILING_SLASH: Record<Runtime, string> = {
  django: "/",
  fastapi: "",
  node: "",
};

/*
 * `runtime`, NOT `pythonBackend` (#360 window closure). The old key is no
 * longer read, so a body carrying it names no runtime and the proxy 400s.
 *
 * WORTH A NOTE BECAUSE OF HOW THIS ESCAPED THE RENAME: line below spells the
 * property in ES6 SHORTHAND — `{ runtime }`, no colon — so a sweep grepping
 * `pythonBackend:` could not match it at all. Not an exclusion filter dropping
 * a hit; the pattern was structurally incapable of finding one of the two
 * spellings JavaScript allows for the same property.
 */
const probeBody = (runtime?: Runtime) => ({
  messages: [
    { role: "user", content: "routing probe — never reaches a model" },
  ],
  aiBackend: "langchain",
  topology: PROBE_TOPOLOGY,
  ...(runtime ? { runtime } : {}),
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

  // A process that names itself is believed over a shape inference — but only if it names
  // something this suite knows. An unrecognised value is INDETERMINATE rather than trusted,
  // or a typo in a backend would silently become a new runtime nobody routes to.
  const declared = obj[SELF_DECLARED];
  if (typeof declared === "string") {
    return (RUNTIMES as readonly string[]).includes(declared)
      ? (declared as Runtime)
      : "indeterminate";
  }

  const hasDjango = typeof obj[ENVELOPE_KEY.django] === "string";
  const hasFastapi = typeof obj[ENVELOPE_KEY.fastapi] === "string";
  if (hasDjango && !hasFastapi) return "django";
  if (hasFastapi && !hasDjango) return "fastapi";
  return "indeterminate";
}

/**
 * The human-readable reason, from whichever envelope key this reply used.
 *
 * Needed because the key is no longer a function of the runtime: node answers under FastAPI's
 * `detail` while identifying itself with `runtime`. Indexing ENVELOPE_KEY by the runtime —
 * which is what this file did — reads `undefined` for node and asserts against nothing.
 */
function messageOf(obj: Record<string, unknown>): string | undefined {
  for (const key of Object.values(ENVELOPE_KEY)) {
    if (typeof obj[key] === "string") return obj[key] as string;
  }
  return undefined;
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
  // NAMED ONE BY ONE, not asserted as a group. #328 item 22 is this job verifying the right
  // backend for the wrong reason: an absent runtime coerced to django, DJANGO_URL unset,
  // falling through to BACKEND_URL. A collective "all URLs present" would have been true of
  // that configuration too.
  for (const runtime of RUNTIMES) {
    expect(
      DIRECT_BASE[runtime],
      `${runtime.toUpperCase()}_URL must be set — this suite needs an open-swe with ALL ` +
        `${RUNTIMES.length} runtimes configured, which is the whole point of it. Without it ` +
        `the ${runtime} cases would be asserting against whichever process the proxy fell ` +
        `back to.`
    ).toBeTruthy();
  }
});

test.describe("open-swe runtime selector — which process actually answers", () => {
  test("CONTROL: all three backends can still be told apart at all", async ({
    request,
  }) => {
    // Straight at each process, bypassing open-swe entirely. This establishes
    // the ground truth every other test in this file reads. If it fails, the
    // failures below are not about routing.
    const direct: Record<Runtime, { status: number; body: string }> =
      {} as never;

    for (const runtime of RUNTIMES) {
      const base = DIRECT_BASE[runtime]!;
      const root = base.endsWith("/") ? base.slice(0, -1) : base;
      // The trailing slash is Django's URLconf requirement and FastAPI's and node's
      // dislike — the same rule buildBackendUrl applies. Applied by hand here
      // so this control does not depend on the code it is a control for.
      const url = `${root}/langchain${TRAILING_SLASH[runtime]}`;
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
        `${runtime}'s 404 reply no longer identifies it. The backends have ` +
          `stopped being distinguishable, so every routing ` +
          `assertion in this file would pass while proving nothing. Fix the ` +
          `discriminator before trusting the rest of this suite.`
      ).toBe(runtime);
    }

    // EVERY PAIR, not just the first two. With three processes there are three pairs, and a
    // check that compared only django against fastapi would go green on the day node's reply
    // became byte-identical to one of them — which is nearer than it sounds, since node
    // already shares FastAPI's envelope key by design.
    for (let i = 0; i < RUNTIMES.length; i++) {
      for (let j = i + 1; j < RUNTIMES.length; j++) {
        const [a, b] = [RUNTIMES[i], RUNTIMES[j]];
        expect(
          direct[a].body,
          `${a} and ${b} returned byte-identical bodies for the same probe — there is nothing left to route by`
        ).not.toBe(direct[b].body);
      }
    }
  });

  for (const runtime of RUNTIMES) {
    test(`runtime="${runtime}" is answered by the ${runtime} process`, async ({
      request,
    }) => {
      const { status, body } = await probeThroughProxy(request, runtime);

      expect(
        status,
        `the ${runtime} view's own 404 must survive the proxy`
      ).toBe(404);

      const obj = firstJsonObject(body);

      // POSITIVE — judged by the one discriminator this file defines, so this test and the
      // CONTROL above cannot drift apart. It used to index ENVELOPE_KEY by the runtime, which
      // is `undefined` for node and would have asserted against nothing.
      expect(
        authorOf(body),
        `expected the ${runtime} process to answer; got ${JSON.stringify(obj)}`
      ).toBe(runtime);

      // ...and it is a real rejection of the probe topology, not an empty body that happens
      // to identify a process.
      expect(
        messageOf(obj),
        `${runtime} identified itself but said nothing about the probe topology: ${JSON.stringify(
          obj
        )}`
      ).toEqual(expect.stringContaining("unknown topology"));

      // NEGATIVE — for the two told apart BY SHAPE, the other's key must be absent. A body
      // carrying both would satisfy the check above, and "both" is exactly what a harmonised
      // error format looks like. node is exempt because it does not rely on shape: it shares
      // FastAPI's key deliberately and names itself instead.
      if (runtime !== "node") {
        const other = runtime === "django" ? "fastapi" : "django";
        expect(
          obj[ENVELOPE_KEY[other]],
          `the reply also carries ${other}'s "${ENVELOPE_KEY[other]}" envelope, so it does not identify a process`
        ).toBeUndefined();
      }
    });
  }

  test("mid-session, each turn is answered by the runtime that turn asked for", async ({
    request,
  }) => {
    /*
     * The failure this catches is a runtime resolved once and cached — per
     * process, per module, per connection. Every single-runtime job passes
     * with that bug present, because there is no other backend to be stuck on.
     *
     * ALTERNATING, and back again. django -> fastapi is satisfied by a route
     * that simply follows the last value it saw; the RETURN to django is what
     * makes each turn's answer a function of that turn's request.
     *
     * All three runtimes, and node in the middle rather than at the end (#360):
     * a runtime cached on first use is caught by any second value, but one
     * cached on LAST use is only caught by visiting a runtime and then leaving
     * it. Ending on node would test the first bug twice and the second never.
     *
     * One APIRequestContext throughout, so this is one client, one cookie jar
     * and one keep-alive connection — a session, not four unrelated calls.
     */
    const sequence: Runtime[] = ["django", "fastapi", "node", "django"];
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
