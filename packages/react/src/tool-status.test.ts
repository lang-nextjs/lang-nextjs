import { describe, expect, it } from "vitest";
import { partsToMessages } from "./converter";
import type { ToolCallMessage } from "./types";

/**
 * A TOOL THAT FAILED IS NOT A TOOL THAT COMPLETED.
 *
 * `ToolCallMessage["status"]` was `"running" | "complete"` while the AI SDK
 * reports five tool-part states. The converter had nowhere to put two of them:
 *
 *   output-error   -> "complete"   the tool THREW
 *   output-denied  -> "complete"   a human REFUSED it
 *
 * Both apps render on that status, so a failed tool showed a green dot and the
 * literal word "complete". The ERROR TEXT came through correctly the whole
 * time, which is why reading the transcript never revealed it — the right
 * words were on screen under the wrong colour.
 *
 * open-swe still carries the fingerprint of someone half-noticing: its summary
 * line reads `hasResult && !/^error/i.test(resultText)`, a regex against the
 * RESULT TEXT to stop an error leaking into a line claiming success — a
 * workaround for the symptom, one layer above the status that was lying.
 *
 * Same shape as #246 two packages away: a type with fewer states than the
 * world it models forces its mapper to invent an answer, and every invention
 * available to it is a claim the source never made.
 */

const assistant = (parts: unknown[]) => ({
  id: "m1",
  role: "assistant" as const,
  parts,
});

function toolOf(state: string, extra: Record<string, unknown> = {}) {
  const msgs = partsToMessages(
    [
      assistant([
        {
          type: "dynamic-tool",
          toolCallId: "tc-1",
          toolName: "risky",
          state,
          ...extra,
        },
      ]) as never,
    ],
    false
  );
  const m = msgs.find((x) => x.type === "tool-call");
  return m as ToolCallMessage | undefined;
}

describe("the two states that were filed under success", () => {
  it("A TOOL THAT THREW IS NOT complete", () => {
    // The headline. Against the previous build this returned "complete" and an
    // existing test asserted exactly that, which is how it survived.
    expect(toolOf("output-error", { errorText: "boom" })?.status).toBe("error");
  });

  it("A TOOL A HUMAN REFUSED IS NOT complete", () => {
    // Distinct from an error on purpose: nothing went wrong, a person said no.
    // Rendering a refusal as a failure would send someone debugging a decision.
    expect(toolOf("output-denied")?.status).toBe("denied");
  });

  it("error and denied are DISTINCT from each other", () => {
    // Collapsing them would be the same defect in a smaller box.
    expect(toolOf("output-error", { errorText: "x" })?.status).not.toBe(
      toolOf("output-denied")?.status
    );
  });

  it("the error TEXT still comes through — that part always worked", () => {
    // Guards the half that was never broken, so a fix to the status cannot
    // quietly cost the message.
    expect(toolOf("output-error", { errorText: "tool blew up" })?.result).toBe(
      "tool blew up"
    );
  });

  it("an error with no text still says something", () => {
    // A blank result under a red dot tells a person nothing they can act on.
    const r = toolOf("output-error")?.result;
    expect(typeof r).toBe("string");
    expect(String(r).length).toBeGreaterThan(0);
  });
});

describe("the states that already worked, asserted so they keep working", () => {
  it("input-streaming and input-available are running", () => {
    expect(toolOf("input-streaming")?.status).toBe("running");
    expect(toolOf("input-available")?.status).toBe("running");
  });

  it("output-available is complete", () => {
    // The control for the whole file. Without it, "nothing is complete" would
    // satisfy every case above — the same bug pointing the other way.
    expect(toolOf("output-available", { output: "42" })?.status).toBe("complete");
  });

  it("every SDK state maps to a DISTINCT outcome where it should", () => {
    // Two running states share an answer legitimately; the other three must
    // not. A mapper returning one constant passes any single case above.
    const seen = new Set(
      ["output-available", "output-error", "output-denied"].map(
        (s) => toolOf(s)?.status
      )
    );
    expect(seen.size).toBe(3);
  });
});

describe("a state this build has never seen", () => {
  it("IS NOT REPORTED AS COMPLETE", () => {
    // The exact defect #176 exists to prevent, in a third package. A future
    // SDK state arriving here must not render as a finished, successful call.
    expect(toolOf("output-quarantined")?.status).not.toBe("complete");
  });

  it("renders as still running, which is honest and recoverable", () => {
    // Of the four, `running` is the only one that claims nothing: it does not
    // assert success, does not accuse the tool of failing, and resolves itself
    // the moment a state the build understands arrives.
    expect(toolOf("output-quarantined")?.status).toBe("running");
    expect(toolOf("")?.status).toBe("running");
  });

  it("a missing state is treated the same way", () => {
    // `state` is optional on the wire; the converter defaults it to
    // input-streaming, and that must remain a non-terminal answer.
    const msgs = partsToMessages(
      [
        assistant([
          { type: "dynamic-tool", toolCallId: "tc-2", toolName: "t" },
        ]) as never,
      ],
      false
    );
    const m = msgs.find((x) => x.type === "tool-call") as ToolCallMessage;
    expect(m.status).toBe("running");
  });
});
