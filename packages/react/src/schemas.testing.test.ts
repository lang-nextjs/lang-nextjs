/**
 * TestingSchema (data-testing) — rung-5-owned.
 *
 * Lives in its own file rather than in schemas.test.ts because `data-testing` is
 * owned by the software-developer-agent rung: a fork ejected to rung 4 prunes the
 * schema, and a shared test asserting it would fail after that eject. Same reason
 * rung 4's adapter tests live beside their adapter rather than in a shared suite.
 *
 * The consumer side of the contract that packages/server cannot express: server
 * has no dependency on this package, so sdaEnrich.test.ts asserts field NAMES
 * literally and this file asserts the schema ACCEPTS those exact payloads. The two
 * must be changed together.
 */

import { describe, it, expect } from "vitest";
import {
  TESTING_STATUSES,
  TestingSchema,
  TestingStatusSchema,
  TestingRunSchema,
} from "./schemas";
import { parseDataPart } from "./schemas";

/** A status payload exactly as sdaEnrich.ts emits it. */
function statusPayload(status: string) {
  return {
    id: "run-1--set_testing_status-0",
    seq: 0,
    kind: "status" as const,
    status,
    reason: "because",
    updatedAt: "2026-08-24T21:00:00.000Z",
  };
}

/** A run payload exactly as sdaEnrich.ts emits it. */
const runPayload = {
  id: "run-1--playwright-0",
  seq: 1,
  kind: "run" as const,
  command: "run_test_file",
  testFile: "e2e/login.spec.ts",
  browser: "chromium",
  headless: false,
  status: "in_progress",
  updatedAt: "2026-08-24T21:00:00.000Z",
};

describe("TestingSchema — accepts everything the producer emits", () => {
  it("ACCEPT: all six upstream statuses parse", () => {
    for (const s of [
      "not_started",
      "required",
      "in_progress",
      "completed",
      "failed",
      "skipped",
    ]) {
      const r = TestingSchema.safeParse(statusPayload(s));
      expect(r.success, `status ${s} must parse`).toBe(true);
    }
  });

  it("ACCEPT: `unknown` parses — sdaEnrich emits it for out-of-enum input", () => {
    // If this enum forgets "unknown", converter.ts is fail-open: it warns and
    // DROPS the part, so a coerced status becomes an invisible frame. That is
    // the #59 failure mode — a schema narrower than its producer.
    const r = TestingSchema.safeParse(statusPayload("unknown"));
    expect(r.success).toBe(true);
  });

  it("ACCEPT: every member of TESTING_STATUSES parses, by construction", () => {
    // Guards against the enum and the exported list drifting apart.
    for (const s of TESTING_STATUSES) {
      expect(TestingSchema.safeParse(statusPayload(s)).success, s).toBe(true);
    }
    expect(TESTING_STATUSES).toContain("unknown");
    expect(TESTING_STATUSES).toHaveLength(7);
  });

  it("ACCEPT: a run payload parses, including nullable testFile/browser", () => {
    expect(TestingSchema.safeParse(runPayload).success).toBe(true);
    expect(
      TestingSchema.safeParse({
        ...runPayload,
        testFile: null,
        browser: null,
      }).success
    ).toBe(true);
  });

  it("ACCEPT: registered in SCHEMA_MAP, so parseDataPart resolves it", () => {
    // Defining a schema without registering it is exactly what #59 was.
    const r = parseDataPart({
      type: "data-testing",
      data: statusPayload("failed"),
    });
    expect(r.ok).toBe(true);
  });
});

describe("TestingSchema — rejects what it should", () => {
  it("REJECT: a status outside the enum", () => {
    expect(TestingSchema.safeParse(statusPayload("ha_ha_pwned")).success).toBe(
      false
    );
  });

  it("REJECT: a kind that is neither status nor run", () => {
    expect(
      TestingSchema.safeParse({ ...statusPayload("failed"), kind: "other" })
        .success
    ).toBe(false);
  });

  it("REJECT: a status payload missing `reason`", () => {
    const { reason: _drop, ...rest } = statusPayload("failed");
    expect(TestingStatusSchema.safeParse(rest).success).toBe(false);
  });

  it("REJECT: a run payload missing `headless`", () => {
    const { headless: _drop, ...rest } = runPayload;
    expect(TestingRunSchema.safeParse(rest).success).toBe(false);
  });

  it("REJECT: a negative or fractional seq", () => {
    expect(
      TestingSchema.safeParse({ ...statusPayload("failed"), seq: -1 }).success
    ).toBe(false);
    expect(
      TestingSchema.safeParse({ ...statusPayload("failed"), seq: 1.5 }).success
    ).toBe(false);
  });

  it("REJECT: the run shape under kind=status and vice versa", () => {
    // The discriminated union must not let a run payload masquerade as a status.
    expect(
      TestingSchema.safeParse({ ...runPayload, kind: "status" }).success
    ).toBe(false);
  });
});
