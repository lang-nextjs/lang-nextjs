/**
 * E2E spec for the HITL (human-in-the-loop) approval demo.
 *
 * Walks the full client⇄server flow through the example app:
 *   1. Visit /hitl-demo
 *   2. Click "Start demo run" → useDeepAgentsChat POSTs /api/hitl-demo
 *   3. The proxy (createDeepAgentsHandler + approvalGating) fetches
 *      /api/hitl-demo/backend and intercepts tool-input-start
 *   4. data-approval-required arrives at the client; the page renders ApprovalCard
 *   5. Click approve / reject / edit / respond → POST /api/approval/[id]
 *   6. Proxy drains buffered frames or emits data-error / data-human-response
 *   7. Assert the visible result
 *
 * Notes
 *   - Approve/edit assertions verify the post-approval continuation text
 *     ("Done. Two files in /tmp.") arrives. This proves the gate released
 *     and the stream proceeded — it does NOT rely on AI SDK v6's tool-call
 *     assembly (which uses a strictObject schema that rejects tool-input-start
 *     frames carrying an `input` field — an orthogonal compatibility concern).
 *   - Each test creates a fresh in-memory approval (random UUID server-side),
 *     so tests are independent even though the registry is a process singleton.
 */

import { test, expect } from "@playwright/test";
import type { Page, TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { SSE_HEADERS, makeDataPartsSseBody } from "./shared/sse-fixtures";

/* -------------------------------------------------------------------------- */
/*  #114 — make the failure say what happened                                 */
/* -------------------------------------------------------------------------- */

/**
 * WHY THIS EXISTS. `cross-tab isolation` fails on webkit in CI and nowhere
 * else — not on macOS webkit (30/30), not locally on any browser (20/20), not
 * under 8 concurrent streams. Three CI artifacts told the same story and could
 * not tell us WHY:
 *
 *   Status: streaming
 *   Conversation: "You: List the files in /tmp   Agent:"
 *   POST /api/hitl-demo -> 200 in 35ms, then nothing for 15s
 *
 * The one question that separates every remaining explanation is whether the
 * BROWSER RECEIVED ANY BYTES. A page snapshot cannot answer it: an empty
 * "Agent:" looks identical whether no frames arrived, frames arrived and were
 * rejected by a schema (#140 — a rejected part is indistinguishable from an
 * absent one), or frames arrived and React never rendered.
 *
 * Playwright's own trace does not answer it either. It records the SSE response
 * as `bodySize=-1 receive=-1` because the stream is still open when the test
 * ends, and that is what a healthy stream looks like too.
 *
 * So this tees the response body inside the page. It costs nothing on a passing
 * run and is attached only on failure.
 *
 * TO READ THE RESULT OUT OF A CI ARTIFACT: `node scripts/attach-owner.mjs <report-dir>
 * sse-received`. The HTML reporter content-hashes attachment filenames and keeps the
 * test -> attachment mapping base64'd inside index.html, so grepping the artifact for
 * `sse-received` finds nothing while the attachment is plainly there.
 */

/** Records every chunk the page receives on a hitl-demo stream. */
/**
 * WAIT FOR THE APPROVAL CARD, AND SAY WHAT THE STREAM WAS DOING IF IT NEVER CAME.
 *
 * THIS DOES NOT REDUCE THE FLAKE RATE. AT ALL. It converts an occurrence from
 * noise into a labelled observation. A legibility change is not a repair, and
 * nobody should stop looking for the cause because the failures got readable.
 *
 * WHY THIS EXISTS (#675). Every webkit occurrence measured failed at exactly this
 * precondition, with a call log one line long:
 *
 *     - Expect "toBeVisible" with timeout 15000ms
 *     - waiting for getByTestId('approval-card')
 *
 * Nothing resolved. No partial content, no wrong content, no element. Two such
 * logs sat in CI for a day before anyone could extract anything from them,
 * because a bare visibility timeout cannot distinguish the two worlds it covers:
 * the stream was still in flight and would have produced a card a second later,
 * or the stream had finished and no card was ever coming. Those are slowness and
 * a defect respectively, and they want opposite responses.
 *
 * THE STATUS SEPARATES THEM, which is the only reason it is captured here. It is
 * NOT a signal to wait on instead — measured on webkit, it reads `streaming` at
 * the moment the card is expected, because this flow SUSPENDS at the interrupt
 * while a human decides. There is no terminal value to wait for before the card,
 * by construction. (That is also why the `toHaveText("done")` pattern in
 * shared/remix.spec.ts and shared/sveltekit.spec.ts is correct THERE and
 * inapplicable HERE: those flows run to completion; this one is designed not to.)
 * Waiting on `streaming` instead would relocate the same race onto an earlier
 * frame delivered over the same SSE.
 *
 * ── GIVE UP ON EVIDENCE, NOT ON A CLOCK ──────────────────────────────────────
 *
 * The instrument above fired for the first time on 2026-09-04 (run 33871493239,
 * attempt 1) and said:
 *
 *     stream state when we gave up : Status: streaming
 *     frames rendered              : ai-msg=1 tool-call-msg=0
 *
 * Identical on the retry. Two things follow, and the second was a surprise.
 *
 * NOT `idle`, so this was the slowness arm, not the defect arm — the exit
 * condition #675 was left open for, answered on its first occurrence.
 *
 * AND THERE WAS PARTIAL CONTENT, which the paragraph above says there is not
 * ("Nothing resolved. No partial content"). The assistant text frame had
 * arrived AND PAINTED; the tool-call frame, on the same still-open response,
 * had not, fifteen seconds later. So the subject is not "the stream never
 * starts" — it is a stall BETWEEN FRAMES of a response that is still open.
 *
 * That makes a fixed deadline the wrong instrument. `15000ms` is a clock, and
 * the fact that decides this case is whether the stream is still moving:
 *
 *   Status: idle       nothing more is coming. FAIL NOW — and this is strictly
 *                      faster than the old behaviour, which sat out the full
 *                      timeout before reporting a defect it could already see.
 *   still in flight    extend ONCE, bounded, and SAY SO on stdout.
 *
 * WHY THIS IS NOT "RAISE THE TIMEOUT" (option (b), rejected on this issue). A
 * longer timeout waits out the defect arm too, which is the half that should
 * get stricter. This asks a different question at the deadline, and answers the
 * two arms in opposite directions.
 *
 * WHY IT IS NOT A MUTE BUTTON EITHER. An absorbed occurrence stops being a
 * Playwright `flaky`, and `scripts/measure-e2e-flake.mjs` reads the flaky block
 * — so absorbing them silently would zero out the only rate this issue has. The
 * marker below is greppable and that script counts it as its own partition.
 * Suppressing the symptom while keeping the measurement is the whole bargain;
 * without the second half this would be the mute button #675 argued against.
 */
const EXTENSION_MARKER = "[#675-EXTENSION]";

/**
 * The frame the card is rendered FROM.
 *
 * `tool-input-start` never reaches the browser: the proxy mounts approvalGating
 * and the transform REPLACES it with this. So the wire question is about this
 * type, not the backend's.
 *
 * Depending on the TYPE is safe in a way that depending on its payload is not:
 * the approval frame- and pause-conformance tests pin the adapter's part against
 * the card's schema, so a rename goes red. The layout has no such guarantee
 * (#420 owns it and calls it provisional), and nothing here reads inside it.
 */
const APPROVAL_FRAME = "data-approval-required";

/** What the page can tell us about the stream, at the moment we ask. */
async function readStreamState(page: Page) {
  const status =
    (await page
      .getByTestId("status")
      .textContent()
      .catch(() => null)) ?? "<status element absent>";
  const ai = await page.getByTestId("ai-msg").count();
  const tools = await page.getByTestId("tool-call-msg").count();
  /*
   * THE WIRE, NOT ONLY THE DOM (#675).
   *
   * The three readings above are rendered elements, so `tool-call-msg=0` cannot
   * separate "never emitted" from "arrived and was not applied" — opposite
   * defects wanting opposite repairs, and the distinction this issue has turned
   * on through three passes.
   *
   * The evidence was already captured: the fetch wrapper above tees every
   * hitl-demo body into `__sse` and counts requests in `__sseAsked`. It was
   * attached as `sse-received` and never read HERE, so answering the question
   * cost a CI artifact download while this message looked complete. That is the
   * defect this file exists to prevent, in this file's own diagnostic.
   */
  const wire = await page
    .evaluate(() => {
      const w = window as unknown as {
        __sse?: string[];
        __sseAsked?: number;
        __sseAt?: number[];
        __sseHeadAt?: number;
      };
      return {
        chunks: w.__sse ?? [],
        asked: w.__sseAsked ?? 0,
        at: w.__sseAt ?? [],
        headAt: w.__sseHeadAt,
      };
    })
    .catch(() => null);
  return { status, ai, tools, wire };
}

type StreamState = Awaited<ReturnType<typeof readStreamState>>;

/**
 * A window of the body that KEEPS THE DISCRIMINATOR.
 *
 * Centred on the marker rather than cut at a fixed offset, because a fixed slice
 * has cost this repository a verdict before: a 200-character cut removed the
 * bytes the answer turned on and two different cases rendered as identical
 * bullets. If what is being decided is whether a token is present, the window
 * must contain the place it would be — and the label must say it was cut.
 */
export function clipAround(body: string, marker: string, span = 240) {
  const at = body.indexOf(marker);
  if (body.length <= span * 2)
    return { label: `wire, in full (${body.length} bytes):`, text: body };
  if (at === -1)
    return {
      label: `wire, FIRST ${span * 2} of ${
        body.length
      } bytes (marker absent — nothing to centre on) — CLIPPED:`,
      text: body.slice(0, span * 2),
    };
  const from = Math.max(0, at - span);
  const to = Math.min(body.length, at + marker.length + span);
  return {
    label: `wire, ${to - from} bytes CENTRED ON ${marker} (of ${
      body.length
    }) — CLIPPED:`,
    text: body.slice(from, to),
  };
}

/**
 * What the wire says, as a READING rather than a dump.
 *
 * FOUR DISTINCT ANSWERS, because a block rendering the same text on every
 * failing run is decoration — it reassures a reader without telling them
 * anything, and is indistinguishable from one that works. Two of the four point
 * at opposite halves of the system.
 */
/*
 * PARAMETER NARROWED TO WHAT IT READS (#770). `StreamState["wire"]` now also
 * carries timing, and this function reads none of it. Typing the parameter as
 * the subset it actually uses keeps the WIRE-0N fixtures — which construct
 * `{ chunks, asked }` by hand — valid without teaching them about a field this
 * function ignores. A fixture forced to supply data the code under test never
 * looks at is a fixture that will drift.
 */
export function wireReading(
  wire: { chunks: string[]; asked: number } | null
): string[] {
  if (wire === null)
    return [
      `  wire                         : COULD NOT READ the page — it may have closed.`,
      `                                 Not evidence of absence: the recorder was never asked.`,
    ];
  if (wire.asked === 0)
    return [
      `  wire                         : this page never REQUESTED a hitl-demo stream (asked=0).`,
      `                                 Nothing was dropped — nothing was fetched. A tab that only`,
      `                                 POSTs through the request context reads this way legitimately.`,
    ];
  if (wire.chunks.length === 0)
    return [
      `  wire                         : requested ${wire.asked}, received ZERO chunks.`,
      `                                 The stream opened and delivered nothing, so the frame was`,
      `                                 not lost between arrival and render — it never arrived.`,
    ];

  const body = wire.chunks.join("");
  const present = body.includes(APPROVAL_FRAME);
  const clip = clipAround(body, APPROVAL_FRAME);
  return [
    `  wire                         : requested ${wire.asked}, ${wire.chunks.length} chunk(s), ${body.length} bytes`,
    present
      ? `  ${APPROVAL_FRAME}       : PRESENT ON THE WIRE. It reached this browser and no card`
      : `  ${APPROVAL_FRAME}       : ABSENT. Chunks arrived; this frame was not among them.`,
    present
      ? `                                 rendered — the defect is BETWEEN RECEIPT AND RENDER, and`
      : `                                 The defect is UPSTREAM of this browser: the gate did not`,
    present
      ? `                                 waiting longer cannot help.`
      : `                                 emit it, or it was lost in transit.`,
    ``,
    `  ${clip.label}`,
    `    ${clip.text}`,
  ];
}

/**
 * WHEN THE STREAM MOVED — the axis eight occurrences of #675 do not record (#770).
 *
 * Every occurrence so far carries an IDENTICAL wire reading: one chunk, 39 bytes,
 * `text-start` and nothing after. The bytes are settled. What is NOT settled is
 * whether the run was slow to be SERVED, or served promptly and then stalled —
 * and those want opposite investigations. The first is the environment; the
 * second is the transport.
 *
 * THE BASELINE IS A MEASUREMENT, NOT A GUESS. On an unloaded machine, a plain
 * non-browser client against the same dev server and the same route saw response
 * headers at 98ms and its first chunk at 101ms, carrying all four frames. Any
 * failing run can be read against those two numbers.
 *
 * WHY A SEPARATE FUNCTION, for the same reason `wireReading` is one: the render
 * path can only produce the timings a real failure happens to have, so a test
 * driving this directly is the only thing that can assert the SLOW and STALLED
 * branches differ. A reading that renders both alike is decoration.
 *
 * WHAT THIS DOES NOT DO. It records timing at the moment of failure; it does not
 * establish that timing is the cause. #770 exists because the environment is the
 * axis that separates a failing CI run from 57 passing local ones — not because
 * load has been shown to be the mechanism. No load instrumentation belongs in
 * the shared workflow until a correlation says it is real.
 */
export function timingReading(
  t: { at: number[]; headAt?: number } | null
): string[] {
  if (!t || t.headAt === undefined) {
    return [
      `  timing                       : COULD NOT READ — no hitl-demo request was`,
      `                                 stamped, so this says nothing about the`,
      `                                 environment either way.`,
    ];
  }
  const ms = (n: number) => `${Math.round(n)}ms`;
  const first = t.at.length > 0 ? t.at[0]! : undefined;
  // The largest silence between consecutive chunks, and where it fell. A stall
  // is one enormous gap; contention is a slow START with ordinary gaps after.
  let gap = 0;
  let gapAfter = 0;
  for (let i = 1; i < t.at.length; i++) {
    const d = t.at[i]! - t.at[i - 1]!;
    if (d > gap) {
      gap = d;
      gapAfter = i;
    }
  }
  const SLOW_HEADERS = 1_000;
  const slow = t.headAt > SLOW_HEADERS;
  return [
    `  request -> headers           : ${ms(
      t.headAt
    )}  (baseline 98ms, unloaded)`,
    first === undefined
      ? `  -> first chunk               : NEVER — headers arrived, no chunk did`
      : `  -> first chunk               : ${ms(
          first
        )}  (baseline 101ms, unloaded)`,
    t.at.length > 1
      ? `  largest gap between chunks   : ${ms(
          gap
        )} (after chunk ${gapAfter} of ${t.at.length})`
      : `  largest gap between chunks   : n/a — ${t.at.length} chunk(s) arrived`,
    slow
      ? `  SLOW TO BE SERVED: headers took ${ms(
          t.headAt
        )} against a 98ms baseline, so this`
      : `  SERVED PROMPTLY, THEN STOPPED: headers took ${ms(
          t.headAt
        )} against a 98ms`,
    slow
      ? `  run was starved before the stream began. Read it as the ENVIRONMENT`
      : `  baseline, so the run was NOT starved. The stream opened on time and then`,
    slow
      ? `  (runner contention), not as the transport.`
      : `  stopped delivering. Read it as the TRANSPORT, not the environment.`,
  ];
}

function giveUpMessage(waited: number, s: StreamState, extended: boolean) {
  return [
    `approval card never appeared within ${waited}ms.`,
    `  stream state when we gave up : ${s.status}`,
    `  frames rendered              : ai-msg=${s.ai} tool-call-msg=${s.tools}`,
    ...wireReading(s.wire),
    ...timingReading(s.wire),
    extended
      ? `  (the deadline was already EXTENDED once because the stream was still`
      : `  (no extension: see the reading below)`,
    extended
      ? `   in flight at the base deadline — so this is not mere slowness)`
      : ``,
    ``,
    `HOW TO READ THAT (#675):`,
    `  "Status: idle"      the stream FINISHED and emitted no card. A DEFECT —`,
    `                      waiting longer would not have helped, and this call`,
    `                      failed as soon as it saw that rather than waiting.`,
    `  "Status: submitted" or "streaming": still in flight even after the`,
    `                      extension. The known engine flake is webkit 15,`,
    `                      firefox 1, chromium 0 over identical specs — but an`,
    `                      occurrence that survives the extension is worse than`,
    `                      the ones that motivated it. Read the frame counts.`,
    `  ai-msg=0 tool-call-msg=0: nothing arrived at all, so the stream did not`,
    `                      merely lag on this frame.`,
    ``,
    `  AND READ THE WIRE LINE BEFORE CONCLUDING ANYTHING (#675). The frame counts`,
    `  are RENDERED elements; the wire line is what this browser RECEIVED.`,
    `  "PRESENT ON THE WIRE" with no card is a different defect from "ABSENT",`,
    `  and they want opposite repairs. Before this line existed the two were`,
    `  indistinguishable from a failure message, and telling them apart cost a CI`,
    `  artifact download — which is why three passes at this issue did not.`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

async function expectApprovalCard(page: Page, timeout = 15_000) {
  const card = page.getByTestId("approval-card");
  try {
    await expect(card).toBeVisible({ timeout });
    return card;
  } catch (cause) {
    const state = await readStreamState(page);

    /*
     * THE DEFECT ARM, AND IT NOW FAILS IMMEDIATELY. A finished stream carrying
     * no card is not going to produce one; every millisecond spent waiting for
     * it was always wasted, and under the change below it would have been
     * doubled.
     */
    if (/\bidle\b/i.test(state.status)) {
      throw new Error(giveUpMessage(timeout, state, false), { cause });
    }

    /*
     * THE SLOWNESS ARM. One extension, the same size as the base wait, so the
     * worst case stays a number a reader can predict rather than a retry loop.
     */
    const where = (() => {
      try {
        const i = test.info();
        return `[${i.project.name}] › ${
          i.file.split("/e2e/")[1] ? "e2e/" + i.file.split("/e2e/")[1] : i.file
        }:${i.line}`;
      } catch {
        return "[unknown] › <outside a test>";
      }
    })();
    console.log(
      `${EXTENSION_MARKER} ${where} base=${timeout}ms status="${state.status}" ` +
        `ai-msg=${state.ai} tool-call-msg=${state.tools}`
    );

    try {
      await expect(card).toBeVisible({ timeout });
      console.log(
        `${EXTENSION_MARKER} ${where} card appeared during the extension ` +
          `(total <= ${timeout * 2}ms) — occurrence absorbed, still counted`
      );
      return card;
    } catch (cause2) {
      throw new Error(
        giveUpMessage(timeout * 2, await readStreamState(page), true),
        { cause: cause2 }
      );
    }
  }
}

async function recordStreamChunks(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __sse?: string[];
      __sseAsked?: number;
      __sseAt?: number[];
      __sseT0?: number;
      __sseHeadAt?: number;
    };
    w.__sse = [];
    /*
     * WHEN, NOT ONLY WHAT (#770). `__sse` records the bytes; these record the
     * clock. Eight occurrences of #675 carry eight IDENTICAL wire readings and
     * nothing about the machine — which is the axis that now separates a
     * failing run from a passing one, since the same specs pass 57/57 locally.
     *
     * Parallel arrays rather than a richer element type, DELIBERATELY: the
     * WIRE-0N cases and `wireReading` read `__sse` as string[], and changing its
     * shape to carry timing would rewrite the assertions that caught the last
     * defect. Additive costs one index and breaks nothing.
     */
    w.__sseAt = [];
    w.__sseT0 = undefined;
    w.__sseHeadAt = undefined;
    /*
     * ASKED, NOT JUST RECEIVED — the third spelling (#114).
     *
     * `__sse` starts empty, so a page that NEVER REQUESTED a hitl-demo stream and a page that
     * requested one and received nothing both end up with []. Two distinguishable states, one
     * spelling, and the alarming one wins: on 2026-08-31 that reported `sse-received-tabB`
     * from the shared-registry cross-tab test as "the stream opened and delivered nothing",
     * and it was published as the first evidence constraining WHERE the fault is. That tab
     * never navigates — its only action is `tabB.request.post(...)`, which uses Playwright's
     * request context and never touches this fetch at all. Zero bytes was correct for it.
     *
     * Counting requests separates the two, and it is the same defect this whole file exists
     * to make visible: a part that is dropped and a part that never arrived produce the same
     * screen.
     */
    w.__sseAsked = 0;
    const realFetch = window.fetch;
    window.fetch = async (...args: Parameters<typeof fetch>) => {
      // Stamped BEFORE the await: this is when the request was ISSUED, so the
      // headers figure below includes time spent waiting to be served — which
      // is the part a contended runner would inflate.
      const t0 = performance.now();
      const res = await realFetch(...args);
      const url =
        typeof args[0] === "string"
          ? args[0]
          : String((args[0] as Request).url ?? "");
      if (!url.includes("/api/hitl-demo")) return res;
      // First hitl-demo request wins: a later one must not reset the origin and
      // make earlier offsets read as negative.
      if (w.__sseT0 === undefined) {
        w.__sseT0 = t0;
        w.__sseHeadAt = performance.now() - t0;
      }
      // Counted on REQUEST, before the body is inspected: a response with no body is still a
      // stream this page asked for, and must not read as "never asked".
      w.__sseAsked = (w.__sseAsked ?? 0) + 1;
      if (!res.body) return res;
      // Tee the body: one branch to the app, one to the recorder. Consuming it
      // here without teeing would starve the app and INVENT the failure this
      // is meant to observe.
      const [toApp, toProbe] = res.body.tee();
      void (async () => {
        const reader = toProbe.getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { done, value } = await reader
            .read()
            .catch(() => ({ done: true, value: undefined }));
          if (done) break;
          w.__sse!.push(dec.decode(value, { stream: true }));
          w.__sseAt!.push(performance.now() - (w.__sseT0 ?? t0));
        }
      })();
      return new Response(toApp, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    };
  });
}

/**
 * Evidence for the test currently running, handed to `afterEach`.
 *
 * COLLECTED IN THE TEST, ATTACHED AFTERWARDS, AND THE SPLIT IS THE POINT.
 * `testInfo.status` inside the test body is still "passed" — Playwright
 * finalises it only once the test function has returned. The first version of
 * this guarded on `status === expectedStatus` in the `finally` and therefore
 * returned early on EVERY run, attaching nothing at all while looking correct.
 * It was caught by forcing a failure and finding no attachment.
 *
 * So the pages are read while they are still open, and the decision to attach
 * is made in `afterEach`, where the status is real. One test runs at a time per
 * worker, so a single slot is enough.
 */
/** Read what each page received and attach it. Cheap; safe on a pass. */
async function collectStreamEvidence(
  testInfo: TestInfo,
  pages: Array<{ label: string; page: Page }>
): Promise<void> {
  for (const { label, page } of pages) {
    let body: string;
    try {
      const probe = await page.evaluate(() => {
        const w = window as unknown as {
          __sse?: string[];
          __sseAsked?: number;
        };
        /*
         * THE PRECONDITION, READ ALONGSIDE THE STREAM (#615).
         *
         * `asked === 0` has two worlds in it and the message below used to give
         * them one voice. A page that never NAVIGATED here correctly never asks
         * — that is the cross-tab case #620 separated. But a page that navigated
         * and NEVER BECAME INTERACTIVE also never asks, because the request is
         * fired by clicking `start-button`. That second world is the shape
         * behind both suite-wide collapses on 2026-08-29: 61 and 48 spec
         * locations in one run each, every one of them
         * `expect(getByTestId("chat-input")).toBeEnabled()` timing out at line
         * 81 of a shared helper. ONE broken precondition, amplified by the
         * helper's fan-out.
         *
         * Reported as "says NOTHING about transport", that world reads as
         * benign and sends the reader away from a real failure. So the DOM is
         * read too, and the branch below names which world it was.
         */
        const byId = (id: string) =>
          document.querySelector(`[data-testid="${id}"]`);
        const starter = byId("start-button");
        return {
          chunks: w.__sse ?? [],
          asked: w.__sseAsked ?? 0,
          path: location.pathname,
          mounted: Boolean(byId("hitl-demo-page")),
          starter: !starter
            ? "absent"
            : starter.hasAttribute("disabled")
            ? "present-but-disabled"
            : "present-and-enabled",
        };
      });
      const { chunks, asked, path, mounted, starter } = probe;
      /*
       * EACH MESSAGE CLAIMS ONLY WHAT ITS OWN CASE ESTABLISHES. The previous single no-bytes
       * message asserted "the stream opened and delivered nothing" — a claim about the STREAM,
       * from an instrument that only knows about the ARRAY. It could not tell whether anything
       * had been requested, so it said the alarming thing in both cases and was quoted forward
       * as evidence for a stall it could not see.
       */
      if (asked === 0 && !path.includes("/hitl-demo")) {
        body =
          `THIS PAGE NEVER NAVIGATED TO hitl-demo (path: ${path}).\n` +
          "EXPECTED for a page that only drives the API — a `request.post` from a second\n" +
          "context does not go through this fetch — and for one that never navigated.\n" +
          "This says NOTHING about transport: no stream was opened to have failed.";
      } else if (asked === 0 && !mounted) {
        body =
          `THE PRECONDITION NEVER BECAME INTERACTIVE. The page is at ${path} but\n` +
          "`hitl-demo-page` never rendered, so nothing could click `start-button` and\n" +
          "no stream was ever requested.\n\n" +
          "THIS IS NOT A TRANSPORT FAILURE and must not be read as one. It is the shape\n" +
          "behind the two suite-wide collapses on 2026-08-29 — one surface that never\n" +
          "came up, amplified across every spec sharing the setup helper. Look at what\n" +
          "the app served, not at the stream.";
      } else if (asked === 0 && starter !== "present-and-enabled") {
        body =
          `THE SURFACE MOUNTED BUT ITS STARTER WAS ${starter}. The page is at ${path},\n` +
          "`hitl-demo-page` rendered, and `start-button` never reached a clickable\n" +
          "state — so no stream was requested. Between the two worlds above: the app\n" +
          "served something, and it did not finish becoming usable.";
      } else if (asked === 0) {
        body =
          `THE SURFACE WAS READY AND NO STREAM WAS REQUESTED. Path ${path},\n` +
          "`hitl-demo-page` present, `start-button` enabled — and nothing asked for a\n" +
          "stream. The failure is upstream of the transport and downstream of render:\n" +
          "the test did not get as far as starting a run.";
      } else if (chunks.length === 0) {
        body =
          `A STREAM WAS REQUESTED (${asked}) AND DELIVERED NOTHING — no bytes reached the browser.\n` +
          "The request was intercepted here, so it was made; the body yielded no chunks.\n" +
          "That rules out schema rejection and client rendering, and puts the fault\n" +
          "upstream of the browser.";
      } else {
        body =
          `${asked} request(s), ${chunks.length} chunk(s), ` +
          `${chunks.join("").length} bytes. ` +
          `Precondition at capture: path ${path}, mounted=${mounted}, ` +
          `starter=${starter}.\n\n${chunks.join("")}`;
      }
    } catch (e) {
      /*
       * COULD NOT TELL, AND SAYS SO. A probe that throws leaves BOTH questions
       * open — whether bytes arrived and whether the surface came up — and a
       * message naming either one would be a claim this run cannot support.
       */
      body =
        `COULD NOT TELL. The recorder did not read back, so this run says nothing\n` +
        `about either transport or the precondition: ${String(e)}`;
    }
    /*
     * BY PATH, NOT BY BODY — AND THAT DISTINCTION IS THE WHOLE FIX.
     *
     * Two earlier versions of this produced nothing in CI:
     *
     *   1. attached from `afterEach`, where testInfo.status is finally correct
     *   2. attached from inside the test, with `{ body }`
     *
     * Both are visible to the JSON reporter and NEITHER survives the HTML
     * reporter — which is the one CI uploads. Measured on the first real CI
     * failure after (1) landed: the report carried the error context and no
     * evidence at all, which is exactly the silence this was written to end.
     *
     * A path attachment is copied into the report's data directory, the same
     * way traces and screenshots are. Written unconditionally: it is one test,
     * the file is small, and evidence that only exists on the runs you
     * remembered to ask for is not evidence.
     */
    const file = testInfo.outputPath(`sse-received-${label}.txt`);
    await writeFile(file, body, "utf8");
    await testInfo.attach(`sse-received-${label}`, {
      path: file,
      contentType: "text/plain",
    });
  }
}

test.describe("HITL demo — LangGraph HumanInterrupt parity", () => {
  /*
   * THE DIAGNOSTIC ITSELF IS TESTED HERE, because until now nothing exercised it.
   *
   * expectApprovalCard's give-up path (#675, #686, #694) reports the stream state
   * so a reader can tell "still in flight" (the webkit engine flake) from
   * "finished and never coming" (a defect). It runs ONLY when a card fails to
   * appear — which in practice means only during the flake it exists to explain.
   * So the one instrument we depend on at the worst moment had never run in CI,
   * and a rename of `status`, `ai-msg` or `tool-call-msg` would degrade it
   * silently to "<status element absent>" with nobody the wiser until the next
   * occurrence.
   *
   * THE FLAKE ITSELF CANNOT BE TRIGGERED. It is webkit-in-CI only — 30/30 on
   * macOS webkit, 20/20 locally on every browser, 0 in 66 test-runs, against
   * chromium 0 over identical specs. A test that tried to summon it would BE the
   * flake. What can be triggered deterministically, on every engine, is the
   * CONDITION the diagnostic describes: a stream that completes carrying no
   * approval frame. The card then cannot appear, for a reason that is not timing.
   *
   * This is the "Status: idle" arm — the DEFECT reading. It is the more important
   * of the two to keep honest: mislabelling it sends a reader chasing an engine
   * flake that is not there.
   */
  test("the give-up path names the stream state, and a finished stream with no card reads as a defect (#675)", async ({
    page,
  }) => {
    // A completed stream with text and NO interrupt frame. Deterministic on every
    // engine: the card cannot arrive, and not because anything was slow.
    await page.route("**/api/hitl-demo", (route) =>
      route.fulfill({
        status: 200,
        headers: SSE_HEADERS,
        body: makeDataPartsSseBody([], "No tool call in this run."),
      })
    );

    await page.goto("/hitl-demo");
    await page.getByTestId("start-button").click();

    const thrown = await expectApprovalCard(page, 2_000).then(
      () => null,
      (e: unknown) => e as Error
    );

    // The positive companion: it must THROW. An expectApprovalCard that resolved
    // here would mean the card appeared without an interrupt frame, which is a
    // different and larger defect than a bad message.
    expect(
      thrown,
      "expectApprovalCard resolved even though the stream carried no approval frame"
    ).not.toBeNull();

    const msg = thrown!.message;
    expect(msg).toContain("approval card never appeared within 2000ms");
    expect(msg).toContain("stream state when we gave up");
    expect(msg).toContain("frames rendered");

    // The values, not just the labels. A message with the right shape and an
    // empty status is the failure this test exists to catch.
    expect(msg).toContain("Status: idle");
    expect(msg).not.toContain("<status element absent>");
    expect(msg).toContain("tool-call-msg=0");

    // The original Playwright error is preserved, so no evidence is hidden by
    // the wrapper.
    expect(thrown!.cause).toBeDefined();
  });

  /*
   * THE OTHER ARM: A CARD THAT ARRIVES AFTER THE BASE DEADLINE IS NOT A FAILURE.
   *
   * The test above pins the DEFECT reading (`Status: idle` → fail, now
   * immediately). This pins the SLOWNESS reading, which is the one the first
   * labelled occurrence turned out to be: still in flight at the deadline, and
   * the card lands shortly after.
   *
   * DETERMINISTIC BY ORDERING, NOT BY TIMING. The route handler holds the real
   * response behind a promise this test resolves, so "the card arrives after the
   * base deadline" is something the test CAUSES rather than something it hopes
   * for. Only the render after the release is engine-dependent, and it has more
   * than a second of room.
   *
   * IT CANNOT PASS AGAINST THE OLD HELPER, which threw at the base deadline —
   * so this case is the discriminator for the change, not a restatement of it.
   * The elapsed assertion is what stops it passing for the boring reason of the
   * card simply arriving on time.
   */
  test("a card that arrives after the base deadline is absorbed, not failed (#675)", async ({
    page,
    browserName,
  }) => {
    /*
     * CHROMIUM ONLY, AND THE ASYMMETRY IS THE POINT.
     *
     * The property this asserts — that `expectApprovalCard` EXTENDS rather than
     * failing when the stream is still in flight at the base deadline — lives in
     * the test process, in TypeScript. It does not vary by rendering engine.
     * Running it on three engines gives no additional coverage of that property.
     *
     * Its DEPENDENCY does vary: the case can only observe the extension if a card
     * eventually renders, and #675 is precisely the finding that a tool-call frame
     * sometimes never arrives under webkit. Measured on that issue over identical
     * specs, assertions and timeouts: webkit 15, firefox 1, chromium 0.
     *
     * So this case was exposed to the very flake it exists to prove is absorbed,
     * and it failed that way on #724 and again on #732 — twice, in a test whose
     * name asserts the absorption works. I wrote it and validated it 18/18 on
     * local webkit, which is the one environment #675 says does not reproduce.
     * A timing-dependent case, proving a timing fix, verified where the timing
     * problem is known not to occur.
     *
     * Restricting it removes the engine-dependent dependency and keeps the
     * engine-independent property. It is NOT a workaround for #675: the flake
     * still reaches the ordinary cross-tab tests in this file, which is where it
     * should be observed, and #675 stays open for it.
     *
     * Un-skip when #675 is resolved — not when this case next goes green.
     */
    test.skip(
      browserName !== "chromium",
      "#675: this case asserts a property of the test helper, which does not vary by engine, but can only observe it if a card renders — and webkit sometimes never delivers the tool-call frame (webkit 15 / firefox 1 / chromium 0). Running it off chromium multiplies exposure to the flake it exists to prove is absorbed, without testing anything additional."
    );

    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route("**/api/hitl-demo", async (route) => {
      await held;
      await route.continue();
    });

    await page.goto("/hitl-demo");
    await page.getByTestId("start-button").click();

    const startedAt = Date.now();
    const cardPromise = expectApprovalCard(page, 2_000);

    // A node timer, not page.waitForTimeout: the page is busy awaiting the card
    // and this must not contend with it.
    await new Promise((r) => setTimeout(r, 2_500));
    release();

    const card = await cardPromise;
    await expect(card).toBeVisible();

    const elapsed = Date.now() - startedAt;
    expect(
      elapsed,
      "the card arrived before the base deadline, so the extension path never ran and this test proved nothing"
    ).toBeGreaterThan(2_000);
  });
  /*
   * The post-approval continuation. Named once because #503's absence assertion and its
   * presence companion MUST be the same string: two literals that drift apart would leave the
   * absence passing against text the companion no longer looks for.
   */
  const DRAIN_TEXT = "Done. Two files in /tmp.";

  /* ------------------------------------------------------------------------ */
  /*  #114 — the recorder runs for EVERY test here, not a hand-picked few      */
  /* ------------------------------------------------------------------------ */
  /*
   * WHY EVERY TEST. The recorder was written for `cross-tab isolation` (#296), that
   * test was quarantined on webkit (#306), and the instrumentation went with it — so
   * every webkit failure since has been evidence-free. Attaching it to whichever test
   * failed most recently would repeat that mistake one test to the right.
   *
   * The CI record says the failure MOVES. Two `E2E — Mocked` runs on 2026-08-31:
   *
   *   33393395290  [webkit] hitl.spec.ts:200  reject   18.0s  failed twice (initial + retry)
   *   33392713270  [webkit] hitl.spec.ts:266  respond  18.4s  failed once, passed on retry
   *
   * Different tests, same browser, same file, both `expect(locator).toBeVisible()`
   * at ~18s — a 15s card wait plus overhead. The subject is therefore the FILE on
   * webkit, and a per-test opt-in would be green precisely on the run that picked a
   * different test.
   *
   * `beforeEach` installs the tee before the first navigation, which is what
   * addInitScript requires. `afterEach` attaches, because a failing assertion aborts
   * the test body and anything written after it never runs.
   */
  test.beforeEach(async ({ page }) => {
    await recordStreamChunks(page);
  });

  /*
   * ATTACHED BY PATH — the distinction that already cost #299 two attempts. A `{ body }`
   * attachment is visible to the JSON reporter and does NOT survive the HTML reporter,
   * which is the one CI uploads. Written unconditionally: evidence that exists only on
   * the runs someone remembered to ask for is not evidence.
   *
   * UNVERIFIED, AND SAYING SO: the attach SITE is new. #299 proved path-attachment from
   * inside the test body; attaching from `afterEach` is standard Playwright but has not
   * been observed surviving this repo's HTML reporter. If it does not, the next webkit
   * failure carries no attachment — which is exactly today's state, so this cannot be
   * worse than the status quo, only not-yet-better. First CI failure after this lands
   * settles it.
   */
  test.afterEach(async ({ page }, testInfo) => {
    /*
     * SKIP THE PAGE THAT WAS NEVER USED. `beforeEach` requests the `page` fixture, so
     * the cross-tab tests — which drive their own contexts — also get one, and it stays
     * on about:blank. Recording it would attach "NO BYTES REACHED THE BROWSER" for a
     * page that was never asked to fetch anything: a false negative that reads exactly
     * like the defect, in the file whose whole purpose is telling those two apart.
     */
    if (!page.url().includes("/hitl-demo")) return;
    await collectStreamEvidence(testInfo, [{ label: "page", page }]);
  });

  test("approve: card dismisses; no error-msg appears (drain succeeded)", async ({
    page,
  }) => {
    await page.goto("/hitl-demo");
    await expect(page.getByTestId("hitl-demo-page")).toBeVisible();

    await page.getByTestId("start-button").click();

    const card = await expectApprovalCard(page);
    await expect(page.getByTestId("approval-action-name")).toHaveText(
      "bash_execute"
    );
    await expect(page.getByTestId("approval-status")).toHaveText("waiting");
    // The approval's `arguments` echo shows the unmodified command.
    await expect(page.getByTestId("approval-arguments")).toContainText(
      "ls -la /tmp"
    );

    await page.getByTestId("approve-button").click();

    // The POST resolves with 200 → card dismisses. A failed POST would leave
    // status="error" on the controller and the card visible.
    await expect(card).toBeHidden({ timeout: 10_000 });
    await expect(page.getByTestId("respond-status")).toHaveText(
      "Respond status: success"
    );

    // Approve does NOT emit a data-error frame, so no error message appears.
    // (Reject and timeout DO surface error-msg — see those tests.)
    await expect(page.getByTestId("error-msg")).toHaveCount(0);

    // After approval, the gate drains the buffered tool-output-available and
    // forwards the trailing text-delta frames. Asserting the continuation
    // text appeared proves the drain actually worked — the previous version
    // only checked that the card hid (which a 200 POST achieves on its own,
    // even if the buffered frames were dropped).
    await expect(page.getByTestId("ai-msg").last()).toContainText(
      "Done. Two files in /tmp.",
      { timeout: 30_000 }
    );
  });

  test("reject: data-error surfaces, the tool does not execute, unrelated trailing frames still pass through", async ({
    page,
  }) => {
    // The old title claimed "agent's closing text does NOT appear". It never
    // asserted that, and the claim is false: on reject the gate drops only the
    // buffered TOOL frames and still drains globalBufferedFrames, which hold
    // the backend's trailing text-deltas. That pass-through is the documented
    // contract (see the round-7 revert note on the timeout test) — the title
    // was the wrong half. Both halves are now asserted so the file cannot
    // drift back into describing behaviour it does not check.
    await page.goto("/hitl-demo");
    await page.getByTestId("start-button").click();

    await expectApprovalCard(page);
    await page.getByTestId("reject-button").click();
    await expect(page.getByTestId("approval-card")).toBeHidden({
      timeout: 10_000,
    });

    // The rejection emits a data-error frame which useDeepAgentsChat surfaces
    // as an ErrorMessage in the message union.
    await expect(page.getByTestId("error-msg")).toContainText(/rejected/i, {
      timeout: 30_000,
    });

    // The real invariant: the rejected tool never executed, so no tool call
    // and no tool result may reach the client. This is what "rejected" has to
    // mean; without it the test would pass on a gate that forwarded the tool
    // frames and merely also emitted an error.
    await expect(page.getByTestId("tool-call-msg")).toHaveCount(0);
    await expect(page.getByTestId("tool-result")).toHaveCount(0);

    // The documented pass-through, pinned so it is a decision rather than an
    // accident: frames unrelated to the gated tool still reach the client.
    await expect(page.getByTestId("ai-msg").last()).toContainText(
      "Done. Two files in /tmp.",
      { timeout: 30_000 }
    );
  });

  test("edit: textarea fill + submit → 200 → card dismisses", async ({
    page,
  }) => {
    await page.goto("/hitl-demo");
    await page.getByTestId("start-button").click();

    await expectApprovalCard(page);

    await page.getByTestId("show-edit-button").click();
    const editInput = page.getByTestId("edit-input");
    await editInput.fill('{"command":"ls"}');
    await page.getByTestId("submit-edit-button").click();

    await expect(page.getByTestId("approval-card")).toBeHidden({
      timeout: 10_000,
    });
    // Successful POST → controller status is "success".
    await expect(page.getByTestId("respond-status")).toHaveText(
      "Respond status: success"
    );

    /*
     * A WITNESS THE ORIGINAL ARGUMENTS COULD NOT PRODUCE.
     *
     * Everything above is satisfied by a DROPPED edit. A 200 hides the card and
     * sets the status on its own, so this test passed unchanged whether the edit
     * reached the tool or `ls -la /tmp` ran instead — the failure mode that looks
     * most like success. The approve case in this file already carries the lesson
     * ("the previous version only checked that the card hid, which a 200 POST
     * achieves on its own, even if the buffered frames were dropped"); edit was
     * left in the pre-hardening form.
     *
     * `tool-arguments` renders the arguments the GATE RELEASED, which makes it the
     * browser-side counterpart of the route test asserting the counter reads 5
     * rather than 1 (apps/django-backend/tests/test_approval_dispatch.py).
     *
     * ASSERTED WITH THE CLOSING QUOTE, DELIBERATELY. Bare `ls` is a substring of
     * `ls -la /tmp`, so `toContainText("ls")` would pass on exactly the payload
     * this exists to catch. `"command": "ls"` cannot occur in the unedited call.
     * The negative is kept beside it because the two fail for different reasons:
     * the first if nothing was released, the second if the original was.
     */
    const toolArgs = page.getByTestId("tool-arguments");
    await expect(toolArgs).toContainText('"command": "ls"', {
      timeout: 30_000,
    });
    await expect(toolArgs).not.toContainText("ls -la /tmp");
  });

  test("respond: human-response frame is rendered; error-msg is NOT", async ({
    page,
  }) => {
    await page.goto("/hitl-demo");
    await page.getByTestId("start-button").click();

    await expectApprovalCard(page);

    await page.getByTestId("show-respond-button").click();
    await page
      .getByTestId("respond-input")
      .fill("Use grep -r 'pattern' instead — safer.");
    await page.getByTestId("submit-respond-button").click();

    await expect(page.getByTestId("approval-card")).toBeHidden({
      timeout: 10_000,
    });

    // data-human-response reaches the client.
    await expect(page.getByTestId("human-response")).toContainText(
      "Use grep -r 'pattern' instead — safer.",
      { timeout: 30_000 }
    );
    // No data-error (respond is a successful resolution, not rejection).
    await expect(page.getByTestId("error-msg")).toHaveCount(0);
  });

  test("edit: invalid JSON in the textarea is rejected client-side without POSTing", async ({
    page,
  }) => {
    await page.goto("/hitl-demo");
    await page.getByTestId("start-button").click();

    await expectApprovalCard(page);

    await page.getByTestId("show-edit-button").click();
    await page.getByTestId("edit-input").fill("not valid json {");
    await page.getByTestId("submit-edit-button").click();

    await expect(page.getByTestId("edit-error")).toBeVisible();
    await expectApprovalCard(page);
  });

  // NOTE: the next test is pure ApprovalCard form-validation (does not
  // exercise the HITL drain/respond flow) — it lives here because it shares
  // the page setup, but the assertion is a button-disabled UI check. If
  // ApprovalCard moves into a shared component package, this test should
  // migrate to that package's component tests.
  test("ApprovalCard form: respond submit is disabled until text is entered (UI-only, no flow)", async ({
    page,
  }) => {
    await page.goto("/hitl-demo");
    await page.getByTestId("start-button").click();

    await expectApprovalCard(page);

    await page.getByTestId("show-respond-button").click();
    await expect(page.getByTestId("submit-respond-button")).toBeDisabled();

    await page.getByTestId("respond-input").fill("a");
    await expect(page.getByTestId("submit-respond-button")).toBeEnabled();
  });

  test("timeout: /api/hitl-demo-timeout reports that the tool RAN when its result arrives after the approval expired", async ({
    request,
  }) => {
    // HTTP-LEVEL TIMEOUT COVERAGE.
    //
    // The previous UI-level test (test.skip below) suffered from a real but
    // orthogonal AI SDK ↔ React rendering issue: "No tool invocation found
    // for tool call ID 'tc-hitl-1'" surfaced before the data-error frame
    // could be processed when run AFTER any other HITL test. The proxy
    // itself emits the correct stream; the leak is upstream of the gate.
    //
    // This test bypasses the AI SDK and asserts the contract that actually
    // matters at the E2E layer: POSTing to the timeout-configured proxy
    // produces an SSE response containing a data-error frame with
    // code="approval_timeout". The backend mock sleeps 8s before sending
    // tool-output-available; the proxy is mounted with timeoutMs:1_000,
    // so by the time the upstream output arrives the lazy TTL check has
    // marked the approval as timed-out and drainRejectOrTimeout fires.
    test.setTimeout(30_000);

    const response = await request.post("/api/hitl-demo-timeout", {
      data: { messages: [{ role: "user", content: "List the files in /tmp" }] },
      headers: { "Content-Type": "application/json" },
      timeout: 20_000,
    });
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/event-stream");

    const body = await response.text();
    const frames = body
      .split("\n\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => {
        try {
          return JSON.parse(line.slice("data: ".length));
        } catch {
          return null;
        }
      })
      .filter(Boolean) as Array<{
      type: string;
      data?: { code?: string; message?: string };
    }>;

    // Must see the approval envelope before the timeout fires.
    const approvalRequired = frames.find(
      (f) => f.type === "data-approval-required"
    );
    expect(
      approvalRequired,
      "proxy must emit data-approval-required before timeout"
    ).toBeTruthy();

    /*
     * THE CODE IS `tool_executed_without_approval`, NOT `approval_timeout`, AND
     * THE CHANGE IS THE POINT (#435).
     *
     * "Without resolution" means nobody approved or rejected — it does NOT mean
     * nothing ran. This route's mock backend SLEEPS 8s and then emits
     * `tool-output-available` against a gate configured with timeoutMs 1_000, so
     * by the time the drain fires THE TOOL'S RESULT IS IN HAND. The tool ran.
     *
     * Reporting only "approval expired" there is #256's defect verbatim: the
     * action happened, the UI was told it needed approval, and the frames
     * describing it were discarded — so the effect is invisible and the refusal
     * looks decisive.
     *
     * MEASURED ON MAIN, the two drain paths disagreed given the SAME evidence:
     *
     *   per-frame timeout  data-error(approval_timeout)             frames DROPPED
     *   close-time sweep   data-error(tool_executed_without_approval) frames RELEASED
     *
     * Which answer a client got depended only on WHEN THE STREAM HAPPENED TO
     * CLOSE. #435 makes the first agree with the second, which is the settled
     * one — #311 released those frames deliberately, and this path had not
     * caught up. Not a new term: `tool_executed_without_approval` is #256's own.
     */
    const errorFrame = frames.find(
      (f) =>
        f.type === "data-error" &&
        f.data?.code === "tool_executed_without_approval"
    );
    expect(
      errorFrame,
      "proxy must report that the tool RAN when its result arrives after the approval expired — not merely that the approval timed out"
    ).toBeTruthy();
    expect(errorFrame!.data!.message).toMatch(/timeout|expired/i);

    /*
     * THE ANTI-LEAK PROPERTY SURVIVES, RESTATED AS WHAT IT ACTUALLY GUARDS.
     *
     * This asserted the tool-output-available was ABSENT, because the bug it was
     * written for was the proxy leaking the raw frame INSTEAD OF emitting the
     * error at all (a cleanup race in approval-registry.ts). Absence was a proxy
     * for "the error came first" — and it stopped being one once the frames are
     * released deliberately after that error.
     *
     * So the guard is now the thing it was standing in for: THE data-error
     * LEADS, and the released frames come after it. A regression of the
     * cleanup race puts a tool frame first and still fails here.
     */
    const errorIndex = frames.findIndex((f) => f.type === "data-error");
    const firstToolFrame = frames.findIndex((f) =>
      String(f.type).startsWith("tool-")
    );
    expect(
      errorIndex,
      "proxy must emit a data-error at all — its absence is the cleanup-race bug"
    ).toBeGreaterThanOrEqual(0);
    if (firstToolFrame !== -1) {
      expect(
        errorIndex,
        "the data-error must LEAD the released tool frames — a tool frame arriving first is the raw leak this guards"
      ).toBeLessThan(firstToolFrame);
    }

    // NOTE: A "no frames after data-error" invariant was attempted and
    // reverted (round 7) — by design the gate drops ONLY the buffered
    // tool frames on timeout. The backend mock's subsequent unrelated
    // frames (closing text-deltas + finish) legitimately pass through,
    // mirroring the contract documented on the cross-tab reject test.
    // The leakedToolOutput check above is the correct invariant for the
    // gate's timeout behavior; a no-frames-after-error check would
    // overreach and assert behavior the gate doesn't promise.
  });

  test("multi-interrupt: two gated tool calls in a row each render an approval card", async ({
    page,
    browserName,
  }) => {
    // WebKit skip. #39 did NOT fix this one; re-verified after it landed and
    // the test still fails 3/3 on WebKit. Measurements below are from the
    // #25 spike, all against the same machine and browser build.
    //
    // The bytes are not the problem. Reading /api/hitl-demo-multi with RAW
    // fetch (no AI SDK, no React) from the page's own origin, the second
    // data-approval-required frame arrives at 4.02s under WebKit and 4.02s
    // under chromium — identical. So there is no WebKit network-level
    // chunk buffering here, and an SSE heartbeat would not help.
    //
    // The gap is between "bytes reached JS" and "React rendered the card",
    // and it is specific to the SECOND data-* part mid-stream: the FIRST
    // approval card renders in 0.03s on WebKit in every scenario. Card 2
    // does not render until the stream ends. That points at the AI SDK v6
    // UIMessageStream/useChat pipeline under WebKit, which is what the
    // original skip comment said — that part of it was right, and the #25
    // spike's initial "WebKit chunked-fetch buffering" reading was wrong.
    //
    // What the original comment got wrong, and why it is not restored
    // verbatim: it claimed a 60s test timeout (the real failure is an
    // assertion failure at ~39s), and it cited "both attempts in CI" for a
    // run that cannot have existed — the first CI job ever to execute WebKit
    // skipped this very test.
    //
    // #39 made the symptom worse rather than better, which is expected and
    // is not an argument against #39. The proxy now holds its response open
    // waiting for the human, so the stream no longer closes at ~8.5s — and
    // stream close was the only thing that flushed the pending part. Card 2
    // therefore appears at 38.59s (upstream close + the 30s drainGraceMs)
    // instead of 9.02s. Measured both ways on the same box. #39 still does
    // its job here: at grace expiry the buffered frames are released with an
    // approval_pending_at_close error rather than dropped.
    //
    // Un-skip when the client-side pipeline surfaces a mid-stream second
    // data-* part on WebKit without waiting for stream end. No upstream
    // issue is filed yet — do not add a URL here until one exists.
    /*
     * THE SKIP IS RIGHT AND ITS OLD REASON WAS WRONG (#114).
     *
     * It used to say: "bytes arrive on time (raw fetch: 4.02s, same as chromium), so this is
     * the client pipeline, not the network." Both halves are refuted by measurement. The gap
     * is in BYTE DELIVERY, and it belongs to PLAYWRIGHT'S WEBKIT BUILD rather than to WebKit.
     *
     * One page, one server, one flow — raw fetch, no React and no AI SDK, driving this exact
     * multi-interrupt stream and POSTing the approval itself:
     *
     *     real Safari 26.2, UNAUTOMATED   bytes=1980  second frame @ 4093ms
     *     real Safari 26.2, UNAUTOMATED   bytes=1980  second frame @ 4039ms
     *     Playwright chromium             bytes=1980  second frame @ 4013ms
     *     Playwright webkit               bytes=1131  second frame @ 38017ms
     *
     * Real Safari matches chromium byte for byte. Playwright's WebKit receives 1131 of 1980
     * bytes and the second frame arrives thirty-four seconds late.
     *
     * WHY THE DISTINCTION IS WORTH THE COMMENT. Under the old reason this looked like a
     * product defect: if the client pipeline could not surface a mid-stream part on WebKit,
     * every Safari user would miss mid-stream updates, and a forker would inherit that
     * unknowingly. It measures as harness-specific, so the tests are not hiding a defect from
     * users — but the reason mattered more than the skip, and it was wrong for weeks while
     * #114 read as a mystery.
     *
     * The real-Safari arm was run unautomated: a static page in the app's own origin that
     * runs itself on load and POSTs its result to a local collector. safaridriver was NOT
     * used — it requires enabling remote automation, which would have reintroduced the very
     * variable under test. A control page proved the reporting channel worked before the
     * silence of a probe run could be read as a result.
     *
     * Un-skip when Playwright's WebKit stops truncating this stream, not when the client
     * pipeline changes. No upstream issue is filed yet — do not add a URL until one exists.
     */
    test.skip(
      browserName === "webkit",
      "Playwright's WebKit build truncates this stream: it receives 1131 of 1980 bytes and the second mid-stream frame arrives at 38s. Real Safari 26.2, unautomated, matches chromium (1980 bytes, 4.0s), so this is the harness and not the product. See the note above (#114)."
    );
    // The N-output SseMultiTransform contract eliminates the structural
    // limitation that previously made multi-interrupt fail: the gate no
    // longer juggles a readyQueue across calls — each transform call returns
    // its full drain array in one shot, so subsequent input frames (including
    // a second gated tool-input-start) reach the gate normally.
    await page.goto("/hitl-demo?proxy=multi");
    await page.getByTestId("start-button").click();

    // Card 1: bash_execute
    await expectApprovalCard(page);
    await expect(page.getByTestId("approval-action-name")).toHaveText(
      "bash_execute"
    );
    await page.getByTestId("approve-button").click();
    await expect(page.getByTestId("approval-card")).toBeHidden({
      timeout: 10_000,
    });

    // Card 2: write_file (the second tool-input-start in the multi scenario)
    await expect(page.getByTestId("approval-action-name")).toHaveText(
      "write_file",
      { timeout: 30_000 }
    );
    await expectApprovalCard(page);
    await page.getByTestId("approve-button").click();
    await expect(page.getByTestId("approval-card")).toBeHidden({
      timeout: 10_000,
    });

    // Both approvals resolved cleanly; no error frame surfaced.
    await expect(page.getByTestId("respond-status")).toHaveText(
      "Respond status: success"
    );
    await expect(page.getByTestId("error-msg")).toHaveCount(0);

    // Verify the trailing closing-summary text-delta from the backend
    // actually reached the client. This proves the second drain after the
    // write_file approval released the readyQueue end-to-end — without this
    // assertion, the previous coverage only proved both POSTs returned 200.
    await expect(page.getByTestId("ai-msg").last()).toContainText(
      "Done. Two files in /tmp.",
      { timeout: 30_000 }
    );
  });

  test("auth-deny: POST to /api/approval-protected without a token returns 401", async ({
    request,
  }) => {
    // No approvalId in the registry — but the 401 must come BEFORE the
    // route looks up the registry. We don't need a real approval to test this.
    const response = await request.post(
      "/api/approval-protected/nonexistent-id",
      {
        data: { decision: "approve" },
        // No Authorization header → authorize callback returns false → 401.
      }
    );
    expect(response.status()).toBe(401);
    const body = await response.json();
    expect(body).toEqual({ error: "unauthorized" });
  });

  test("auth-deny: POST with a wrong Bearer token also returns 401", async ({
    request,
  }) => {
    const response = await request.post(
      "/api/approval-protected/nonexistent-id",
      {
        data: { decision: "approve" },
        headers: { Authorization: "Bearer wrong-token" },
      }
    );
    expect(response.status()).toBe(401);
  });

  test("auth-allow: POST with the correct Bearer reaches the registry (404, not 401)", async ({
    request,
  }) => {
    // Auth passes → handler progresses to the registry lookup → 404 since
    // no such approvalId exists. Proves the auth callback isn't blocking the
    // happy path.
    const response = await request.post(
      "/api/approval-protected/nonexistent-id",
      {
        data: { decision: "approve" },
        headers: { Authorization: "Bearer test-secret-token" },
      }
    );
    expect(response.status()).toBe(404);
  });

  test("auth-allow happy path: valid Bearer resolves a real approval end-to-end and the gate drains", async ({
    request,
    baseURL,
  }) => {
    // The previous auth-allow test only proves the token authorises far enough
    // to hit the registry lookup (404). This test exercises the FULL round-trip:
    //   1. Start a streaming /api/hitl-demo POST (unprotected approval route
    //      will be the natural producer of the approval envelope).
    //   2. Read frames until data-approval-required arrives; capture approvalId.
    //   3. POST decision=approve to /api/approval-protected/<approvalId> with
    //      the valid Bearer — the protected route shares the global approval
    //      registry, so resolving via the protected route should release the gate.
    //   4. Continue reading the stream; expect the trailing "Done. Two files in
    //      /tmp." text-delta to arrive, proving the drain actually fired.
    test.setTimeout(30_000);

    // Use the native fetch (Node 18+) so we can stream the body incrementally.
    // Playwright's `request` fixture returns the body in one shot, which would
    // block until the gate releases — and we're the ones who release it.
    const streamRes = await fetch(`${baseURL}/api/hitl-demo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "List the files in /tmp" }],
      }),
    });
    expect(streamRes.status).toBe(200);

    const reader = streamRes.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let approvalId: string | undefined;

    // Drain incoming chunks until we extract approvalId from a
    // data-approval-required frame. Bound by test.setTimeout above.
    while (!approvalId) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const segments = buffer.split("\n\n");
      // Keep the last (possibly partial) segment in the buffer.
      buffer = segments.pop() ?? "";
      for (const seg of segments) {
        if (!seg.startsWith("data: ")) continue;
        try {
          const frame = JSON.parse(seg.slice("data: ".length)) as {
            type?: string;
            data?: { id?: string };
          };
          if (frame.type === "data-approval-required" && frame.data?.id) {
            approvalId = frame.data.id;
            break;
          }
        } catch {
          // Non-JSON or partial; ignore and keep reading.
        }
      }
    }
    expect(
      approvalId,
      "approval envelope must arrive before timeout"
    ).toBeTruthy();

    // Resolve via the PROTECTED route with a valid Bearer. This is the
    // assertion under test — auth-allow happy path.
    const resolve = await request.post(
      `/api/approval-protected/${approvalId}`,
      {
        data: { decision: "approve" },
        headers: { Authorization: "Bearer test-secret-token" },
      }
    );
    expect(resolve.status()).toBe(200);

    // Continue reading the stream. The gate must drain the buffered tool
    // frames and forward the trailing text-delta. Without the drain, we'd
    // hit the test timeout instead.
    let sawDrainText = false;
    while (!sawDrainText) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes("Done. Two files in /tmp.")) {
        sawDrainText = true;
      }
    }
    // Releasing the reader so the underlying socket can close cleanly.
    await reader.cancel().catch(() => {});

    expect(
      sawDrainText,
      "after auth-allowed approval resolves, the gate must drain and emit the trailing text"
    ).toBe(true);
  });

  test("cross-tab: an approval created in tab A can be resolved from tab B via the shared global registry", async ({
    browser,
  }, testInfo) => {
    // CONTRACT CHANGED BY #170 — this comment described the defect, not a feature.
    //
    // The registry is still a process-level singleton, but "any client with the approvalId
    // can resolve it, regardless of which context created it" is exactly what #170 removed:
    // with no boundary, one visitor's approvals sat in the same Map as another's. Resolution
    // now additionally requires the creator's `x-approval-owner` key.
    //
    // What this test still proves is the part worth keeping — that a resolution made by a
    // DIFFERENT client reaches tab A's in-flight stream. The refusal case is asserted
    // separately in "a client WITHOUT the owner key is REFUSED".
    //
    //   1. Tab A: open /hitl-demo, click start, wait for the approval card,
    //      capture approvalId from the card's data-approval-id attribute.
    //   2. Tab B: open a *separate* browser context (independent cookies,
    //      independent React tree) and POST decision=approve to /api/approval/<id>.
    //   3. Tab A: assert the card dismisses and the drain completion text
    //      "Done. Two files in /tmp." appears — proving the registry
    //      resolution from B was observed by A's in-flight stream.
    test.setTimeout(30_000);

    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const tabA = await contextA.newPage();
    const tabB = await contextB.newPage();

    // #114: this test drives its own contexts, so the file-level beforeEach does not
    // reach them. Both tabs are recorded — the failing assertion is on tab A's stream,
    // and tab B's says whether a stall is per-stream or per-process.
    await Promise.all([recordStreamChunks(tabA), recordStreamChunks(tabB)]);

    try {
      await tabA.goto("/hitl-demo");
      await tabA.getByTestId("start-button").click();

      const cardA = await expectApprovalCard(tabA);

      // The approval id is exposed as data-approval-id on the card itself
      // (see packages/react/src/ApprovalCard.tsx:102).
      const approvalId = await cardA.getAttribute("data-approval-id");
      expect(
        approvalId,
        "approval card must expose data-approval-id"
      ).toBeTruthy();

      // Tab B does NOT call any HITL setup — it posts the decision via the API, presenting
      // tab A's owner key. A separate browser context has its own localStorage, so without
      // this it holds no key and is refused (#170).
      const ownerKey = await tabA.evaluate(() =>
        window.localStorage.getItem("deepagents:approval-owner:v1")
      );
      expect(ownerKey, "tab A must have minted an owner key").toBeTruthy();

      const resolveFromB = await tabB.request.post(
        `/api/approval/${approvalId}`,
        {
          data: { decision: "approve" },
          headers: { "x-approval-owner": ownerKey as string },
        }
      );
      expect(resolveFromB.status()).toBe(200);

      // Tab A's *stream* observes the resolution and drains: the trailing
      // text-delta after the gated tool reaches A's React tree.
      await expect(tabA.getByTestId("ai-msg").last()).toContainText(
        "Done. Two files in /tmp.",
        { timeout: 30_000 }
      );

      // NOTE on tab A's card visibility: today's hitl-demo only dismisses the
      // card when its own ApprovalCard buttons fire (see hitl-demo/page.tsx
      // dismiss handlers). A cross-tab resolution doesn't sync the local
      // card UI — that's a known UX limitation. This test deliberately does
      // NOT assert on cardA's final visibility so a future UX fix (e.g.
      // dismissing the card when the stream observes the resolution) won't
      // be a regression.

      // The respond-status controller in tab A was NOT used to resolve this
      // approval (tab B did it via raw API), so it stays at its initial value
      // — proving the resolution path went through the registry, not tab A's
      // ApprovalCard controller.
      await expect(tabA.getByTestId("respond-status")).toHaveText(
        /Respond status: idle/i
      );
    } finally {
      // BEFORE the contexts close — a closed page cannot be asked what it received.
      await collectStreamEvidence(testInfo, [
        { label: "tabA", page: tabA },
        { label: "tabB", page: tabB },
      ]);
      await contextA.close();
      await contextB.close();
    }
  });

  // -------------------------------------------------------------------------
  // Cross-tab parity for the OTHER three decision modes. Each tests the same
  // contract (B resolves via API → A's stream observes the drain) but with
  // a different decision and a different drain effect.
  // -------------------------------------------------------------------------
  for (const scenario of [
    {
      decision: "reject" as const,
      payload: undefined,
      // Reject emits a data-error frame; the hitl-demo page surfaces it via
      // the error-msg testid. Note that the backend mock's text-delta frames
      // AFTER the tool stage still pass through (the gate only drops the
      // buffered tool frames, not subsequent unrelated text) — so we
      // intentionally don't assert their absence here.
      assertOnA: async (tabA: import("@playwright/test").Page) => {
        await expect(tabA.getByTestId("error-msg")).toContainText(/rejected/i, {
          timeout: 30_000,
        });
      },
    },
    {
      decision: "edit" as const,
      payload: { editedInput: { command: "ls -la /var" } },
      // Edit drains like approve — the trailing text-delta arrives.
      assertOnA: async (tabA: import("@playwright/test").Page) => {
        await expect(tabA.getByTestId("ai-msg").last()).toContainText(
          "Done. Two files in /tmp.",
          { timeout: 30_000 }
        );
      },
    },
    {
      decision: "respond" as const,
      payload: { response: "use grep -r instead — safer" },
      // Respond emits a data-human-response carrying the user's reply; the
      // hitl-demo page surfaces it via the human-response testid.
      assertOnA: async (tabA: import("@playwright/test").Page) => {
        await expect(tabA.getByTestId("human-response")).toContainText(
          "use grep -r instead — safer",
          { timeout: 30_000 }
        );
      },
    },
  ]) {
    test(`cross-tab: ${scenario.decision} from tab B is observed by tab A's stream`, async ({
      browser,
    }, testInfo) => {
      // Budget = setup (≤15s for the card to appear) + assertOnA's own 30s
      // wait for the cross-tab frame. The old 30s cap couldn't fit both, so
      // WebKit's slower cold-start fetch streaming tripped the ceiling even
      // though the single-tab equivalents pass in ~6s. Use the 60s global.
      test.setTimeout(60_000);
      const contextA = await browser.newContext();
      const contextB = await browser.newContext();
      const tabA = await contextA.newPage();
      const tabB = await contextB.newPage();

      /*
       * #615: this test drives its own contexts, so neither the file-level
       * beforeEach (which records the `page` FIXTURE) nor the afterEach (which
       * attaches it) reaches these tabs — the fixture page stays on about:blank
       * and the afterEach returns early by design. Two of the four own-context
       * tests here already record and collect; this was one of the two that did
       * not, and it is the one that failed on webkit with `element(s) not found`
       * on the SETUP card. That failure carried no evidence about whether the
       * browser received any bytes, which is the single question that separates
       * "the stream never arrived" from "the card rendered late".
       */
      await Promise.all([recordStreamChunks(tabA), recordStreamChunks(tabB)]);

      try {
        await tabA.goto("/hitl-demo");
        await tabA.getByTestId("start-button").click();
        const cardA = await expectApprovalCard(tabA);

        const approvalId = await cardA.getAttribute("data-approval-id");
        expect(approvalId).toBeTruthy();

        // #170 binds an approval to the browser that raised it, so tab B must present tab
        // A's owner key. This test's SUBJECT is unchanged — that a resolution made by a
        // DIFFERENT client is observed by tab A's stream — but the mechanism it used (a
        // foreign client with no key at all) is now exactly what the feature forbids. The
        // negative case is asserted separately below rather than left implicit here.
        const ownerKey = await tabA.evaluate(() =>
          window.localStorage.getItem("deepagents:approval-owner:v1")
        );
        expect(
          ownerKey,
          "tab A must have minted an owner key, or this test proves nothing about authorized cross-client resolution"
        ).toBeTruthy();

        const resolve = await tabB.request.post(`/api/approval/${approvalId}`, {
          data: { decision: scenario.decision, ...scenario.payload },
          headers: { "x-approval-owner": ownerKey as string },
        });
        expect(
          resolve.status(),
          `cross-tab ${scenario.decision} must return 200`
        ).toBe(200);

        await scenario.assertOnA(tabA);
      } finally {
        // BEFORE the contexts close — a closed page cannot be asked what it received.
        await collectStreamEvidence(testInfo, [
          { label: "tabA", page: tabA },
          { label: "tabB", page: tabB },
        ]);
        await contextA.close();
        await contextB.close();
      }
    });
  }

  test("cross-tab: a client WITHOUT the owner key is REFUSED (#170)", async ({
    browser,
  }, testInfo) => {
    // The assertion the old cross-tab shape made impossible. Before #170 any client holding
    // an approvalId could resolve it, and the tests above demonstrated that as a FEATURE
    // because they posted from a foreign context with no key. This pins the opposite: the
    // same request, minus the key, must be refused — otherwise #170 ships as a no-op and the
    // tests above pass because ownership is not enforced at all rather than because it is
    // satisfied.
    test.setTimeout(60_000);
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const tabA = await contextA.newPage();
    const tabB = await contextB.newPage();

    /*
     * #615: own contexts, so the file-level beforeEach/afterEach do not reach
     * these tabs — see the sibling above. This test's SETUP is the same card
     * wait that failed on webkit in the parameterised test next door, so it can
     * fail the same way and, until now, would have said as little about why.
     */
    await Promise.all([recordStreamChunks(tabA), recordStreamChunks(tabB)]);

    try {
      await tabA.goto("/hitl-demo");
      await tabA.getByTestId("start-button").click();
      const cardA = await expectApprovalCard(tabA);

      const approvalId = await cardA.getAttribute("data-approval-id");
      expect(approvalId).toBeTruthy();

      // GUARD: the approval must actually carry an owner, or a 403 below would be
      // indistinguishable from the route rejecting for some unrelated reason.
      const ownerKey = await tabA.evaluate(() =>
        window.localStorage.getItem("deepagents:approval-owner:v1")
      );
      expect(ownerKey, "tab A must have minted an owner key").toBeTruthy();

      const refused = await tabB.request.post(`/api/approval/${approvalId}`, {
        data: { decision: "approve" },
      });
      expect(
        refused.status(),
        "a client with no owner key must not be able to resolve another browser's approval"
      ).toBe(403);
    } finally {
      // BEFORE the contexts close — a closed page cannot be asked what it received.
      await collectStreamEvidence(testInfo, [
        { label: "tabA", page: tabA },
        { label: "tabB", page: tabB },
      ]);
      await contextA.close();
      await contextB.close();
    }
  });

  test("cross-tab isolation: two tabs of /hitl-demo create independent sessions and approvals", async ({
    browser,
    browserName,
  }, testInfo) => {
    /*
     * QUARANTINED ON WEBKIT ONLY — #114, AND DECLARED RATHER THAN HIDDEN.
     *
     * `fixme` marks this KNOWN-BROKEN. It does not report a pass: the run shows
     * it as expected-to-fail, so the tick on this suite means "everything not
     * known-broken passed" and nothing stronger. If the underlying defect is
     * fixed, this line goes red for the right reason and must be deleted.
     *
     * SCOPED TO WEBKIT, DELIBERATELY. chromium and firefox run this test and
     * assert it in full — the invariant it guards is still enforced on two of
     * three engines. Quarantining the whole test would have traded a real check
     * for a green tick, which is the trade this repo exists to refuse.
     *
     * WHAT IS KNOWN, in full on #114:
     *   - reproduces off-CI (Linux WebKitGTK container; recipe on the issue)
     *   - the server enqueues 471 bytes and reports success=true; the client
     *     receives 39 — exactly the first frame — and its reader stays PENDING,
     *     neither done nor errored
     *   - a raw fetch over the same route, two contexts, 12 trials: 0 truncated
     *   - so the transport is capable and the producer finishes; the stall
     *     appears only when the app consumes the stream
     *
     * Eight hypotheses eliminated by measurement, including two of mine that
     * looked well-evidenced. The cause is NOT identified, which is why this is
     * a quarantine and not a fix.
     */
    test.fixme(
      browserName === "webkit",
      "#114: the SSE stream stalls after the first frame on Linux WebKit — " +
        "server reports success, client receives 39 of 471 bytes. Not diagnosed."
    );
    // Each /hitl-demo page mounts a fresh sessionId per useState init
    // (apps/example/app/hitl-demo/page.tsx:47). Two tabs must therefore
    // produce two *different* approval entries in the registry — neither
    // tab should see the other tab's card.
    // Two back-to-back 15s card waits sit right at a 30s ceiling; WebKit
    // cold-start can tip it over. Use the 60s global budget for headroom.
    test.setTimeout(60_000);

    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const tabA = await contextA.newPage();
    const tabB = await contextB.newPage();
    // #114: on failure, say whether the browser received any bytes. Installed
    // BEFORE the first navigation — addInitScript only applies to documents
    // loaded after it is registered.
    await Promise.all([recordStreamChunks(tabA), recordStreamChunks(tabB)]);

    try {
      await Promise.all([tabA.goto("/hitl-demo"), tabB.goto("/hitl-demo")]);
      await Promise.all([
        tabA.getByTestId("start-button").click(),
        tabB.getByTestId("start-button").click(),
      ]);

      await expectApprovalCard(tabA);
      await expectApprovalCard(tabB);

      const idA = await tabA
        .getByTestId("approval-card")
        .getAttribute("data-approval-id");
      const idB = await tabB
        .getByTestId("approval-card")
        .getAttribute("data-approval-id");

      expect(idA).toBeTruthy();
      expect(idB).toBeTruthy();
      expect(idA).not.toBe(idB);

      /*
       * ── SETTLE ON AN EVENT, NOT ON AN INSTANT (#503) ──────────────────────────────────
       *
       * The previous version approved in A, waited for A's own card to hide, and immediately
       * asserted B unchanged. A's card hiding is LOCAL UI — it says the click was handled, not
       * that the server processed anything — so the assertions on B ran at an arbitrary moment
       * with nothing establishing that a violation would have had time to arrive. They were
       * also satisfied by B's state BEFORE the approval, so "nothing has happened yet" passed
       * exactly as well as "nothing will happen".
       *
       * A's DRAIN is the event that closes the window: the continuation text only appears once
       * the server has resolved A's approval and released the buffered frames back down A's
       * stream. A full round trip has completed by the time it is on screen, so any
       * cross-contamination has had its chance.
       */
      await tabA.getByTestId("approve-button").click();
      await expect(tabA.getByTestId("approval-card")).toBeHidden({
        timeout: 10_000,
      });
      await expect(tabA.getByTestId("ai-msg").last()).toContainText(
        DRAIN_TEXT,
        {
          timeout: 30_000,
        }
      );

      /*
       * ── THE ABSENCE, ON THE CHANNEL THAT CAN ACTUALLY CARRY THE VIOLATION ─────────────
       *
       * B's CARD IS NOT A DETECTOR. hitl-demo dismisses a card only when that tab's own
       * ApprovalCard buttons fire, so a resolution reaching B's approval server-side would
       * leave B's card exactly as it is — the old assertion could not have failed for the
       * defect it was named after. B's STREAM is the detector: if A's resolution wrongly
       * resolved B's approval, B's gate releases and B drains, the same way tab A's stream
       * observes a resolution made by a different client in the shared-registry test above.
       *
       * Identity, not shape: B's card must still be B's approval, asserted by id rather than
       * by "a card is visible", so a card belonging to something else does not satisfy it.
       */
      await expect(tabB.getByTestId("approval-card")).toHaveAttribute(
        "data-approval-id",
        idB!
      );
      await expect(tabB.getByTestId("approval-status")).toHaveText("waiting");
      /*
       * WHAT WOULD MAKE THIS STOP MEANING ANYTHING, stated here because a negative
       * assertion's premise expires quietly. Two directions, and only one is guarded:
       *
       *   - the text changes, or ai-msg is renamed  -> count is 0 forever and this passes
       *     over anything. CAUGHT: the companion below watches the SAME locator reach 1.
       *   - hitl-demo starts syncing resolutions across tabs deliberately -> B would drain
       *     legitimately and this goes red. NOT a false alarm: at that point isolation as
       *     this test defines it has genuinely been given up, and the red is the decision
       *     surfacing. Change the test THEN, with the feature, not in advance of it.
       */
      await expect(
        tabB.getByTestId("ai-msg").filter({ hasText: DRAIN_TEXT })
      ).toHaveCount(0);

      /*
       * ── THE PRESENCE COMPANION, ON THE SAME LOCATOR ───────────────────────────────────
       *
       * Required, and it is the half that makes the absence mean anything: `toHaveCount(0)`
       * is satisfied by a page that never renders ai-msg at all, and `toBeHidden` by a card
       * that could never appear. So the SAME locator with the SAME filter must be watched
       * reaching 1 in the tab where the drain SHOULD happen. If ai-msg were renamed, or the
       * demo stopped emitting the continuation, this goes red rather than letting the
       * absence above pass over a check that had stopped discriminating.
       *
       * This was previously written as "clean up B by approving it too" — the same clicks,
       * doing the same work, described as housekeeping. It was already the companion and
       * nothing said so, which is why it asserted the card and not the drain.
       */
      await tabB.getByTestId("approve-button").click();
      await expect(tabB.getByTestId("approval-card")).toBeHidden({
        timeout: 10_000,
      });
      await expect(
        tabB.getByTestId("ai-msg").filter({ hasText: DRAIN_TEXT })
      ).toHaveCount(1, { timeout: 30_000 });
    } finally {
      // BEFORE the contexts close — the recorder lives in the page, and a closed
      // page cannot be asked what it received.
      await collectStreamEvidence(testInfo, [
        { label: "tabA", page: tabA },
        { label: "tabB", page: tabB },
      ]);
      await contextA.close();
      await contextB.close();
    }
  });

  // -------------------------------------------------------------------------
  // Route-handler behavior with an `Origin` header. SCOPE NOTE — these are
  // NOT real CSRF tests. Playwright's `request.post` doesn't trigger a
  // browser's CORS preflight or same-origin policy, so what we're proving
  // is that the Next.js route handler itself does not gate on the `Origin`
  // request header. The unprotected route is documented as fail-open
  // ("production deployments should wire authorize against their
  // session/API-key system"). The protected variant gates on Bearer
  // presence only, regardless of origin. Pinning both contracts here so a
  // future silent change to either (e.g. an origin-allowlist) gets caught
  // as a deliberate decision rather than a regression. A real browser-CSRF
  // test would need to load evil.example.com in another browser context
  // and observe whether the browser blocks the request — out of scope.
  // -------------------------------------------------------------------------
  test("route handler: unprotected /api/approval/[id] accepts a POST with Origin: evil.example.com (documented fail-open contract — NOT a browser CSRF test)", async ({
    request,
  }) => {
    // We don't need a real approval — the open route's lookup-then-resolve
    // path returns 404 for an unknown id. The point is that the request
    // wasn't rejected upstream of the registry on the basis of Origin.
    const response = await request.post(
      "/api/approval/nonexistent-cross-origin-id",
      {
        data: { decision: "approve" },
        headers: {
          Origin: "https://evil.example.com",
          Referer: "https://evil.example.com/exploit",
        },
      }
    );
    // 404 (registry miss) — NOT 403 or 401, which would indicate an
    // unannounced origin/CSRF rejection layer that production code might
    // rely on. If this assertion ever fails as 403, the demo route changed
    // its security model and dependent consumers need to know.
    expect(
      response.status(),
      "unprotected route is documented as fail-open — a 403 would indicate a silent security tightening"
    ).toBe(404);
  });

  test("route handler: protected /api/approval-protected/[id] rejects POST without Bearer (401) — gate is auth-based, not origin-based", async ({
    request,
  }) => {
    // The protected route's authorize callback gates on Bearer presence
    // — not on origin. A missing Bearer is 401 whether the request came
    // from the app's own origin or evil.com. This pins that the protection
    // mechanism is auth-based, not origin-based, so a future origin-based
    // check would be a deliberate change (caught here).
    const response = await request.post(
      "/api/approval-protected/nonexistent-cross-origin-id",
      {
        data: { decision: "approve" },
        headers: {
          Origin: "https://evil.example.com",
          Referer: "https://evil.example.com/exploit",
        },
        // Deliberately NO Authorization header.
      }
    );
    expect(response.status()).toBe(401);
  });
});

/**
 * THE WIRE READING MUST BE ABLE TO SAY THE WRONG THING (#675).
 *
 * A diagnostic block rendering the same text on every failing run is decoration:
 * it reassures a reader without telling them anything, and is indistinguishable
 * from one that works. These drive `wireReading` directly with synthetic states,
 * so what is asserted is that the four cases produce FOUR DIFFERENT answers —
 * and specifically that the two pointing at opposite halves of the system cannot
 * be confused for one another.
 *
 * Pure: no browser, no backend, no flake. They run in the mocked job on every
 * pull request, which matters because a broken diagnostic breaks nothing that
 * goes red — it would otherwise regress invisibly.
 */
test.describe("the give-up message reads the wire (#675)", () => {
  const CARD = 'data: {"type":"data-approval-required","data":{"id":"a1"}}\n\n';
  const TEXT = 'data: {"type":"text-delta","id":"t1","delta":"Listing…"}\n\n';

  test("WIRE-01: never requested is not the same as received nothing", () => {
    const never = wireReading({ chunks: [], asked: 0 }).join("\n");
    const empty = wireReading({ chunks: [], asked: 1 }).join("\n");
    expect(never).toContain("never REQUESTED");
    expect(empty).toContain("ZERO chunks");
    // The pair misread once on this very issue: a tab that only POSTs through
    // the request context legitimately reads asked=0, and was published as
    // "the stream opened and delivered nothing".
    expect(never).not.toBe(empty);
  });

  test("WIRE-02: PRESENT and ABSENT point at opposite halves of the system", () => {
    const present = wireReading({ chunks: [TEXT, CARD], asked: 1 }).join("\n");
    const absent = wireReading({ chunks: [TEXT], asked: 1 }).join("\n");
    expect(present).toContain("PRESENT ON THE WIRE");
    expect(present).toContain("BETWEEN RECEIPT AND RENDER");
    expect(absent).toContain("ABSENT");
    expect(absent).toContain("UPSTREAM of this browser");
    // THE LOAD-BEARING ASSERTION. If these rendered alike the block would be
    // decoration and the reader would still need the artifact — the state this
    // change exists to end.
    expect(present).not.toBe(absent);
  });

  test("WIRE-03: an unreadable page is not evidence of absence", () => {
    const msg = wireReading(null).join("\n");
    expect(msg).toContain("COULD NOT READ");
    // It must not read like ABSENT: "we did not ask" and "we asked and it was
    // not there" are the could-not-compute distinction this repo spells with
    // exit 2 everywhere else.
    expect(msg).not.toContain("UPSTREAM of this browser");
  });

  test("WIRE-04: the clip keeps the discriminator and says it clipped", () => {
    const body = "x".repeat(4000) + CARD + "y".repeat(4000);
    const clip = clipAround(body, "data-approval-required");
    expect(clip.text).toContain("data-approval-required");
    expect(clip.label).toContain("CLIPPED");
    expect(clip.text.length).toBeLessThan(body.length);
    // The companion: a body short enough to show whole is NOT labelled clipped,
    // or "CLIPPED" stops carrying information.
    const whole = clipAround(CARD, "data-approval-required");
    expect(whole.label).not.toContain("CLIPPED");
    expect(whole.text).toBe(CARD);
  });

  /*
   * THE ENVIRONMENT IS THE AXIS THE WIRE CANNOT SEE (#770).
   *
   * Eight occurrences, three tests, two shas — and eight IDENTICAL wire
   * readings. The bytes stopped being informative after the first one. What
   * separates a failing CI run from 57 passing local executions of the same
   * specs is not on the wire at all, and the give-up message recorded none of it.
   *
   * These drive `timingReading` DIRECTLY, for the same reason the WIRE cases
   * drive `wireReading` directly: the render path can only produce the timings a
   * real failure happens to have, so no amount of running the suite can observe
   * whether the SLOW and STALLED branches differ. Asked straight, it can.
   *
   * NESTED UNDER THE WIRE BLOCK DELIBERATELY: both describe readings of the
   * SAME give-up message, and #770 is #754's shape one axis over. The title
   * is written to read as a continuation of the parent's rather than as a
   * second unrelated suite.
   */
  test.describe("...and the clock (#770)", () => {
    test("TIME-01: SLOW-TO-BE-SERVED and SERVED-THEN-STOPPED are different readings", () => {
      const stalled = timingReading({ headAt: 101, at: [104] }).join("\n");
      const slow = timingReading({ headAt: 8_200, at: [8_400] }).join("\n");
      expect(stalled).toContain("SERVED PROMPTLY, THEN STOPPED");
      expect(stalled).toContain("TRANSPORT");
      expect(slow).toContain("SLOW TO BE SERVED");
      expect(slow).toContain("ENVIRONMENT");
      // THE LOAD-BEARING ASSERTION, and the reason this lives apart from
      // giveUpMessage. If these rendered alike the block would be decoration and
      // the next occurrence would cost another investigation to learn what the
      // last eight already said.
      expect(stalled).not.toBe(slow);
    });

    test("TIME-02: an unstamped request is COULD NOT READ, not a verdict either way", () => {
      const none = timingReading(null).join("\n");
      const unstamped = timingReading({ at: [], headAt: undefined }).join("\n");
      expect(none).toContain("COULD NOT READ");
      expect(unstamped).toContain("COULD NOT READ");
      // "We could not measure" and "we measured and it was fine" are the
      // could-not-compute distinction this repo spells with exit 2 elsewhere.
      expect(none).not.toContain("SLOW TO BE SERVED");
      expect(none).not.toContain("SERVED PROMPTLY");
    });

    test("TIME-03: headers that arrive with no chunk behind them say so", () => {
      const msg = timingReading({ headAt: 97, at: [] }).join("\n");
      expect(msg).toContain("NEVER");
      // The companion: a run that DID get a chunk must not print NEVER, or the
      // word stops carrying information — the same failure as "at least" on
      // every number.
      const got = timingReading({ headAt: 97, at: [101] }).join("\n");
      expect(got).not.toContain("NEVER");
    });

    test("TIME-04: the largest gap names where it fell, and is n/a when there is none", () => {
      const msg = timingReading({ headAt: 99, at: [101, 4_200, 4_205] }).join(
        "\n"
      );
      expect(msg).toContain("largest gap");
      expect(msg).toContain("after chunk 1 of 3");
      // One chunk cannot have a gap, and printing 0ms would read as a measured
      // silence rather than an unmeasurable one.
      const single = timingReading({ headAt: 99, at: [101] }).join("\n");
      expect(single).toContain("n/a");
    });
  });
});
