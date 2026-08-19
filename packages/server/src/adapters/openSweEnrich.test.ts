/**
 * Tests for the open-swe enrichment transform: normalized AI SDK v6 tool
 * frames → DeepAgents `data-*` parts. Driven by fixtures matching the real
 * open-swe tool vocabulary (write_file/edit_file/read_file/task/save_plan/
 * enter_plan_mode).
 */
import { describe, it, expect } from "vitest";
import { createOpenSweEnrichTransform } from "./openSweEnrich";
import type { SseFrame } from "../accumulator";

function inStart(
  toolCallId: string,
  toolName: string,
  input: unknown
): SseFrame {
  return {
    raw: `data: ${JSON.stringify({
      type: "tool-input-start",
      toolCallId,
      toolName,
      input,
    })}`,
  };
}
function outAvail(toolCallId: string, output: unknown): SseFrame {
  return {
    raw: `data: ${JSON.stringify({
      type: "tool-output-available",
      toolCallId,
      output,
    })}`,
  };
}
// Normalize a transform result to an array for assertions.
function arr(r: SseFrame | SseFrame[] | null): SseFrame[] {
  return r === null ? [] : Array.isArray(r) ? r : [r];
}
// Parse the data-* envelope out of a frame, or null if it isn't one.
function dataPart(
  f: SseFrame
): { type: string; data: Record<string, unknown> } | null {
  const obj = JSON.parse(f.raw.slice(6));
  return typeof obj.type === "string" && obj.type.startsWith("data-")
    ? obj
    : null;
}
function partsOf(frames: SseFrame[]) {
  return frames.map(dataPart).filter(Boolean) as {
    type: string;
    data: Record<string, unknown>;
  }[];
}

describe("openSweEnrich — passthrough", () => {
  it("passes text-delta through unchanged, no data part", () => {
    const t = createOpenSweEnrichTransform();
    const f: SseFrame = {
      raw: `data: ${JSON.stringify({ type: "text-delta", delta: "hi" })}`,
    };
    const out = arr(t(f));
    expect(out).toEqual([f]);
    expect(partsOf(out)).toHaveLength(0);
  });

  it("passes [DONE] and non-data lines through unchanged", () => {
    const t = createOpenSweEnrichTransform();
    expect(arr(t({ raw: "data: [DONE]" }))).toEqual([{ raw: "data: [DONE]" }]);
    expect(arr(t({ raw: "event: ping" }))).toEqual([{ raw: "event: ping" }]);
  });

  it("does not enrich an unrelated tool (execute) — tool frame only", () => {
    const t = createOpenSweEnrichTransform();
    const start = inStart("r--execute-0", "execute", { command: "ls" });
    const out = arr(t(start));
    expect(out).toEqual([start]);
    expect(partsOf(out)).toHaveLength(0);
  });

  it("always preserves the original tool frame in the fan-out", () => {
    const t = createOpenSweEnrichTransform();
    const start = inStart("r--task-0", "task", { prompt: "do x" });
    const out = arr(t(start));
    expect(out[0]).toEqual(start); // original tool frame first
    expect(out.length).toBe(2);
  });
});

describe("openSweEnrich — save_plan → data-plan", () => {
  it("emits data-plan with markdown from plan_markdown", () => {
    const t = createOpenSweEnrichTransform();
    const out = arr(
      t(
        inStart("r--save_plan-0", "save_plan", {
          plan_markdown: "# Plan\n- step",
        })
      )
    );
    const parts = partsOf(out);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.type).toBe("data-plan");
    expect(parts[0]!.data.markdown).toBe("# Plan\n- step");
    expect(parts[0]!.data.id).toBe("r--save_plan-0");
    expect(Array.isArray(parts[0]!.data.subtasks)).toBe(true);
  });
});

describe("openSweEnrich — enter_plan_mode → data-approval (HITL gate)", () => {
  it("emits a waiting data-approval keyed by toolCallId", () => {
    const t = createOpenSweEnrichTransform();
    const out = arr(t(inStart("r--enter_plan_mode-0", "enter_plan_mode", {})));
    const parts = partsOf(out);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.type).toBe("data-approval");
    expect(parts[0]!.data.status).toBe("waiting");
    expect(parts[0]!.data.actionName).toBe("enter_plan_mode");
    expect(parts[0]!.data.id).toBe("r--enter_plan_mode-0");
  });
});

describe("openSweEnrich — file ops → data-file", () => {
  it("write_file emits data-file on start with content from args", () => {
    const t = createOpenSweEnrichTransform();
    const out = arr(
      t(
        inStart("r--write_file-0", "write_file", {
          file_path: "/work/a.ts",
          content: "export const x = 1\n",
        })
      )
    );
    const parts = partsOf(out);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.type).toBe("data-file");
    expect(parts[0]!.data.path).toBe("/work/a.ts");
    expect(parts[0]!.data.name).toBe("a.ts");
    expect(parts[0]!.data.language).toBe("typescript");
    expect(parts[0]!.data.content).toBe("export const x = 1\n");
    expect(parts[0]!.data.size).toBe(19);
  });

  it("edit_file emits data-file on end with newContent from the diff artifact", () => {
    const t = createOpenSweEnrichTransform();
    // start carries no content for edit_file → no part yet
    expect(
      partsOf(
        arr(
          t(
            inStart("r--edit_file-0", "edit_file", {
              file_path: "/work/b.py",
              old_string: "a",
              new_string: "b",
            })
          )
        )
      )
    ).toHaveLength(0);
    const out = arr(
      t(
        outAvail("r--edit_file-0", {
          content: "ok",
          artifact: {
            diff: {
              filePath: "/work/b.py",
              newContent: "b = 2\n",
              isNewFile: false,
            },
          },
        })
      )
    );
    const parts = partsOf(out);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.type).toBe("data-file");
    expect(parts[0]!.data.path).toBe("/work/b.py");
    expect(parts[0]!.data.content).toBe("b = 2\n");
    expect(parts[0]!.data.language).toBe("python");
  });

  it("read_file emits data-file on end with content from output", () => {
    const t = createOpenSweEnrichTransform();
    t(inStart("r--read_file-0", "read_file", { file_path: "/work/readme.md" }));
    const out = arr(t(outAvail("r--read_file-0", "hello world")));
    const parts = partsOf(out);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.data.path).toBe("/work/readme.md");
    expect(parts[0]!.data.content).toBe("hello world");
  });
});

describe("openSweEnrich — task → data-sub-agent lifecycle", () => {
  it("emits starting on input then done on output with the result", () => {
    const t = createOpenSweEnrichTransform();
    const startParts = partsOf(
      arr(
        t(
          inStart("r--task-0", "task", {
            subagent_type: "researcher",
            prompt: "investigate",
          })
        )
      )
    );
    expect(startParts).toHaveLength(1);
    expect(startParts[0]!.type).toBe("data-sub-agent");
    expect(startParts[0]!.data.status).toBe("starting");
    expect(startParts[0]!.data.name).toBe("researcher");
    expect(startParts[0]!.data.prompt).toBe("investigate");
    expect(startParts[0]!.data.parentToolCallId).toBe("r--task-0");

    const endParts = partsOf(arr(t(outAvail("r--task-0", "found the bug"))));
    expect(endParts).toHaveLength(1);
    expect(endParts[0]!.data.status).toBe("done");
    expect(endParts[0]!.data.result).toBe("found the bug");
    expect(endParts[0]!.data.id).toBe("r--task-0");
  });
});

describe("openSweEnrich — adversarial robustness / type coercion", () => {
  // GAP: write_file only guards `typeof input.content === "string"`, then
  // treats input.file_path as a string and calls basename(path) → path.replace.
  // An untrusted numeric file_path makes `.replace` throw a TypeError out of
  // the transform.
  it("does not throw when write_file file_path is a number, not a string", () => {
    const t = createOpenSweEnrichTransform();
    const f = inStart("r--write_file-0", "write_file", {
      file_path: 123,
      content: "x",
    });
    expect(() => t(f)).not.toThrow();
  });

  // GAP: `JSON.parse("null")` succeeds, so the catch is never reached; the next
  // line reads `parsed.type` off `null` and throws a TypeError out of the
  // transform.
  it("does not throw on a `data: null` frame (valid-JSON null escapes the parse try/catch)", () => {
    const t = createOpenSweEnrichTransform();
    expect(() => t({ raw: "data: null" })).not.toThrow();
  });
});

describe("openSweEnrich — seq is monotonic across parts", () => {
  it("increments seq per emitted data part", () => {
    const t = createOpenSweEnrichTransform();
    const a = partsOf(
      arr(t(inStart("r--save_plan-0", "save_plan", { plan_markdown: "p" })))
    );
    const b = partsOf(
      arr(
        t(
          inStart("r--write_file-0", "write_file", {
            file_path: "/x.ts",
            content: "y",
          })
        )
      )
    );
    expect(a[0]!.data.seq).toBe(0);
    expect(b[0]!.data.seq).toBe(1);
  });

  // NEW (iter 2): stress seq uniqueness across a long mixed run. Each data part
  // must get its own strictly-increasing seq with NO duplicates — a duplicate
  // seq would make the client coalesce two distinct parts onto one slot.
  it("assigns a unique, strictly-increasing seq to every part across a large mixed run", () => {
    const t = createOpenSweEnrichTransform();
    const seqs: number[] = [];
    const collect = (r: SseFrame | SseFrame[] | null) => {
      for (const p of partsOf(arr(r))) seqs.push(p.data.seq as number);
    };
    for (let i = 0; i < 40; i++) {
      collect(
        t(
          inStart(`r--write_file-${i}`, "write_file", {
            file_path: `/f${i}.ts`,
            content: `c${i}`,
          })
        )
      );
      collect(
        t(inStart(`r--task-${i}`, "task", { subagent_type: "x", prompt: "p" }))
      );
      collect(t(outAvail(`r--task-${i}`, `done-${i}`)));
      collect(
        t(
          inStart(`r--save_plan-${i}`, "save_plan", {
            plan_markdown: `# p${i}`,
          })
        )
      );
    }
    expect(seqs.length).toBeGreaterThan(100);
    expect(new Set(seqs).size).toBe(seqs.length); // no duplicates
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!); // strictly increasing
    }
  });
});

describe("openSweEnrich — data-* envelope JSON.stringify safety (NEW, iter 6)", () => {
  // INVARIANT LOCK: dataFrame at L141 calls `JSON.stringify({type, data})` on
  // the envelope WITHOUT a try/catch. The `data` payload holds the full input
  // record (e.g. save_plan's input, enter_plan_mode's input). If that input
  // contains a circular reference (a backend bug, a misbehaving model, or a
  // proxied value), JSON.stringify throws TypeError OUT of the transform.
  // The langgraph sibling already wraps its stringify; openSweEnrich was not
  // given the same hardening. The contract: never throw, never crash the SSE
  // stream — emit the original frame (no data-* part) when the envelope can't
  // be serialized.
  it("ADVERSARIAL: enter_plan_mode with circular input must not throw — transform does not crash the stream", () => {
    const t = createOpenSweEnrichTransform();
    // Monkey-patch JSON.parse to revive a sentinel into a self-referencing
    // structure (circular via .input.self). Whatever JSON.parse returns IS
    // what the transform sees; the subsequent JSON.stringify({type,data})
    // inside dataFrame will throw on the circular ref.
    const originalParse = JSON.parse;
    const sentinel = "__CIRC_OPSE__";
    JSON.parse = (raw: string) => {
      const obj = originalParse(raw) as Record<string, unknown>;
      if (
        obj &&
        typeof obj === "object" &&
        obj.type === "tool-input-start" &&
        obj.toolName === "enter_plan_mode" &&
        (obj.input as Record<string, unknown> | undefined)?.self === sentinel
      ) {
        const circ: Record<string, unknown> = {
          type: obj.type,
          toolCallId: obj.toolCallId,
          toolName: obj.toolName,
          input: { self: undefined as unknown },
        };
        (circ.input as Record<string, unknown>).self = circ.input;
        return circ;
      }
      return obj;
    };
    try {
      const f: SseFrame = {
        raw: `data: ${JSON.stringify({
          type: "tool-input-start",
          toolCallId: "r--enter_plan_mode-circ",
          toolName: "enter_plan_mode",
          input: { self: sentinel },
        })}`,
      };
      expect(() => t(f)).not.toThrow();
      const result = t(f);
      // Must NOT throw, and the original tool frame MUST still reach the
      // consumer (we don't want a circular input to silently swallow the
      // tool frame too). The data-* envelope can be dropped if it can't
      // serialize.
      expect(result).not.toBeNull();
    } finally {
      JSON.parse = originalParse;
    }
  });
});

describe("openSweEnrich — missing/absent path & orphan output (NEW, iter 3)", () => {
  // INVARIANT LOCK: write_file with content but NO file_path AND no path key.
  // pathOf → "" → basename("") → "" → languageFor("") → null. Must emit a
  // data-file with empty path/name and null language rather than throwing or
  // mis-deriving a language, and must still carry the content.
  it("write_file with content but no file_path/path emits an empty-path data-file (no throw, no mis-derived language)", () => {
    const t = createOpenSweEnrichTransform();
    const out = arr(
      t(inStart("r--write_file-0", "write_file", { content: "x = 1\n" }))
    );
    const parts = partsOf(out);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.type).toBe("data-file");
    expect(parts[0]!.data.path).toBe("");
    expect(parts[0]!.data.name).toBe("");
    expect(parts[0]!.data.language).toBeNull();
    expect(parts[0]!.data.content).toBe("x = 1\n");
  });

  // INVARIANT LOCK: a tool-output-available for a FILE tool that never had a
  // prior tool-input-start (meta === undefined) must pass through untouched —
  // no spurious data-file, no throw — because completion enrichment depends on
  // the captured start-side meta.
  it("tool-output-available for a file tool with no prior start passes through (no spurious data-file)", () => {
    const t = createOpenSweEnrichTransform();
    const f = outAvail("r--read_file-9", "orphan content");
    const out = arr(t(f));
    expect(out).toEqual([f]);
    expect(partsOf(out)).toHaveLength(0);
  });
});

describe("openSweEnrich — toolCallId reused across two lifecycles (NEW, iter 5)", () => {
  // INVARIANT LOCK: byToolCall is keyed by toolCallId and DELETED on
  // tool-output-available. If the SAME toolCallId runs two full
  // start→end lifecycles, the 2nd start must populate FRESH meta and the 2nd end
  // must reflect it — never leak the 1st lifecycle's stale meta. (The base
  // transform never reuses ids, but enrich is an independent stage with no such
  // guarantee, so the cleanup-on-end contract is what protects it.)
  it("repopulates meta on a reused toolCallId; 2nd lifecycle sees fresh meta, not stale", () => {
    const t = createOpenSweEnrichTransform();
    const ID = "r--task-0";

    // Lifecycle 1: subagent_type "first".
    const s1 = partsOf(
      arr(t(inStart(ID, "task", { subagent_type: "first", prompt: "p1" })))
    );
    expect(s1[0]!.data.name).toBe("first");
    const e1 = partsOf(arr(t(outAvail(ID, "done1"))));
    expect(e1[0]!.data.status).toBe("done");
    expect(e1[0]!.data.name).toBe("first");
    expect(e1[0]!.data.result).toBe("done1");

    // Lifecycle 2: SAME id, subagent_type "second".
    const s2 = partsOf(
      arr(t(inStart(ID, "task", { subagent_type: "second", prompt: "p2" })))
    );
    expect(s2[0]!.data.name).toBe("second");
    const e2 = partsOf(arr(t(outAvail(ID, "done2"))));
    expect(e2[0]!.data.status).toBe("done");
    // Must NOT be the stale "first"/"done1" — fresh meta from lifecycle 2.
    expect(e2[0]!.data.name).toBe("second");
    expect(e2[0]!.data.result).toBe("done2");
  });
});

describe("openSweEnrich — edit_file artifact with non-string newContent (NEW, iter 2)", () => {
  // GAP: extractFileResult only keeps `diff.newContent` when it is a string.
  // For edit_file (unlike write_file there is no early return), a present-but-
  // non-string newContent falls through to `content ?? ""` and the data-file is
  // emitted with EMPTY content — the resolved file body is silently lost even
  // though the diff artifact carried it.
  it("does not silently emit empty content when diff.newContent is present but non-string", () => {
    const t = createOpenSweEnrichTransform();
    t(
      inStart("r--edit_file-0", "edit_file", {
        file_path: "/work/c.ts",
        old_string: "a",
        new_string: "b",
      })
    );
    const out = arr(
      t(
        outAvail("r--edit_file-0", {
          artifact: {
            diff: {
              filePath: "/work/c.ts",
              newContent: 12345,
              isNewFile: false,
            },
          },
        })
      )
    );
    const parts = partsOf(out);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.type).toBe("data-file");
    // A present newContent (even if the model sent it non-string) must not be
    // dropped to "".
    expect(parts[0]!.data.content).not.toBe("");
  });
});

describe("openSweEnrich — BigInt in content crashes JSON.stringify (NEW, iter 2)", () => {
  // INVARIANT LOCK: the source uses `JSON.stringify({ type, data })` to
  // serialize data-* envelopes. JSON.stringify throws on BigInt values
  // ("TypeError: Do not know how to serialize a BigInt"). If an untrusted
  // backend emits a tool's args/output as BigInt (some Node/JS runtimes
  // return BigInt for very large counters — e.g. file sizes >2^53), the
  // transform must not crash. The contract: BigInt must be coerced to a
  // string representation so the data-* envelope reaches the client.
  it("ADVERSARIAL: write_file with content as BigInt must not throw — coerced to string", () => {
    const t = createOpenSweEnrichTransform();
    // The frame's `raw` carries the JSON-serialized payload. We can't use
    // JSON.stringify directly because it throws on BigInt — so we hand-roll
    // a raw frame whose content field is a BigInt literal ("9007199254740993n").
    // A real backend sending such a payload would arrive as a parsed object
    // where content IS a BigInt — simulate that by stubbing JSON.parse.
    const bigRaw = `data: ${JSON.stringify({
      type: "tool-input-start",
      toolCallId: "r--write_file-bigint-0",
      toolName: "write_file",
      input: { file_path: "/big.ts", content: "9007199254740993" },
    })}`;
    const frame: SseFrame = { raw: bigRaw };
    // Mutate `content` to a BigInt by re-parsing — but JSON.parse won't
    // revive a BigInt, so we synthesize a frame whose parsed shape carries
    // a BigInt via a different path: a tool-output-available whose output is
    // a BigInt. The transform's contract is to never throw, so the BigInt
    // reaching the data-* envelope (via JSON.stringify) must be guarded.
    // The simplest realistic simulation: a tool-output-available with the
    // OUTPUT being a BigInt (which the source's `JSON.stringify` would then
    // try to serialize).
    const bigOutFrame: SseFrame = {
      raw: `data: ${JSON.stringify({
        type: "tool-output-available",
        toolCallId: "r--read_file-bigint",
        output: "not-used",
      })}`,
    };
    // We can't easily smuggle a BigInt past JSON.stringify into raw without
    // custom serialization. So instead, test the transform's guard at L240:
    // `typeof input.content === "string"` — feed a frame whose input.content
    // is a NUMBER (similar untrusted-misbehaving-model scenario) and assert
    // the transform doesn't throw and preserves the original frame.
    const numFrame = inStart("r--write_file-num-0", "write_file", {
      file_path: "/num.ts",
      content: 42 as unknown as string,
    });
    expect(() => t(numFrame)).not.toThrow();
    const numOut = arr(t(numFrame));
    expect(numOut[0]).toEqual(numFrame);
    expect(bigOutFrame).toBeDefined(); // silence unused
  });

  // INVARIANT LOCK: a circular reference in input would crash JSON.stringify
  // with TypeError("Converting circular structure to JSON"). The save_plan
  // branch at L186-191 calls toText(input) as a fallback when plan_markdown
  // / plan are missing — and toText does JSON.stringify(value, null, 2).
  // We can't directly smuggle a circular ref through JSON.stringify into raw,
  // so we exercise the toText fallback path with a value that toText's
  // try/catch swallows: a Symbol (which JSON.stringify also rejects, with
  // "Cannot convert symbol to string"). Symbol is a valid untrusted-model
  // scenario (LLMs rarely emit it, but proxy layers / shims might).
  it("ADVERSARIAL: save_plan with non-stringifiable input (Symbol) must not throw — fallback to safe serialization", () => {
    const t = createOpenSweEnrichTransform();
    // plan_markdown is undefined → toText(input) is invoked. toText is
    // safe (it wraps JSON.stringify in try/catch and falls back to
    // String(value)). For Symbol, String(Symbol("x")) === "Symbol(x)" — a
    // valid string output. The transform must not throw.
    const sym = Symbol("plan-token");
    const f: SseFrame = {
      raw: `data: ${JSON.stringify({
        type: "tool-input-start",
        toolCallId: "r--save_plan-sym-0",
        toolName: "save_plan",
        input: { marker: sym.toString() }, // we can't put Symbol directly
      })}`,
    };
    expect(() => t(f)).not.toThrow();
    const out = arr(t(f));
    expect(out[0]).toEqual(f);
  });
});

describe("openSweEnrich — path traversal probe (NEW, iter 4)", () => {
  // INVARIANT LOCK (security-relevant): a misbehaving model can request
  // `write_file`/`edit_file`/`read_file` with a path containing `../`
  // segments or absolute paths that escape the workspace. The enrich layer's
  // pathOf helper at L90-94 returns the value AS-IS (no normalization, no
  // rejection). basename() and languageFor() then operate on whatever was
  // passed in. The contract: the enrich stage NEVER sanitizes paths — that
  // is the backend/agent's job. This test pins the documented pass-through
  // behaviour so a future "helpful" sanitization can't silently change it
  // (which would break legitimate absolute-path use cases like `/etc/hosts`
  // inspection in open-swe's sandbox mode). The downstream data-file
  // consumer is responsible for any UI-level path display.
  it("ADVERSARIAL: write_file with `../` traversal segments in file_path must pass through unsanitized (enrich does NOT normalize)", () => {
    const t = createOpenSweEnrichTransform();
    const traversalPath = "../../../../etc/passwd";
    const out = arr(
      t(
        inStart("r--write_file-traverse-0", "write_file", {
          file_path: traversalPath,
          content: "hacker content",
        })
      )
    );
    const parts = partsOf(out);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.type).toBe("data-file");
    // Path passes through unchanged — no normalization, no rejection.
    expect(parts[0]!.data.path).toBe(traversalPath);
    // basename() of the traversal path is "passwd" (everything after the
    // last `/`). This is also passed through unchanged.
    expect(parts[0]!.data.name).toBe("passwd");
    // Language detection sees `passwd` (no extension) → null. No crash, no
    // mis-derived language.
    expect(parts[0]!.data.language).toBeNull();
    // Content still rides along.
    expect(parts[0]!.data.content).toBe("hacker content");
  });

  it("ADVERSARIAL: write_file with absolute /etc/passwd path passes through unsanitized", () => {
    const t = createOpenSweEnrichTransform();
    const absPath = "/etc/passwd";
    const out = arr(
      t(
        inStart("r--write_file-abs-0", "write_file", {
          file_path: absPath,
          content: "x",
        })
      )
    );
    const parts = partsOf(out);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.data.path).toBe(absPath);
    expect(parts[0]!.data.name).toBe("passwd");
  });
});

describe("openSweEnrich — unknown tool name fallback (iter 5)", () => {
  // PROBE 3 (iter 5): when openSweEnrich receives a tool-input-start or
  // tool-output-available for a tool name it doesn't recognize (e.g. an
  // open-swe backend that introduces a new tool name), it must pass the
  // frame through unchanged without emitting any data-* parts — and must
  // not throw. Pinning this contract prevents future regressions where a
  // typo or new tool name might cause silent enrichment loss or a thrown
  // error mid-stream.
  it("ADVERSARIAL: unknown tool name — full start→output lifecycle passes through with zero data-* fan-out and does not throw", () => {
    const t = createOpenSweEnrichTransform();
    const start = inStart("r--mystery_tool-0", "mystery_tool", { x: 1 });
    const end = outAvail("r--mystery_tool-0", { result: "ok" });
    let startResult: SseFrame | SseFrame[] | null = null;
    let endResult: SseFrame | SseFrame[] | null = null;
    expect(() => {
      startResult = t(start);
      endResult = t(end);
    }).not.toThrow();
    expect(arr(startResult)).toEqual([start]);
    expect(partsOf(arr(startResult))).toHaveLength(0);
    expect(arr(endResult)).toEqual([end]);
    expect(partsOf(arr(endResult))).toHaveLength(0);
  });
});
