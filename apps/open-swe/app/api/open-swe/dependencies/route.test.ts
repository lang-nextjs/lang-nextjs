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
