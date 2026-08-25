import { describe, it, expect } from "vitest";
import { RUNGS } from "@deepagents-nextjs/rungs";
import {
  FRAMEWORKS,
  DEFAULT_FRAMEWORK,
  PYTHON_BACKENDS,
  asPythonBackend,
  isKnownFramework,
  labelFor,
  topologiesFor,
  envVarFor,
  authEnvVarFor,
  resolveBackendBase,
  buildBackendUrl,
  type PythonBackend,
  type Topology,
} from "./frameworks";

/**
 * These assert the DERIVATION, not a copy of today's manifest.
 *
 * Pinning the literal list — ["langchain","langgraph","deepagents"] — would
 * rebuild the second list this module exists to delete: the test would then
 * have to be edited whenever the ladder changed, which is exactly the
 * maintenance the manifest is supposed to absorb. So each case states a
 * PROPERTY that must hold for whatever the manifest says, and only the two
 * cases about ladder ORDER name rungs, because order is the claim being made.
 *
 * The one exception is the grid tripwire below, which is a literal ON PURPOSE.
 * See its comment — it is the only assertion here with an independent source.
 */
describe("FRAMEWORKS — derived from the manifest", () => {
  it("contains exactly the conversation-shaped rungs", () => {
    const expected = RUNGS.filter((r) => r.shape === "conversation").map(
      (r) => r.id
    );
    expect(FRAMEWORKS.map((f) => f.id).sort()).toEqual(expected.sort());
  });

  it("excludes run-shaped rungs — open-swe is not a chat framework", () => {
    const runIds = RUNGS.filter((r) => r.shape === "run").map((r) => r.id);
    expect(runIds.length).toBeGreaterThan(0); // the case is not vacuous
    for (const id of runIds) {
      expect(FRAMEWORKS.some((f) => f.id === id)).toBe(false);
    }
  });

  it("is ordered by ordinal — simple to complex, which is the ladder", () => {
    const ordinalOf = new Map<string, number>(
      RUNGS.map((r) => [r.id as string, r.ordinal])
    );
    const ordinals = FRAMEWORKS.map((f) => ordinalOf.get(f.id)!);
    expect(ordinals).toEqual([...ordinals].sort((a, b) => a - b));
  });

  it("puts langchain before langgraph before deepagents", () => {
    // The one case that names rungs, because THIS is the reported bug: the
    // hardcoded array read langgraph, langchain, deepagents.
    const ids = FRAMEWORKS.map((f) => f.id);
    expect(ids.indexOf("langchain")).toBeLessThan(ids.indexOf("langgraph"));
    expect(ids.indexOf("langgraph")).toBeLessThan(ids.indexOf("deepagents"));
  });

  it("defaults to the first rung on the ladder", () => {
    expect(DEFAULT_FRAMEWORK).toBe(FRAMEWORKS[0].id);
  });

  it("labels every framework with something non-empty", () => {
    for (const f of FRAMEWORKS)
      expect(f.label.trim().length).toBeGreaterThan(0);
  });
});

describe("isKnownFramework", () => {
  it("accepts every derived framework", () => {
    for (const f of FRAMEWORKS) expect(isKnownFramework(f.id)).toBe(true);
  });

  it("rejects null, empty and unknown ids", () => {
    expect(isKnownFramework(null)).toBe(false);
    expect(isKnownFramework(undefined)).toBe(false);
    expect(isKnownFramework("")).toBe(false);
    expect(isKnownFramework("not-a-rung")).toBe(false);
  });

  it("rejects a run-shaped rung — a real id that is still not a framework", () => {
    expect(isKnownFramework("open-swe")).toBe(false);
  });
});

describe("asPythonBackend", () => {
  it("accepts both runtimes", () => {
    expect(asPythonBackend("django")).toBe("django");
    expect(asPythonBackend("fastapi")).toBe("fastapi");
  });

  it("defaults unknown/absent input to fastapi rather than throwing", () => {
    // The route takes this from a request body, so it must never throw on junk.
    for (const junk of [undefined, null, "", "flask", 42, {}, []]) {
      expect(asPythonBackend(junk)).toBe("fastapi");
    }
  });
});

describe("topologiesFor — derived from the manifest, not restated", () => {
  it("returns what the manifest declares, for each rung on each runtime", () => {
    for (const f of FRAMEWORKS) {
      for (const runtime of PYTHON_BACKENDS) {
        const declared = RUNGS.find((r) => r.id === f.id)?.runtimes?.[runtime]
          ?.topologies;
        if (declared && declared.length > 0) {
          expect([...topologiesFor(f.id, runtime)]).toEqual([...declared]);
        }
      }
    }
  });

  it("serves deep-research on deepagents from BOTH runtimes", () => {
    /*
     * This replaced a test asserting the opposite — "does NOT offer
     * deep-research on deepagents x django" — and the replacement is the point,
     * not an accident of merging.
     *
     * That test was correct and load-bearing when it was written: django's
     * RESEARCH_TOOLS genuinely had no deep-research entry, so the Mode list had
     * to follow the runtime or the UI would offer a button django could not
     * serve. The asymmetry has since been CLOSED ON PURPOSE — django gained the
     * topology — so the honest assertion is the inverse.
     *
     * Kept as an explicit case rather than folded into the grid because the
     * runtime asymmetry is what made the two-axis derivation necessary in the
     * first place. Whoever removes deep-research from one runtime again should
     * have to walk past this.
     */
    for (const runtime of PYTHON_BACKENDS) {
      expect(topologiesFor("deepagents", runtime)).toContain("deep-research");
    }
  });

  it("pins the whole (rung, runtime) grid as a literal", () => {
    // A TRIPWIRE, and deliberately a hardcoded one.
    //
    // The obvious "improvement" is to derive this expectation from rungs.json.
    // Do not: `topologiesFor` reads RUNG_BY_ID, which is GENERATED from
    // rungs.json. Deriving the expectation from the same file puts one source
    // on both sides of the assertion, and it would then pass for any manifest
    // — deep-research deleted everywhere, or added everywhere. That is not a
    // more maintainable test, it is a test that cannot fail.
    //
    // So this literal is the second, independent statement of the grid. When
    // it fails, the grid changed. That is not a bug in the test: it is the
    // test asking whether the change was intended, and whether the UI story
    // still holds. UPDATING IT IS THE CORRECT RESPONSE — but consciously, in
    // the same change that moved the grid, so the decision is recorded rather
    // than absorbed. That is exactly what happened to the deepagents x django
    // cell below, and the case above records why.
    const grid: Record<string, Record<PythonBackend, readonly Topology[]>> = {
      langchain: {
        django: ["react", "plan-execute"],
        fastapi: ["react", "plan-execute"],
      },
      langgraph: {
        django: ["react", "plan-execute"],
        fastapi: ["react", "plan-execute"],
      },
      deepagents: {
        django: ["react", "plan-execute", "deep-research"],
        fastapi: ["react", "plan-execute", "deep-research"],
      },
    };

    for (const [rung, byRuntime] of Object.entries(grid)) {
      for (const runtime of PYTHON_BACKENDS) {
        expect(
          topologiesFor(rung, runtime),
          `${rung} x ${runtime} changed. If that was deliberate, update this ` +
            `literal in the same change and say why in the commit — the UI ` +
            `derives its Mode buttons from this grid.`
        ).toEqual(byRuntime[runtime]);
      }
    }
  });

  it("gives langchain and langgraph the same two on both runtimes", () => {
    for (const rung of ["langchain", "langgraph"]) {
      for (const runtime of PYTHON_BACKENDS) {
        expect(topologiesFor(rung, runtime)).toEqual(["react", "plan-execute"]);
      }
    }
  });

  it("at least one rung declares deep-research — the case is not vacuous", () => {
    expect(
      FRAMEWORKS.some((f) => topologiesFor(f.id, "fastapi").includes("deep-research"))
    ).toBe(true);
  });

  it("at least one rung does NOT — so the filtering is observable", () => {
    // Without this, a derivation that returned all three topologies for
    // everything would satisfy every other case in this block.
    expect(
      FRAMEWORKS.some(
        (f) => !topologiesFor(f.id, "fastapi").includes("deep-research")
      )
    ).toBe(true);
  });

  it("never returns an empty axis, even for an unknown rung", () => {
    // An empty list renders zero Mode buttons and strands the surface.
    for (const runtime of PYTHON_BACKENDS) {
      expect(topologiesFor("no-such-rung", runtime)).toEqual(["react"]);
      expect(topologiesFor("open-swe", runtime)).toEqual(["react"]);
      for (const f of FRAMEWORKS)
        expect(topologiesFor(f.id, runtime).length).toBeGreaterThan(0);
    }
  });
});

describe("labelFor", () => {
  it("names the three known topologies", () => {
    expect(labelFor("react").label).toBe("ReAct");
    expect(labelFor("plan-execute").label).toBe("Plan-Execute");
    expect(labelFor("deep-research").label).toBe("DeepResearch");
  });

  it("falls back to the id rather than rendering nothing", () => {
    // A topology the manifest gains before this map does must still appear:
    // a copy gap is a smaller failure than silently hiding a real capability.
    expect(labelFor("brand-new-topology")).toEqual({
      label: "brand-new-topology",
      title: "brand-new-topology",
    });
  });
});

describe("env var naming", () => {
  it("names the runtime-specific vars so errors can name them", () => {
    expect(envVarFor("django")).toBe("DJANGO_URL");
    expect(envVarFor("fastapi")).toBe("FASTAPI_URL");
    expect(authEnvVarFor("django")).toBe("DJANGO_AUTH_TOKEN");
    expect(authEnvVarFor("fastapi")).toBe("FASTAPI_AUTH_TOKEN");
  });
});

describe("resolveBackendBase", () => {
  it("reads each runtime from its own var, not a shared one", () => {
    const env = {
      DJANGO_URL: "http://localhost:8002/api/chat/stream",
      FASTAPI_URL: "http://localhost:8001/api/chat/stream",
      DJANGO_AUTH_TOKEN: "dj",
    };
    expect(resolveBackendBase("django", env).url).toBe(env.DJANGO_URL);
    expect(resolveBackendBase("fastapi", env).url).toBe(env.FASTAPI_URL);
    expect(resolveBackendBase("django", env).token).toBe("dj");
    expect(resolveBackendBase("fastapi", env).token).toBeUndefined();
  });

  it("reports an unconfigured runtime as undefined rather than falling back", () => {
    // Falling back to the other runtime's URL would make the selector lie:
    // you would pick django and be served by fastapi.
    const env = { FASTAPI_URL: "http://localhost:8001/api/chat/stream" };
    expect(resolveBackendBase("django", env).url).toBeUndefined();
  });
});

describe("buildBackendUrl", () => {
  it("appends the rung path", () => {
    expect(buildBackendUrl("fastapi", "http://h/api", "deepagents")).toBe(
      "http://h/api/deepagents"
    );
  });

  it("adds django's required trailing slash and withholds it from fastapi", () => {
    // Django's URLconf 404s without it; FastAPI does not want one.
    expect(buildBackendUrl("django", "http://h/api", "langgraph")).toBe(
      "http://h/api/langgraph/"
    );
    expect(buildBackendUrl("fastapi", "http://h/api", "langgraph")).toBe(
      "http://h/api/langgraph"
    );
  });

  it("does not double a slash when the base already ends with one", () => {
    expect(buildBackendUrl("django", "http://h/api/", "deepagents")).toBe(
      "http://h/api/deepagents/"
    );
    expect(buildBackendUrl("fastapi", "http://h/api/", "deepagents")).toBe(
      "http://h/api/deepagents"
    );
  });
});
