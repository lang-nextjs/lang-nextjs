/**
 * PROOF FOR assert-checkers-registered.mjs — it fires on each arm, and stays silent on the
 * cases it must not fire on (#741).
 *
 * THE ARMS ARE TESTED SEPARATELY BECAUSE THEY FAIL FOR DIFFERENT REASONS. A gate asserting
 * "registered or excused" has an obvious degenerate form: excuse everything. Arms 4 and 5 are
 * what stop that, and they are the ones a later reader is most likely to weaken, because a
 * failing exclusion looks like paperwork rather than like a defect.
 *
 * EVERY REJECTION CASE HAS AN ACCEPTANCE COMPANION. Without them a gate that rejected every
 * input would score full marks here, which is the shape this repo keeps deleting.
 */
import {
  partition,
  orphanProofs,
  audit,
} from "./assert-checkers-registered.mjs";

let pass = 0;
const results = [];
const ok = (name, cond, detail) => {
  results.push({ name, ok: cond, detail });
  if (cond) pass++;
};
const AL = (p) => true; // every path exists
const NONE = () => false; // no path exists

console.log(
  "\nassert-checkers-registered — each arm fires, and the companions stay green\n"
);

/* ── the population ─────────────────────────────────────────────────────── */
{
  const { total, proofs, checkers } = partition([
    "assert-a.mjs",
    "assert-a.selftest.mjs",
    "assert-b.sh",
    "assert-b.selftest.sh",
    "check-not-in-scope.mjs",
    "lib",
  ]);
  ok(
    "partitions assert-* into proofs and checkers, ignoring everything else",
    total === 4 && proofs.length === 2 && checkers.length === 2,
    `total=${total} proofs=${proofs.length} checkers=${checkers.length}`
  );
}

/* ── arm 1: unregistered and unexcused ──────────────────────────────────── */
ok(
  "a checker that is neither registered nor listed is CAUGHT",
  audit({
    checkers: ["assert-x.mjs"],
    registered: [],
    excluded: [],
    exists: AL,
  }).some((f) => /neither registered/.test(f)),
  "not caught"
);
ok(
  "...and a registered one is not (the companion)",
  audit({
    checkers: ["assert-x.mjs"],
    registered: ["scripts/assert-x.mjs"],
    excluded: [],
    exists: AL,
  }).length === 0,
  "flagged a registered checker"
);

/* ── arm 2: both at once ────────────────────────────────────────────────── */
ok(
  "a checker BOTH registered and listed is caught as a contradiction",
  audit({
    checkers: ["assert-x.mjs"],
    registered: ["scripts/assert-x.mjs"],
    excluded: [
      { checker: "scripts/assert-x.mjs", reason: "x".repeat(30), lifts: null },
    ],
    exists: AL,
  }).some((f) => /BOTH registered/.test(f)),
  "not caught"
);

/* ── arm 3: an exclusion outliving its subject ──────────────────────────── */
ok(
  "an exclusion naming a file that no longer exists is caught",
  audit({
    checkers: [],
    registered: [],
    excluded: [
      {
        checker: "scripts/assert-gone.mjs",
        reason: "y".repeat(30),
        lifts: null,
      },
    ],
    exists: NONE,
  }).some((f) => /does not exist/.test(f)),
  "not caught"
);

/* ── arm 4: the anti-mute-button arm ────────────────────────────────────── */
ok(
  "an exclusion with no substantive reason is caught",
  audit({
    checkers: ["assert-x.mjs"],
    registered: [],
    excluded: [{ checker: "scripts/assert-x.mjs", reason: "no", lifts: null }],
    exists: AL,
  }).some((f) => /no substantive reason/.test(f)),
  "not caught"
);
ok(
  "an exclusion missing `lifts` entirely is caught",
  audit({
    checkers: ["assert-x.mjs"],
    registered: [],
    excluded: [{ checker: "scripts/assert-x.mjs", reason: "z".repeat(30) }],
    exists: AL,
  }).some((f) => /lifts=/.test(f)),
  "not caught"
);
ok(
  "...and `lifts: null` — permanent under the rule — is accepted (the companion)",
  audit({
    checkers: ["assert-x.mjs"],
    registered: [],
    excluded: [
      { checker: "scripts/assert-x.mjs", reason: "z".repeat(30), lifts: null },
    ],
    exists: AL,
  }).length === 0,
  "rejected a permanent exclusion"
);

/* ── arm 5: a placeholder cannot ship ───────────────────────────────────── */
ok(
  "a PENDING reason with a placeholder instead of an issue is caught",
  audit({
    checkers: ["assert-x.mjs"],
    registered: [],
    excluded: [
      {
        checker: "scripts/assert-x.mjs",
        reason: "z".repeat(30),
        lifts: "#TBD",
      },
    ],
    exists: AL,
  }).some((f) => /placeholder cannot ship/.test(f)),
  "not caught"
);
ok(
  "...and a real issue number is accepted (the companion)",
  audit({
    checkers: ["assert-x.mjs"],
    registered: [],
    excluded: [
      {
        checker: "scripts/assert-x.mjs",
        reason: "z".repeat(30),
        lifts: "#772",
      },
    ],
    exists: AL,
  }).length === 0,
  "rejected a pending exclusion naming an issue"
);

/* ── arm 6: the orphan proof ────────────────────────────────────────────── */
ok(
  "a proof with no checker beside it is caught",
  orphanProofs(["assert-ghost.selftest.mjs"], ["assert-real.mjs"]).length === 1,
  "not caught"
);
ok(
  "...and a proof WITH its checker is not (the companion)",
  orphanProofs(["assert-real.selftest.mjs"], ["assert-real.mjs"]).length === 0,
  "flagged a paired proof"
);

/* ── REPORT ─────────────────────────────────────────────────────────────── */
const width = Math.max(...results.map((r) => r.name.length));
for (const r of results)
  console.log(
    `  ${r.ok ? "ok  " : "FAIL"} ${r.name.padEnd(width)}  (${r.detail})`
  );
console.log();
if (pass !== results.length) {
  console.error(`FAIL: ${results.length - pass}/${results.length} arms wrong.`);
  process.exit(1);
}
console.log(
  `PASS: ${pass}/${results.length}. Each arm fires on its own defect, and every rejection\n` +
    `      has an acceptance companion, so a gate that refused everything would not pass here.`
);
