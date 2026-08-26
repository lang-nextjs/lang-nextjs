/**
 * THE OBSERVABILITY STATE MAPPING (#124).
 *
 * Five states, and the reason there are five rather than a boolean: "tracing is on"
 * collapses situations that call for different actions. Not wired means change the build;
 * not configured means add credentials; unverified means nobody has checked; unreachable
 * means it was checked and refused. Only the last of those is a bug, and a boolean cannot
 * tell you which one you have.
 *
 * WHAT WOULD LET THESE PASS WHILE THE MAPPING IS WRONG, and what stops it:
 *   · a mapping that returned one state for everything -> every case asserts a DIFFERENT
 *     state, so a constant answer fails at least four of them;
 *   · the null/false collapse -> `unverified` and `unreachable` are asserted separately
 *     over inputs that differ ONLY in `tracing: null` vs `tracing: false`. That pair is
 *     the whole point of the model and is the one a "simplification" would destroy;
 *   · reading the row that happened to be first -> every assertion is keyed by id.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GET } from "./route";
import type { DependencyReport } from "../../../../lib/dependency-status";

type Obs = {
  supported?: boolean;
  configured?: boolean;
  tracing?: boolean | null;
  detail?: string | null;
};

/**
 * Stub `/api/config`. The route derives its origin from the request URL and proxies, so
 * the transport is controlled here rather than left to whatever is listening on a port —
 * a test that silently changes its answer with the environment is testing the machine.
 */
function configSays(observability: Record<string, Obs>, source = "backend") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes("/api/config")) {
        return new Response(
          JSON.stringify({
            activeLlm: "nvidia",
            observability,
            observabilitySource: source,
          }),
          { status: 200 }
        );
      }
      // Everything else the route probes is deliberately unreachable: those rows are not
      // this file's subject and must not decide its result.
      throw new Error("connection refused");
    })
  );
}

function configUnreadable() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("connection refused");
    })
  );
}

const req = () =>
  new Request("http://localhost:3000/api/open-swe/dependencies") as never;

async function rows(): Promise<DependencyReport[]> {
  const body = (await (await GET(req())).json()) as {
    dependencies: DependencyReport[];
  };
  return body.dependencies.filter((d) => d.id.startsWith("observability-"));
}

const byId = (rs: DependencyReport[], id: string) =>
  rs.find((r) => r.id === `observability-${id}`)!;

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe("observability rows — one state per situation, not a boolean", () => {
  it("supported:false is NOT-WIRED — absent from the build is not a failure", async () => {
    configSays({ langsmith: { supported: false, configured: false } });
    expect(byId(await rows(), "langsmith").state).toBe("not-wired");
  });

  it("configured:false is NOT-CONFIGURED — present but no credentials", async () => {
    configSays({ langsmith: { supported: true, configured: false } });
    expect(byId(await rows(), "langsmith").state).toBe("not-configured");
  });

  it("tracing:true is RESPONDING — a span was accepted", async () => {
    configSays({
      langsmith: { supported: true, configured: true, tracing: true },
    });
    expect(byId(await rows(), "langsmith").state).toBe("responding");
  });

  it("tracing:false is UNREACHABLE — attempted and refused", async () => {
    configSays({
      langsmith: { supported: true, configured: true, tracing: false },
    });
    expect(byId(await rows(), "langsmith").state).toBe("unreachable");
  });

  it("tracing:null is UNVERIFIED and says why — nobody asked", async () => {
    configSays({
      langsmith: { supported: true, configured: true, tracing: null },
    });
    const r = byId(await rows(), "langsmith");
    expect(r.state).toBe("unverified");
    // The panel renders this at dep-{id}-why. A row that cannot be verified without a
    // side effect must say what the side effect costs, rather than absorbing it.
    expect(r.unverifiableBecause).toBeTruthy();
  });

  it("THE PAIR: null and false differ only in tracing, and must not agree", async () => {
    // The discriminating case. Any change that collapses absent into false — a `?? false`
    // that reads as a tidy-up — makes these two identical, and an integration nobody
    // probed becomes indistinguishable from one that was refused.
    configSays({
      a: { supported: true, configured: true, tracing: null },
      b: { supported: true, configured: true, tracing: false },
    });
    const rs = await rows();
    expect(byId(rs, "a").state).toBe("unverified");
    expect(byId(rs, "b").state).toBe("unreachable");
    expect(byId(rs, "a").state).not.toBe(byId(rs, "b").state);
  });

  it("an unknown integration id degrades to its own name, it is not dropped", async () => {
    // Dropping a row we have no label for would hide a real integration behind a
    // presentation gap — the panel would simply not mention it.
    configSays({ honeycomb: { supported: true, configured: true, tracing: true } });
    const r = byId(await rows(), "honeycomb");
    expect(r).toBeDefined();
    expect(r.label).toBe("honeycomb");
  });

  it("local-env source says the BACKEND could not be asked, not that it failed", async () => {
    configSays(
      { langsmith: { supported: true, configured: true, tracing: null } },
      "local-env"
    );
    const r = byId(await rows(), "langsmith");
    expect(r.state).toBe("unverified");
    // Local inference can answer `configured` and nothing more — spans are emitted by the
    // process that builds the model, which is not this one.
    expect(r.unverifiableBecause).toMatch(/cannot observe a span/i);
  });

  it("config unreadable yields UNVERIFIED rows, never a green or a red", async () => {
    // Failing to ASK is not the integration failing to answer. Reporting `unreachable`
    // here would blame the dependency for our own outage.
    configUnreadable();
    const rs = await rows();
    expect(rs.length).toBeGreaterThan(0);
    for (const r of rs) {
      expect(r.state).toBe("unverified");
      expect(r.unverifiableBecause).toBeTruthy();
    }
  });
});

/**
 * THE INFERENCE ROW, PROBED FOR REAL.
 *
 * The check behind this row used to fetch the BACKEND'S /health — which reports
 * {"configured": true, "provider": "nvidia"}, i.e. whether a KEY IS PRESENT — and render
 * it as `responding`. It ran behind a button warning that it cost an inference call. It
 * cost nothing and could not fail for the reason it named.
 *
 * Since it now runs automatically, that gap would have become a claim of model health on
 * every page load. These cases assert the two things no other test in the tree can:
 * WHICH ENDPOINT is called, and what happens to the row when the model misbehaves while
 * the key stays perfectly configured.
 *
 * The lib tests cover stream parsing; the e2e drives mocks. Only here is the route's own
 * probe exercised, so a regression to the /health ping is only catchable here.
 */
describe("inference is verified by asking the model, not by reading a key", () => {
  const ORIGINAL_FASTAPI_URL = process.env.FASTAPI_URL;

  /** Stubs /api/config as configured, and the backend stream with whatever is given. */
  function backendStreams(
    stream: { status?: number; body?: string; throws?: string },
    onCall?: (url: string, init?: RequestInit) => void
  ) {
    process.env.FASTAPI_URL = "http://backend:8001";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        onCall?.(u, init);
        if (u.includes("/api/config")) {
          return new Response(
            JSON.stringify({ activeLlm: "nvidia", observability: {} }),
            { status: 200 }
          );
        }
        if (u.includes("/api/chat/stream")) {
          if (stream.throws) throw new Error(stream.throws);
          return new Response(stream.body ?? "", { status: stream.status ?? 200 });
        }
        throw new Error("connection refused");
      })
    );
  }

  // `refresh=1` on every case here. The verdict is cached process-wide for five
  // minutes, so without it the first test's `responding` would be handed to all
  // the others — which is exactly what happened when these were first written,
  // and is how the missing cache-bypass on the Re-verify button was found.
  const verifyReq = (refresh = true) =>
    new Request(
      `http://localhost:3000/api/open-swe/dependencies?verify=llm${
        refresh ? "&refresh=1" : ""
      }`
    ) as never;

  async function inferenceRow(refresh = true): Promise<DependencyReport> {
    const body = (await (await GET(verifyReq(refresh))).json()) as {
      dependencies: DependencyReport[];
    };
    return body.dependencies.find((d) => d.id === "inference")!;
  }

  afterEach(() => {
    if (ORIGINAL_FASTAPI_URL === undefined) delete process.env.FASTAPI_URL;
    else process.env.FASTAPI_URL = ORIGINAL_FASTAPI_URL;
  });

  it("POSTS TO THE STREAM ENDPOINT — not to /health", async () => {
    // The regression guard for the original defect. A row can read `responding`
    // whatever endpoint was called, so the row is not the thing to assert.
    const called: string[] = [];
    backendStreams(
      { body: 'data: {"type":"text-delta","delta":"ok"}\n\ndata: {"type":"finish"}\n\n' },
      (u) => called.push(u)
    );
    await inferenceRow();

    const backendCalls = called.filter((u) => u.includes("backend:8001"));
    expect(backendCalls.some((u) => u.includes("/api/chat/stream"))).toBe(true);
    expect(backendCalls.some((u) => u.endsWith("/health"))).toBe(false);
  });

  it("sends a prompt, so the call actually costs what it says it costs", async () => {
    let seen: RequestInit | undefined;
    backendStreams(
      { body: 'data: {"type":"text-delta","delta":"ok"}\n\ndata: {"type":"finish"}\n\n' },
      (u, init) => {
        if (u.includes("/api/chat/stream")) seen = init;
      }
    );
    await inferenceRow();

    expect(seen?.method).toBe("POST");
    expect(String(seen?.body)).toContain("messages");
  });

  it("a model that answers is reported as responding, quoting it", async () => {
    backendStreams({
      body: 'data: {"type":"text-delta","delta":"ok"}\n\ndata: {"type":"finish"}\n\n',
    });
    const row = await inferenceRow();
    expect(row.state).toBe("responding");
    expect(row.detail).toContain("the model answered");
  });

  it("A CONFIGURED KEY WITH A DEAD MODEL IS NOT responding", async () => {
    // The exact live incident: NVIDIA retired a model, every stream returned 410,
    // and the key stayed configured. The old check called this healthy.
    backendStreams({ status: 410, body: "model has been retired" });
    const row = await inferenceRow();
    expect(row.state).not.toBe("responding");
    expect(row.detail).toContain("410");
  });

  it("a stream that finishes with NO TEXT is not a pass", async () => {
    // A well-formed empty answer is what a filtered or dead model produces.
    backendStreams({ body: 'data: {"type":"finish","finishReason":"stop"}\n\n' });
    const row = await inferenceRow();
    expect(row.state).not.toBe("responding");
  });

  it("a failure is `unreachable`, not `unverified` — we DID ask", async () => {
    // Filing a measured failure under "never measured" is the same confusion
    // running the other way, and it changes what a person does about it.
    backendStreams({ throws: "connection reset" });
    const row = await inferenceRow();
    expect(row.state).toBe("unreachable");
    expect(row.unverifiableBecause).toBeUndefined();
  });

  it("without ?verify the model is NOT called — the cost stays opt-in per request", async () => {
    // The route still has a cheap mode. The settings page opts in; other callers
    // must not be made to spend a call by merely reading the panel's shape.
    const called: string[] = [];
    backendStreams({ body: "" }, (u) => called.push(u));
    const body = (await (await GET(req())).json()) as {
      dependencies: DependencyReport[];
    };
    expect(body.dependencies.find((d) => d.id === "inference")?.state).toBe(
      "unverified"
    );
    expect(called.some((u) => u.includes("/api/chat/stream"))).toBe(false);
  });
});

/**
 * THE CACHE, AND THE BUTTON THAT MUST DEFEAT IT.
 *
 * The verdict is cached for five minutes because the check now genuinely spends a call and
 * runs on every page load — without it, an F5 costs money.
 *
 * But the Re-verify button is labelled "spends a call". Served from that cache it would
 * spend nothing and hand back the answer already on screen, which is precisely what a
 * person clicks it to distrust — the same defect this whole change removes, rebuilt one
 * layer up. It was caught by four unrelated tests going green-then-red as the first test's
 * verdict leaked into them.
 */
describe("the inference cache", () => {
  const ORIGINAL_FASTAPI_URL = process.env.FASTAPI_URL;
  afterEach(() => {
    if (ORIGINAL_FASTAPI_URL === undefined) delete process.env.FASTAPI_URL;
    else process.env.FASTAPI_URL = ORIGINAL_FASTAPI_URL;
  });

  function backend(body: string, count: { n: number }) {
    process.env.FASTAPI_URL = "http://backend:8001";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const u = String(url);
        if (u.includes("/api/config"))
          return new Response(
            JSON.stringify({ activeLlm: "nvidia", observability: {} }),
            { status: 200 }
          );
        if (u.includes("/api/chat/stream")) {
          count.n++;
          return new Response(body, { status: 200 });
        }
        throw new Error("connection refused");
      })
    );
  }

  const ANSWERED =
    'data: {"type":"text-delta","delta":"ok"}\n\ndata: {"type":"finish"}\n\n';
  const ask = (refresh: boolean) =>
    GET(
      new Request(
        `http://localhost:3000/api/open-swe/dependencies?verify=llm${
          refresh ? "&refresh=1" : ""
        }`
      ) as never
    );

  it("an automatic load reuses a fresh verdict — an F5 does not cost a call", async () => {
    const count = { n: 0 };
    backend(ANSWERED, count);
    await ask(true); // seed
    const seeded = count.n;
    await ask(false);
    await ask(false);
    expect(count.n).toBe(seeded);
  });

  it("REFRESH SPENDS ONE, because the button says it does", async () => {
    const count = { n: 0 };
    backend(ANSWERED, count);
    await ask(true);
    const before = count.n;
    await ask(true);
    expect(count.n).toBe(before + 1);
  });
});
