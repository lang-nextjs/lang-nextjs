import { describe, it, expect } from "vitest";
import { createDeepAgentsEnrichTransform } from "./deepagentsEnrich";
import type { SseFrame } from "../accumulator";

function inAvail(
  toolCallId: string,
  toolName: string,
  input: unknown
): SseFrame {
  return {
    raw: `data: ${JSON.stringify({
      type: "tool-input-available",
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
function arr(r: SseFrame | SseFrame[] | null): SseFrame[] {
  return r === null ? [] : Array.isArray(r) ? r : [r];
}
function parts(frames: SseFrame[]) {
  return frames
    .map((f) => JSON.parse(f.raw.slice(6)))
    .filter((o) => typeof o.type === "string" && o.type.startsWith("data-"));
}

describe("createDeepAgentsEnrichTransform", () => {
  it("maps write_todos → data-todo with normalized items", () => {
    const t = createDeepAgentsEnrichTransform();
    const out = arr(
      t(
        inAvail("c1", "write_todos", {
          todos: [
            { content: "buy milk", status: "pending" },
            { content: "walk dog", status: "completed" },
          ],
        })
      )
    );
    expect(out).toHaveLength(2); // original frame + data-todo
    const p = parts(out)[0]!;
    expect(p.type).toBe("data-todo");
    expect(p.data.items).toEqual([
      { id: "c1-0", text: "buy milk", status: "pending" },
      { id: "c1-1", text: "walk dog", status: "done" },
    ]);
  });

  it("maps write_file → data-file with path/name/language/content", () => {
    const t = createDeepAgentsEnrichTransform();
    const p = parts(
      arr(
        t(
          inAvail("c2", "write_file", {
            file_path: "/plan.md",
            content: "# Plan",
          })
        )
      )
    )[0]!;
    expect(p.type).toBe("data-file");
    expect(p.data).toMatchObject({
      path: "/plan.md",
      name: "plan.md",
      language: "markdown",
      content: "# Plan",
    });
  });

  it("maps read_file output → data-file (content from output)", () => {
    const t = createDeepAgentsEnrichTransform();
    t(inAvail("c3", "read_file", { file_path: "/a.py" }));
    const p = parts(arr(t(outAvail("c3", "print('hi')"))))[0]!;
    expect(p.type).toBe("data-file");
    expect(p.data).toMatchObject({
      path: "/a.py",
      language: "python",
      content: "print('hi')",
    });
  });

  it("maps task start/end → data-sub-agent lifecycle", () => {
    const t = createDeepAgentsEnrichTransform();
    const start = parts(
      arr(
        t(
          inAvail("c4", "task", {
            subagent_type: "researcher",
            description: "go",
          })
        )
      )
    )[0]!;
    expect(start.type).toBe("data-sub-agent");
    expect(start.data).toMatchObject({
      name: "researcher",
      status: "starting",
      prompt: "go",
    });
    const end = parts(arr(t(outAvail("c4", "found it"))))[0]!;
    expect(end.data).toMatchObject({ status: "done", result: "found it" });
  });

  it("write_todos with EMPTY todos array emits a data-todo with items=[] (does not drop the call, does not crash on seq increment)", () => {
    // Adversarial: an agent may call write_todos({}) or write_todos({todos:[]})
    // on a planning step where it has nothing to add yet (or to clear the list).
    // The current implementation:
    //   const todos = Array.isArray(input.todos) ? input.todos : [];
    //   return [frame, dataFrame("data-todo", { ..., items: todos.map(...) })];
    // A non-array input.todos falls back to [], and items becomes [].
    // This test covers the EXPLICIT empty-array case AND the implicit "todos
    // missing" case — both must produce a data-todo with items.length===0,
    // and the original tool frame MUST still be preserved in the fan-out.
    const t = createDeepAgentsEnrichTransform();
    const out = arr(t(inAvail("c-empty-todos", "write_todos", { todos: [] })));
    expect(out).toHaveLength(2); // original frame + data-todo (NOT dropped)
    const p = parts(out)[0]!;
    expect(p.type).toBe("data-todo");
    expect(p.data.id).toBe("c-empty-todos");
    expect(Array.isArray(p.data.items)).toBe(true);
    expect(p.data.items).toHaveLength(0);
    // The original tool frame is preserved in the fan-out so the generic ToolCard
    // can still render the tool-call message in the chat transcript.
    expect(out[0]).toEqual(
      inAvail("c-empty-todos", "write_todos", { todos: [] })
    );
  });

  it("passes unrelated tools and non-JSON through untouched, never throws", () => {
    const t = createDeepAgentsEnrichTransform();
    expect(arr(t(inAvail("c5", "some_other_tool", { x: 1 })))).toHaveLength(1);
    expect(() => t({ raw: "data: not-json" })).not.toThrow();
    expect(() => t({ raw: "data: null" })).not.toThrow();
    expect(arr(t({ raw: "data: [DONE]" }))).toEqual([{ raw: "data: [DONE]" }]);
  });

  // INVARIANT LOCK: the write_todos branch (deepagentsEnrich.ts L114-130) maps
  // each element via `t.content ?? t.text ?? ""`. If an element is `null` or a
  // primitive number, `t.content` is a property access on a non-object — for
  // `null` JS throws TypeError, which bubbles out of the transform and crashes
  // the stream (the transform's contract: never throw). A misbehaving model
  // emitting `[null, {content:"real"}]` must not crash — the bad element should
  // be coerced to an empty string and the data-todo emitted.
  it("ADVERSARIAL: write_todos with a null element in the todos array must not throw — null element coerced to empty-text pending", () => {
    const t = createDeepAgentsEnrichTransform();
    const frame = inAvail("c-null-todo", "write_todos", {
      todos: [null, { content: "real task", status: "pending" }],
    });
    expect(() => t(frame)).not.toThrow();
    const out = arr(t(frame));
    expect(out).toHaveLength(2); // original + data-todo
    const p = parts(out)[0]!;
    expect(p.type).toBe("data-todo");
    // Two items, second element preserved, first is the null-coerced placeholder
    expect(p.data.items).toHaveLength(2);
    expect((p.data.items as Array<Record<string, unknown>>)[1]).toEqual({
      id: "c-null-todo-1",
      text: "real task",
      status: "pending",
    });
  });

  // INVARIANT LOCK (partial-failure resilience): a real-world SSE stream
  // can drop or corrupt individual frames without the upstream connection
  // dying. The transform contract: ONE malformed frame must not corrupt the
  // per-toolCallId Map state, must not throw, and subsequent valid frames
  // must still be enriched correctly. Emit 5 frames in sequence:
  //   1. valid tool-input-available for read_file → enriches to data-file
  //   2. malformed JSON ("data: <<garbled>>")      → must pass through unchanged, no throw
  //   3. valid tool-input-available for write_todos → enriches to data-todo
  //   4. malformed frame with data: null           → must pass through unchanged
  //   5. valid tool-output-available for #1        → enriches to data-file
  // After all 5, every valid frame produced a data-* part.
  it("ADVERSARIAL: malformed JSON frames between valid frames must NOT corrupt byToolCall state — stream continues enriching subsequent valid frames", () => {
    const t = createDeepAgentsEnrichTransform();
    const emitted: SseFrame[] = [];

    // Frame 1: valid read_file input (read_file enriches on both start AND
    // output, so we can verify both code paths survive malformed frames in
    // between).
    const f1 = inAvail("c-resilience-1", "read_file", {
      file_path: "/work/a.ts",
    });
    emitted.push(...arr(t(f1)));

    // Frame 2: malformed JSON — must pass through unchanged, never throw
    const f2: SseFrame = { raw: "data: <<not json at all>>" };
    expect(() => t(f2)).not.toThrow();
    const r2 = t(f2);
    expect(r2).toEqual(f2); // pass-through

    // Frame 3: valid write_todos
    const f3 = inAvail("c-resilience-2", "write_todos", {
      todos: [{ content: "after-error", status: "pending" }],
    });
    emitted.push(...arr(t(f3)));

    // Frame 4: data:null — JSON.parse succeeds with null, must not crash on
    // `.type` property access
    const f4: SseFrame = { raw: "data: null" };
    expect(() => t(f4)).not.toThrow();
    const r4 = t(f4);
    expect(r4).toEqual(f4); // pass-through

    // Frame 5: valid tool-output-available for the FIRST read_file — the
    // critical test. If the malformed frames leaked into byToolCall state
    // (e.g. set "c-resilience-1" with garbage), this output would either
    // crash or emit a malformed data-file. It must enrich correctly.
    const f5 = outAvail("c-resilience-1", "export const x = 1\n");
    const out5 = arr(t(f5));
    const dataParts = parts(out5);
    expect(dataParts).toHaveLength(1);
    expect(dataParts[0]!.type).toBe("data-file");
    expect(dataParts[0]!.data.path).toBe("/work/a.ts");
    expect(dataParts[0]!.data.content).toBe("export const x = 1\n");

    // Sanity: the data-todo from frame 3 was emitted intact
    const todoParts = parts(emitted).filter((p) => p.type === "data-todo");
    expect(todoParts).toHaveLength(1);
    expect(
      (todoParts[0]!.data.items as Array<Record<string, unknown>>)[0]!.text
    ).toBe("after-error");
  });
});
