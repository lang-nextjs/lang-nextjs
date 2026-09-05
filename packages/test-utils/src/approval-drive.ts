/**
 * DRIVE A GATED RUN TO COMPLETION — dispatch, approve what it pauses on, resume.
 *
 * WHAT DOES NOT EXIST WITHOUT THIS (#745). `GATED_TOPOLOGIES` declares a gate
 * across six cells, #668 holds the decision vocabulary in parity in SOURCE, and
 * the seam checker proves the saver is injected while printing "whether a
 * decision is honoured" on its own NOT CHECKED list. The frame conformance tests
 * beside this file pin the adapter to the card's schema. Every piece is proven
 * and NOTHING DRIVES THE ROUND TRIP: as the backend's own gated-run invariants
 * put it, "every existing assertion is driven by a CONSTRUCTED gated graph or an
 * INJECTED fixture frame, never by a run that paused and then resumed".
 *
 * This is the missing piece, and it is deliberately a HELPER rather than a test.
 * Its first caller is the live tool matrix, which is the only suite that already
 * drives real backends across all six gating cells — but the round trip is not a
 * property of that suite, and burying it there would make the next caller copy it.
 *
 * ── WHAT IT MAY DEPEND ON, AND WHAT IT MUST NOT ─────────────────────────────
 *
 * It keys on the pause part's TYPE and on nothing inside it. That line is drawn
 * where the repository draws it, not by taste:
 *
 *   - the TYPE is a contract with a guard. `approval-pause-conformance.test.ts`
 *     beside this file asserts the adapter's part and the card's schema agree on
 *     it, so a rename goes red rather than silent.
 *   - the LAYOUT is explicitly not one. `_pending_approval_events` carries
 *     "THE SHAPE OF THESE FRAMES IS PROVISIONAL AND #420 OWNS IT — nothing may
 *     depend on this layout yet: no client renders it, no resume path parses it".
 *     A helper that read `action_requests` out of a pause would make that shape
 *     the contract by nobody deciding, which is the failure that comment exists
 *     to prevent.
 *
 * So it approves POSITIONALLY — `{type: "approve"}` with no id — which is what
 * the resume path already consumes (`Command(resume={"decisions": [...]})`) and
 * what `parse_approval_decisions` accepts for an approve: `type` and nothing
 * else. Approving without naming what you approve is a real limitation, stated
 * in `driveApprovals` rather than hidden.
 */

/**
 * The part a paused run reaches a client as.
 *
 * The backend emits `event: approval_pending`; packages/server turns it into
 * this part. A client of `/api/chat/stream` sees only the second, which is why
 * this and not the wire event upstream of it.
 */
export const APPROVAL_PAUSE_PART = "data-approval-pause";

/** A decision the resume path accepts for "run it". */
export const APPROVE: Readonly<{ type: "approve" }> = Object.freeze({
  type: "approve" as const,
});

/**
 * Did this stream end waiting for an approval?
 *
 * Matches the part type anywhere in the body rather than parsing frames: a
 * paused run's pause is appended after the stream drains, so it is not at a
 * position this can rely on, and a parser that missed it would report "not
 * paused" — which is the answer that makes a gated run look like a working one.
 */
export function isApprovalPause(sse: string): boolean {
  return sse.includes(`"${APPROVAL_PAUSE_PART}"`);
}

/** The policy wire shape: the READ-ONLY allowlist, never the gated names. */
export function approvalPolicy(readOnlyTools: readonly string[]): {
  readOnlyTools: string[];
} {
  return { readOnlyTools: [...readOnlyTools] };
}

export interface ApprovalDriveResult {
  /** Every response body, in order. `bodies[0]` is the first dispatch. */
  bodies: string[];
  /** Dispatches performed, including the first. */
  rounds: number;
  /** Decisions sent — `rounds - 1` by construction. */
  approvals: number;
}

/**
 * Dispatch, then approve for as long as the run keeps pausing.
 *
 * `dispatch` takes a request body and returns the response text, so this is
 * driven by whatever the caller already has — a Playwright `APIRequestContext`,
 * a fetch, or a stub. It deliberately does not import a test framework: a helper
 * that needed a live backend to exercise would only run where the failure
 * already costs a day, which is the situation #745 was found in.
 *
 * REFUSES RATHER THAN GIVING UP. If the run is still paused after `maxRounds`,
 * this THROWS. A helper that returned a still-paused result would hand its
 * caller a body with no tool output in it, and the caller's assertion would
 * report "the tool did not run" about a run nobody finished driving — a true
 * sentence about the wrong subject.
 *
 * LIMITATION, STATED: approvals are positional. Every pending request in a round
 * gets one `approve`, and this cannot approve one call and reject another. That
 * is enough for "does the round trip work at all", which is what does not exist
 * today, and it is not enough for testing selective approval. Naming what you
 * approve needs the pause frame's layout, which #420 owns and has not settled.
 */
export async function driveApprovals(
  dispatch: (body: Record<string, unknown>) => Promise<string>,
  body: Record<string, unknown>,
  opts: { maxRounds?: number } = {}
): Promise<ApprovalDriveResult> {
  const maxRounds = opts.maxRounds ?? 3;
  if (maxRounds < 1) {
    throw new Error(
      `maxRounds must be at least 1, got ${maxRounds}: a drive that never ` +
        "dispatches reports nothing about a run it did not start."
    );
  }

  const bodies: string[] = [];
  let rounds = 0;

  for (;;) {
    const sent =
      rounds === 0 ? body : { ...body, approvalDecisions: [APPROVE] };
    const sse = await dispatch(sent);
    bodies.push(sse);
    rounds += 1;

    if (!isApprovalPause(sse)) {
      return { bodies, rounds, approvals: rounds - 1 };
    }
    if (rounds >= maxRounds) {
      throw new Error(
        `still awaiting approval after ${rounds} dispatch(es) (maxRounds=${maxRounds}). ` +
          "Returning here would hand back a body with no tool output and let the " +
          "caller report 'the tool did not run' about a run that was never finished."
      );
    }
  }
}
