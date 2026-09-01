/**
 * The trace vocabulary, pinned against the Python planes' output.
 *
 * `pnpm check:run-axes-parity` asserts fastapi's and django's `set_run_axes` /
 * `langfuse_trace_metadata` are BYTE-IDENTICAL. That is the right test for two
 * copies of one Python source and is not expressible against a TypeScript port
 * — so this runtime is deliberately NOT added to that gate (see README).
 *
 * What IS enforced is the thing the gate exists to protect: the OUTPUT.
 *
 * THIS HEADER USED TO CLAIM "a drift in either direction fails here", AND THAT
 * WAS NOT TRUE (#616). The expected values were literals taken from reading the
 * Python -- a second spelling, with nothing asserting it still matched the
 * first. Literals cannot notice Python changing, and the cases below had no
 * SESSION-ONLY case, so they could not notice that the two had never agreed
 * there in the first place: for a session with no other axis the Python planes
 * emitted `langfuse_tags: []` and this module omitted the key.
 *
 * The comparison now lives in scripts/fixtures/run-axes-cases.json, which the
 * Python planes' own tests read as well. A case added there is added to every
 * plane at once. The hand-written cases below are kept -- they cover shapes the
 * fixture does not, like AsyncLocalStorage isolation between concurrent runs --
 * but they are no longer what stands in for cross-plane agreement.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  currentRunAxes,
  traceMetadata,
  withRunAxes,
  runConfig,
} from "./runAxes.js";

const ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  ".."
);
const FIXTURE = JSON.parse(
  readFileSync(join(ROOT, "scripts/fixtures/run-axes-cases.json"), "utf8")
) as {
  mustContain: string[];
  cases: {
    id: string;
    why: string;
    axes: Record<string, string>;
    expect: unknown;
  }[];
};

describe("the run-axes contract, shared with the Python planes", () => {
  /*
   * BOTH HALVES, because either alone passes on an empty table. Non-emptiness
   * is satisfied by six easy cases after someone deletes the hard one; naming
   * the ids is satisfied by nothing at all if the list is empty. The ids come
   * from the fixture's own `mustContain`, so the fixture declares which cases
   * are load-bearing rather than this file guessing.
   */
  it("has cases, and still has the ones that found something", () => {
    expect(FIXTURE.cases.length).toBeGreaterThan(0);
    const ids = new Set(FIXTURE.cases.map((c) => c.id));
    const missing = FIXTURE.mustContain.filter((id) => !ids.has(id));
    expect(
      missing,
      `the fixture no longer contains ${JSON.stringify(
        missing
      )} — these are declared ` +
        `load-bearing in its own mustContain list, and losing one silently is how the ` +
        `divergence they pin comes back`
    ).toEqual([]);
  });

  for (const c of FIXTURE.cases) {
    it(`${c.id}: ${c.why.split(".")[0]}`, () => {
      withRunAxes(c.axes, () => {
        expect(traceMetadata(), c.why).toEqual(c.expect);
      });
    });
  }
});

describe("run axes", () => {
  it("tags are axis:value, sorted, and the session is an identity not a tag", () => {
    withRunAxes(
      {
        runtime: "node",
        framework: "langchain",
        topology: "react",
        session: "conv-9",
      },
      () => {
        expect(traceMetadata()).toEqual({
          langfuse_tags: [
            "framework:langchain",
            "runtime:node",
            "topology:react",
          ],
          langfuse_session_id: "conv-9",
        });
      }
    );
  });

  it("an absent axis is dropped, not recorded as a string", () => {
    // "an absent axis and an axis whose value is the string 'None' are
    // different facts, and only one of them is true" — the Python comment this
    // is a port of. `undefined` must not become "undefined".
    withRunAxes({ runtime: "node", framework: "", session: undefined }, () => {
      expect(currentRunAxes()).toEqual({ runtime: "node" });
      expect(traceMetadata()).toEqual({ langfuse_tags: ["runtime:node"] });
    });
  });

  it("concurrent requests do not see each other's axes", async () => {
    // The reason this is AsyncLocalStorage and not a module-level variable. A
    // global would let the second request overwrite the first mid-stream, and
    // the traces would be mislabelled rather than missing — the harder failure
    // to notice.
    const seen: string[] = [];
    await Promise.all([
      withRunAxes({ runtime: "node", topology: "react" }, async () => {
        await new Promise((r) => setTimeout(r, 10));
        seen.push(currentRunAxes().topology!);
      }),
      withRunAxes({ runtime: "node", topology: "plan-execute" }, async () => {
        seen.push(currentRunAxes().topology!);
      }),
    ]);
    expect(seen.sort()).toEqual(["plan-execute", "react"]);
  });

  it("runConfig is {} when there is nothing to say", () => {
    // `{}` rather than `{callbacks: []}`: an empty callbacks list REPLACES
    // inherited callbacks on nested runs, so the empty-but-present form would
    // actively suppress tracing a parent had set up.
    expect(runConfig()).toEqual({});
    withRunAxes({ runtime: "node" }, () => {
      expect(runConfig()).toEqual({
        metadata: { langfuse_tags: ["runtime:node"] },
      });
    });
  });
});
