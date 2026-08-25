import { describe, it, expect } from "vitest";
import {
  PYTHON_BACKENDS,
  asPythonBackend,
  topologiesFor,
  envVarFor,
  authEnvVarFor,
  resolveBackendBase,
  buildBackendUrl,
} from "./frameworks";

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
  it("gives deepagents x fastapi all three, including deep-research", () => {
    expect(topologiesFor("deepagents", "fastapi")).toEqual([
      "react",
      "plan-execute",
      "deep-research",
    ]);
  });

  it("does NOT offer deep-research on deepagents x django", () => {
    // The whole reason the Mode list must follow the runtime: django's
    // TOPOLOGIES dict has no deep-research entry, so offering it produces a
    // backend error for a control the UI presented as available.
    expect(topologiesFor("deepagents", "django")).not.toContain(
      "deep-research"
    );
    expect(topologiesFor("deepagents", "django")).toEqual([
      "react",
      "plan-execute",
    ]);
  });

  it("deep-research appears in EXACTLY ONE (rung, runtime) cell", () => {
    // Guards the asymmetry itself. If a future change gives django
    // deep-research, this fails and whoever made the change decides whether
    // the UI story still holds — rather than the asymmetry vanishing silently.
    const cells: string[] = [];
    for (const rung of ["langchain", "langgraph", "deepagents"]) {
      for (const runtime of PYTHON_BACKENDS) {
        if (topologiesFor(rung, runtime).includes("deep-research")) {
          cells.push(`${rung}x${runtime}`);
        }
      }
    }
    expect(cells).toEqual(["deepagentsxfastapi"]);
  });

  it("gives langchain and langgraph the same two on both runtimes", () => {
    for (const rung of ["langchain", "langgraph"]) {
      for (const runtime of PYTHON_BACKENDS) {
        expect(topologiesFor(rung, runtime)).toEqual(["react", "plan-execute"]);
      }
    }
  });

  it("never returns an empty axis, even for an unknown rung", () => {
    // An empty list renders zero Mode buttons and strands the surface.
    expect(topologiesFor("no-such-rung", "fastapi")).toEqual(["react"]);
    expect(topologiesFor("open-swe", "fastapi")).toEqual(["react"]);
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
