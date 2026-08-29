// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import SettingsPage from "./page";

/**
 * #337 — THE SANDBOX PANEL MUST READ `r.ok`.
 *
 * The panel built `{ ok: r.ok, body: await r.json() }` and then destructured
 * only `body`. `ok` was computed on one line and dropped on the next, so the
 * panel had no way to tell "the sandbox is unavailable" from "there is no such
 * route in this build".
 *
 * WHAT SAVED IT WAS AN ACCIDENT, AND THAT IS WHY THE OBVIOUS TEST IS THE WRONG
 * ONE. Next answers a missing route with an HTML error page, so `r.json()`
 * threw and the `.catch` set a parse-error message — which looks like handling.
 * A route that answered `404 {"error": "..."}` parsed fine, was stored as
 * `health`, and rendered a clean panel that was simply wrong.
 *
 * So "a 404 shows an error" is NOT the test; the old code passes it by
 * accident. The test that separates them is "a 404 WHOSE BODY IS VALID JSON
 * still says the sandbox is absent". Written first and watched failing against
 * the original code before the fix existed.
 */

type Reply = { status: number; body: unknown; asHtml?: boolean };

/** Route the page's two fetches; the sandbox one is what each test varies. */
function mockFetch(sandbox: Reply) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/sandbox/health")) {
      const text = sandbox.asHtml
        ? "<!DOCTYPE html><html><body>404</body></html>"
        : JSON.stringify(sandbox.body);
      return Promise.resolve(
        new Response(text, {
          status: sandbox.status,
          headers: {
            "content-type": sandbox.asHtml ? "text/html" : "application/json",
          },
        })
      );
    }
    if (url.includes("/api/config")) {
      return Promise.resolve(
        new Response(JSON.stringify({ activeLlm: "nvidia" }), { status: 200 })
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  });
}

const panel = () => screen.getByTestId("settings-sandbox");

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("#337 — the sandbox panel distinguishes absent from unavailable", () => {
  it("A 404 WITH A VALID JSON BODY still reports the sandbox as absent", async () => {
    // THE DECISIVE CASE. This is the one the accident does not cover: the body
    // parses, so nothing throws, so the old code stored an error payload as
    // health and rendered it as a provider.
    vi.stubGlobal(
      "fetch",
      mockFetch({ status: 404, body: { error: "no such route" } })
    );
    render(<SettingsPage />);

    await waitFor(() => {
      expect(panel().textContent).not.toContain("checking");
    });
    // It must NOT read as a healthy-shaped panel with an unknown provider,
    // which is exactly what the original rendered.
    expect(panel().textContent).not.toBe("unknown");
    expect(panel().textContent?.toLowerCase()).toMatch(
      /not part of this build|no sandbox|absent/
    );
  });

  it("still handles the HTML 404 that used to be the only path exercised", async () => {
    // The accidental path must keep working. Fixing the JSON case by removing
    // the catch would trade one silent failure for another.
    vi.stubGlobal("fetch", mockFetch({ status: 404, body: {}, asHtml: true }));
    render(<SettingsPage />);

    await waitFor(() => {
      expect(panel().textContent).not.toContain("checking");
    });
    expect(panel().textContent?.toLowerCase()).toMatch(
      /not part of this build|no sandbox|absent/
    );
  });

  it("a 500 is a FAILED probe, not an absent sandbox", async () => {
    // Absent and broken are different facts and call for different responses:
    // one is a fork that legitimately has no sandbox, the other is a sandbox
    // that should be there and is not answering.
    vi.stubGlobal(
      "fetch",
      mockFetch({ status: 500, body: { error: "docker daemon down" } })
    );
    render(<SettingsPage />);

    await waitFor(() => {
      expect(panel().textContent).not.toContain("checking");
    });
    expect(panel().textContent).toContain("500");
    expect(panel().textContent?.toLowerCase()).not.toMatch(
      /not part of this build/
    );
  });

  /*
   * THE COLOUR IS PART OF THE CLAIM, and it had no test until a mutation said
   * so. Repainting `absent` from muted to destructive passed all fifteen other
   * cases in this change — the rule "absent is not a fault, so it is not red"
   * was written in a comment, restated in the panel, and unfalsifiable.
   *
   * That is the expensive shape: a reader greps for the rule, finds it stated
   * twice, finds tests nearby, and stops. These three cases are what make the
   * statement mean something.
   */
  const dotClass = () =>
    screen.getByTestId("settings-sandbox-dot").getAttribute("class") ?? "";

  it("ABSENT IS NOT RED — a fork without sandbox routes has nothing wrong with it", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({ status: 404, body: { error: "no such route" } })
    );
    render(<SettingsPage />);
    await waitFor(() => {
      expect(panel().textContent).not.toContain("checking");
    });
    expect(dotClass()).not.toContain("destructive");
    expect(dotClass()).toContain("muted-foreground");
  });

  it("but a FAILED probe IS red — the distinction has to survive in the colour too", async () => {
    // Without this, "absent is not red" is satisfiable by never rendering red
    // at all, which would hide every genuine outage instead.
    vi.stubGlobal(
      "fetch",
      mockFetch({ status: 500, body: { error: "docker daemon down" } })
    );
    render(<SettingsPage />);
    await waitFor(() => {
      expect(panel().textContent).toContain("500");
    });
    expect(dotClass()).toContain("destructive");
  });

  it("and a healthy sandbox is green", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        status: 200,
        body: { provider: "docker", available: true },
      })
    );
    render(<SettingsPage />);
    await waitFor(() => {
      expect(panel().textContent).toContain("Docker (local)");
    });
    expect(dotClass()).toContain("success");
  });

  it("a healthy 200 still renders the provider", async () => {
    // Absence assertions pass vacuously against a panel that renders nothing.
    // This is the case that proves the others are measuring something.
    vi.stubGlobal(
      "fetch",
      mockFetch({
        status: 200,
        body: { provider: "docker", available: true, detail: "ready" },
      })
    );
    render(<SettingsPage />);

    await waitFor(() => {
      expect(panel().textContent).toContain("Docker (local)");
    });
    expect(panel().textContent).toContain("ready");
  });
});
