/**
 * Live integration smoke test for the Blazing workspace provider (TEST-03).
 *
 * This exercises the real `BlazingSandbox` adapter against a running Blazing
 * `/v1/workspace` REST API — the full create → get → exec → list → destroy
 * lifecycle, plus health/capacity. Unlike `blazing-sandbox.test.ts` (which
 * mocks `fetch`), this hits a real server and parses real responses via
 * `Response.json()`.
 *
 * It is SKIPPED unless `BLAZING_API_URL` is set, so it never runs in normal
 * CI. To run it against a live instance:
 *
 *   BLAZING_API_URL=http://localhost:8009 \
 *   BLAZING_API_TOKEN=test-token \
 *   pnpm --filter open-swe test -- lib/sandbox/blazing-sandbox.live.test.ts
 */
import { describe, it, expect, beforeAll } from "vitest";
import { BlazingSandbox } from "./blazing-sandbox";

const BASE_URL = process.env.BLAZING_API_URL;
const LIVE = Boolean(BASE_URL);
const TEST_IMAGE = process.env.BLAZING_TEST_IMAGE ?? "blazing/workspace:latest";

// Real provisioning + exec can take a few seconds — give each step room.
const STEP_TIMEOUT = 60_000;

describe.skipIf(!LIVE)("BlazingSandbox — live integration (TEST-03)", () => {
  // Constructed in beforeAll, not in the suite body: a skipped `describe`
  // still runs its factory at collection time, and `new BlazingSandbox`
  // would throw on an undefined baseUrl before the skip takes effect.
  let sandbox: BlazingSandbox;

  // Shared across the ordered lifecycle steps below.
  let workspaceId = "";

  beforeAll(() => {
    sandbox = new BlazingSandbox({
      baseUrl: BASE_URL as string,
      apiToken: process.env.BLAZING_API_TOKEN,
      timeoutMs: STEP_TIMEOUT,
    });
  });

  it(
    "health() reports the live server as available",
    async () => {
      const health = await sandbox.health();
      expect(health.provider).toBe("blazing");
      expect(health.available).toBe(true);
    },
    STEP_TIMEOUT
  );

  it(
    "capacity() returns a sane used/max/available report",
    async () => {
      const cap = await sandbox.capacity();
      expect(cap.provider).toBe("blazing");
      expect(cap.max).toBeGreaterThan(0);
      expect(cap.used).toBeGreaterThanOrEqual(0);
      expect(cap.available).toBe(Math.max(0, cap.max - cap.used));
    },
    STEP_TIMEOUT
  );

  it(
    "create() provisions a ready workspace",
    async () => {
      const ws = await sandbox.create({ image: TEST_IMAGE, label: "vitest-live" });
      expect(ws.provider).toBe("blazing");
      expect(ws.id).toMatch(/^ws_/);
      expect(ws.status).toBe("ready");
      workspaceId = ws.id;
    },
    STEP_TIMEOUT
  );

  it(
    "create() with env fails loud — Blazing rejects env with 422 (blazing#48)",
    async () => {
      await expect(
        sandbox.create({ image: TEST_IMAGE, env: { FOO: "bar" } })
      ).rejects.toMatchObject({ code: "create_failed" });
    },
    STEP_TIMEOUT
  );

  it(
    "get() returns the freshly created workspace",
    async () => {
      const ws = await sandbox.get(workspaceId);
      expect(ws).not.toBeNull();
      expect(ws?.id).toBe(workspaceId);
      expect(ws?.provider).toBe("blazing");
    },
    STEP_TIMEOUT
  );

  it(
    "executeTool() runs a command and returns exit_code 0 with stdout",
    async () => {
      const result = await sandbox.executeTool(workspaceId, "echo", [
        "hello-from-adapter",
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("hello-from-adapter");
      expect(result.timedOut).toBe(false);
    },
    STEP_TIMEOUT
  );

  it(
    "executeTool() parses multiline stdout (real escaped-JSON path)",
    async () => {
      const result = await sandbox.executeTool(workspaceId, "python3", [
        "-c",
        "print(6 * 7)",
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("42");
    },
    STEP_TIMEOUT
  );

  it(
    "list() includes the workspace and tags every entry as blazing",
    async () => {
      const all = await sandbox.list();
      expect(all.some((w) => w.id === workspaceId)).toBe(true);
      expect(all.every((w) => w.provider === "blazing")).toBe(true);
    },
    STEP_TIMEOUT
  );

  it(
    "destroy() is idempotent and get() then returns null",
    async () => {
      await expect(sandbox.destroy(workspaceId)).resolves.toBeUndefined();
      // The API contract: DELETE is idempotent — 204 even for an unknown id.
      await expect(sandbox.destroy(workspaceId)).resolves.toBeUndefined();
      expect(await sandbox.get(workspaceId)).toBeNull();
    },
    STEP_TIMEOUT
  );
});
