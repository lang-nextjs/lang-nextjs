/**
 * Adversarial iter 3 — direct test for SseFrameAccumulator.
 *
 * The accumulator was previously excluded from this package's coverage
 * (covered only via packages/server). This file is a focused probe to
 * expose CRLF cross-platform compatibility edge cases.
 */
import { describe, it, expect } from "vitest";
import { SseFrameAccumulator } from "./accumulator";

describe("SseFrameAccumulator — CRLF terminators", () => {
  it("frames terminated with \\r\\n\\r\\n (CRLF) ARE split — delimiter is CRLF-aware per SSE spec", () => {
    // SSE spec (HTML living standard, "Server-Sent Events") says events are
    // separated by a blank line, defined as "\n\n" OR "\r\n\r\n" depending on
    // the platform. The accumulator normalizes CRLF/CR to LF before splitting
    // so both Windows-hosted (CRLF) and Unix (LF) backends work.
    //
    // This test pins the FIXED contract: CRLF frames ARE split correctly.
    // A backend (e.g. a Windows-hosted Python server using sys.stdout.write
    // with \r\n endings) emitting CRLF frames now delivers both events to
    // the client instead of deadlocking.
    const acc = new SseFrameAccumulator();

    // Two CRLF-terminated frames.
    const crlfStream = 'data: {"id":1}\r\n\r\ndata: {"id":2}\r\n\r\n';
    const frames = acc.push(crlfStream);

    // FIXED BEHAVIOR: both frames are extracted (delimiters consumed by split).
    expect(frames).toEqual(['data: {"id":1}', 'data: {"id":2}']);
    // Buffer is empty after the split — nothing left to flush.
    expect(acc.flush()).toEqual([]);
  });
});
