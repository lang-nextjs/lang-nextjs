import { describe, it, expect } from "vitest";
import {
  describeDependency,
  formatAge,
  isVerifiedHealthy,
  type DependencyState,
} from "./dependency-status";

const ALL: DependencyState[] = [
  "not-configured",
  "unverified",
  "unreachable",
  "responding",
  "not-wired",
];

describe("describeDependency — nothing defaults to green", () => {
  it("ONLY `responding` is success — the whole point of #126", () => {
    const green = ALL.filter((s) => describeDependency(s).tone === "success");
    expect(green).toEqual(["responding"]);
  });

  it("`unverified` is NOT green — configuration is not observation", () => {
    const d = describeDependency("unverified");
    expect(d.tone).not.toBe("success");
    expect(d.label).toMatch(/not verified/i);
  });

  it("`unverified` and `unreachable` are DIFFERENT — differently actionable", () => {
    // The first may just need triggering; the second means something is broken.
    const a = describeDependency("unverified");
    const b = describeDependency("unreachable");
    expect(a.label).not.toBe(b.label);
    expect(a.tone).not.toBe(b.tone);
  });

  it("`not-wired` is never red — a capability that does not exist is not a failure", () => {
    // False alarms are how operators learn to stop reading a panel.
    expect(describeDependency("not-wired").tone).not.toBe("destructive");
  });

  it("`unreachable` IS red — the state a boolean hides", () => {
    expect(describeDependency("unreachable").tone).toBe("destructive");
  });

  it("every state has a distinct label — none collapses into another", () => {
    const labels = ALL.map((s) => describeDependency(s).label);
    expect(new Set(labels).size).toBe(ALL.length);
  });

  it("isVerifiedHealthy is true ONLY for a live observation", () => {
    for (const s of ALL) {
      expect(isVerifiedHealthy({ id: "x", label: "x", state: s })).toBe(
        s === "responding"
      );
    }
  });
});

describe("formatAge — a green from 40 minutes ago is a different claim", () => {
  const now = Date.parse("2026-08-26T12:00:00Z");
  it("never probed is said, not shown as fresh", () => {
    expect(formatAge(undefined, now)).toBe("never probed");
  });
  it("recent reads as just now", () => {
    expect(formatAge("2026-08-26T11:59:58Z", now)).toBe("just now");
  });
  it("seconds, minutes and hours each render", () => {
    expect(formatAge("2026-08-26T11:59:30Z", now)).toBe("30s ago");
    expect(formatAge("2026-08-26T11:20:00Z", now)).toBe("40m ago");
    expect(formatAge("2026-08-26T09:00:00Z", now)).toBe("3h ago");
  });
  it("an unparseable timestamp is `age unknown`, never `just now`", () => {
    expect(formatAge("not-a-date", now)).toBe("age unknown");
  });
});
