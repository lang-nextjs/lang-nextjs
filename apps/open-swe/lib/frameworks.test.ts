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
  backendHealthBase,
  type PythonBackend,
  type Topology,
  resolveFramework,
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
      FRAMEWORKS.some((f) =>
        topologiesFor(f.id, "fastapi").includes("deep-research")
      )
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

/**
 * WHERE A RUNTIME'S /health LIVES — one derivation, not a second copy (#333).
 *
 * `app/api/config/route.ts` grew its own: `FASTAPI_URL ?? BACKEND_URL ?? localhost:8001`,
 * hardcoded in TWO functions. Being a second copy is what let it drift from the one the chat
 * route uses — that one honours `body.pythonBackend`, this one could not, so a user on django
 * got a readiness verdict computed from fastapi.
 */
describe("backendHealthBase", () => {
  it("reads the runtime it is asked about, not a fixed one", () => {
    const env = {
      DJANGO_URL: "http://django.test/api/chat/stream",
      FASTAPI_URL: "http://fastapi.test/api/chat/stream",
    };
    expect(backendHealthBase("django", env)).toBe("http://django.test");
    expect(backendHealthBase("fastapi", env)).toBe("http://fastapi.test");
  });

  it("strips the stream path, with or without a trailing slash", () => {
    // The env vars point at the STREAM endpoint; /health is a sibling at the root.
    for (const suffix of ["/api/chat/stream", "/api/chat/stream/"]) {
      expect(backendHealthBase("fastapi", { FASTAPI_URL: `http://h:8001${suffix}` })).toBe(
        "http://h:8001"
      );
    }
  });

  it("leaves a bare base URL alone", () => {
    expect(backendHealthBase("django", { DJANGO_URL: "http://h:8002" })).toBe("http://h:8002");
  });

  it("falls back to BACKEND_URL then to localhost, per runtime", () => {
    // Preserves what the config route did before this helper existed, so the
    // change is about WHICH runtime is read, not about changing the defaults.
    expect(backendHealthBase("fastapi", { BACKEND_URL: "http://legacy:9000" })).toBe(
      "http://legacy:9000"
    );
    expect(backendHealthBase("fastapi", {})).toBe("http://localhost:8001");
    expect(backendHealthBase("django", {})).toBe("http://localhost:8002");
  });

  it("prefers the runtime's own var over BACKEND_URL", () => {
    // BACKEND_URL is a legacy single-runtime setting. If a deployment sets both,
    // the specific one is the one that means what it says.
    const env = { DJANGO_URL: "http://django.test", BACKEND_URL: "http://legacy:9000" };
    expect(backendHealthBase("django", env)).toBe("http://django.test");
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

/**
 * ABSENT AND PRESENT-BUT-UNKNOWN ARE DIFFERENT USER INTENTS (#211).
 *
 * `?framework=` silently fell back to DEFAULT_FRAMEWORK on ANY invalid value, so a typo'd or
 * stale deep link landed on langchain with no signal: the toolbar showed langchain, the
 * conversation worked, and nothing said the requested framework had been discarded. **A wrong
 * value producing a plausible screen** — the same family as every other defect in this
 * milestone.
 *
 * The severability case is the one that makes it more than a UX nit. After `pnpm eject
 * langchain`, FRAMEWORKS is `RUNGS.filter(shape === "conversation")` over a ONE-RUNG manifest,
 * so a bookmark to `?framework=deepagents` silently becomes langchain — a fork answering for a
 * rung it does not contain.
 *
 * Absent is not an error: no intent was expressed, and defaulting is correct. Present-but-
 * unknown IS: an intent was expressed and cannot be honoured, and substituting silently is the
 * defect. The code treated both identically.
 */
describe("resolveFramework", () => {
  it("absent param defaults, and that is not a substitution", () => {
    const r = resolveFramework(null);
    expect(r.kind).toBe("default");
    expect(r.id).toBe(DEFAULT_FRAMEWORK);
  });

  it("empty string is absent, not a typo", () => {
    // `?framework=` with no value expresses no intent. Reporting it as a failed substitution
    // would be a false alarm, and false alarms are how a notice earns the reflex to be ignored.
    expect(resolveFramework("").kind).toBe("default");
  });

  it("a known framework is honoured", () => {
    const known = FRAMEWORKS[0].id;
    const r = resolveFramework(known);
    expect(r.kind).toBe("honoured");
    expect(r.id).toBe(known);
  });

  it("an unknown value is SUBSTITUTED and keeps what was asked for", () => {
    // The whole point: the requested value survives, so the UI can name it. Discarding it
    // would leave the notice unable to say what the user actually asked for.
    const r = resolveFramework("langraph");
    expect(r.kind).toBe("substituted");
    expect(r.id).toBe(DEFAULT_FRAMEWORK);
    expect(r.kind === "substituted" && r.requested).toBe("langraph");
  });

  it("a real rung this build does not have is substituted, not honoured", () => {
    // The severability case. `zzz-not-a-rung` stands in for a rung that exists in the ladder
    // but was ejected from THIS build — mechanically identical, and the case that matters,
    // because the fork answering for a rung it does not contain is the actual harm.
    const r = resolveFramework("zzz-not-a-rung");
    expect(r.kind).toBe("substituted");
    expect(r.id).toBe(DEFAULT_FRAMEWORK);
  });

  it("never returns an id outside FRAMEWORKS", () => {
    // Whatever it decides, the result must be selectable. A resolution that returned the
    // requested-but-unknown id would push an unusable value into the chat body.
    const ids = FRAMEWORKS.map((f) => f.id);
    for (const input of [null, "", "langraph", "deepagent", FRAMEWORKS[0].id]) {
      expect(ids).toContain(resolveFramework(input).id);
    }
  });
});
