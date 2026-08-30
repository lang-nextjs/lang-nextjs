import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRuntime } from "./frameworks";

/**
 * #377 — THIS PLANE'S HALF OF THE DECLARED RUNTIME CONTRACT.
 *
 * The cases live in scripts/fixtures/runtime-parse-cases.json and are consumed
 * by BOTH surfaces. apps/example has its own copy of this parser and reads the
 * same file through its route, because its copy is private.
 *
 * WHY CASES AND NOT A CHECKER COMPARING THE COPIES. A source check would
 * compare the three declarations of RUNTIMES, which agree; it has no purchase
 * on the two parsers, which are where casing, whitespace, unknown and absent
 * are decided. It would ship green and stay green through exactly the drift it
 * was named for.
 *
 * The file is READ, not imported, so it is the same bytes both planes see and
 * neither can be satisfied by a copy that drifted from it.
 */
const FIXTURE = join(__dirname, "..", "..", "..", "scripts", "fixtures", "runtime-parse-cases.json");

type Case = {
  why: string;
  input?: unknown;
  expect: { ok: boolean; runtime?: string; reason?: string };
};

const cases: Case[] = (
  JSON.parse(readFileSync(FIXTURE, "utf8")) as { cases: Case[] }
).cases;

/** Omitting `input` means undefined — see the fixture's note. */
const inputOf = (c: Case) => ("input" in c ? c.input : undefined);

describe("open-swe reads a runtime the way the contract says", () => {
  it("the fixture was found and carries BOTH outcomes", () => {
    /*
     * ANTI-VACUITY, and it guards two different failures. An unreadable or
     * renamed fixture would make `cases` empty and `it.each([])` register
     * nothing — a file that passes having asserted nothing. And a fixture of
     * only accept rows would be satisfied by a parser that never refuses,
     * which is the defect this whole issue is about.
     */
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.some((c) => c.expect.ok)).toBe(true);
    expect(cases.some((c) => !c.expect.ok)).toBe(true);
    /*
     * BOTH REFUSAL REASONS ARE EXERCISED. missing and unknown converging on one
     * answer is the original defect, and a fixture carrying only one cannot see
     * it — so this is a COVERAGE claim about the fixture, not a copy of a
     * declared list.
     *
     * The distinction matters because a consumer that restates a declared list
     * rots when the list grows (#375, and check-run-axes-parity.selftest.mjs
     * hit it again within a day). Nothing declares "the set of refusal reasons"
     * — it is the parser's union type — so there is no list here to drift from.
     * What this pins is that the cases still reach both branches.
     *
     * If a THIRD reason is ever added, this fails, and that failure is the
     * point: a new refusal reason needs its own cases in the fixture before the
     * planes can be said to agree about it. Updating the literal without adding
     * them would be the rot.
     */
    const reasons = new Set(cases.filter((c) => !c.expect.ok).map((c) => c.expect.reason));
    expect(
      [...reasons].sort(),
      "the fixture must exercise BOTH refusal reasons — if a third has been added, " +
        "give it cases here rather than widening this literal"
    ).toEqual(["missing", "unknown"]);
  });

  it.each(cases.map((c) => [c.why, c] as const))("%s", (_why, c) => {
    const got = parseRuntime(inputOf(c));
    expect(got.ok).toBe(c.expect.ok);
    if (c.expect.ok) {
      expect(got.ok === true && got.runtime).toBe(c.expect.runtime);
    } else {
      expect(got.ok === false && got.reason).toBe(c.expect.reason);
    }
  });
});
