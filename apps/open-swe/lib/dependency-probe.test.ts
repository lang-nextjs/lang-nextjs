import { describe, expect, it } from "vitest";
import { readDependencyProbe } from "./dependency-status";

/**
 * A FAILED PROBE AND AN EMPTY ONE WERE THE SAME PANEL (#237).
 *
 * `loadDeps` did `const b = (await r.json())` and never read `r.ok`. A 500
 * carrying `{"error": "..."}` fell through `b.dependencies ?? []`, and the
 * panel renders `[]` as no rows and no message — a clean, empty box.
 *
 * So the settings page a person opens to find out whether their backends are
 * reachable went silently blank exactly when they were not, and looked
 * identical to a healthy system with nothing configured.
 *
 * The tests below are organised around that confusion: every case asserts which
 * of the three states a response lands in, because the bug was never a crash —
 * it was two different realities rendering the same way.
 */

const res = (
  status: number,
  body: string,
  ok = status >= 200 && status < 300
): Response => ({ ok, status, text: async () => body } as unknown as Response);

const OK_BODY = JSON.stringify({
  probedAt: "2026-08-26T12:00:00Z",
  dependencies: [{ id: "agent", state: "reachable" }],
});

describe("a probe that FAILED", () => {
  it("a 500 is a failure, not an empty result", () => {
    // The exact reported shape.
    const p = readDependencyProbe(res(500, '{"error":"probe crashed"}'));
    return p.then((r) => {
      expect(r.kind).toBe("failed");
    });
  });

  it("carries the status code and what the server said", async () => {
    // Both halves. The code says who refused; the message says why. The old
    // path had neither, because it never looked.
    const r = await readDependencyProbe(
      res(502, '{"error":"agent unreachable"}')
    );
    expect(r.kind === "failed" && r.message).toContain("502");
    expect(r.kind === "failed" && r.message).toContain("agent unreachable");
  });

  it("falls back to the raw body when the error is not JSON", async () => {
    const r = await readDependencyProbe(res(503, "upstream gateway down"));
    expect(r.kind === "failed" && r.message).toContain("503");
    expect(r.kind === "failed" && r.message).toContain("gateway down");
  });

  it("says something useful even with an empty body", async () => {
    const r = await readDependencyProbe(res(500, ""));
    expect(r.kind).toBe("failed");
    expect(r.kind === "failed" && r.message).toContain("500");
    expect((r.kind === "failed" && r.message.length) || 0).toBeGreaterThan(10);
  });

  it("clips a long body instead of pushing the code off screen", async () => {
    // An HTML error page is the common case, and it is long.
    const r = await readDependencyProbe(res(500, "<html>" + "x".repeat(9000)));
    const msg = r.kind === "failed" ? r.message : "";
    expect(msg.length).toBeLessThan(300);
    expect(msg).toContain("500");
  });
});

describe("a 200 that cannot be believed", () => {
  it("a 200 that is not JSON is a failure, not an empty result", async () => {
    // The status line said fine; the body says otherwise. Rendering this as
    // "no dependencies" would be the same lie in a different colour.
    const r = await readDependencyProbe(res(200, "<html>gateway</html>"));
    expect(r.kind).toBe("failed");
  });

  it("a 200 whose dependencies is not a list is a failure", async () => {
    const r = await readDependencyProbe(
      res(200, JSON.stringify({ dependencies: { agent: "ok" } }))
    );
    expect(r.kind).toBe("failed");
    expect(r.kind === "failed" && r.message).toContain("object");
  });

  it("a 200 with dependencies MISSING is a failure, not zero dependencies", async () => {
    // This is the precise line that produced the bug: `b.dependencies ?? []`.
    // An absent key was silently converted into a successful empty answer.
    const r = await readDependencyProbe(
      res(200, JSON.stringify({ probedAt: "x" }))
    );
    expect(r.kind).toBe("failed");
  });
});

describe("a probe that WORKED", () => {
  it("passes the rows and the timestamp through", async () => {
    const r = await readDependencyProbe(res(200, OK_BODY));
    expect(r.kind).toBe("ok");
    expect(r.kind === "ok" && r.rows).toHaveLength(1);
    expect(r.kind === "ok" && r.probedAt).toBe("2026-08-26T12:00:00Z");
  });

  it("an EMPTY list is a success, and stays distinguishable from a failure", async () => {
    // The control for the whole file. If this collapsed into `failed` the fix
    // would just be the original bug pointing the other way.
    const r = await readDependencyProbe(
      res(200, JSON.stringify({ dependencies: [] }))
    );
    expect(r.kind).toBe("ok");
    expect(r.kind === "ok" && r.rows).toEqual([]);
  });

  it("a missing probedAt is not itself a failure", async () => {
    // Absent metadata is not an unreadable response — the rows are the point.
    const r = await readDependencyProbe(
      res(
        200,
        JSON.stringify({ dependencies: [{ id: "a", state: "reachable" }] })
      )
    );
    expect(r.kind).toBe("ok");
    expect(r.kind === "ok" && r.probedAt).toBeUndefined();
  });
});

describe("the three states stay three", () => {
  it("every response lands in exactly one kind, and never in none", async () => {
    // The property the bug violated: two distinct realities must not produce
    // the same state. Asserted across the whole range rather than case by case,
    // so a future branch that forgets to return is caught here.
    const cases: Array<[Response, "ok" | "failed"]> = [
      [res(200, OK_BODY), "ok"],
      [res(200, JSON.stringify({ dependencies: [] })), "ok"],
      [res(200, "not json"), "failed"],
      [res(200, JSON.stringify({})), "failed"],
      [res(404, "missing"), "failed"],
      [res(500, '{"error":"x"}'), "failed"],
      [res(503, ""), "failed"],
    ];
    for (const [input, expected] of cases) {
      const r = await readDependencyProbe(input);
      expect(["ok", "failed"]).toContain(r.kind);
      expect(r.kind).toBe(expected);
    }
  });
});
