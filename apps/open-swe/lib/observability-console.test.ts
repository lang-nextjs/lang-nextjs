import { afterEach, describe, expect, it } from "vitest";
import { browserReachable, consoleFor } from "./observability-console";

/**
 * The rule this module exists for is a REFUSAL, and refusals are the thing a
 * "does the link appear" test cannot check. The version that links every host
 * passes every such test and ships a button that resolves nowhere.
 */

const ORIGINAL = process.env.LANGFUSE_CONSOLE_URL;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.LANGFUSE_CONSOLE_URL;
  else process.env.LANGFUSE_CONSOLE_URL = ORIGINAL;
});

describe("browserReachable", () => {
  it("accepts a public https host", () => {
    expect(browserReachable("https://cloud.langfuse.com")).toBe(
      "https://cloud.langfuse.com"
    );
  });

  it("accepts localhost and 127.0.0.1 — a local fixture IS reachable", () => {
    // The control that stops the rule from degenerating into "reject anything
    // unfamiliar", which would refuse the one deployment developers actually use.
    expect(browserReachable("http://localhost:3100")).toBe(
      "http://localhost:3100"
    );
    expect(browserReachable("http://127.0.0.1:3100")).toBe(
      "http://127.0.0.1:3100"
    );
  });

  it("REJECTS a single-label container alias", () => {
    // Verbatim from scripts/langfuse-local/backend-override.yml, which is the
    // exact value a developer running the fixture has in their environment.
    expect(browserReachable("http://langfuse:3000")).toBeNull();
  });

  it("rejects a non-http scheme", () => {
    expect(browserReachable("ftp://langfuse.example.com")).toBeNull();
    expect(browserReachable("javascript:alert(1)")).toBeNull();
  });

  it("rejects unparseable input rather than throwing", () => {
    expect(browserReachable("not a url")).toBeNull();
    expect(browserReachable("")).toBeNull();
    expect(browserReachable(null)).toBeNull();
    expect(browserReachable(undefined)).toBeNull();
  });

  it("returns the ORIGIN, dropping any path or query", () => {
    // The console root is what we want to open; carrying a path from a span
    // ingestion URL would land somewhere arbitrary.
    expect(browserReachable("https://cloud.langfuse.com/api/public/ingestion")).toBe(
      "https://cloud.langfuse.com"
    );
  });
});

describe("consoleFor", () => {
  it("LangSmith is hosted, so its console does not depend on the deployment", () => {
    expect(consoleFor("langsmith", null).consoleUrl).toBe(
      "https://smith.langchain.com"
    );
  });

  it("Langfuse uses a reachable reported host", () => {
    expect(consoleFor("langfuse", "https://cloud.langfuse.com").consoleUrl).toBe(
      "https://cloud.langfuse.com"
    );
  });

  it("an in-network host yields NO url, and a reason naming it", () => {
    const r = consoleFor("langfuse", "http://langfuse:3000");
    expect(r.consoleUrl).toBeUndefined();
    expect(r.consoleUnavailableBecause).toContain("langfuse:3000");
    expect(r.consoleUnavailableBecause).toContain("LANGFUSE_CONSOLE_URL");
  });

  it("LANGFUSE_CONSOLE_URL OVERRIDES an in-network host", () => {
    // The escape hatch. Without it a self-hosted deployment behind a public
    // address could never offer a link, because the only host this process can
    // see is the private one the backend posts to.
    process.env.LANGFUSE_CONSOLE_URL = "https://langfuse.internal.example.com";
    const r = consoleFor("langfuse", "http://langfuse:3000");
    expect(r.consoleUrl).toBe("https://langfuse.internal.example.com");
    expect(r.consoleUnavailableBecause).toBeUndefined();
  });

  it("an UNREACHABLE override does not win — it falls through, it does not break", () => {
    // A misconfigured override must not produce a dead link either. The rule is
    // about the address, not about who supplied it.
    process.env.LANGFUSE_CONSOLE_URL = "http://also-in-network:3000";
    const r = consoleFor("langfuse", "https://cloud.langfuse.com");
    expect(r.consoleUrl).toBe("https://cloud.langfuse.com");
  });

  it("no host and no override yields a reason, not silence", () => {
    const r = consoleFor("langfuse", null);
    expect(r.consoleUrl).toBeUndefined();
    expect(r.consoleUnavailableBecause).toBeTruthy();
  });

  it("an integration it does not know gets neither a url nor a reason", () => {
    // A sandbox row must not sprout an "Open" button. Silence is correct here:
    // there is no console we know of, and no advice to give about it.
    expect(consoleFor("sandbox", "https://example.com")).toEqual({});
  });
});
