/**
 * The per-browser approval owner key (#170).
 *
 * WHY THIS VALUE IS A FRESH SECRET AND NOT AN ID THE APP ALREADY HAD — measured, not assumed:
 *   apps/open-swe  sessionId: "lang-nextjs-chat"   HARDCODED, identical in every browser.
 *                  Owner-matching against it is a no-op that LOOKS like a guard.
 *   apps/example   `hitl-${Date.now()}`            per-tab but timestamp-derived, guessable.
 * Neither has the entropy to be a capability, so "reuse the session id" was never available.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getBrowserOwnerKey,
  APPROVAL_OWNER_STORAGE_KEY,
} from "./browser-owner-key";

describe("getBrowserOwnerKey", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("GUARD: mints a high-entropy value, not a timestamp or a constant", () => {
    // The whole point of this helper is that the values it returns could not have come from
    // the ids already in the tree. A short or monotonic value would defeat it silently.
    const key = getBrowserOwnerKey();
    expect(key).toBeDefined();
    expect(key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it("is STABLE across calls — the same browser keeps one key", () => {
    // If it minted per call, the key stamped on an approval would never match the key sent to
    // resolve it, and every approval would 403. That failure would look like the guard
    // working, which is the worst way for this to break.
    const a = getBrowserOwnerKey();
    const b = getBrowserOwnerKey();
    expect(a).toBe(b);
    expect(window.localStorage.getItem(APPROVAL_OWNER_STORAGE_KEY)).toBe(a);
  });

  it("two browsers get DIFFERENT keys", () => {
    const first = getBrowserOwnerKey();
    window.localStorage.clear(); // simulates a different browser profile
    const second = getBrowserOwnerKey();
    expect(second).not.toBe(first);
  });

  it("degrades to undefined when storage throws, rather than failing the app", () => {
    // Private mode, disabled site data, a sandboxed iframe. Approvals then carry no owner and
    // stay resolvable by id alone — the documented pre-#170 contract. A gate that BREAKS when
    // storage is unavailable would be worse than one that returns to its previous behaviour.
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError: localStorage is not available");
    });
    expect(getBrowserOwnerKey()).toBeUndefined();
  });
});
