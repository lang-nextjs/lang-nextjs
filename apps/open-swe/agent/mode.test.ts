import { afterEach, beforeEach, describe, expect, it } from "vitest";
// Plain ESM dev fixture; TypeScript resolves it via allowJs.
import { readFileSync } from "node:fs";
import {
  modelKeyConfigured,
  resolveMode,
  resolveServedMode,
} from "./mode.mjs";

/**
 * WHICH REASON THE BANNER GIVES, AND WHETHER IT IS TRUE.
 *
 * Reported from a running app: "Scripted run — no LLM was called. Set
 * NVIDIA_API_KEY… to run against a real model" — shown to someone whose
 * NVIDIA_API_KEY was set.
 *
 * It was set in the repo-root .env, which the BACKEND reads through docker's
 * env_file. This stub is a plain node process started by dev-all.sh, and that
 * script reports secrets by name and deliberately does not copy them into
 * child environments. So a check on `process.env` alone answered "did anyone
 * export this to me" while the banner reported it as "you have no key".
 *
 * The same defect as the readiness banner an hour earlier: a verdict about a
 * file, computed from somewhere the file is not.
 *
 * THE MODE IS `canned` EITHER WAY — a key does not wire a graph, and the
 * dev-all.sh output says so. Only the REASON moves, and the reason is the
 * whole message: one sends you to fix a key you already have, the other names
 * the actual blocker.
 */

const VARS = ["NVIDIA_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const v of VARS) {
    saved[v] = process.env[v];
    delete process.env[v];
  }
});
afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

describe("a key in the environment", () => {
  it.each(VARS)("%s is recognised", (v) => {
    // The chain is NVIDIA -> OpenRouter -> Anthropic. An earlier version
    // checked OpenRouter alone, so somebody with NVIDIA set — the free
    // provider this repo recommends — was told to set a key they did not need.
    process.env[v] = "sk-test";
    expect(resolveMode().reason).toBe("live-graph-not-configured");
  });

  it("an EMPTY value is not a key, and falls through to the file", () => {
    // `NVIDIA_API_KEY=` is what a half-finished setup looks like, and an empty
    // value must not count as configured.
    //
    // THIS ASSERTS THE COMPOSED BEHAVIOUR, not the process branch alone, and
    // the first version got that wrong: it expected `no-model-api-key` and
    // failed, because falling through to a repo .env that HAS a key is the
    // correct outcome — the question is "is a key configured for this repo",
    // and it is. The empty-value rule is what makes the fall-through happen
    // rather than short-circuiting on a blank string.
    process.env.NVIDIA_API_KEY = "";
    const withEmpty = resolveMode().reason;
    delete process.env.NVIDIA_API_KEY;
    const withNothing = resolveMode().reason;
    // An empty var is indistinguishable from an absent one, which is the rule.
    expect(withEmpty).toBe(withNothing);
  });
});

describe("a key in the repo's .env but not in this process", () => {
  it("IS FOUND — the reported case", () => {
    // No model key is exported here (the fixture strips them). Before the fix
    // this returned `no-model-api-key` and the banner told the reader to set a
    // key that was already set in the repo-root .env — the file the BACKEND
    // reads through docker's env_file, and which this stub never sees because
    // dev-all.sh reports secrets by name and does not copy them into children.
    //
    // Read through `modelKeyConfigured` rather than `resolveMode`, so the
    // assertion is about the FILE LOOKUP and not about a composed answer.
    // Conditional on the file existing, because a fresh clone has none and
    // `false` is the honest answer there — the branch is stated rather than
    // passing silently either way.
    const envHasKey = (() => {
      try {
        return readFileSync(new URL("../../../.env", import.meta.url), "utf8")
          .split(/\r?\n/)
          .some((l) =>
            VARS.some((v) =>
              new RegExp(`^\\s*(export\\s+)?${v}\\s*=\\s*\\S`).test(l)
            )
          );
      } catch {
        return false;
      }
    })();
    expect(modelKeyConfigured()).toBe(envHasKey);
  });

  it("an injected decision overrides the file entirely", () => {
    // The seam that keeps every other test in this repo deterministic. Without
    // it, `resolveMode()` answers differently on a machine with a .env than in
    // CI, and two existing cases broke exactly that way when the read landed.
    expect(resolveMode({ hasKey: false }).reason).toBe("no-model-api-key");
    expect(resolveMode({ hasKey: true }).reason).toBe("live-graph-not-configured");
  });
});

describe("what the mode itself reports", () => {
  it("STAYS canned WHATEVER THE KEY SAYS", () => {
    // The property that makes the reason worth getting right. A key does not
    // wire a graph; claiming `live` because one exists is precisely the
    // misattribution mode.mjs was written to prevent.
    expect(resolveMode({ hasKey: false }).mode).toBe("canned");
    expect(resolveMode({ hasKey: true }).mode).toBe("canned");
  });

  it("always carries a reason, so the banner is never blank", () => {
    for (const hasKey of [false, true]) {
      expect(resolveMode({ hasKey }).reason?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

/**
 * ONLY A SERVED RUN MAY CLAIM `live`.
 *
 * mode.mjs opens by saying a key "says what was requested; it does not say
 * what answered", and `resolveMode` is called BEFORE anything is served — it
 * answers "what will probably happen", from configuration.
 *
 * So the live path needed a second question, asked after the fact:
 * `resolveServedMode`, which is the only function permitted to return `live`
 * and does so only when a model actually produced output.
 */
describe("what a run reports after it has been served", () => {
  it("A MODEL THAT ANSWERED IS live", () => {
    const m = resolveServedMode({ modelAnswered: true, detail: "deepagents/react" });
    expect(m.mode).toBe("live");
    expect(m.reason).toBe("deepagents/react");
  });

  it("A MODEL THAT DID NOT ANSWER FALLS BACK TO canned", () => {
    // Not "live with no output". A run that streamed nothing did not answer,
    // and the scripted content is what the person is about to watch.
    expect(resolveServedMode({ modelAnswered: false }).mode).toBe("canned");
  });

  it("names WHICH model answered, so the banner is specific", () => {
    // "Live agent run" alone cannot tell you whether it was the framework you
    // selected. The reason carries framework/topology.
    expect(
      resolveServedMode({ modelAnswered: true, detail: "langgraph/plan-execute" }).reason
    ).toContain("langgraph");
  });

  it("still returns a reason when none was given", () => {
    expect(
      (resolveServedMode({ modelAnswered: true }).reason ?? "").length
    ).toBeGreaterThan(0);
  });

  it("A MISSING OUTCOME IS NOT live", () => {
    // Defensive on purpose: this decides a banner that asserts a real agent
    // ran. Anything unclear must fall to `canned`, which claims less.
    for (const bad of [undefined, null, {}, { modelAnswered: "yes" }]) {
      expect(resolveServedMode(bad as never).mode, String(bad)).toBe("canned");
    }
  });

  it("resolveMode ALONE never says live, whatever the key", () => {
    // The invariant the whole module is built on, re-asserted now that a
    // second resolver exists beside it.
    expect(resolveMode({ hasKey: true }).mode).toBe("canned");
    expect(resolveMode({ hasKey: false }).mode).toBe("canned");
  });
});
