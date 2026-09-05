#!/usr/bin/env node
/**
 * Proof for assert-board-declarations-agree.mjs — that it CAN fail, in both directions, and
 * that it refuses rather than passing when it cannot see the board (#410).
 *
 * WHY THIS FILE CARRIES MORE WEIGHT THAN A USUAL SELFTEST. The board is clean today: 0
 * disagreements over 45 open issues. So the checker's live run is green and will stay green,
 * and a green that has never been red is indistinguishable from one that cannot go red. The
 * only evidence that this checker works is here, against boards that were actually wrong.
 *
 * The two historical fixtures are real, reconstructed from the record rather than invented:
 *
 *   drift-2nd-occurrence   13 issues, from #410's own body. 6 label-without-milestone.
 *   drift-3rd-occurrence   27 issues, measured 2026-08-31. 7 carrying NEITHER.
 *
 * THE SECOND ONE IS A NEGATIVE CONTROL AND ITS EXPECTED COUNT IS ZERO. That is deliberate and
 * it corrects the spec: the third drift was seven issues carrying neither declaration, which
 * is a DIFFERENT defect — under-declaration, a judgement call — and this checker passes it by
 * design (#410's ACCEPT requirement). A checker built to report 7 there would have to treat
 * "neither" as a failure and would then fire on every unrelated issue on the board. So this
 * fixture proves the checker does NOT fire where it must not, which is the half that a
 * fixture set built only from the failing case never covers.
 *
 * The third fixture is SYNTHETIC and labelled as such: no milestone-without-label instance has
 * ever occurred, so that direction has no historical evidence and would otherwise go unguarded
 * — the exact "assert only the arm we were bitten by" shape this repo keeps finding.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  analyse,
  disagreements,
  CONTROL_MARKER,
  fetchBoard,
  BOARD_LIMIT,
} from "./assert-board-declarations-agree.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKER = join(HERE, "assert-board-declarations-agree.mjs");
const FIX = join(HERE, "__fixtures__", "board");

let failed = 0;
const ok = (name) => console.log(`  ok   ${name}`);
const bad = (name, detail) => {
  console.error(`  FAIL ${name}\n       ${detail}`);
  failed++;
};
const check = (name, cond, detail) => (cond ? ok(name) : bad(name, detail));

const run = (...args) =>
  spawnSync(process.execPath, [CHECKER, ...args], { encoding: "utf8" });

console.log(
  "board declarations — the checker must be able to FAIL, both directions:"
);

// 1. The real defect. Six label-without-milestone on a 13-issue board.
{
  const r = run("--fixture", join(FIX, "drift-2nd-occurrence.json"));
  check("2nd occurrence: exits non-zero", r.status === 1, `status ${r.status}`);
  check(
    "2nd occurrence: reports exactly 6 disagreement(s)",
    /6 label\/milestone disagreement\(s\)/.test(r.stderr),
    r.stderr.split("\n")[0]
  );
  check(
    "2nd occurrence: names the subject it examined",
    /examined 13 open issue\(s\)/.test(r.stderr),
    "the count of examined issues is absent from the failure output"
  );
  for (const n of [145, 154, 377, 390, 399, 400])
    check(
      `2nd occurrence: names #${n}`,
      r.stderr.includes(`#${n}`),
      "not listed"
    );
  check(
    "2nd occurrence: does NOT report the 5 issues carrying neither",
    ![328, 332, 404, 405, 406].some((n) => r.stderr.includes(`#${n}`)),
    "an issue carrying neither declaration was reported as a disagreement"
  );
}

// 2. NEGATIVE CONTROL. Seven issues carrying neither is legal; expected count is ZERO.
{
  const r = run("--fixture", join(FIX, "drift-3rd-occurrence.json"));
  check(
    "3rd occurrence: exits 0 — 'neither' is not a disagreement",
    r.status === 0,
    `status ${r.status}`
  );
  check(
    "3rd occurrence: reports 0 over 27 examined, naming both numbers",
    /examined 27 open issue\(s\)/.test(r.stdout) &&
      /0 label\/milestone disagreement/.test(r.stdout),
    r.stdout.trim() || r.stderr.trim()
  );
}

// 3. BOTH DIRECTIONS. Synthetic, because the second direction has never occurred.
{
  const r = run("--fixture", join(FIX, "both-directions-synthetic.json"));
  check(
    "both directions: exits non-zero",
    r.status === 1,
    `status ${r.status}`
  );
  check(
    "both directions: reports 2 — one of each",
    /2 label\/milestone disagreement\(s\)/.test(r.stderr),
    r.stderr.split("\n")[0]
  );
  check(
    "both directions: names the milestone-without-label case",
    /#99\s+milestone, no label/.test(r.stderr),
    "the direction that has never occurred in practice is unguarded"
  );
  check(
    "both directions: names the label-without-milestone case",
    /#98\s+label, no milestone/.test(r.stderr),
    "not listed"
  );
}

console.log(
  "refusal — a query that could not compute must not score as a clean board:"
);

// 4. GUARD 2, the positive control marker. A well-formed, parseable, EMPTY board.
{
  const r = run("--fixture", join(FIX, "empty-well-formed.json"));
  check("empty board: exits 2, not 0", r.status === 2, `status ${r.status}`);
  check(
    "empty board: refuses on the missing control marker, not on emptiness",
    r.stderr.includes(`#${CONTROL_MARKER}`),
    "the refusal does not name the control marker it looked for"
  );
  check(
    "empty board: says explicitly that this is not a pass",
    /NOT A PASS/.test(r.stderr),
    "a reader could take the refusal for a pass"
  );
}

// 5. GUARD 2 again, and this is the case an emptiness check would MISS: a full, plausible
//    board that is not ours — 20 agreeing issues, no #16. Zero disagreements, wrong subject.
{
  const r = run("--fixture", join(FIX, "wrong-board-no-marker.json"));
  check(
    "wrong board: exits 2 despite 0 disagreements over 20 issues",
    r.status === 2,
    `status ${r.status}`
  );
  check(
    "...and says the marker is ABSENT, not that it was closed",
    /does not contain #16/.test(r.stderr),
    r.stderr.slice(0, 140)
  );
}

console.log("the marker's state, which is what expired in #720:");

// 5b. THE BRANCH THAT DID NOT EXIST WHEN #720 LANDED. `wrong-board-no-marker.json` is a
//     plausible board with no #16. While the marker is OPEN that is a wrong board and case 5
//     above proves the refusal. Once #16 CLOSES it is the shape of every real board, and the
//     checker must pass it — which is precisely what it stopped doing on 2026-09-02.
{
  const r = run(
    "--fixture",
    join(FIX, "wrong-board-no-marker.json"),
    "--marker-state",
    "CLOSED"
  );
  check(
    "marker closed: the same fixture that refuses at OPEN now PASSES",
    r.status === 0,
    `status ${r.status}: ${(r.stderr || r.stdout).slice(0, 200)}`
  );
  check(
    "marker closed: the PASS says which guarantee it earned",
    /NOT that the response was unfiltered/.test(r.stdout),
    "a reader cannot tell the weaker control from the stronger one"
  );
}

// 5c. The other direction, so the closed branch is not a blanket exemption: a board that
//     still carries the closed marker is refused.
{
  const r = run(
    "--fixture",
    join(FIX, "drift-2nd-occurrence.json"),
    "--marker-state",
    "CLOSED"
  );
  check(
    "marker closed: a board still carrying #16 is refused, not passed",
    r.status === 2,
    `status ${r.status}`
  );
  check(
    "...and says the marker is CLOSED, not that the board lacked it",
    /reports as CLOSED/.test(r.stderr),
    r.stderr.slice(0, 140)
  );
}

// 5d. The flag cannot be used to assert the control on a live run — that would let a caller
//     supply the very fact the check exists to derive.
{
  const r = run("--marker-state", "CLOSED");
  check(
    "--marker-state without --fixture is fatal, not silently honoured",
    r.status === 2 && /only meaningful with --fixture/.test(r.stderr),
    `status ${r.status}: ${(r.stderr || "").slice(0, 160)}`
  );
}

console.log(
  "the rule itself, driven directly — the selftest must not reimplement it:"
);

// 6. The predicate, called as the checker calls it. If this file recomputed the rule it would
//    prove only that two copies agree; these drive the exported function.
{
  const mk = (n, l, m) => ({
    number: n,
    labels: l ? [{ name: "v2.0-reference" }] : [],
    milestone: m ? { title: "v2.0 — Reference Implementation" } : null,
  });
  check(
    "agree/both is not a disagreement",
    disagreements([mk(1, true, true)]).length === 0,
    ""
  );
  check(
    "agree/neither is not a disagreement",
    disagreements([mk(1, false, false)]).length === 0,
    ""
  );
  check(
    "label only is a disagreement",
    disagreements([mk(1, true, false)]).length === 1,
    ""
  );
  check(
    "milestone only is a disagreement",
    disagreements([mk(1, false, true)]).length === 1,
    ""
  );
  check(
    "a milestone with a different title does not count as the v2.0 milestone",
    disagreements([
      {
        number: 1,
        labels: [{ name: "v2.0-reference" }],
        milestone: { title: "v1.7" },
      },
    ]).length === 1,
    "a non-v2.0 milestone was accepted as agreement"
  );
  // THE SECOND ARGUMENT IS THE POINT OF THESE THREE (#720). Called with no options at all,
  // analyse() refuses on "the control marker's state was not established" — a real guard, but
  // a DIFFERENT one. This case would then be green while asserting nothing about the marker,
  // which is how a check's subject slips one level without anyone editing its name.
  const refuses = (issues, opts) => {
    try {
      analyse(issues, opts);
      return null;
    } catch (e) {
      return e.message;
    }
  };
  check(
    "analyse() refuses a set without the control marker while the marker is OPEN",
    (refuses([mk(2, true, true)], { markerIsOpen: true }) ?? "").includes(
      "does not contain"
    ),
    "it did not refuse on the marker's absence"
  );
  check(
    "analyse() ACCEPTS that same set once the marker is CLOSED",
    refuses([mk(2, true, true)], { markerIsOpen: false }) === null,
    "it refused a board that is legitimately missing a closed marker"
  );
  check(
    "analyse() refuses a board containing a marker GitHub reports as closed",
    (
      refuses([mk(CONTROL_MARKER, true, true)], { markerIsOpen: false }) ?? ""
    ).includes("reports as CLOSED"),
    "a closed issue on the open board was accepted"
  );
  check(
    "analyse() refuses when the marker's state was never established",
    (refuses([mk(CONTROL_MARKER, true, true)], {}) ?? "").includes(
      "was not established"
    ),
    "an unestablished control resolved to a usable value"
  );
}

/* ── A FETCH AT THE LIMIT IS NOT A BOARD (#735) ───────────────────────────────
 *
 * `gh issue list --limit N` returning exactly N is indistinguishable from a board
 * with more than N open issues, so every verdict downstream would be about a
 * SUBSET. That is the same failure the #16 marker was there to catch, and unlike
 * the marker it cannot expire: the relationship between a page size and a result
 * count is not a fact about any issue.
 *
 * Driven through the REAL fetchBoard with an injected runner rather than a
 * fixture, because `--fixture` bypasses fetchBoard entirely — a check placed
 * there and tested only through fixtures would be an arm no test can reach,
 * which is the shape that let #720 land in the first place.
 */
let lastArgs = null;
const stubRunner = (n) => (_cmd, args) => ({
  status: 0,
  stdout: JSON.stringify(
    Array.from({ length: n }, (_, i) => ({
      number: i + 1,
      labels: [],
      milestone: null,
    }))
  ),
  stderr: "",
  ...((lastArgs = args), {}),
});

const refusalFrom = (n) => {
  try {
    fetchBoard(stubRunner(n));
    return null;
  } catch (e) {
    return e.message;
  }
};

{
  const msg = refusalFrom(BOARD_LIMIT);
  check(
    "a fetch returning exactly --limit REFUSES rather than judging a subset",
    msg !== null && msg.includes(String(BOARD_LIMIT)),
    msg === null
      ? "it returned a board — every verdict below would be about a possibly-partial set"
      : `refused with an unexpected message: ${msg}`
  );
}
{
  /*
   * THE PRESENCE COMPANION. Without it a fetchBoard that threw on every input
   * would satisfy the case above. One short of the limit is the nearest input
   * that must still be judged.
   */
  const msg = refusalFrom(BOARD_LIMIT - 1);
  check(
    "a fetch one short of the limit is still judged, not refused",
    msg === null,
    `refused a complete board of ${BOARD_LIMIT - 1}: ${msg}`
  );
}
{
  const msg = refusalFrom(0);
  check(
    "an empty board is a real answer, not a truncation",
    msg === null,
    `refused an empty board: ${msg}`
  );
}

{
  /*
   * THE PAIR THE CONSTANT EXISTS TO PROTECT. Mutation found this gap: changing the
   * flag to a literal "499" while the guard still compared against BOARD_LIMIT was
   * caught by NOTHING, because the stub ignores argv. A guard comparing against a
   * number the query never sent is a guard about a different fetch.
   */
  fetchBoard(stubRunner(1));
  const i = (lastArgs ?? []).indexOf("--limit");
  check(
    "the --limit actually sent is the constant the guard compares against",
    i !== -1 && (lastArgs ?? [])[i + 1] === String(BOARD_LIMIT),
    i === -1
      ? "no --limit was passed to gh at all"
      : `sent --limit ${
          (lastArgs ?? [])[i + 1]
        }, guard compares against ${BOARD_LIMIT}`
  );
}

console.log(
  failed === 0
    ? `\nPASS: ${"assert-board-declarations-agree.mjs"} fails on both directions, passes the ` +
        `legal "neither" case, and refuses rather than reporting a clean board it never saw.`
    : `\nFAIL: ${failed} proof(s) failed.`
);
process.exit(failed === 0 ? 0 : 1);
