/**
 * The trace vocabulary, pinned against the Python planes' output.
 *
 * `pnpm check:run-axes-parity` asserts fastapi's and django's `set_run_axes` /
 * `langfuse_trace_metadata` are BYTE-IDENTICAL. That is the right test for two
 * copies of one Python source and is not expressible against a TypeScript port
 * — so this runtime is deliberately NOT added to that gate (see README).
 *
 * What IS enforced is the thing the gate exists to protect: the OUTPUT. The
 * expected values below are literals taken from reading the Python, not derived
 * from this module, so a drift in either direction fails here.
 */
import { describe, expect, it } from "vitest";
import { currentRunAxes, traceMetadata, withRunAxes, runConfig } from "./runAxes.js";

describe("run axes", () => {
  it("tags are axis:value, sorted, and the session is an identity not a tag", () => {
    withRunAxes(
      { runtime: "node", framework: "langchain", topology: "react", session: "conv-9" },
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
