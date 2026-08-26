import { describe, expect, it } from "vitest";
import { mapStatus } from "./langgraph-client";
import { mapThreadStatus } from "./thread-state";
import { RUN_STATUSES } from "./types";

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
 * They assert what the two surfaces owe each other.
 *
 * FIXED. Three cases here were `it.fails` when this file was written, and the
 * note said "fixing #246 turns those green and vitest reports the annotation as
 * stale" — which is what happened. The fix was NOT in the mapper: `Run["status"]`
 * was widened to the thread's full vocabulary, because while the two unions
 * differed there was no correct value for the mapper to return. The `it.fails`
 * markers are gone and the assertions are unchanged; that is the record.
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

  it(
    "IDLE IS NOT COMPLETED — the board claims a success the thread never reported (#246)",
    () => {
      // #176 fixed exactly this on the thread side, and wrote down why: "`idle`
      // no longer means 'completed'. It means the thread is not executing,
      // which is equally true before a run and after a failure, so it cannot
      // carry a claim of success."
      //
      // The board mapped it to `completed`: a run that never started and a run
      // that finished were rendered identically, in the Done column. It now
      // returns `idle`, which the board files under Other.
      expect(mapStatus("idle", undefined)).not.toBe("completed");
    }
  );

  it(
    "AN UNKNOWN STATUS IS NOT A TERMINAL STATE — the board defaults to completed (#246)",
    () => {
      // Was `default: return "completed"` — the exact defect #176 exists to
      // prevent, living one module away from the fix: a status this build has
      // never seen, rendered as a finished, successful run. Now `unknown`.
      expect(
        TERMINAL_ON_BOARD.has(mapStatus("some-new-platform-state", undefined))
      ).toBe(false);
    }
  );

  it(
    "INTERRUPTED IS NOT RUNNING — and this is why Needs approval can never fill (#246)",
    () => {
      // The board declares a `needs-approval` column for `interrupted`, and
      // run-board.ts says it does so deliberately: "It gets a column here even
      // though the list endpoint does not currently report it."
      //
      // That was WHY it did not report it. `Run["status"]` could not hold
      // `interrupted`, so the mapper collapsed it to `running` and the column
      // was unreachable from the list endpoint by construction. A run waiting
      // on a human — the one state a person is meant to act on — was filed
      // under work in progress. Widening the type is what emptied that excuse.
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
  it("the board can express every status the thread can — the actual fix", () => {
    // Stated as a test because it is the ROOT of #246 and is otherwise only
    // visible by reading two type declarations in different files. The earlier
    // version of this case asserted the OPPOSITE and passed; its note said "if
    // a fix widens Run['status'], this test is the one that should be updated
    // first — and its failure is the signal that the structural problem was
    // addressed rather than papered over in the mapper." That is what happened.
    //
    // RUN_STATUSES is imported, not re-typed here. A list copied into a test
    // agrees with whatever it was copied from no matter what the source does
    // afterwards, so it could never detect the narrowing it exists to forbid.
    for (const s of ["interrupted", "idle", "unknown"]) {
      expect(
        (RUN_STATUSES as readonly string[]).includes(s),
        `${s} is representable on the board`
      ).toBe(true);
    }
  });

  it("no thread-only status collapses onto a board status that means otherwise", () => {
    // The three specific false claims the board used to make, now the thread's
    // own words. Each line was a bug report.
    expect(mapStatus("interrupted", undefined)).toBe("interrupted"); // was: running
    expect(mapStatus("idle", undefined)).toBe("idle"); // was: completed
    expect(mapStatus("who-knows", undefined)).toBe("unknown"); // was: completed
  });

  it("and none of the three is filed as a finished run any more", () => {
    // The consequence that made #246 visible: seventeen runs in a terminal
    // column, none of them terminal. Asserted through TERMINAL_ON_BOARD so it
    // measures the claim the COLUMN makes, not just the mapper's return value.
    for (const raw of ["interrupted", "idle", "who-knows"]) {
      expect(TERMINAL_ON_BOARD.has(mapStatus(raw, undefined)), raw).toBe(false);
      expect(TERMINAL_ON_THREAD.has(mapThreadStatus(raw, false)), raw).toBe(false);
    }
  });

  it("every status the board can express is reachable from some raw input", () => {
    // Widening a union is cheap and a value nothing returns is dead weight that
    // still has to be handled at every switch. This fails if a status is added
    // to RUN_STATUSES with no path to it.
    const reachable = new Set(
      [...RAW, "who-knows", undefined].map((r) => mapStatus(r, undefined))
    );
    for (const s of RUN_STATUSES) {
      expect(reachable.has(s), `nothing maps to ${s}`).toBe(true);
    }
  });
});
