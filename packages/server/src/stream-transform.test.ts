import { describe, it, expect } from "vitest";
import { transformSseStream } from "./stream-transform";
import { openSweAdapter } from "./adapters/openSwe";

function sourceFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]!));
      else controller.close();
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
  }
  return buf
    .split("\n\n")
    .filter(Boolean)
    .map((f) => f.replace(/^data: /, ""));
}

const lgEvent = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

describe("transformSseStream + openSweAdapter (end-to-end)", () => {
  it("turns a write_file tool run into a tool frame + a data-file part", async () => {
    const src = sourceFrom([
      lgEvent({
        event: "on_tool_start",
        name: "write_file",
        run_id: "r1",
        data: { input: { file_path: "/work/a.ts", content: "const x = 1\n" } },
      }),
      lgEvent({
        event: "on_tool_end",
        name: "write_file",
        run_id: "r1",
        data: { output: { content: "ok" } },
      }),
    ]);

    const out = await drain(transformSseStream(src, openSweAdapter.transforms));
    const parsed = out.map((s) => JSON.parse(s));
    const types = parsed.map((p) => p.type);

    // tool-input-start + data-file (from start), then tool-output-available.
    expect(types).toContain("tool-input-start");
    expect(types).toContain("tool-output-available");
    const fileParts = parsed.filter((p) => p.type === "data-file");
    expect(fileParts.length).toBeGreaterThanOrEqual(1);
    expect(fileParts[0].data.path).toBe("/work/a.ts");
    expect(fileParts[0].data.content).toBe("const x = 1\n");
  });

  it("emits data-sub-agent for a task tool and data-plan for save_plan", async () => {
    // Matched start/end per tool, in order (as LangGraph actually streams).
    const src = sourceFrom([
      lgEvent({
        event: "on_tool_start",
        name: "save_plan",
        run_id: "r2",
        data: { input: { plan_markdown: "# Do it" } },
      }),
      lgEvent({
        event: "on_tool_end",
        name: "save_plan",
        run_id: "r2",
        data: { output: "saved" },
      }),
      lgEvent({
        event: "on_tool_start",
        name: "task",
        run_id: "r2",
        data: { input: { subagent_type: "researcher", prompt: "go" } },
      }),
      lgEvent({
        event: "on_tool_end",
        name: "task",
        run_id: "r2",
        data: { output: "done" },
      }),
    ]);
    const parsed = (
      await drain(transformSseStream(src, openSweAdapter.transforms))
    ).map((s) => JSON.parse(s));
    const types = parsed.map((p) => p.type);
    expect(types).toContain("data-plan");
    expect(types.filter((t) => t === "data-sub-agent").length).toBe(2); // starting + done
    const done = parsed.find(
      (p) => p.type === "data-sub-agent" && p.data.status === "done"
    );
    expect(done.data.result).toBe("done");
  });

  it("handles LangGraph JOIN-stream frames (event: events\\ndata: …)", () => {
    // GET /threads/{tid}/runs/{rid}/stream prefixes each frame with an
    // `event: events` line. Drive the transforms directly (synchronous) so the
    // parsing — not the stream plumbing — is what's under test.
    const transforms = openSweAdapter.transforms;
    const run = (raw: string) => {
      let cur: { raw: string }[] = [{ raw }];
      for (const t of transforms) {
        const next: { raw: string }[] = [];
        for (const f of cur) {
          const r = (t as (x: { raw: string }) => unknown)(f);
          if (r == null) continue;
          Array.isArray(r)
            ? next.push(...(r as { raw: string }[]))
            : next.push(r as { raw: string });
        }
        cur = next;
      }
      return cur;
    };
    const joinFrame = (o: unknown) =>
      `event: events\ndata: ${JSON.stringify(o)}`;
    const frames = [
      joinFrame({
        event: "on_tool_start",
        name: "write_file",
        run_id: "j1",
        data: { input: { file_path: "/x.ts", content: "z\n" } },
      }),
      joinFrame({
        event: "on_chain_stream",
        name: "noise",
        run_id: "j1",
        data: {},
      }),
      joinFrame({
        event: "on_tool_end",
        name: "write_file",
        run_id: "j1",
        data: { output: { content: "ok" } },
      }),
    ];
    const parsed = frames.flatMap(run).map((f) => JSON.parse(f.raw.slice(6)));
    const types = parsed.map((p) => p.type);
    expect(types).toContain("tool-input-start");
    expect(types).toContain("data-file");
    // on_chain_* noise is dropped, not forwarded raw.
    expect(
      types.every(
        (t) =>
          typeof t === "string" &&
          (t.startsWith("tool-") || t.startsWith("data-") || t === "text-delta")
      )
    ).toBe(true);
  });

  it("splits CRLF frames (LangGraph Platform uses \\r\\n\\r\\n)", async () => {
    // Real LangGraph SSE: `event: events\r\ndata: {…}\r\n\r\n`.
    const crlf = (o: unknown) =>
      `event: events\r\ndata: ${JSON.stringify(o)}\r\n\r\n`;
    const src = sourceFrom([
      crlf({
        event: "on_tool_start",
        name: "write_file",
        run_id: "c1",
        data: { input: { file_path: "/a.ts", content: "1\n" } },
      }),
      crlf({
        event: "on_tool_end",
        name: "write_file",
        run_id: "c1",
        data: { output: { content: "ok" } },
      }),
    ]);
    const parsed = (
      await drain(transformSseStream(src, openSweAdapter.transforms))
    ).map((s) => JSON.parse(s));
    const types = parsed.map((p) => p.type);
    expect(types).toContain("tool-input-start");
    expect(types).toContain("data-file");
    // No raw event-prefixed blob leaked through.
    expect(types.every((t) => typeof t === "string")).toBe(true);
  });

  it("does not strand a buffered out-of-order tool end when the unblocking end is the final frame", async () => {
    // tool_b finishes before tool_a, so end_b is buffered. end_a (the LAST
    // frame) unblocks the drain, returning end_a immediately and pushing end_b
    // into readyQueue. With no further input frames and flush not touching the
    // transform, end_b is stranded — its tool-output-available never reaches
    // the client even though the tool finished.
    const src = sourceFrom([
      lgEvent({
        event: "on_tool_start",
        name: "tool_a",
        run_id: "rz",
        data: { input: {} },
      }),
      lgEvent({
        event: "on_tool_start",
        name: "tool_b",
        run_id: "rz",
        data: { input: {} },
      }),
      lgEvent({
        event: "on_tool_end",
        name: "tool_b",
        run_id: "rz",
        data: { output: "b-out" },
      }),
      lgEvent({
        event: "on_tool_end",
        name: "tool_a",
        run_id: "rz",
        data: { output: "a-out" },
      }),
    ]);
    const parsed = (
      await drain(transformSseStream(src, openSweAdapter.transforms))
    ).map((s) => JSON.parse(s));
    const outputs = parsed
      .filter((p) => p.type === "tool-output-available")
      .map((p) => p.output)
      .sort();
    expect(outputs).toEqual(["a-out", "b-out"]);
  });

  it("propagates an upstream mid-stream read error via controller.error (clean rejection, no hang)", async () => {
    // NEW (iter 2): the upstream succeeds for one frame then its pull throws,
    // making reader.read() reject. transformSseStream must surface that through
    // controller.error so the consumer's read() rejects cleanly — not swallow it
    // (truncated stream) nor leak an unhandled rejection.
    const enc = new TextEncoder();
    const boom = new Error("upstream exploded");
    let pulls = 0;
    const src = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls === 1) {
          controller.enqueue(
            enc.encode(
              lgEvent({
                event: "on_tool_start",
                name: "write_file",
                run_id: "e1",
                data: { input: { file_path: "/a.ts", content: "1\n" } },
              })
            )
          );
        } else {
          throw boom; // upstream read() rejects on the next pull
        }
      },
    });

    const reader = transformSseStream(
      src,
      openSweAdapter.transforms
    ).getReader();
    let caught: unknown;
    try {
      // First pull emits the transformed first frame(s); a later read triggers
      // the upstream throw and must reject.
      for (let i = 0; i < 10; i++) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(boom);
  });

  it("passes through frames split across chunk boundaries", async () => {
    const frame = lgEvent({
      event: "on_chat_model_stream",
      name: "model",
      run_id: "r3",
      data: { chunk: { content: "hello" } },
    });
    const mid = Math.floor(frame.length / 2);
    const src = sourceFrom([frame.slice(0, mid), frame.slice(mid)]);
    const parsed = (
      await drain(transformSseStream(src, openSweAdapter.transforms))
    ).map((s) => JSON.parse(s));
    expect(parsed).toEqual([{ type: "text-delta", delta: "hello" }]);
  });
});

describe("transformSseStream — adversarial framing (NEW, iter 3)", () => {
  // GAP (NEW): CRLF normalization runs PER-CHUNK via
  //   decoder.decode(value,{stream:true}).replace(/\r\n/g,"\n")
  // so a `\r\n` that is itself SPLIT across two reads — chunk A ends with the
  // `\r`, chunk B starts with the `\n` — is never collapsed. The frame separator
  // `\r\n\r\n` split between its third (`\r`) and fourth (`\n`) byte leaves a
  // stray `\r\n` mid-buffer that the accumulator's `\n\n` split does NOT treat as
  // a boundary. Two distinct frames MERGE into one; the base transform then
  // extracts only the first `data:` line (the second now begins with `\r`, so it
  // fails the `startsWith("data: ")` scan) and the SECOND frame's payload is lost.
  it("does not merge/lose frames when a CRLF boundary is split across chunks (chunk A ends \\r, chunk B starts \\n)", async () => {
    const crlfFrame = (content: string) =>
      `data: ${JSON.stringify({
        event: "on_chat_model_stream",
        name: "model",
        run_id: "x",
        data: { chunk: { content } },
      })}\r\n\r\n`;
    const full = crlfFrame("AAA") + crlfFrame("BBB");
    // Cut inside the FIRST frame's trailing `\r\n\r\n`, between the 2nd `\r` and
    // its `\n`: chunk A ends "...\r\n\r", chunk B starts "\n...".
    const cut = full.indexOf("\r\n\r\n") + 3;
    const src = sourceFrom([full.slice(0, cut), full.slice(cut)]);
    const deltas = (
      await drain(transformSseStream(src, openSweAdapter.transforms))
    )
      .map((s) => JSON.parse(s))
      .filter((p) => p.type === "text-delta")
      .map((p) => p.delta);
    // Both deltas must survive the split boundary.
    expect(deltas).toEqual(["AAA", "BBB"]);
  });

  // NEW DEFECT (iter 4): the base transform's reorder buffer (startOrder/
  // endBuffer) is GLOBAL across run_ids. When two INDEPENDENT runs interleave —
  // run A starts a tool, run B starts a tool, run B's tool ENDS — run B's end is
  // buffered behind run A's still-open start. If run A's tool never emits an end
  // within this stream (cancelled, errored, or the start belongs to an outer
  // scope whose end is on a different stream), run B's completed output is
  // STRANDED in endBuffer and never flushed → permanent data loss for a run that
  // actually finished. transformSseStream.flush() only flushes the accumulator,
  // not the transform's internal endBuffer.
  it("does not strand an independent run's completed output behind another run whose start has no end (cross-run head-of-line, permanent loss)", async () => {
    const src = sourceFrom([
      lgEvent({
        event: "on_tool_start",
        name: "tool_a",
        run_id: "run-A",
        data: { input: {} },
      }),
      lgEvent({
        event: "on_tool_start",
        name: "tool_b",
        run_id: "run-B",
        data: { input: {} },
      }),
      lgEvent({
        event: "on_tool_end",
        name: "tool_b",
        run_id: "run-B",
        data: { output: "b-out" },
      }),
      // stream ends here: run A's tool never emits on_tool_end.
    ]);
    const parsed = (
      await drain(transformSseStream(src, openSweAdapter.transforms))
    ).map((s) => JSON.parse(s));
    const bOut = parsed
      .filter((p) => p.type === "tool-output-available")
      .map((p) => p.output);
    // Run B finished — its output must reach the client regardless of run A.
    expect(bOut).toEqual(["b-out"]);
  });

  // INVARIANT LOCK (iter 4): a multibyte UTF-8 char (4-byte emoji) split across
  // two chunk reads must be reassembled by the streaming TextDecoder
  // (decode(value,{stream:true})) and survive intact end-to-end through framing
  // and transform — no mojibake, no replacement char, no frame corruption.
  it("reassembles a multibyte emoji split across chunk boundaries (streaming decoder)", async () => {
    const enc = new TextEncoder();
    const frameBytes = enc.encode(
      lgEvent({
        event: "on_chat_model_stream",
        name: "model",
        run_id: "u1",
        data: { chunk: { content: "hi😀end" } },
      })
    );
    // Cut 2 bytes into the 4-byte emoji sequence (0xF0 0x9F 0x98 0x80).
    const cut = frameBytes.indexOf(0xf0) + 2;
    const src = (() => {
      const chunks = [frameBytes.slice(0, cut), frameBytes.slice(cut)];
      let i = 0;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (i < chunks.length) controller.enqueue(chunks[i++]!);
          else controller.close();
        },
      });
    })();
    const parsed = (
      await drain(transformSseStream(src, openSweAdapter.transforms))
    ).map((s) => JSON.parse(s));
    expect(parsed).toEqual([{ type: "text-delta", delta: "hi😀end" }]);
  });

  // INVARIANT LOCK: an upstream that emits only DROPPED frames (on_chain_* noise)
  // and then closes must flush + close cleanly — no hang (vitest would time out),
  // no spurious output. Exercises the loop-until-output path returning via `done`.
  it("flushes and closes cleanly when no output frame is ever produced (all dropped)", async () => {
    const src = sourceFrom([
      lgEvent({ event: "on_chain_start", name: "c", run_id: "r", data: {} }),
      lgEvent({ event: "on_chain_stream", name: "c", run_id: "r", data: {} }),
      lgEvent({ event: "on_chain_end", name: "c", run_id: "r", data: {} }),
    ]);
    const out = await drain(transformSseStream(src, openSweAdapter.transforms));
    expect(out).toEqual([]);
  });
});

describe("transformSseStream — convergence integration locks (NEW, iter 6)", () => {
  // BROAD INTEGRATION LOCK: one realistic FULL run through the COMPLETE chain
  // (base + enrich) end-to-end over transformSseStream, frames chopped into tiny
  // arbitrary chunks. It mixes text-delta, a write_file (data-file on start +
  // authoritative upsert on end), a `task` sub-agent lifecycle under the main
  // run, and a read_file executed under a SECOND run_id (the sub-agent's own run)
  // whose end arrives WHILE the parent task is still open. The complete expected
  // set of output parts must appear, none dropped, with sane ordering — and the
  // sub-run's completed read_file output must NOT be stranded behind the still-open
  // parent task (cross-run head-of-line isolation, proven through real plumbing).
  it("emits the complete expected part-set for a full mixed run (text + file + cross-run sub-agent), arbitrarily chunk-split", async () => {
    const frames = [
      lgEvent({
        event: "on_chat_model_stream",
        name: "model",
        run_id: "main",
        data: { chunk: { content: "Working " } },
      }),
      lgEvent({
        event: "on_tool_start",
        name: "write_file",
        run_id: "main",
        data: {
          input: {
            file_path: "/app/index.ts",
            content: "export const x = 1\n",
          },
        },
      }),
      lgEvent({
        event: "on_tool_end",
        name: "write_file",
        run_id: "main",
        data: {
          output: {
            artifact: {
              diff: {
                filePath: "/app/index.ts",
                newContent: "export const x = 1\n",
                isNewFile: true,
              },
            },
          },
        },
      }),
      lgEvent({
        event: "on_tool_start",
        name: "task",
        run_id: "main",
        data: {
          input: { subagent_type: "researcher", prompt: "look into it" },
        },
      }),
      // read_file runs under the sub-agent's OWN run_id ("sub").
      lgEvent({
        event: "on_tool_start",
        name: "read_file",
        run_id: "sub",
        data: { input: { file_path: "/app/readme.md" } },
      }),
      // sub-run read_file finishes WHILE the parent task is still open.
      lgEvent({
        event: "on_tool_end",
        name: "read_file",
        run_id: "sub",
        data: { output: "the readme body" },
      }),
      lgEvent({
        event: "on_tool_end",
        name: "task",
        run_id: "main",
        data: { output: "research complete" },
      }),
      lgEvent({
        event: "on_chat_model_stream",
        name: "model",
        run_id: "main",
        data: { chunk: { content: "Done" } },
      }),
    ].join("");

    // Chop the whole concatenated stream into tiny 5-byte chunks so frame and
    // field boundaries fall at arbitrary points.
    const chunks: string[] = [];
    for (let i = 0; i < frames.length; i += 5)
      chunks.push(frames.slice(i, i + 5));

    const parsed = (
      await drain(
        transformSseStream(sourceFrom(chunks), openSweAdapter.transforms)
      )
    ).map((s) => JSON.parse(s));

    // Nothing leaked raw — every emitted frame is a typed JSON object.
    expect(parsed.every((p) => typeof p.type === "string")).toBe(true);

    // text-deltas survive in order.
    expect(
      parsed.filter((p) => p.type === "text-delta").map((p) => p.delta)
    ).toEqual(["Working ", "Done"]);

    // The write_file data-file (from start) carries the real file content.
    const writeFile = parsed.find(
      (p) => p.type === "data-file" && p.data.path === "/app/index.ts"
    );
    expect(writeFile).toBeDefined();
    expect(writeFile.data.content).toBe("export const x = 1\n");

    // Sub-agent lifecycle: starting + done, with the result on done.
    const subStatuses = parsed
      .filter((p) => p.type === "data-sub-agent")
      .map((p) => p.data.status);
    expect(subStatuses).toContain("starting");
    expect(subStatuses).toContain("done");
    const subDone = parsed.find(
      (p) => p.type === "data-sub-agent" && p.data.status === "done"
    );
    expect(subDone.data.result).toBe("research complete");

    // CROSS-RUN: the sub-run read_file completed and reached the client even
    // though the parent task (main run) was still open at that point.
    const readOut = parsed.find(
      (p) =>
        p.type === "tool-output-available" && p.output === "the readme body"
    );
    expect(readOut).toBeDefined();
    const readFile = parsed.find(
      (p) => p.type === "data-file" && p.data.content === "the readme body"
    );
    expect(readFile).toBeDefined();
    expect(readFile.data.path).toBe("/app/readme.md");

    // The parent task's own output also reaches the client.
    expect(
      parsed.some(
        (p) =>
          p.type === "tool-output-available" && p.output === "research complete"
      )
    ).toBe(true);
  });

  // CHAIN FAN-OUT LOCK: when the BASE transform unblocks a reorder drain and
  // returns an ARRAY of multiple tool-output-available frames in one call, the
  // pipeline must feed EACH array element through the enrich stage so EACH
  // file-tool end fans out its OWN data-file. Existing chain tests only drain at
  // the base level or use a single file tool; this verifies per-element
  // enrichment of a base-produced array. read_file then edit_file start; ends
  // arrive reversed so edit_file's end buffers and read_file's end drains both in
  // a single array — each must yield a correct data-file.
  it("fans out a data-file for EACH file-tool end when the base drains multiple ends as one array", async () => {
    const src = sourceFrom([
      lgEvent({
        event: "on_tool_start",
        name: "read_file",
        run_id: "rd",
        data: { input: { file_path: "/a.md" } },
      }),
      lgEvent({
        event: "on_tool_start",
        name: "edit_file",
        run_id: "rd",
        data: {
          input: { file_path: "/b.ts", old_string: "a", new_string: "b" },
        },
      }),
      // edit_file ends first → base buffers it (read_file is head of start order).
      lgEvent({
        event: "on_tool_end",
        name: "edit_file",
        run_id: "rd",
        data: {
          output: {
            artifact: {
              diff: {
                filePath: "/b.ts",
                newContent: "b = 2\n",
                isNewFile: false,
              },
            },
          },
        },
      }),
      // read_file ends → base emits read end + drains buffered edit end as ONE array.
      lgEvent({
        event: "on_tool_end",
        name: "read_file",
        run_id: "rd",
        data: { output: "alpha contents" },
      }),
    ]);

    const parsed = (
      await drain(transformSseStream(src, openSweAdapter.transforms))
    ).map((s) => JSON.parse(s));

    // Both tool-output-available frames survive the array drain.
    const outs = parsed
      .filter((p) => p.type === "tool-output-available")
      .map((p) => p.output);
    expect(outs).toContainEqual("alpha contents");
    expect(outs.some((o) => typeof o === "object" && o !== null)).toBe(true); // edit's artifact output

    // EACH drained file-tool end fanned out its own correct data-file.
    const files = parsed.filter((p) => p.type === "data-file");
    const readFile = files.find((p) => p.data.path === "/a.md");
    const editFile = files.find((p) => p.data.path === "/b.ts");
    expect(readFile).toBeDefined();
    expect(readFile.data.content).toBe("alpha contents");
    expect(editFile).toBeDefined();
    expect(editFile.data.content).toBe("b = 2\n");
  });
});
