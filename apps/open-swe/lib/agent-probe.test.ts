import { describe, expect, it } from "vitest";
import { AGENT_PROBE_PATHS, probeAgentPaths } from "./agent-probe";

/**
 * Reported from a running settings panel:
 *
 *   Agent backend — http://localhost:8100 answered 404 — not responding — 18ms
 *
 * Something answered, in 18 milliseconds, and was reported as not responding.
 * The probe asked for `/ok`, the LangGraph Platform convention; the local queue
 * agent serves `/health`.
 */

/** A stubbed transport, so these cases never touch the network. */
const serve =
  (byPath: Record<string, number | { error: string }>) =>
  async (url: string) => {
    const path = new URL(url).pathname;
    const r = byPath[path];
    if (r === undefined) return { status: 404, ms: 1 };
    if (typeof r === "object") return { error: r.error, ms: 1 };
    return { status: r, ms: 1 };
  };

describe("probeAgentPaths", () => {
  it("THE REPORTED CASE: a backend serving only /health is reachable and healthy", async () => {
    const out = await probeAgentPaths(
      "http://localhost:8100",
      serve({ "/health": 200 })
    );
    expect(out.reachable).toBe(true);
    expect(out.healthy).toBe(true);
    expect(out.decisive.path).toBe("/health");
  });

  it("a hosted platform serving /ok is decided on the FIRST path", async () => {
    // The ordering matters: a real platform must not be judged by a fallback.
    const out = await probeAgentPaths("https://api.example", serve({ "/ok": 200 }));
    expect(out.decisive.path).toBe("/ok");
    expect(out.attempts).toHaveLength(1);
  });

  it("a 404 advances to the next path; any OTHER status does not", async () => {
    // The rule that makes this safe. A 500 is a health signal and must be
    // reported, not walked past in the hope that another path says 200 —
    // which would turn an unwell backend into a healthy-looking one.
    const out = await probeAgentPaths(
      "http://h",
      serve({ "/ok": 500, "/health": 200 })
    );
    expect(out.decisive.path).toBe("/ok");
    expect(out.decisive.status).toBe(500);
    expect(out.healthy).toBe(false);
  });

  it("REACHABLE AND HEALTHY ARE SEPARATE ANSWERS", async () => {
    // Conflating them produced the original bug. A 500 means something is
    // there and unwell — the report owes the reader both facts.
    const out = await probeAgentPaths("http://h", serve({ "/ok": 500 }));
    expect(out.reachable).toBe(true);
    expect(out.healthy).toBe(false);
  });

  it("a connection failure is NOT reachable, and does not try further paths", async () => {
    // The next request goes to the same host and fails the same way; trying
    // again only doubles the time before the person is told.
    const out = await probeAgentPaths(
      "http://h",
      serve({ "/ok": { error: "ECONNREFUSED" } })
    );
    expect(out.reachable).toBe(false);
    expect(out.healthy).toBe(false);
    expect(out.attempts).toHaveLength(1);
  });

  it("all paths 404: reachable, not healthy, and it says what it tried", async () => {
    // Something is listening and none of the paths we know are its. Claiming
    // "unreachable" would send someone to check whether the process is running.
    const out = await probeAgentPaths("http://h", serve({}));
    expect(out.reachable).toBe(true);
    expect(out.healthy).toBe(false);
    expect(out.attempts.map((a) => a.path)).toEqual([...AGENT_PROBE_PATHS]);
  });

  it("a trailing slash on the base URL does not produce a double slash", async () => {
    let asked = "";
    await probeAgentPaths("http://h/", async (url) => {
      asked = url;
      return { status: 200, ms: 1 };
    });
    expect(asked).toBe("http://h/ok");
  });

  it("every attempt is recorded, not just the decisive one", async () => {
    // The report can then say "tried /ok (404), /health (200)" instead of
    // naming one path and leaving the reader to guess at the rest.
    const out = await probeAgentPaths("http://h", serve({ "/health": 200 }));
    expect(out.attempts.map((a) => a.path)).toEqual(["/ok", "/health"]);
    expect(out.attempts[0].status).toBe(404);
  });
});
