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
    expect(
      browserReachable("https://cloud.langfuse.com/api/public/ingestion")
    ).toBe("https://cloud.langfuse.com");
  });
});

describe("consoleFor", () => {
  it("LangSmith is hosted, so its console does not depend on the deployment", () => {
    expect(consoleFor("langsmith", null).consoleUrl).toBe(
      "https://smith.langchain.com"
    );
  });

  it("Langfuse uses a reachable reported host", () => {
    expect(
      consoleFor("langfuse", "https://cloud.langfuse.com").consoleUrl
    ).toBe("https://cloud.langfuse.com");
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

/**
 * THE HOST WAS REPORTED AND THEN LOST.
 *
 * Reported from a running app: the panel says "tracing — Langfuse accepted our
 * credentials" and then "no host was reported, so there is no console address
 * to offer". Both sentences were produced by the same request, and the second
 * was false:
 *
 *   backend /health  ->  host: "http://langfuse:3000"
 *   /api/config      ->  (dropped — the field was not in its mapping)
 *   consoleFor       ->  host === undefined
 *   the panel        ->  "no host was reported"
 *
 * THE REFUSAL WAS RIGHT AND THE REASON WAS WRONG, which is the half a person
 * acts on. `http://langfuse:3000` is a container alias and no browser can open
 * it, so declining to link it is correct. But knowing the backend traces THERE
 * is what tells someone to set LANGFUSE_CONSOLE_URL; "no host was reported"
 * sends them looking for a configuration problem that does not exist.
 *
 * These pin the distinction between the two absences, because the code has two
 * branches for them and only one was reachable.
 */
describe("the two ways there can be no console link", () => {
  it("A REPORTED-BUT-UNREACHABLE HOST NAMES ITSELF", () => {
    const r = consoleFor("langfuse", "http://langfuse:3000");
    expect(r.consoleUrl).toBeUndefined();
    // The host itself, so a person can see WHAT the backend is tracing to.
    expect(r.consoleUnavailableBecause).toContain("http://langfuse:3000");
    // And the action that fixes it.
    expect(r.consoleUnavailableBecause).toContain("LANGFUSE_CONSOLE_URL");
  });

  it("A GENUINELY ABSENT HOST SAYS THAT INSTEAD", () => {
    // The other branch. These two messages must not be interchangeable —
    // conflating them is exactly what made the panel mislead.
    const r = consoleFor("langfuse", undefined);
    expect(r.consoleUnavailableBecause).toContain("no host was reported");
    expect(r.consoleUnavailableBecause).not.toContain("LANGFUSE_CONSOLE_URL");
  });

  it("the two reasons are DIFFERENT strings", () => {
    // Stated as a property so a later tidy-up cannot merge them.
    const unreachable = consoleFor("langfuse", "http://langfuse:3000");
    const absent = consoleFor("langfuse", undefined);
    expect(unreachable.consoleUnavailableBecause).not.toBe(
      absent.consoleUnavailableBecause
    );
  });
});

describe("configuring it properly", () => {
  const saved = process.env.LANGFUSE_CONSOLE_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.LANGFUSE_CONSOLE_URL;
    else process.env.LANGFUSE_CONSOLE_URL = saved;
  });

  it("an explicit console URL is offered, and beats the unreachable host", () => {
    // The fix the message asks for. The backend keeps tracing to the container
    // alias — that is correct and unchanged — while the person gets the
    // published address.
    process.env.LANGFUSE_CONSOLE_URL = "http://localhost:3100";
    const r = consoleFor("langfuse", "http://langfuse:3000");
    expect(r.consoleUrl).toBe("http://localhost:3100");
    expect(r.consoleUnavailableBecause).toBeUndefined();
  });

  it("AN UNREACHABLE OVERRIDE IS STILL REFUSED", () => {
    // The override is a value someone typed. Trusting it blindly would let a
    // typo produce exactly the dead link this module exists to prevent.
    process.env.LANGFUSE_CONSOLE_URL = "http://langfuse:3000";
    expect(
      consoleFor("langfuse", "http://langfuse:3000").consoleUrl
    ).toBeUndefined();
  });

  it("a nonsense override does not throw", () => {
    process.env.LANGFUSE_CONSOLE_URL = "not a url";
    expect(() => consoleFor("langfuse", null)).not.toThrow();
    expect(consoleFor("langfuse", null).consoleUrl).toBeUndefined();
  });
});
