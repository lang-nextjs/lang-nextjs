import { describe, expect, it } from "vitest";
import { mapStatus } from "./langgraph-client";
import { mapThreadStatus } from "./thread-state";

/**
 * TWO MAPPERS, ONE RUN, DIFFERENT ANSWERS (#246).
 *
 * Reported from a live board: seventeen runs shown as "Running", some a day
 * old, every one of their threads reporting `idle`. The board and the detail
 * page each derive a status from the platform, independently, with different
 * tables — and nothing compared them, because `mapStatus` was file-private and
 * could not be examined at all.
 *
 * THE CAUSE IS STRUCTURAL, NOT A MISSING CASE. The two sides cannot express the
 * same set of answers:
 *
 *   ThreadRunStatus   pending running completed failed interrupted idle unknown
 *   Run["status"]     pending running completed failed
 *
 * `Run["status"]` has nowhere to put `interrupted`, `idle` or `unknown`. So the
 * board's mapper is not merely missing #176's fix — it is FORCED to invent an
 * answer for three inputs it has no vocabulary for, and every invention it can
 * make is a claim the thread never made.
 *
 * These tests do not assert the current behaviour, which would encode the bug.
 * They assert what the two surfaces owe each other, and are marked `it.fails`
 * where the code does not yet deliver it. Fixing #246 turns those green and
 * vitest reports the annotation as stale.
 */

/** Every raw status the platform is known to emit, in one place. */
const RAW = [
  "busy",
  "idle",
  "error",
  "interrupted",
  "pending",
  "success",
  "timeout",
  "running",
] as const;

/** Statuses that mean "this run has stopped, and how it stopped is known". */
const TERMINAL_ON_BOARD = new Set(["completed", "failed"]);
const TERMINAL_ON_THREAD = new Set(["completed", "failed"]);

describe("the board's mapper, on its own terms", () => {
  it("maps the executing states to running", () => {
    expect(mapStatus("busy", undefined)).toBe("running");
    expect(mapStatus(undefined, "running")).toBe("running");
  });

  it("maps the failure states to failed", () => {
    expect(mapStatus("error", undefined)).toBe("failed");
    expect(mapStatus("timeout", undefined)).toBe("failed");
  });

  it("prefers the RUN's status over the THREAD's when both are present", () => {
    // `const s = runStatus ?? threadStatus`. This is the line that produces the
    // reported symptom: an orphaned run recorded `running` outranks its own
    // thread saying `idle`, so the board shows work executing that stopped.
    expect(mapStatus("idle", "running")).toBe("running");
  });

  it("falls back to the thread's status when the run has none", () => {
    expect(mapStatus("busy", undefined)).toBe("running");
  });
});

describe("what the two mappers owe each other", () => {
  /**
   * THE THREAD SIDE, ASSERTED SEPARATELY AND EXPECTED TO PASS.
   *
   * Every `it.fails` below originally carried this assertion too — which was a
   * hole: `it.fails` is satisfied by ANY throw, so if the thread mapper
   * regressed, those tests would still have reported "expected fail" while
   * saying nothing about the board. Held here, an `it.fails` below can only be
   * failing for the reason it names.
   */
  it("the thread mapper already behaves correctly — the baseline the board is measured against", () => {
    expect(mapThreadStatus("idle", false)).toBe("idle");
    expect(mapThreadStatus("interrupted", false)).toBe("interrupted");
    expect(mapThreadStatus("some-new-platform-state", false)).toBe("unknown");
    expect(mapThreadStatus(undefined, false)).toBe("unknown");
    // Interrupts win over any status — the #176 precedence rule.
    expect(mapThreadStatus("busy", true)).toBe("interrupted");
  });

  it.fails(
    "IDLE IS NOT COMPLETED — the board claims a success the thread never reported (#246)",
    () => {
      // #176 fixed exactly this on the thread side, and wrote down why: "`idle`
      // no longer means 'completed'. It means the thread is not executing,
      // which is equally true before a run and after a failure, so it cannot
      // carry a claim of success."
      //
      // The board still maps it to `completed`. A run that never started and a
      // run that finished are rendered identically, in the Done column.
      expect(mapStatus("idle", undefined)).not.toBe("completed");
    }
  );

  it.fails(
    "AN UNKNOWN STATUS IS NOT A TERMINAL STATE — the board defaults to completed (#246)",
    () => {
      // `default: return "completed"`. The exact defect #176 exists to prevent,
      // still live one module away: a status this build has never seen is
      // rendered as a finished, successful run.
      expect(
        TERMINAL_ON_BOARD.has(mapStatus("some-new-platform-state", undefined))
      ).toBe(false);
    }
  );

  it.fails(
    "INTERRUPTED IS NOT RUNNING — and this is why Needs approval can never fill (#246)",
    () => {
      // The board declares a `needs-approval` column for `interrupted`, and
      // run-board.ts says it does so deliberately: "It gets a column here even
      // though the list endpoint does not currently report it."
      //
      // This is WHY it does not report it. `Run["status"]` cannot hold
      // `interrupted`, so the mapper collapses it to `running` and the column
      // is unreachable from the list endpoint by construction. A run waiting on
      // a human — the one state a person is meant to act on — is filed under
      // work in progress.
      expect(mapStatus("interrupted", undefined)).not.toBe("running");
    }
  );

  it("NEITHER MAPPER INVENTS A FAILURE — the safe direction is preserved", () => {
    // The control for all three above. Whatever the fix does, it must not swing
    // the other way: reporting a healthy run as failed would send people to
    // investigate work that is fine, and is its own kind of lie.
    for (const raw of RAW) {
      if (raw === "error" || raw === "timeout") continue;
      expect(mapStatus(raw, undefined), `board on ${raw}`).not.toBe("failed");
      expect(mapThreadStatus(raw, false), `thread on ${raw}`).not.toBe("failed");
    }
  });

  it("the two agree on every status they CAN both express", () => {
    // The part that already works, asserted so a fix cannot regress it. These
    // four are in both unions, so there is no excuse for a divergence.
    for (const raw of ["busy", "error"] as const) {
      const board = mapStatus(raw, undefined);
      const thread = mapThreadStatus(raw, false);
      expect(board, `board and thread on ${raw}`).toBe(thread);
    }
  });
});

describe("the vocabularies themselves", () => {
  it("the board cannot express three states the thread can", () => {
    // Stated as a test because it is the ROOT of #246 and is otherwise only
    // visible by reading two type declarations in different files. If a fix
    // widens Run["status"], this test is the one that should be updated first —
    // and its failure is the signal that the structural problem was addressed
    // rather than papered over in the mapper.
    const threadOnly = ["interrupted", "idle", "unknown"];
    const boardCanExpress = ["pending", "running", "completed", "failed"];
    for (const s of threadOnly) {
      expect(
        boardCanExpress.includes(s),
        `${s} is representable on the board`
      ).toBe(false);
    }
  });

  it("every thread-only state currently collapses onto a board state that means something else", () => {
    // The consequence, made concrete. Each of these is a specific false claim
    // the board makes today.
    expect(mapStatus("interrupted", undefined)).toBe("running"); // waiting → working
    expect(mapStatus("idle", undefined)).toBe("completed"); // stopped → succeeded
    expect(mapStatus("who-knows", undefined)).toBe("completed"); // unknown → succeeded
    // And all three land in a column that asserts something the thread did not.
    expect(TERMINAL_ON_THREAD.has("completed")).toBe(true);
  });
});
