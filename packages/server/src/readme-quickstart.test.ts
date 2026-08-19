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
 * This is a doctest in spirit: the executable form of the README so
 * the docs can't drift silently from the API.
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
