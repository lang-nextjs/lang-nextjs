/**
 * THE ROUTE CONTRACT — main.py's dispatch is the specification.
 *
 * The reference app's runtime selector only works if fastapi, django and node
 * are interchangeable behind one contract, so these assertions are written as
 * LITERALS taken from apps/fastapi-backend/main.py rather than derived from
 * this server. Deriving them from the code under test would produce a suite
 * that passes for any contract at all, which is the defect class this repo
 * tracks — and the specific way a third runtime would silently drift from the
 * two it is meant to be swappable with.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

let server: Server;
let base: string;

beforeEach(async () => {
  vi.resetModules();
  vi.doMock("./common/llm.js", () => ({
    makeLlm: () => {
      throw new Error("no model should be built for a route-contract test");
    },
    llmStatus: () => ({ configured: true, provider: "nvidia" }),
  }));
  const { createApp } = await import("./server.js");
  server = createApp();
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  vi.doUnmock("./common/llm.js");
});

/**
 * `Response.json()` is typed `unknown`, correctly — it is parsed from the wire.
 * Narrowing it once here keeps every assertion below reading as an assertion
 * rather than as a cast.
 */
async function readJson(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>;
}

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("GET /health", () => {
  it("reports the same keys FastAPI does, plus which runtime answered", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = await readJson(res);

    // The five keys main.py returns. Asserted as a SET, so a renamed or
    // dropped key fails rather than being tolerated by a subset check.
    expect(Object.keys(body).sort()).toEqual([
      "ai_backends",
      "llm",
      "observability",
      "runtime",
      "status",
      "topologies",
    ]);
    expect(body.status).toBe("ok");
    expect(body.runtime).toBe("node");
    expect(body.ai_backends).toEqual(["langchain"]);

    // THE SCAFFOLD'S HONEST GAP, ASSERTED. The Python planes serve
    // ["react", "plan-execute"] for this rung; this one serves react only
    // (#8 is the parity work). A runtime that ADVERTISED a topology it cannot
    // serve is the worse failure, and this is the field that prevents it — so
    // the literal here must change on the same commit the topology lands.
    expect(body.topologies).toEqual({ langchain: ["react"] });

    // Presence only, never the key.
    expect(body.llm).toEqual({ configured: true, provider: "nvidia" });
    expect(Object.keys(body.observability).sort()).toEqual([
      "langfuse",
      "langsmith",
    ]);
    // Reported as unsupported rather than merely unconfigured: this runtime
    // attaches no handler, so no key can make a span arrive.
    expect(body.observability.langfuse.supported).toBe(false);
  });
});

describe("POST /api/chat/stream/{ai_backend}", () => {
  it("an unknown ai_backend is a 404 naming what exists", async () => {
    const res = await post("/api/chat/stream/deepagents", { messages: [] });
    expect(res.status).toBe(404);
    const body = await readJson(res);
    // FastAPI's envelope key, deliberately — see the note in server.ts.
    expect(body.detail).toContain("unknown ai_backend 'deepagents'");
    expect(body.detail).toContain("langchain");
  });

  it("an unknown topology is a 404 naming the topologies that exist", async () => {
    const res = await post("/api/chat/stream/langchain", {
      messages: [{ role: "user", content: "hi" }],
      topology: "plan-execute",
    });
    expect(res.status).toBe(404);
    const body = await readJson(res);
    expect(body.detail).toContain("unknown topology 'plan-execute'");
    expect(body.detail).toContain("react");
  });

  it("the legacy route targets deepagents, and says so when it is absent", async () => {
    // main.py's `/api/chat/stream` defaults to deepagents. Repointing it at the
    // one backend this runtime HAS would make the same URL mean different
    // things on different runtimes — the one property the shared contract
    // exists to prevent. So it 404s, truthfully.
    const res = await post("/api/chat/stream", { messages: [] });
    expect(res.status).toBe(404);
    expect((await readJson(res)).detail).toContain("unknown ai_backend 'deepagents'");
  });

  it("refuses a body over 1MB before buffering it", async () => {
    const res = await fetch(`${base}/api/chat/stream/langchain`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "x".repeat(1_100_000) }] }),
    });
    expect(res.status).toBe(413);
  });
});

describe("GET /api/tools/{ai_backend}", () => {
  it("returns the shared tools in main.py's shape", async () => {
    const res = await fetch(`${base}/api/tools/langchain`);
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(Object.keys(body).sort()).toEqual([
      "ai_backend",
      "mcps",
      "tools",
      "topology",
    ]);
    expect(body.ai_backend).toBe("langchain");
    expect(body.topology).toBe("react");
    expect(body.tools.map((t: { name: string }) => t.name).sort()).toEqual([
      "get_counter",
      "increment",
    ]);
    for (const t of body.tools) {
      expect(t.source).toBe("custom");
      expect(t.description.length).toBeGreaterThan(0);
      // First line only, like main.py's `describe()`.
      expect(t.description).not.toContain("\n");
    }
    expect(body.mcps).toEqual([]);
  });

  it("an unknown ai_backend is a 404", async () => {
    const res = await fetch(`${base}/api/tools/nope`);
    expect(res.status).toBe(404);
    expect((await readJson(res)).detail).toContain("unknown ai_backend 'nope'");
  });
});

/**
 * CORS — the guard the Semgrep exception CLAIMS, asserted so the claim is a
 * checked fact rather than a comment.
 *
 * `.github/workflows/semgrep_triage.py` excepts
 * javascript.express.security.cors-misconfiguration here on the grounds that
 * the origin echo is guarded by a closed allowlist. An exception whose premise
 * nothing tests is an assertion, and this repo's whole subject is checks that
 * cannot fail — so the premise is tested. If someone widens the guard, the
 * exception's reasoning becomes false and THIS goes red, rather than the
 * exception quietly covering something it was never written for.
 */
describe("CORS", () => {
  it("echoes an allowed origin and refuses an unlisted one", async () => {
    const allowed = await fetch(`${base}/health`, {
      headers: { Origin: "http://localhost:3000" },
    });
    expect(allowed.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:3000"
    );

    // THE HALF THAT MAKES THE OTHER HALF MEAN SOMETHING. Without it, a server
    // that echoed every origin would satisfy the assertion above.
    const denied = await fetch(`${base}/health`, {
      headers: { Origin: "http://evil.example" },
    });
    expect(
      denied.headers.get("access-control-allow-origin"),
      "an unlisted origin was echoed — the allowlist guard is gone, and the " +
        "Semgrep exception for this file is no longer true"
    ).toBeNull();
  });

  it("sets Vary: Origin on every response, allowed or not", async () => {
    // A shared cache keying only on the URL would otherwise serve one origin's
    // CORS headers — or their absence — to another.
    for (const origin of ["http://localhost:3000", "http://evil.example"]) {
      const res = await fetch(`${base}/health`, { headers: { Origin: origin } });
      expect(res.headers.get("vary"), `no Vary for ${origin}`).toBe("Origin");
    }
  });

  it("never grants credentials", async () => {
    // Absent, not "false": these endpoints are unauthenticated, so the header
    // has no business being present in either spelling.
    const res = await fetch(`${base}/health`, {
      headers: { Origin: "http://localhost:3000" },
    });
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });
});
