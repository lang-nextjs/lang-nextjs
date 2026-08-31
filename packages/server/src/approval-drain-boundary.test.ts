/**
 * THE DRAIN AND THE REGISTRY MUST AGREE ABOUT ONE INSTANT (#417).
 *
 * `drainOnClose` and `getApproval` used to read `expiresAt` with different bounds:
 *
 *   approval-registry  expiresAt <  Date.now()        -> at now === expiresAt: NOT expired
 *   approval-gating    min(expiry, grace) - now <= 0  -> at now === expiresAt: give up
 *
 * So at exactly `expiresAt` the drain stopped waiting while the registry still called the
 * approval `waiting`; the loop fell through to the release sweep, and a call one comparison
 * from `approval_timeout` was reported as `approval_pending_at_close` — which claims the
 * operator still had a decision window they did not have.
 *
 * ── WHY THIS FILE EXISTS RATHER THAN A COMMENT ────────────────────────────────────────────
 *
 * The mechanism was READ FROM SOURCE and had never been reproduced: the CI failure that
 * prompted it did not recur in 300 local runs. A source reading that cannot be demonstrated
 * is a hypothesis, and this repository has shipped fixes for those before. These cases are
 * the demonstration — they fail on the old bounds and pass on the shared predicate.
 *
 * ── THE CLOCK IS FROZEN, AND THE FIRST ATTEMPT AT THIS WAS WRONG BECAUSE IT WAS NOT ───────
 *
 * An advancing fake clock cannot pin an instant: milliseconds elapse between setting the
 * offset and entering the drain, so the probe lands a millisecond off and reports the
 * boundary in the wrong place. My first version did exactly that and produced
 * `approval_pending_at_close` at `expiresAt + 1` — which was cross-test contamination, not a
 * measurement, and disappeared when the case was run alone.
 *
 * Freezing is safe HERE specifically because at an offset >= the expiry the loop breaks on
 * its first iteration without sleeping, so there is no timer to starve. Below the expiry a
 * frozen clock would spin forever, which is why no such case appears in this file.
 *
 * ── MUTATING ONE SIDE HANGS; MUTATE BOTH ─────────────────────────────────────────────────
 *
 * Reverting only the registry leaves a hybrid neither version ever was: the drain no longer
 * breaks at the boundary and the frozen clock never advances, so the loop spins and the case
 * fails by TIMEOUT rather than by assertion. Reverting BOTH reproduces the original failure
 * exactly — `expected [ 'approval_pending_at_close' ] to deeply equal [ 'approval_timeout' ]`,
 * the same words as the CI failure on #402. That is the mutation worth running.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApprovalGatingTransform } from "./approval-gating";
import type { SseFrame } from "./accumulator";

const frame = (o: Record<string, unknown>): SseFrame => ({
  raw: `data: ${JSON.stringify(o)}`,
});

/** 20ms is arbitrary; only its relationship to the frozen clock matters. */
const gateAll = () => ({ require: true, timeoutMs: 20 });
const TIMEOUT_MS = 20;

afterEach(() => vi.restoreAllMocks());

function errorCodes(frames: SseFrame[]): string[] {
  const joined = frames.map((f) => f.raw).join("\n");
  return (joined.match(/"code"\s*:\s*"([a-z_]+)"/g) ?? []).map((s) =>
    s.replace(/.*"([a-z_]+)"$/, "$1")
  );
}

/** Buffer one gated tool call, then enter `drainOnClose` with the clock frozen at `offset`. */
async function drainEnteredAt(offset: number): Promise<string[]> {
  const T0 = 1_000_000;
  let clock = T0;
  vi.spyOn(Date, "now").mockImplementation(() => clock);

  const t = createApprovalGatingTransform({ getApprovalConfig: gateAll });
  for (const f of [
    frame({ type: "tool-input-start", toolCallId: "tc1", toolName: "increment", input: {} }),
    frame({ type: "tool-input-available", toolCallId: "tc1", toolName: "increment", input: {} }),
  ]) {
    t(f);
  }

  clock = T0 + offset; // expiresAt === T0 + TIMEOUT_MS
  return errorCodes(await t.drainOnClose());
}

describe("drainOnClose — the expiry boundary", () => {
  it("at exactly expiresAt, reports approval_timeout and not pending_at_close", async () => {
    /*
     * THE DEFECT, and the one case that fails on the old bounds. `approval_pending_at_close`
     * describes a window the operator still had; at `expiresAt` they did not, so the report
     * would have been false about the only thing it exists to say.
     */
    expect(await drainEnteredAt(TIMEOUT_MS)).toEqual(["approval_timeout"]);
  });

  it("one millisecond past expiresAt reports the same thing", async () => {
    /*
     * The instant either side of a boundary should not produce two different reports for the
     * same situation. This passed before the fix too — which is the point: the defect was
     * visible only AT the boundary, so a suite sampling near it would have missed it.
     */
    expect(await drainEnteredAt(TIMEOUT_MS + 1)).toEqual(["approval_timeout"]);
  });

  it("well past expiresAt still reports approval_timeout", async () => {
    // The far case, so "agrees at the boundary" is not satisfied by a predicate that has
    // stopped distinguishing anything at all.
    expect(await drainEnteredAt(TIMEOUT_MS + 500)).toEqual(["approval_timeout"]);
  });
});
