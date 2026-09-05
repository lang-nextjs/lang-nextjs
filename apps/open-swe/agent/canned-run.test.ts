import { describe, expect, it } from "vitest";
// The stub is plain ESM JS — a dev fixture, not shipped code — and TypeScript
// resolves it via allowJs, so no suppression is needed. Worth noting because
// the first version added one and failed typecheck for being unused; the
// SECOND failed again for explaining that in a comment, since the compiler
// reads the directive's name wherever it appears on a comment line.
import {
  cannedFinalState,
  cannedSteps,
  threadStatusFromRuns,
} from "./canned-run.mjs";

/**
 * A SCRIPTED RUN SHOWS THE TASK IT WAS GIVEN.
 *
 * Reported as: every card in the queue renders the same conversation. The
 * board showed the task a person had submitted; opening the card showed
 * "Fix the failing parser test" and "Added a null-guard to parse()" — a
 * discussion of a parser they had never mentioned, identical on every run,
 * because the thread state was a module-level CONSTANT.
 *
 * TWO PROPERTIES, AND THE SECOND IS EASY TO LOSE.
 *
 *   1. the run reflects the task it was actually given
 *   2. it remains RECOGNISABLE AS SCRIPTED
 *
 * The tempting fix — generate plausible work for whatever was typed — delivers
 * the first and destroys the second, producing a fake run that is harder to
 * tell from a real one than the fixed one it replaced. The step SHAPES stay
 * fixed because their job is to exercise UI surfaces; only the content moves,
 * and it says what it is.
 */

const TASK = "Refactor the auth module";

describe("the run reflects the task it was given", () => {
  it("THE TRANSCRIPT OPENS WITH THE SUBMITTED TASK", () => {
    // The reported symptom, directly.
    const { values } = cannedFinalState(TASK);
    expect(values.messages[0]).toMatchObject({ role: "user", content: TASK });
  });

  it("two different tasks produce two different transcripts", () => {
    // The property a constant cannot have, stated as a comparison so it
    // cannot be satisfied by a fixture that happens to contain one task.
    const a = cannedFinalState("Refactor the auth module");
    const b = cannedFinalState("Add rate limiting to the API");
    expect(a.values.messages[0].content).not.toBe(b.values.messages[0].content);
    expect(a.values.messages[1].content).not.toBe(b.values.messages[1].content);
  });

  it("the streamed steps carry it too, not just the final state", () => {
    // The card content and the live stream are two surfaces, and only fixing
    // one leaves a run that streams someone else's investigation and then
    // settles into yours.
    const streamed = JSON.stringify(cannedSteps(TASK));
    expect(streamed).toContain(TASK);
  });

  it("NO STEP CLAIMS TO HAVE TOUCHED src/parser.ts", () => {
    // The specific false detail: a file read that names a path which may not
    // exist in the reader's repo is what made these runs read as real work
    // about someone else's code.
    const streamed = JSON.stringify(cannedSteps(TASK));
    expect(streamed).not.toContain("src/parser.ts");
    expect(streamed).not.toContain("parser.test.ts");
    expect(JSON.stringify(cannedFinalState(TASK))).not.toContain("null-guard");
  });
});

describe("and it still admits to being scripted", () => {
  it("THE REPLY SAYS NO MODEL WAS CALLED", () => {
    // The property the obvious fix would have destroyed. The previous reply —
    // "Added a null-guard to parse() and re-ran the suite" — is a specific
    // technical assertion no model made, believable enough to be mistaken for
    // a result.
    const { values } = cannedFinalState(TASK);
    expect(values.messages[1].content).toMatch(/scripted|no model/i);
  });

  it("it does not claim the work was done", () => {
    const reply = cannedFinalState(TASK).values.messages[1].content as string;
    expect(reply).not.toMatch(/\b(added|fixed|re-ran|refactored|completed)\b/i);
  });

  it("every step's output admits it too, or reveals nothing", () => {
    // A step that reports a concrete FINDING — "2 failing cases in
    // parser.test.ts" — is the shape that reads as real. Outputs may be inert
    // ("plan saved") or self-declaring, never a specific discovery.
    for (const step of cannedSteps(TASK) as Array<{
      name: string;
      data: unknown;
    }>) {
      const out = JSON.stringify(step.data);
      expect(out, `${step.name} reports a finding`).not.toMatch(
        /\d+ failing|\d+ error|\d+ test/i
      );
    }
  });

  it("the file it writes is named for what it is", () => {
    const files = Object.keys(cannedFinalState(TASK).values.files);
    expect(files).toEqual(["SCRIPTED_RUN.md"]);
  });
});

describe("a task that is missing or empty", () => {
  it("does not render as the string 'undefined' or 'null'", () => {
    // These reach a person's screen. `undefined` in a transcript reads as a
    // bug in the app rather than as an absent field.
    for (const bad of [undefined, null, "", "   "]) {
      const first = cannedFinalState(bad).values.messages[0].content as string;
      expect(first, String(bad)).not.toMatch(/undefined|null/);
      expect(first.trim().length).toBeGreaterThan(0);
    }
  });

  it("says Untitled task, which is what the run list already calls it", () => {
    expect(cannedFinalState(undefined).values.messages[0].content).toBe(
      "Untitled task"
    );
  });

  it("a task with quotes does not break the reply", () => {
    // The reply interpolates the task into a quoted sentence.
    const t = 'Fix the "parse" helper';
    const reply = cannedFinalState(t).values.messages[1].content as string;
    expect(reply).toContain(t);
  });
});

/**
 * A THREAD REPORTS WHETHER IT IS EXECUTING.
 *
 * Reported as "when I create a task, it goes directly to idle". It did,
 * because the board had just been changed to believe the THREAD over the run
 * record — correctly, that was the fix for two surfaces disagreeing — and the
 * stub's thread status was the hardcoded string "idle". Harmless while nothing
 * read it; wrong the moment something did.
 *
 * So the run record said `running`, the thread said `idle` and outranked it,
 * and a task went to "Not running" the instant it was created.
 */
describe("a thread's status follows its runs", () => {
  it("A RUN IN FLIGHT MAKES THE THREAD BUSY", () => {
    // The reported symptom, at the rule.
    expect(threadStatusFromRuns([{ status: "running" }])).toBe("busy");
  });

  it("nothing executing is idle — which is what the word means", () => {
    expect(threadStatusFromRuns([{ status: "success" }])).toBe("idle");
    expect(threadStatusFromRuns([])).toBe("idle");
  });

  it("INTERRUPTED OUTRANKS BUSY", () => {
    // A cancelled run is the state a person must act on. Letting a sibling
    // run's activity mask it would hide the one card that needs them.
    expect(
      threadStatusFromRuns([{ status: "running" }, { status: "interrupted" }])
    ).toBe("interrupted");
  });

  it("busy outranks idle, so a finished sibling does not mask live work", () => {
    expect(
      threadStatusFromRuns([{ status: "success" }, { status: "running" }])
    ).toBe("busy");
  });

  it("survives junk without throwing", () => {
    // The stub is a dev fixture and its Map is edited by several handlers.
    // A crash here takes down the endpoint the whole board polls.
    for (const junk of [
      null,
      undefined,
      "nope",
      [null],
      [{}],
      [{ status: 7 }],
    ]) {
      expect(() => threadStatusFromRuns(junk), String(junk)).not.toThrow();
    }
    expect(threadStatusFromRuns([{}])).toBe("idle");
  });

  it("the state carries the status it was given", () => {
    // The wiring, asserted at the seam: a derivation nothing passes through is
    // the shape that produced three defects in this repo today.
    expect(cannedFinalState("t", "busy").status).toBe("busy");
    expect(cannedFinalState("t").status).toBe("idle");
  });
});
