import { describe, it, expect, vi } from "vitest";
import { RUNGS } from "@deepagents-nextjs/rungs";
import {
  FRAMEWORKS,
  DEFAULT_FRAMEWORK,
  RUNTIMES,
  parseRuntime,
  describeRuntimeParse,
  runtimeOrDefault,
  DEFAULT_RUNTIME,
  isKnownFramework,
  labelFor,
  topologiesFor,
  envVarFor,
  authEnvVarFor,
  resolveBackendBase,
  buildBackendUrl,
  backendHealthBase,
  type Runtime,
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
 *
 * EVERY LITERAL HERE IS SCOPED TO THE RUNGS THIS TREE ACTUALLY HAS (#154).
 *
 * This file became `shared` when the shell was reparented out of rung 4, which means it now
 * RUNS INSIDE AN EJECTED FORK — and six of its cases asserted whole-ladder facts a one-rung
 * tree cannot satisfy. `eject langchain` leaves a manifest with langchain and nothing else, so
 * "langgraph declares plan-execute" is not a regression there, it is a question about a rung
 * that is gone.
 *
 * The fix is NOT to derive the expectations from rungs.json — that would put one source on
 * both sides of the assertion and produce a test that cannot fail, which is the exact trade
 * the grid tripwire below refuses. The literals stay literal; each is filtered by `has()` and
 * floored on langchain, the lowest rung, which every fork retains by definition. On a full
 * ladder every assertion is exactly as strong as before.
 */

/** Whether this build serves the named conversation rung. */
const has = (id: string) => FRAMEWORKS.some((f) => f.id === id);

/** The ladder as a literal, filtered to what survived eject. */
const LADDER = ["langchain", "langgraph", "deepagents"] as const;
const presentLadder = LADDER.filter(has);

describe("FRAMEWORKS — derived from the manifest", () => {
  it("contains exactly the conversation-shaped rungs", () => {
    const expected = RUNGS.filter((r) => r.shape === "conversation").map(
      (r) => r.id
    );
    expect(FRAMEWORKS.map((f) => f.id).sort()).toEqual(expected.sort());
  });

  // SKIPPED, VISIBLY, in a fork below rung 4: there is no run-shaped rung left to exclude, so
  // the loop passes over an empty set and the non-vacuity guard it carries is what fails.
  it.skipIf(RUNGS.every((r) => r.shape !== "run"))(
    "excludes run-shaped rungs — open-swe is not a chat framework",
    () => {
      const runIds = RUNGS.filter((r) => r.shape === "run").map((r) => r.id);
      expect(runIds.length).toBeGreaterThan(0); // the case is not vacuous
      for (const id of runIds) {
        expect(FRAMEWORKS.some((f) => f.id === id)).toBe(false);
      }
    }
  );

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
    // One equality against the literal ladder rather than two indexOf comparisons: `indexOf`
    // returns -1 for a rung this build ejected, and -1 < anything, so the old form went green
    // for the wrong reason before failing on the second line. It is also STRICTLY STRONGER on
    // a full ladder — it pins the exact list, so a fourth conversation rung has to be written
    // down instead of slipping in at the end.
    expect(FRAMEWORKS.map((f) => f.id)).toEqual(presentLadder);
    expect(presentLadder).toContain("langchain"); // every fork retains rung 1
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

/**
 * #360 — THE CONVERGENCE THAT HID THREE UNREACHABLE RUNGS.
 *
 * This block replaces `asPythonBackend`, whose test asserted the defect as the
 * contract:
 *
 *     for (const junk of [undefined, null, "", "flask", 42, {}, []]) {
 *       expect(asPythonBackend(junk)).toBe("fastapi");
 *     }
 *
 * Every unrecognised value, and an ABSENT one, produced the same answer. So a
 * request naming the node plane was served by FastAPI, and nothing downstream
 * could tell "you asked for a runtime I do not have" from "you asked for
 * nothing". Three TypeScript rungs shipped unreachable behind that.
 *
 * The tests below therefore assert the two cases are DISTINGUISHABLE, not
 * merely that each is handled. Two inputs reaching one output is what made the
 * original invisible, so equality between the outcomes is the property under
 * test — not the outcomes themselves.
 */
describe("parseRuntime — refuses, and says which way it refused", () => {
  it.each(RUNTIMES)("accepts %s", (rt) => {
    expect(parseRuntime(rt)).toEqual({ ok: true, runtime: rt });
  });

  it("accepts node — the plane that used to be silently rewritten", () => {
    // Named separately from the loop above: the loop is derived from RUNTIMES,
    // so it would still pass if node were removed from the list. This is the
    // independent statement that the TypeScript plane is reachable at all.
    expect(parseRuntime("node")).toEqual({ ok: true, runtime: "node" });
  });

  it.each([undefined, null, ""])("reports %p as MISSING", (v) => {
    expect(parseRuntime(v)).toEqual({ ok: false, reason: "missing" });
  });

  it.each(["flask", 42, {}, []])("reports %p as UNKNOWN, carrying it", (v) => {
    const p = parseRuntime(v);
    expect(p.ok).toBe(false);
    expect(p.ok === false && p.reason).toBe("unknown");
    // The value is carried, because a caller that cannot name what it received
    // cannot report it, and an error that cannot name its subject is the shape
    // this repo keeps removing.
    expect(p.ok === false && p.reason === "unknown" && p.received).toBe(
      String(v)
    );
  });

  it("MISSING AND UNKNOWN DO NOT CONVERGE — this is the whole point", () => {
    const missing = parseRuntime(undefined);
    const unknown = parseRuntime("flask");
    expect(missing).not.toEqual(unknown);
    expect(describeRuntimeParse(missing)).not.toBe(
      describeRuntimeParse(unknown)
    );
    // And both are non-null, so the inequality above is not satisfied by one
    // of them simply having no description.
    expect(describeRuntimeParse(missing)).toBeTruthy();
    expect(describeRuntimeParse(unknown)).toBeTruthy();
  });

  it("names the offending value, so the message is actionable", () => {
    expect(describeRuntimeParse(parseRuntime("flask"))).toContain("flask");
  });

  it("clips a hostile value rather than pasting a page into the UI", () => {
    const long = "x".repeat(500);
    const p = parseRuntime(long);
    expect(p.ok).toBe(false);
    expect(
      p.ok === false && p.reason === "unknown" && p.received.length
    ).toBeLessThan(80);
  });

  it("describes a resolved runtime as nothing to report", () => {
    // The presence companion: "unresolved is described" is satisfied by a
    // function that describes everything, which would put an error on screen
    // for a perfectly good request.
    expect(describeRuntimeParse(parseRuntime("node"))).toBeNull();
  });

  it("never throws — callers read it from a request body", () => {
    for (const junk of [undefined, null, "", "flask", 42, {}, [], NaN]) {
      expect(() => parseRuntime(junk)).not.toThrow();
    }
  });
});

describe("runtimeOrDefault — the fallback, asked for explicitly", () => {
  it("returns the parsed runtime when there is one", () => {
    expect(runtimeOrDefault("node")).toBe("node");
  });

  it("falls back only where a caller opted in", () => {
    // The old code fused "what did you ask for" with "what shall we do about
    // it", which is how a typo became a default. Separating them means a
    // fallback is a line a reader can see, in the caller that wanted it.
    expect(runtimeOrDefault("flask")).toBe(DEFAULT_RUNTIME);
    expect(runtimeOrDefault(undefined)).toBe(DEFAULT_RUNTIME);
  });
});

describe("topologiesFor — derived from the manifest, not restated", () => {
  it("returns what the manifest declares, for each rung on each runtime", () => {
    for (const f of FRAMEWORKS) {
      for (const runtime of RUNTIMES) {
        const declared = RUNGS.find((r) => r.id === f.id)?.runtimes?.[runtime]
          ?.topologies;
        if (declared && declared.length > 0) {
          expect([...topologiesFor(f.id, runtime)]).toEqual([...declared]);
        }
      }
    }
  });

  // A claim ABOUT RUNG 3, so it has nothing to say in a fork that ejected it.
  it.skipIf(!has("deepagents"))(
    "serves deep-research on Python and NOT on node — the pair that discriminates",
    () => {
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
      /*
       * PAIRED ON PURPOSE, AND THE PAIR IS THE TEST (#360).
       *
       * This asserted deep-research on EVERY runtime, because django had
       * gained the topology and the grid had gone uniform. That was the honest
       * assertion at the time — and it was ALSO satisfied by a `topologiesFor`
       * that discards its `runtime` argument entirely, which is exactly what
       * this module's docstring says must never happen. Measured on main
       * before #360: hardcoding the lookup to "fastapi" left all 927 tests
       * green.
       *
       * Nobody erred. The discriminating case was correctly retired when the
       * asymmetry closed, and what went with it was the only thing that could
       * tell a two-axis derivation from a one-axis one. The node plane
       * restores the asymmetry, so the halves are stated TOGETHER — a future
       * editor cannot delete one and be left with a green.
       */
      expect(
        topologiesFor("deepagents", "fastapi"),
        "Python serves deep-research — if this stops being true the pair below " +
          "no longer discriminates and this case is measuring nothing"
      ).toContain("deep-research");
      expect(
        topologiesFor("deepagents", "node"),
        "the node plane does not serve deep-research (#354). If #354 closes, " +
          "THIS FIXTURE'S PREMISE EXPIRES: find another non-uniform cell " +
          "before removing the asymmetry, or the runtime argument goes " +
          "unenforced again."
      ).not.toContain("deep-research");
    }
  );

  it("topologiesFor USES its runtime argument — against a SYNTHETIC grid", async () => {
    /*
     * THE DISCRIMINATOR, RE-FOUNDED SO IT CANNOT EXPIRE AGAIN (#354).
     *
     * The case above asserts the same property against PRODUCTION data:
     * deep-research on fastapi and not on node. That is a true statement today
     * and it is the second time this property has been asserted against a real
     * asymmetry — the first was "django does NOT serve deep-research", which
     * was correct, load-bearing, and expired when django gained the topology.
     * Nothing failed; the only thing distinguishing a two-axis derivation from
     * a one-axis one simply stopped existing, and hardcoding the lookup to
     * "fastapi" left all 927 tests green.
     *
     * IT IS ABOUT TO EXPIRE A SECOND TIME. `deepagents x node` is now the ONLY
     * non-uniform cell in the entire grid — measured across all three runtimes
     * and all three conversation rungs — so closing #354 makes the grid fully
     * uniform and takes the discriminator with it. There is no third cell to
     * move to.
     *
     * So this one does not use production data at all. It injects a grid that
     * IS non-uniform, which no change to this repo can make uniform. The
     * property under test is the derivation, not the manifest, and the
     * derivation is what `topologiesFor`'s docstring promises.
     *
     * Keep BOTH. This one cannot expire; the one above is what a person reads
     * to learn that the real grid has an asymmetry at all, and it fails loudly
     * with instructions when that stops being true.
     */
    vi.resetModules();
    vi.doMock("@deepagents-nextjs/rungs", () => ({
      RUNGS: [{ id: "probe", kind: "conversation" }],
      RUNG_BY_ID: {
        probe: {
          id: "probe",
          kind: "conversation",
          runtimes: {
            alpha: { topologies: ["react", "only-on-alpha"] },
            beta: { topologies: ["react"] },
          },
        },
      },
    }));
    const mod = await import("./frameworks.js");
    try {
      expect(
        mod.topologiesFor("probe", "alpha" as never),
        "the synthetic grid declares only-on-alpha for alpha; if this is absent " +
          "the lookup is not reading the manifest at all"
      ).toContain("only-on-alpha");
      expect(
        mod.topologiesFor("probe", "beta" as never),
        "beta does not declare only-on-alpha. If this CONTAINS it, topologiesFor " +
          "is ignoring its runtime argument — the exact defect that hid behind a " +
          "uniform grid and left 927 tests green"
      ).not.toContain("only-on-alpha");
    } finally {
      vi.doUnmock("@deepagents-nextjs/rungs");
      vi.resetModules();
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
    const grid: Record<string, Record<Runtime, readonly Topology[]>> = {
      langchain: {
        django: ["react", "plan-execute"],
        fastapi: ["react", "plan-execute"],
        node: ["react", "plan-execute"],
      },
      langgraph: {
        django: ["react", "plan-execute"],
        fastapi: ["react", "plan-execute"],
        node: ["react", "plan-execute"],
      },
      deepagents: {
        django: ["react", "plan-execute", "deep-research"],
        fastapi: ["react", "plan-execute", "deep-research"],
        // THE CELL THAT MAKES THIS GRID A GRID (#360). Node serves two where
        // Python serves three: deep-research needs a JS web-search tool and
        // `ddgs` has no direct equivalent (#354). Until this column existed
        // every row was uniform across runtimes, and a `topologiesFor` that
        // IGNORED its runtime argument passed all 927 tests — measured, not
        // supposed. This is the only cell that can tell the two-axis
        // derivation from a one-axis one.
        node: ["react", "plan-execute"],
      },
    };

    // FILTERED BY PRESENCE, floored on langchain. The literal above is the full ladder's grid
    // and stays that way; a fork that ejected rung 2 or 3 simply has no cell to compare.
    expect(Object.keys(grid).filter(has)).toContain("langchain");
    for (const [rung, byRuntime] of Object.entries(grid).filter(([r]) =>
      has(r)
    )) {
      for (const runtime of RUNTIMES) {
        expect(
          topologiesFor(rung, runtime),
          `${rung} x ${runtime} changed. If that was deliberate, update this ` +
            `literal in the same change and say why in the commit — the UI ` +
            `derives its Mode buttons from this grid.`
        ).toEqual(byRuntime[runtime]);
      }
    }
  });

  it("gives langchain and langgraph the same two on EVERY runtime", () => {
    const pair = ["langchain", "langgraph"].filter(has);
    expect(pair).toContain("langchain"); // every fork retains rung 1
    for (const rung of pair) {
      for (const runtime of RUNTIMES) {
        expect(topologiesFor(rung, runtime)).toEqual(["react", "plan-execute"]);
      }
    }
  });

  // deep-research is declared ONLY by rung 3, so a fork below it genuinely has none.
  it.skipIf(!has("deepagents"))(
    "at least one rung declares deep-research — the case is not vacuous",
    () => {
      expect(
        FRAMEWORKS.some((f) =>
          topologiesFor(f.id, "fastapi").includes("deep-research")
        )
      ).toBe(true);
    }
  );

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
    for (const runtime of RUNTIMES) {
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
      expect(
        backendHealthBase("fastapi", { FASTAPI_URL: `http://h:8001${suffix}` })
      ).toBe("http://h:8001");
    }
  });

  it("leaves a bare base URL alone", () => {
    expect(backendHealthBase("django", { DJANGO_URL: "http://h:8002" })).toBe(
      "http://h:8002"
    );
  });

  it("falls back to BACKEND_URL then to localhost, per runtime", () => {
    // Preserves what the config route did before this helper existed, so the
    // change is about WHICH runtime is read, not about changing the defaults.
    expect(
      backendHealthBase("fastapi", { BACKEND_URL: "http://legacy:9000" })
    ).toBe("http://legacy:9000");
    expect(backendHealthBase("fastapi", {})).toBe("http://localhost:8001");
    expect(backendHealthBase("django", {})).toBe("http://localhost:8002");
  });

  it("prefers the runtime's own var over BACKEND_URL", () => {
    // BACKEND_URL is a legacy single-runtime setting. If a deployment sets both,
    // the specific one is the one that means what it says.
    const env = {
      DJANGO_URL: "http://django.test",
      BACKEND_URL: "http://legacy:9000",
    };
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

/**
 * #360 — THE PER-RUNTIME VALUES, WHICH THE RECORDS DO NOT CHECK.
 *
 * `envVarFor` and the trailing-slash rule became `Record<Runtime, string>` so a
 * FOURTH runtime is a compile error rather than a silent inheritance. That is
 * the right shape and it proves nothing about the THIRD runtime's values: a
 * Record is exhaustive over its keys, not correct in them.
 *
 * Measured, not supposed. With the Records in place and no tests here, two
 * mutations passed all 948 tests:
 *
 *   node: "NODE_URL"  ->  "FASTAPI_URL"     node reads the wrong process's URL
 *   node: ""          ->  "/"               node gets django's trailing slash
 *
 * Both are the exact defect the comment above those Records argues against, so
 * this block exists because the argument was written and not checked.
 */
describe("per-runtime values — distinct, not inherited", () => {
  it("every runtime maps to its OWN url env var", () => {
    expect(envVarFor("django")).toBe("DJANGO_URL");
    expect(envVarFor("fastapi")).toBe("FASTAPI_URL");
    expect(envVarFor("node")).toBe("NODE_URL");
  });

  it("every runtime maps to its OWN auth env var", () => {
    expect(authEnvVarFor("django")).toBe("DJANGO_AUTH_TOKEN");
    expect(authEnvVarFor("fastapi")).toBe("FASTAPI_AUTH_TOKEN");
    expect(authEnvVarFor("node")).toBe("NODE_AUTH_TOKEN");
  });

  it("NO TWO RUNTIMES SHARE AN ENV VAR — the property the literals above cannot state", () => {
    // The three cases above are satisfied by three correct constants and also
    // by a table where two entries were copy-pasted and one literal updated.
    // Distinctness is the claim: a shared var means picking one runtime reads
    // another process's URL, which is the silent cross-wiring #360 removed.
    for (const table of [
      RUNTIMES.map(envVarFor),
      RUNTIMES.map(authEnvVarFor),
    ]) {
      expect(new Set(table).size).toBe(RUNTIMES.length);
    }
  });

  it("django gets the trailing slash its URLconf requires; the others do not", () => {
    // Asserted through buildBackendUrl rather than the private table, so this
    // fails if the table is right and the caller stops consulting it.
    expect(buildBackendUrl("django", "http://x", "langchain")).toBe(
      "http://x/langchain/"
    );
    expect(buildBackendUrl("fastapi", "http://x", "langchain")).toBe(
      "http://x/langchain"
    );
    expect(buildBackendUrl("node", "http://x", "langchain")).toBe(
      "http://x/langchain"
    );
  });

  it("the slash rule is not uniform — so the case above is measuring something", () => {
    // The companion. "Each runtime builds its URL" is satisfied by a rule that
    // gives every runtime the same answer, and that is precisely the
    // else-as-default this replaced.
    const built = RUNTIMES.map((r) => buildBackendUrl(r, "http://x", "lc"));
    expect(new Set(built).size).toBeGreaterThan(1);
  });

  it("every runtime has its own local default port", () => {
    // Three planes must be able to run at once, or the selector cannot be
    // exercised at all — which is how three rungs shipped unreachable.
    const bases = RUNTIMES.map((r) => backendHealthBase(r, {}));
    expect(new Set(bases).size).toBe(RUNTIMES.length);
    expect(backendHealthBase("node", {})).toContain("8003");
  });

  it("resolveBackendBase reads the runtime it was asked about", () => {
    const env = {
      DJANGO_URL: "http://dj",
      FASTAPI_URL: "http://fa",
      NODE_URL: "http://no",
      NODE_AUTH_TOKEN: "tok",
    };
    expect(resolveBackendBase("node", env).url).toBe("http://no");
    expect(resolveBackendBase("node", env).token).toBe("tok");
    // The cross-check: asking about node must not return fastapi's URL, which
    // is what the mutation above produced and nothing caught.
    expect(resolveBackendBase("node", env).url).not.toBe(env.FASTAPI_URL);
  });
});

/**
 * #360 — THE WINDOW IS CLOSED, AND THIS BLOCK IS WHY IT NEEDED MOVING.
 *
 * What stood here asserted the transition window — that `pythonBackend` was
 * still accepted — through a LOCAL RESTATEMENT of the routes' rule:
 *
 *   const resolve = (body) =>
 *     parseRuntime(body.runtime ?? body.pythonBackend ?? body.backend);
 *
 * Its own comment promised "when the deletion commit lands, this block is what
 * should fail". IT DID NOT. Closing the window in both routes left all 65 cases
 * here green, because the thing under test was a copy of the rule rather than
 * the rule's only caller. A test that duplicates the behaviour it guards cannot
 * witness that behaviour changing — the same shape as #372, where every request
 * the resume route ever received came from a mock.
 *
 * The window assertions now live in app/api/chat/stream/route.test.ts, which
 * drives the real POST. What stays HERE is only what parseRuntime itself owns:
 * that it reads one value and reports how it failed. The routes decide which
 * KEY to hand it, and that decision is theirs to be tested on.
 */
describe("parseRuntime is given one value — the key is the caller's decision", () => {
  it("does not read a body: it takes the value the route extracted", () => {
    // Guards against this block drifting back into restating the route's rule.
    // `parseRuntime` sees a string, never an object with candidate keys, so a
    // future edit that teaches it about `pythonBackend` fails here.
    expect(parseRuntime({ runtime: "node" } as unknown)).toEqual({
      ok: false,
      reason: "unknown",
      received: "[object Object]",
    });
  });

  it("still refuses junk — the closed window is not amnesty for old values", () => {
    // The window accepted an old NAME, never an old BEHAVIOUR. Now that the
    // name is gone, this is what remains of that distinction.
    const p = parseRuntime("flask");
    expect(p.ok).toBe(false);
    expect(p.ok === false && p.reason).toBe("unknown");
  });
});
