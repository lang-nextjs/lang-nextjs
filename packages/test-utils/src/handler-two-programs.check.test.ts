/**
 * handler.ts MUST TYPECHECK UNDER BOTH PROGRAMS THAT COMPILE IT (#460).
 *
 * `packages/server/src/handler.ts` is compiled twice, by programs whose libs
 * disagree about `RequestInit`:
 *
 *   packages/server/tsconfig.json          `duplex` ABSENT
 *   packages/test-utils/tsconfig.parity    `duplex` PRESENT
 *
 * Node's fetch requires `duplex: "half"` to send a streaming body, so the
 * property has to be there — and a `@ts-expect-error` describing it was REQUIRED
 * under the first program and UNUSED (TS2578, itself an error) under the second.
 * The same line could not be right in both, and the failure surfaced as a
 * cross-package suite failing a typecheck about something it was not testing.
 *
 * WHAT THIS FILE IS FOR. It asserts almost nothing at runtime, and that is not
 * the point: MERELY BEING IN tsconfig.parity.json's include list AND IMPORTING
 * handler.ts is what makes the second program compile that file. tsc is the
 * instrument; this file is how handler.ts gets in front of it.
 *
 * Without it the fix is unguarded — a later `@ts-expect-error` on that line
 * passes the server's own program and breaks whichever cross-package suite next
 * imports this module, which is how the problem arrived the first time. The
 * runtime assertion below exists so the file is not silently skipped as empty.
 */
import { describe, it, expect } from "vitest";

import { createSseProxyHandler } from "../../server/src/handler";

describe("handler.ts compiles under the parity program too (#460)", () => {
  it("is importable, which is what puts it in front of the second typechecker", () => {
    // The real check ran before this did: if handler.ts did not typecheck under
    // tsconfig.parity.json, `pnpm typecheck` failed and this never executed.
    expect(typeof createSseProxyHandler).toBe("function");
  });
});
