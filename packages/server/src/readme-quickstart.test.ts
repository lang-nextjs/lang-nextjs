/**
 * Doctest — verifies the README Quick Start snippet actually runs.
 *
 * The README claims (paraphrased from packages/server/README.md):
 *
 *   import { createDeepAgentsHandler } from '@deepagents-nextjs/server';
 *   export const POST = createDeepAgentsHandler({ backendUrl: process.env.BACKEND_URL! });
 *
 * Two regressions this catches:
 *   1. The import path or symbol name changes — the README still says
 *      `createDeepAgentsHandler` but the package now exports it under a
 *      different name. Type-check + import resolution catches this.
 *   2. The shape of the options object changes — e.g. `backendUrl` is
 *      renamed to `url`. The constructor call exercises the runtime
 *      contract.
 *
 * NOTE: this runs a COPY, not the README — see the note below.
 */

/*
 * WHAT THIS FILE ACTUALLY ASSERTS (#478).
 *
 * It runs a COPY of the README's Quick Start that is maintained here by hand.
 * It does not read each package's own README.md — measured, this file contains no
 * `fs`, `readFileSync` or `node:fs` — so it cannot detect the README changing.
 * The header used to call this "the executable form of the README so the docs
 * can't drift silently from the API"; that sentence was not true of it, and a
 * claim like that is worse than no test because it is cited as coverage.
 *
 * What it IS good for, and why it stays: it exercises the documented shape
 * against the real runtime, with this package's peers present — which the
 * README checker deliberately does not do.
 *
 * THE README'S OWN TEXT is checked by scripts/assert-readme-quickstart.mjs,
 * which reads the published file, extracts the Quick Start fences and asserts
 * every symbol they tell a reader to import is exported by this package.
 */
import { describe, it, expect } from "vitest";
import { createDeepAgentsHandler } from "./index";

describe("packages/server — README Quick Start", () => {
  it("exact snippet compiles, runs, and returns a handler function", () => {
    const handler = createDeepAgentsHandler({
      backendUrl: "http://localhost:8000/stream",
    });
    expect(typeof handler).toBe("function");
  });
});
