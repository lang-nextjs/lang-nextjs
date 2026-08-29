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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * WHICH RUNGS THIS TREE HAS — read from the BARREL SOURCE, not from the module
 * the route derives its own answer from.
 *
 * This file is SHARED scaffold and the set of rungs is rung-dependent, so a
 * hardcoded pair is correct in the full tree and wrong in every ejected one.
 * `pnpm eject langchain` proved it: langgraph is deleted, /health correctly
 * reports ["langchain"], and a literal ["langchain","langgraph"] fails for
 * being right about a tree that no longer exists.
 *
 * BUT DERIVING FROM `AI_BACKENDS` WOULD BE WORSE THAN THE LITERAL. The route
 * builds its answer from that object; comparing the two would compare the
 * implementation to itself and could not fail — a literal that breaks under
 * eject at least breaks honestly, while a tautology never breaks at all.
 *
 * So this reads the barrel's SOURCE TEXT. The route reaches the same file by
 * evaluating it as a module and filtering for `TOPOLOGIES`; this reaches it by
 * parsing `export * as <id> from`. Different paths to the same fact, which is
 * what makes the comparison worth making — a module that failed to load, lost
 * its TOPOLOGIES, or came back in the wrong order fails here.
 *
 * And it needs no edit when a rung lands or leaves: eject prunes the barrel
 * line, and this expectation follows.
 */
function backendsInThisTree(): string[] {
  const barrel = readFileSync(
    fileURLToPath(new URL("./ai_backends/index.ts", import.meta.url)),
    "utf8"
  );
  const ids = [
    ...barrel.matchAll(/^\s*export\s+\*\s+as\s+(\w+)\s+from\s/gm),
  ].map((m) => m[1]);
  // Anti-vacuity: a barrel this regex could not read would make every
  // assertion below pass over an empty list.
  expect(
    ids.length,
    "no backends parsed out of ai_backends/index.ts"
  ).toBeGreaterThan(0);
  return ids.sort();
}

/**
 * Topologies per backend, as LITERALS — and these are NOT rung-dependent.
 *
 * Which rungs exist varies with ejection; what a given rung serves does not.
 * So the pair stays pinned and keeps doing the job it did when rung 2 landed:
 * a rung that appears with no entry here fails, forcing the decision onto the
 * commit that adds it rather than letting a topology drift in unannounced.
 *
 * Checked in the PRESENT -> LITERAL direction only. The other direction would
 * fail after an eject, for the entry of a rung that is legitimately gone.
 */
const TOPOLOGIES_BY_BACKEND: Record<string, string[]> = {
  langchain: ["react"],
  langgraph: ["react", "plan-execute"],
  /*
   * TWO, NOT THREE. The Python deepagents backend serves react, plan-execute
   * AND deep-research; this runtime serves the first two. deep-research needs a
   * JS web-search tool and `ddgs` has no direct equivalent — a TOOL decision,
   * not a DeepAgents one (#10, filed as #354).
   *
   * Advertising it would be worse than omitting it: the router would accept the
   * request and the stream would fail somewhere less legible than a 404 that
   * names what this runtime has.
   */
  deepagents: ["react", "plan-execute"],
};

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
    // Derived from the barrel source — see backendsInThisTree().
    const present = backendsInThisTree();
    expect(body.ai_backends).toEqual(present);

    // A FLOOR THAT HOLDS AT EVERY RUNG. langchain is rung 1 and survives every
    // ejection, so this is true of the full tree and of every fork — and it is
    // the assertion an empty answer cannot satisfy.
    expect(body.ai_backends).toContain("langchain");

    // THE HONEST GAP, STILL ASSERTED — and it has already done its job twice.
    // When rung 2 landed (#9) the old literal `{langchain: ["react"]}` went
    // red, forcing the decision onto that commit. Then `pnpm eject langchain`
    // went red because the literal named a rung the ejected tree does not have
    // — which is the same lesson turned on the test: A SHARED TEST CANNOT
    // ASSERT A RUNG-DEPENDENT VALUE.
    //
    // What survives is per-backend and rung-independent: which rungs exist
    // varies with ejection, what each one SERVES does not.
    for (const id of present) {
      expect(
        TOPOLOGIES_BY_BACKEND[id],
        `${id} is served by this runtime but has no expected topology list — ` +
          `add one, so a new rung's topologies are decided on the commit that ` +
          `adds it rather than drifting in unannounced`
      ).toBeTruthy();
      expect(body.topologies[id]).toEqual(TOPOLOGIES_BY_BACKEND[id]);
      // Nothing may be advertised with an empty topology list: a backend that
      // serves nothing is not a backend, and this is what stops the loop above
      // from being satisfied by a runtime that lists ids and dispatches none.
      expect(body.topologies[id].length).toBeGreaterThan(0);
    }
    // Every advertised key is one this tree actually has — no extras.
    expect(Object.keys(body.topologies).sort()).toEqual(present);

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
    /*
     * `nope`, NOT `deepagents`. This case used a real-but-not-yet-implemented
     * rung as its stand-in for "absent", and that premise expired the moment
     * rung 3 landed (#10) — the request started succeeding and the test failed
     * for the right reason.
     *
     * It would have expired silently had the rung merely been RENAMED, so the
     * fix is not "pick the next unimplemented rung": it is a name that can
     * never become a rung, which keeps the case about the 404 rather than
     * about which rungs exist this week.
     */
    const res = await post("/api/chat/stream/nope", { messages: [] });
    expect(res.status).toBe(404);
    const body = await readJson(res);
    // FastAPI's envelope key, deliberately — see the note in server.ts.
    expect(body.detail).toContain("unknown ai_backend 'nope'");
    // Names what this tree HAS. langchain is rung 1 and survives every eject,
    // so it is the one backend this can assert in any fork.
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

  it("the legacy route targets deepagents, and resolves wherever that rung is retained", async () => {
    /*
     * THIS CASE'S PREMISE RETIRED WHEN RUNG 3 LANDED (#10).
     *
     * It asserted a 404, and correctly: `/api/chat/stream` defaults to
     * deepagents in both Python runtimes, this runtime did not serve that rung,
     * and repointing the default at whichever backend it DID have would make
     * the same URL mean different things on different runtimes — the one
     * property the shared contract exists to prevent. So it 404'd truthfully.
     *
     * The rung exists now, so the same URL means the same thing on all three
     * runtimes, which is what the default was always for. Asserting the 404
     * would now be asserting that this runtime is incomplete.
     *
     * BRANCHED RATHER THAN PINNED, because this file is SHARED and survives
     * every eject while rung 3 does not: `pnpm eject langchain` deletes it and
     * the legacy default becomes unserveable again — truthfully, and the 404 is
     * then the correct assertion once more. Both arms are real states of a real
     * tree, which is why neither is the whole test.
     */
    const res = await post("/api/chat/stream", { messages: [] });
    if (backendsInThisTree().includes("deepagents")) {
      // Routing only: the stream's contents need a model key this test has not
      // got, and a case about routing must not fail on the provider chain.
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
    } else {
      expect(res.status).toBe(404);
      expect((await readJson(res)).detail).toContain(
        "unknown ai_backend 'deepagents'"
      );
    }
  });

  it("refuses a body over 1MB before buffering it", async () => {
    const res = await fetch(`${base}/api/chat/stream/langchain`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "x".repeat(1_100_000) }],
      }),
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
      const res = await fetch(`${base}/health`, {
        headers: { Origin: origin },
      });
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
