/**
 * PROOF FOR assert-lifts-pointers-are-open.mjs — it fires on a closed pointer, and stays
 * silent on the cases it must not fire on (#824).
 *
 * `stateOf` is INJECTED in every arm, so the failing paths are driven without touching the
 * board. A checker whose only red requires a live, shared, throttled API is one nobody has
 * watched fail — and tonight that API is refusing calls while reporting full headroom.
 *
 * THE VACUOUS CASE IS AN ARM, not an assumption. Today the tree has zero pointers, so the
 * checker passes over an empty domain. That is the right answer and it is also exactly the
 * shape that hides a broken query, so "no pointers" and "pointers, all open" are separate
 * arms with different expected reasons.
 */
import {
  pointers,
  pointerComplaints,
} from "./assert-lifts-pointers-are-open.mjs";

let pass = 0;
const results = [];
const ok = (name, cond, detail) => {
  results.push({ name, ok: cond, detail });
  if (cond) pass++;
};

console.log(
  "\nassert-lifts-pointers-are-open — the pointer half, driven without the board\n"
);

/* ── extracting the pointers ────────────────────────────────────────────── */
{
  const cfg = {
    unregistered: [
      { checker: "scripts/a.mjs", lifts: null },
      { checker: "scripts/b.mjs", lifts: "#780" },
      { checker: "scripts/c.mjs", lifts: "#12" },
    ],
  };
  ok(
    "only entries with a pointer are collected — `null` is not a pointer",
    pointers(cfg).length === 2 &&
      pointers(cfg).every((p) => p.issue.startsWith("#")),
    JSON.stringify(pointers(cfg))
  );
  ok(
    "...and a file with no unregistered list yields none (the companion)",
    pointers({}).length === 0,
    "invented a pointer"
  );
}

/* ── the verdict ────────────────────────────────────────────────────────── */
const OPEN = () => "OPEN";
const CLOSED = () => "CLOSED";
const UNASKABLE = () => null;
const found = [{ checker: "scripts/b.mjs", issue: "#780" }];

ok(
  "a CLOSED issue in `lifts` is caught — #824's own incident, inverted",
  pointerComplaints(found, CLOSED).length === 1 &&
    /is CLOSED/.test(pointerComplaints(found, CLOSED)[0]),
  JSON.stringify(pointerComplaints(found, CLOSED))
);
ok(
  "...and an OPEN one is not (the companion)",
  pointerComplaints(found, OPEN).length === 0,
  "flagged an open issue"
);
ok(
  "a board that could not be asked is a COMPLAINT, not a pass",
  pointerComplaints(found, UNASKABLE).length === 1 &&
    /could not be asked/.test(pointerComplaints(found, UNASKABLE)[0]),
  "an unanswerable query was treated as agreement — the #810 shape"
);
ok(
  "the message names WHICH entry and WHICH issue, not just that something is wrong",
  /scripts\/b\.mjs/.test(pointerComplaints(found, CLOSED)[0]) &&
    /#780/.test(pointerComplaints(found, CLOSED)[0]),
  pointerComplaints(found, CLOSED)[0]
);
ok(
  "zero pointers raises nothing, and does so WITHOUT asking the board",
  (() => {
    let asked = 0;
    const counting = () => {
      asked++;
      return "OPEN";
    };
    const out = pointerComplaints([], counting);
    return out.length === 0 && asked === 0;
  })(),
  "an empty domain still cost a call to a throttled shared API"
);

/* ── report ─────────────────────────────────────────────────────────────── */
for (const r of results)
  console.log(
    `  ${r.ok ? "ok  " : "FAIL"} ${r.name.padEnd(74)} ${
      r.ok ? "" : `(${r.detail})`
    }`
  );

const total = results.length;
const EXPECTED = 7;
if (total !== EXPECTED) {
  console.error(
    `\nFAIL: ran ${total} case(s), expected ${EXPECTED} — the harness is broken.`
  );
  process.exit(1);
}
if (pass !== total) {
  console.error(`\nFAIL: ${pass}/${total}.`);
  process.exit(1);
}
console.log(
  `\nPASS: ${pass}/${total}. Every verdict is driven with an injected board, so the failing\n` +
    `      path has been watched failing rather than reasoned about.`
);
