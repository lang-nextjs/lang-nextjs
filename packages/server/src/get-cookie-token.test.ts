import { describe, it, expect } from "vitest";
import { getCookieToken } from "./get-cookie-token";

function makeMockRequest(cookies: Record<string, string> = {}) {
  return {
    cookies: {
      get: (name: string) =>
        cookies[name] !== undefined ? { value: cookies[name] } : undefined,
    },
  } as any;
}

describe("getCookieToken", () => {
  it("returns a function", () => {
    expect(typeof getCookieToken("session")).toBe("function");
  });

  it("returns cookie value when cookie is present", () => {
    const getToken = getCookieToken("session");
    const req = makeMockRequest({ session: "abc123" });
    expect(getToken(req)).toBe("abc123");
  });

  it("returns undefined when cookie is absent", () => {
    const getToken = getCookieToken("session");
    const req = makeMockRequest({});
    expect(getToken(req)).toBeUndefined();
  });

  it("returns empty string when cookie value is empty", () => {
    const getToken = getCookieToken("session");
    const req = makeMockRequest({ session: "" });
    expect(getToken(req)).toBe("");
  });

  it("reads only the named cookie, not others", () => {
    const getToken = getCookieToken("token_a");
    const req = makeMockRequest({ token_b: "other" });
    expect(getToken(req)).toBeUndefined();
  });

  it('returns falsy string values like "0" and "false" as-is (not coerced to undefined)', () => {
    // Type coercion gap: if the implementation uses `?.value || undefined` instead of
    // `?.value` the falsy string "0" would be incorrectly dropped.
    const getToken = getCookieToken("session");
    expect(getToken(makeMockRequest({ session: "0" }))).toBe("0");
    expect(getToken(makeMockRequest({ session: "false" }))).toBe("false");
  });
});
