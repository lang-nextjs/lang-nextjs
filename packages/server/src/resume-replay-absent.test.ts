import { describe, it, expect, vi, afterEach } from "vitest";
import { NextRequest } from "next/server";

// DELIBERATELY NOT MOCKING ./stream-registry.
//
// reconnect.test.ts mocks it at module scope, so every assertion there runs
// against a fabricated record. That is a fine unit test of the handler's
// branching, and it is why the gap below was invisible: the handler was only
// ever asked about records the test itself invented.
//
// This file uses the REAL registry, registered the way production registers,
// so it observes what an actual resume request gets back.
import { createDeepAgentsResumeHandler } from "./reconnect";
import { atomicRegisterIfAbsent, deleteStream } from "./stream-registry";

/**
 * ABSENCE MARKER — this test pins a GAP, not a behaviour.
 *
 * Resume replay is NOT IMPLEMENTED. `registerStream(resumeId, streamId, stream?)`
 * accepts a stream, but the only production call site is
 * `handler.ts` -> `atomicRegisterIfAbsent(resumeId, crypto.randomUUID())`,
 * which passes TWO arguments. Across packages/ and apps/, the three-argument
 * form has ZERO call sites. So `record.stream` is always `undefined` and
 * `reconnect.ts` returns 204 for every resume request, including ones that
 * find a live registered record.
 *
 * ===> IF THIS TEST FAILS, CHECK WHETHER REPLAY WAS IMPLEMENTED BEFORE
 * ===> ASSUMING A BUG. When replay lands, DELETE this file — do not update it
 * ===> to match the new behaviour. Its whole purpose is to stop existing.
 *
 * Why it exists: #160 credited apps/example with "resume after disconnect"
 * because e2e/shared/reconnect.spec.ts has four tests whose names read as
 * end-to-end coverage. All four intercept the resume endpoint with
 * `page.route` and fulfil a fabricated SSE body — including the one called
 * "resume protocol body is consumed: real SSE response renders on mount".
 * They are good CLIENT tests. Nothing anywhere asserted the SERVER half, in
 * either direction, so a capability nobody had shipped sat in a matrix as a
 * measured fact.
 */
describe("resume replay is NOT implemented (absence marker — delete when it is)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /**
   * The QUERY form, which is what the client sends — see
   * packages/react/src/hook.ts:170. This built the PATH form and passed the id
   * a second time as a route param, which is how it kept passing while every
   * real request 404'd: the test supplied the id by a route nothing uses.
   */
  function makeRequest(resumeId: string): NextRequest {
    return new NextRequest(
      `http://localhost/api/chat/stream/resume?resumeId=${resumeId}`
    );
  }

  it("returns 204 for a LIVE registered record, because no stream is ever stored", async () => {
    vi.stubEnv("ENABLE_STREAM_RECONNECT", "true");
    const resumeId = `absence-marker-${Math.random().toString(36).slice(2)}`;

    // Register exactly as handler.ts:374 does — two arguments, no stream.
    const reg = atomicRegisterIfAbsent(resumeId, "stream-id-1");
    expect(reg.ok, "precondition: the id must register").toBe(true);

    try {
      const GET = createDeepAgentsResumeHandler();
      const response = await GET(makeRequest(resumeId));

      // 204, NOT 200 — the record exists and is not done, so this is not the
      // "no record" path. It is the "record has no stream" path, which is the
      // gap itself.
      expect(
        response.status,
        "204 here means replay is unimplemented. A 200 means replay landed — delete this file."
      ).toBe(204);
      expect(await response.text()).toBe("");
    } finally {
      deleteStream(resumeId);
    }
  });

  it("the production registration path cannot store a stream even if one exists", async () => {
    vi.stubEnv("ENABLE_STREAM_RECONNECT", "true");
    const resumeId = `absence-marker-${Math.random().toString(36).slice(2)}`;

    // A real stream exists here. Production still never passes it, so a resume
    // cannot return it. This pins the CAUSE, not just the symptom: if someone
    // wires the stream through, this assertion is what tells them the marker
    // is obsolete rather than broken.
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("data: {}\n\n"));
        c.close();
      },
    });
    expect(stream).toBeInstanceOf(ReadableStream);

    atomicRegisterIfAbsent(resumeId, "stream-id-2"); // <- the two-arg production shape
    try {
      const GET = createDeepAgentsResumeHandler();
      const response = await GET(makeRequest(resumeId));
      expect(response.status).toBe(204);
    } finally {
      deleteStream(resumeId);
    }
  });
});
