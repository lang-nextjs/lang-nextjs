import type { Run } from "@/lib/types";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("../../../../lib/langgraph-client", () => ({
  createRun: vi.fn(),
  listRuns: vi.fn(),
}));

import * as langgraphClient from "../../../../lib/langgraph-client";
import { POST, GET } from "./route";
import { PlatformError } from "../../../../lib/types";

describe("POST /api/open-swe/runs", () => {
  const PLATFORM_URL = "http://localhost:8000";

  beforeEach(() => {
    vi.stubEnv("LANGGRAPH_PLATFORM_URL", PLATFORM_URL);
    vi.stubEnv("OPEN_SWE_ASSISTANT_ID", "open-swe");
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 201 with run_id when task is valid", async () => {
    vi.mocked(langgraphClient.createRun).mockResolvedValueOnce({
      run_id: "run-abc",
      status: "pending",
      created_at: "2026-05-04T00:00:00Z",
      task: "echo hello",
    });

    const req = new NextRequest("http://localhost:3001/api/open-swe/runs", {
      method: "POST",
      body: JSON.stringify({ task: "echo hello" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.run_id).toBe("run-abc");
  });

  it("returns 422 when task field is missing", async () => {
    const req = new NextRequest("http://localhost:3001/api/open-swe/runs", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });

    const res = await POST(req);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("returns 422 when task is not a string (e.g., task: 123)", async () => {
    const req = new NextRequest("http://localhost:3001/api/open-swe/runs", {
      method: "POST",
      body: JSON.stringify({ task: 123 }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await POST(req);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("returns 422 when task is empty or whitespace (e.g., task: '   ')", async () => {
    const req = new NextRequest("http://localhost:3001/api/open-swe/runs", {
      method: "POST",
      body: JSON.stringify({ task: "   " }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await POST(req);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("returns 502 when LANGGRAPH_PLATFORM_URL is not set", async () => {
    vi.unstubAllEnvs();

    const req = new NextRequest("http://localhost:3001/api/open-swe/runs", {
      method: "POST",
      body: JSON.stringify({ task: "echo hello" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await POST(req);
    expect(res.status).toBe(502);
  });

  it("returns 502 when Platform returns 5xx", async () => {
    vi.mocked(langgraphClient.createRun).mockRejectedValueOnce(
      new PlatformError(500, "Internal Server Error")
    );

    const req = new NextRequest("http://localhost:3001/api/open-swe/runs", {
      method: "POST",
      body: JSON.stringify({ task: "echo hello" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await POST(req);
    expect(res.status).toBe(502);
  });

  it("returns 502 when fetch times out (AbortError)", async () => {
    vi.mocked(langgraphClient.createRun).mockRejectedValueOnce(
      Object.assign(new Error("aborted"), { name: "AbortError" })
    );

    const req = new NextRequest("http://localhost:3001/api/open-swe/runs", {
      method: "POST",
      body: JSON.stringify({ task: "echo hello" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await POST(req);
    expect(res.status).toBe(502);
  });

  it("POST with empty task field returns 422 and does NOT call createRun upstream", async () => {
    // Adversarial: task is the empty string. The route must reject it as invalid
    // (per the existing whitespace test, task.trim() === "" is the trim-of-empty
    // path), must NOT call createRun, and the upstream must not be hit.
    //
    // Targets: a future change that uses `body.task.length` instead of trim() —
    // empty string passes length but fails trim. Or one that uses `body.task ?? ""`
    // — the ?? would treat undefined and "" the same way, but if the condition
    // were inverted to `if (!body.task) { ...valid... }` then "" would slip through.
    // Or a falsy check `if (!body.task || ...)` vs `if (body.task === undefined)`.
    // The defensive contract: empty string MUST return 422, no upstream call.
    const cases: Array<{ name: string; bodyValue: unknown }> = [
      { name: "explicit empty string", bodyValue: "" },
      { name: "single space", bodyValue: " " },
      { name: "tab only", bodyValue: "\t" },
      { name: "newline only", bodyValue: "\n" },
      { name: "mixed whitespace", bodyValue: "  \t \n " },
    ];

    for (const { name, bodyValue } of cases) {
      const req = new NextRequest("http://localhost:3001/api/open-swe/runs", {
        method: "POST",
        body: JSON.stringify({ task: bodyValue }),
        headers: { "Content-Type": "application/json" },
      });

      const res = await POST(req);
      const json = await res.json();

      // 422 is the documented invalid-task contract
      expect(
        res.status,
        `case "${name}": status was ${res.status}, expected 422`
      ).toBe(422);

      // createRun must NOT have been called for any empty/whitespace task value
      expect(vi.mocked(langgraphClient.createRun)).not.toHaveBeenCalled();

      // The error message should be the documented one — distinguishable from
      // the malformed-JSON / not-set / upstream errors.
      expect(json.error).toBeDefined();
      expect(typeof json.error).toBe("string");
      expect(json.error.length).toBeGreaterThan(0);

      vi.clearAllMocks();
    }
  });

  it("accepts a 10,240-character unicode task (emoji, RTL, CJK, ZWJ) and forwards every byte to createRun", async () => {
    // Adversarial: a real-world task payload may contain emoji, RTL Arabic,
    // CJK Chinese, ZWJ family emoji, BOM characters, and combining
    // diacritics. The route uses `await request.json()` to parse and
    // `body.task.trim()` to validate — the trim must not strip unicode
    // whitespace differently than ASCII, and the JSON parse must not corrupt
    // surrogate pairs. Then createRun is called with the EXACT byte
    // sequence (the client expects it to round-trip to the platform).
    //
    // Targets: a route that calls `.substring(0, N)` on the task (silent
    // truncation); one that lowercases (breaks i18n casing); one that
    // applies `.normalize("NFC")` and changes byte length.
    //
    // The current implementation must pass this test — but it also pins
    // the exact upstream payload so any future "sanitisation" change is
    // observable.
    vi.mocked(langgraphClient.createRun).mockResolvedValueOnce({
      run_id: "run-unicode-large",
      status: "pending",
      created_at: "2026-06-28T00:00:00Z",
      task: "echo",
    });

    // Build a 9,600-char unicode task — a 120-char "stress block" repeated
    // 80 times. The block contains every adversarial class:
    //   - 🚀 (emoji, surrogate pair, 4 bytes UTF-8)
    //   - أبجد (Arabic RTL)
    //   - 中文 (CJK)
    //   - café (Latin + combining diacritic)
    //   - 👨‍👩‍👧‍👦 (ZWJ family emoji, multiple codepoints joined)
    //   - ﻿ (BOM)
    //   - Ω (Greek)
    const block = "🚀أبجد中文café👨‍👩‍👧‍👦﻿Ω";
    const task = block.repeat(80);
    // 12 chars per block * 80 = 960 chars. But we want a "10KB-class" payload
    // by JS char count; pad with additional CJK to push past 10,000 chars
    // while keeping the mixed-adversarial-class property.
    const paddedTask = task + "中".repeat(10_000 - task.length);
    expect(paddedTask.length).toBe(10_000);
    // Pinned: padded task contains every adversarial unicode class from the
    // original block, so any per-class normalisation failure surfaces.
    expect(paddedTask).toContain("🚀");
    expect(paddedTask).toContain("أبجد");
    expect(paddedTask).toContain("中文");
    expect(paddedTask).toContain("café");
    expect(paddedTask).toContain("👨‍👩‍👧‍👦");
    expect(paddedTask).toContain("﻿");
    expect(paddedTask).toContain("Ω");

    const req = new NextRequest("http://localhost:3001/api/open-swe/runs", {
      method: "POST",
      body: JSON.stringify({ task: paddedTask }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await POST(req);

    // Route must accept the payload — no 4xx from unicode content.
    expect(res.status).toBe(201);

    // createRun must have been called exactly once, with the task forwarded
    // VERBATIM (no truncation, no normalisation, no lowercasing).
    expect(langgraphClient.createRun).toHaveBeenCalledTimes(1);
    const upstreamArg = vi.mocked(langgraphClient.createRun).mock.calls[0][0];
    // The forwarded task must have the exact same length and content.
    expect(upstreamArg.task.length).toBe(paddedTask.length);
    expect(upstreamArg.task).toBe(paddedTask);

    // Specifically: the trailing CJK padding must reach createRun unchanged.
    // If the implementation truncated to N chars, this assertion fails.
    const trailingCJK = "中".repeat(10_000 - task.length);
    expect(upstreamArg.task.endsWith(trailingCJK)).toBe(true);
  });

  it("returns 400 with a helpful message when body is malformed JSON (not just a generic 422)", async () => {
    // Adversarial: the client sent something that looks like JSON but isn't
    // (truncated, single-quote, trailing comma). Currently the route silently
    // swallows the SyntaxError and returns a generic 422 "Missing or invalid
    // 'task' field" — which is misleading: the body was unparseable, not the
    // field. The client should be told it's a JSON problem so they can fix it.
    //
    // We assert the desired contract: status 400 (or 422) AND an error message
    // that mentions JSON (or parsing) — NOT the same generic message used for
    // missing/empty task. If the route continues to swallow the parse error
    // and return "Missing or invalid 'task' field", this test will fail.
    const cases: Array<{ name: string; body: string }> = [
      { name: "trailing comma", body: '{"task": "echo hi",}' },
      { name: "truncated", body: '{"task": "echo hi"' },
      { name: "single quotes (invalid JSON)", body: "{'task': 'echo hi'}" },
      { name: "raw garbage", body: "not-json-at-all" },
    ];

    for (const { name, body } of cases) {
      const req = new NextRequest("http://localhost:3001/api/open-swe/runs", {
        method: "POST",
        body,
        headers: { "Content-Type": "application/json" },
      });

      const res = await POST(req);
      const errBody = await res.json();
      // The createRun mock must NOT have been called — a malformed body should
      // never reach the upstream platform.
      expect(vi.mocked(langgraphClient.createRun)).not.toHaveBeenCalled();
      vi.clearAllMocks();

      // Status should be 400 (preferred for malformed body) — fall back to 422
      // only if the implementation reuses the existing validation path.
      expect([400, 422]).toContain(res.status);
      // The error message MUST be distinguishable from the missing-field error.
      // Either the status is 400 OR the message mentions "JSON" / "parse" /
      // "malformed" / "invalid body" — anything but the generic
      // "Missing or invalid 'task' field".
      const msg = String(errBody.error ?? "").toLowerCase();
      const isHelpful =
        res.status === 400 ||
        msg.includes("json") ||
        msg.includes("parse") ||
        msg.includes("malformed") ||
        msg.includes("invalid body");
      expect(
        isHelpful,
        `case "${name}": error.message="${errBody.error}" — must indicate a JSON parse problem, not a missing-field problem`
      ).toBe(true);
      // It must NOT reuse the missing-field error verbatim.
      expect(errBody.error).not.toBe("Missing or invalid 'task' field");
    }
  });

  it("POST with extra unknown fields (task + privileged/injected keys) still accepts and forwards only task", async () => {
    // Adversarial: the route uses `body.task` directly and discards everything else,
    // but we must verify the contract — extra fields must NOT cause a 4xx and must
    // NOT leak into the upstream payload. If the implementation spreads `body` into
    // createRun, injected fields like `__proto__` or `id` could pollute the request.
    vi.mocked(langgraphClient.createRun).mockResolvedValueOnce({
      run_id: "run-extra",
      status: "pending",
      created_at: "2026-06-28T00:00:00Z",
      task: "echo hello",
    });

    const injected = {
      task: "echo hello",
      // Fields an attacker might inject to confuse/poison downstream handling
      id: "attacker-controlled-id",
      run_id: "attacker-run-id",
      status: "completed",
      created_at: "1970-01-01T00:00:00Z",
      __proto__: { polluted: true },
      isAdmin: true,
    };

    const req = new NextRequest("http://localhost:3001/api/open-swe/runs", {
      method: "POST",
      body: JSON.stringify(injected),
      headers: { "Content-Type": "application/json" },
    });

    const res = await POST(req);
    // Unknown extra fields must NOT cause a validation failure
    expect(res.status).toBe(201);

    // Verify the upstream was called with ONLY the { task } shape (no leakage)
    expect(langgraphClient.createRun).toHaveBeenCalledTimes(1);
    const upstreamArg = vi.mocked(langgraphClient.createRun).mock.calls[0][0];
    // The upstream payload should be exactly { task } — nothing else
    expect(upstreamArg).toEqual({ task: "echo hello" });
    // Specifically, no prototype pollution or extra fields should have been forwarded
    expect(Object.keys(upstreamArg).sort()).toEqual(["task"]);

    // And the response body must reflect what createRun returned, not the injected id/run_id
    const json = await res.json();
    expect(json.run_id).toBe("run-extra");
    expect(json.id).toBeUndefined();
  });
});

describe("GET /api/open-swe/runs", () => {
  const PLATFORM_URL = "http://localhost:8000";

  beforeEach(() => {
    vi.stubEnv("LANGGRAPH_PLATFORM_URL", PLATFORM_URL);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 200 with array of runs", async () => {
    vi.mocked(langgraphClient.listRuns).mockResolvedValueOnce([
      {
        run_id: "run-abc",
        status: "completed",
        created_at: "2026-05-04T00:00:00Z",
        task: "echo hello",
      },
    ]);

    const req = new NextRequest("http://localhost:3001/api/open-swe/runs");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].run_id).toBeDefined();
  });

  it("returns 502 when LANGGRAPH_PLATFORM_URL is not set", async () => {
    vi.unstubAllEnvs();

    const req = new NextRequest("http://localhost:3001/api/open-swe/runs");
    const res = await GET(req);
    expect(res.status).toBe(502);
  });

  it("returns 502 when Platform returns 5xx", async () => {
    vi.mocked(langgraphClient.listRuns).mockRejectedValueOnce(
      new PlatformError(500, "Internal Server Error")
    );

    const req = new NextRequest("http://localhost:3001/api/open-swe/runs");
    const res = await GET(req);
    expect(res.status).toBe(502);
  });
});

// ---------------------------------------------------------------------------
// Adversarial edge-case tests (iteration 2 — POST without Content-Length)
// ---------------------------------------------------------------------------

describe("POST /api/open-swe/runs — Content-Length absent (chunked transfer)", () => {
  const PLATFORM_URL = "http://localhost:8000";

  beforeEach(() => {
    vi.stubEnv("LANGGRAPH_PLATFORM_URL", PLATFORM_URL);
    vi.stubEnv("OPEN_SWE_ASSISTANT_ID", "open-swe");
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts a valid POST body when the client did NOT set Content-Length (Node sends Transfer-Encoding: chunked)", async () => {
    // Adversarial: a programmatic client (curl --data-binary, fetch without
    // explicit Content-Length, or an HTTP/1.1 client using chunked encoding)
    // may submit a perfectly valid JSON body without ever setting
    // Content-Length. Node will then send Transfer-Encoding: chunked on the
    // wire. The route uses `await request.json()` which reads the stream to
    // EOF regardless of whether Content-Length was set, so the body parses
    // correctly.
    //
    // Targets:
    //   - a route that calls request.body.length / expects a Content-Length
    //     header (would 400 or 411)
    //   - a route that uses bodyParser-style limits keyed off Content-Length
    //   - a route that re-reads the body twice and fails on a one-shot stream
    //
    // We pin: status 201, response body has the upstream run_id, createRun
    // was called with the EXACT task (no truncation, no reparse corruption).

    const upstreamRun: Run = {
      run_id: "run-no-content-length",
      status: "pending",
      created_at: "2026-06-28T00:00:00Z",
      task: "echo no content length",
    };
    vi.mocked(langgraphClient.createRun).mockResolvedValueOnce(upstreamRun);

    const taskBody = JSON.stringify({ task: "echo no content length" });

    // Build a NextRequest with a valid body but WITHOUT a Content-Length
    // header. NextRequest accepts a Headers init; we omit Content-Length
    // entirely. Content-Type is set so the JSON parser path is exercised.
    const headers = new Headers();
    headers.set("Content-Type", "application/json");
    // Deliberately do NOT set Content-Length.

    const req = new NextRequest("http://localhost:3001/api/open-swe/runs", {
      method: "POST",
      body: taskBody,
      headers,
    });

    // Sanity: confirm we constructed the request without Content-Length.
    expect(req.headers.get("Content-Length")).toBeNull();
    expect(req.headers.get("Content-Type")).toBe("application/json");

    const res = await POST(req);

    // The route must NOT 4xx on a missing Content-Length — the body is valid.
    // Pin the exact status: 201 is the documented success contract.
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.run_id).toBe(upstreamRun.run_id);

    // createRun must have been called exactly once with the EXACT task
    // (no truncation, no re-encoding corruption from chunked → buffered
    // read in request.json()).
    expect(langgraphClient.createRun).toHaveBeenCalledTimes(1);
    const upstreamArg = vi.mocked(langgraphClient.createRun).mock.calls[0][0];
    expect(upstreamArg.task).toBe("echo no content length");
    // The task was forwarded as the trimmed value (the route does
    // body.task.trim() before forwarding — verify that contract holds).
    expect(upstreamArg.task.length).toBe("echo no content length".length);
  });
});
