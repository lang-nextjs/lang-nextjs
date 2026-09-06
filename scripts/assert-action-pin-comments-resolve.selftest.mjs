#!/usr/bin/env node
/**
 * PROOF for assert-action-pin-comments-resolve.mjs (#859).
 *
 * The load-bearing case is not "a wrong comment fails". It is that A SHA OUTSIDE THE TAGS
 * WINDOW REFUSES RATHER THAN FAILING, and that the two branches are asked in the right order.
 * Reverse them and every pin older than the last hundred tags becomes a false mismatch — a
 * confident edit instruction derived from a reading that never contained the pin.
 *
 * Every case drives the classifier with an INJECTED tag map, so no case touches the network and
 * the failing paths are watched failing rather than reasoned about.
 *
 * Usage: node scripts/assert-action-pin-comments-resolve.selftest.mjs
 */
import {
  parsePins,
  tagsBySha,
  classifyPin,
  pinsIn,
} from "./assert-action-pin-comments-resolve.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0,
  fail = 0;
const ok = (label, cond, got) => {
  if (cond) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label} — got ${JSON.stringify(got)}`);
  }
};

/* ── parsing ──────────────────────────────────────────────────────────────── */

const SRC = [
  "jobs:",
  "  a:",
  "    steps:",
  "      - uses: actions/checkout@3d3c42e5aa1e0b9b4b0a1c1d2e3f4a5b6c7d8e9f # v7",
  "      - uses: pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86 # v6",
  "      - uses: actions/setup-node@8207627860000000000000000000000000000000",
  "      - uses: actions/floating@v4",
].join("\n");

ok(
  "a sha pin is parsed into action, sha and comment",
  (() => {
    const p = parsePins(SRC, "ci.yml");
    return (
      p.length === 3 &&
      p[0].action === "actions/checkout" &&
      p[0].comment === "v7" &&
      p[0].file === "ci.yml"
    );
  })(),
  JSON.stringify(parsePins(SRC, "ci.yml"))
);

/*
 * A FLOATING REF IS NOT THIS CHECK'S SUBJECT. `uses: actions/floating@v4` carries no sha, so
 * there is nothing for a comment to disagree with. Matching it would make this checker report
 * on a different defect that has its own owner — and would do so in a message about comments.
 */
ok(
  "COMPANION: a floating `@v4` ref is NOT matched, so this reports only on sha pins",
  parsePins(SRC, "ci.yml").every((p) => /^[0-9a-f]{40}$/.test(p.sha)),
  parsePins(SRC, "ci.yml").map((p) => p.sha)
);

ok(
  "a pin with no comment parses with comment null rather than being skipped",
  parsePins(SRC, "ci.yml")[2].comment === null,
  parsePins(SRC, "ci.yml")[2]
);

/* ── the tag map ──────────────────────────────────────────────────────────── */

const TAGS = [
  {
    name: "v7.0.1",
    commit: { sha: "3d3c42e5aa1e0b9b4b0a1c1d2e3f4a5b6c7d8e9f" },
  },
  { name: "v7", commit: { sha: "3d3c42e5aa1e0b9b4b0a1c1d2e3f4a5b6c7d8e9f" } },
  { name: "v6", commit: { sha: "1111111111111111111111111111111111111111" } },
];
const MAP = tagsBySha(TAGS);

ok(
  "tagsBySha groups every tag pointing at one sha, so a sha with two names keeps both",
  MAP.get("3d3c42e5aa1e0b9b4b0a1c1d2e3f4a5b6c7d8e9f").join(",") === "v7.0.1,v7",
  [...MAP]
);

ok(
  "...and a malformed tag entry is dropped rather than crashing the map",
  tagsBySha([{ name: "x" }, { commit: { sha: "y" } }, null]).size === 0,
  [...tagsBySha([{ name: "x" }, { commit: { sha: "y" } }, null])]
);

/* ── classification ───────────────────────────────────────────────────────── */

const pin = (sha, comment) => ({
  file: "ci.yml",
  line: 4,
  action: "actions/checkout",
  sha,
  comment,
});
const SHA = "3d3c42e5aa1e0b9b4b0a1c1d2e3f4a5b6c7d8e9f";

ok(
  "a comment naming a tag that resolves to the sha is OK",
  classifyPin(pin(SHA, "v7"), MAP).kind === "ok",
  classifyPin(pin(SHA, "v7"), MAP)
);

ok(
  "...and the OTHER tag on the same sha is equally OK — a sha may carry several names",
  classifyPin(pin(SHA, "v7.0.1"), MAP).kind === "ok",
  classifyPin(pin(SHA, "v7.0.1"), MAP)
);

ok(
  "a comment naming a version the sha is NOT is a mismatch, and the message names both",
  (() => {
    const r = classifyPin(pin(SHA, "v6"), MAP);
    return (
      r.kind === "mismatch" &&
      /"# v6"/.test(r.why) &&
      /v7\.0\.1, v7/.test(r.why)
    );
  })(),
  classifyPin(pin(SHA, "v6"), MAP)
);

ok(
  "a pin with no comment at all is a mismatch — a sha with nothing saying what it is",
  classifyPin(pin(SHA, null), MAP).kind === "mismatch",
  classifyPin(pin(SHA, null), MAP)
);

/*
 * ── THE REFUSAL, AND THE ORDER IT IS ASKED IN ────────────────────────────────
 *
 * A sha outside the fetched window is UNREADABLE, not wrong. The second case is the one that
 * pins the ordering: the comment is also wrong, and the verdict must STILL be a refusal —
 * because a comment cannot be judged against a reading that never contained its sha. Asking
 * "does the comment match" first would classify it a mismatch and produce an edit instruction
 * from a measurement with no power to make it.
 */
const OLD = "9999999999999999999999999999999999999999";

ok(
  "a sha outside the tags window REFUSES rather than reporting a mismatch",
  classifyPin(pin(OLD, "v7"), MAP).kind === "unresolvable",
  classifyPin(pin(OLD, "v7"), MAP)
);

ok(
  "...and it refuses EVEN WHEN THE COMMENT IS ALSO WRONG — the order of the branches is the contract",
  classifyPin(pin(OLD, "v2"), MAP).kind === "unresolvable",
  classifyPin(pin(OLD, "v2"), MAP)
);

ok(
  "the refusal says the window is the limit, not the pin",
  /not among the tags read/.test(classifyPin(pin(OLD, "v7"), MAP).why) &&
    /NOT wrong/.test(classifyPin(pin(OLD, "v7"), MAP).why),
  classifyPin(pin(OLD, "v7"), MAP).why
);

/* ── the real tree ────────────────────────────────────────────────────────── */

/*
 * THE DOMAIN IS REAL AND NON-EMPTY. Every case above runs on fixtures, so all of them would
 * pass over a repository with no workflows at all. This one asserts the checker has a subject.
 */
ok(
  "the real .github/workflows contains sha pins for this to be about",
  (() => {
    const p = pinsIn(join(ROOT, ".github", "workflows"));
    return p.length > 0 && p.every((x) => /^[0-9a-f]{40}$/.test(x.sha));
  })(),
  pinsIn(join(ROOT, ".github", "workflows")).length
);

ok(
  "...and every one of them carries a comment, so none is excused by the null branch",
  pinsIn(join(ROOT, ".github", "workflows")).every((p) => p.comment !== null),
  pinsIn(join(ROOT, ".github", "workflows")).filter((p) => p.comment === null)
);

const EXPECTED = 14;
/*
 * THE COUNT GUARD RUNS AT EXIT (#836), so a case appended below it is still counted.
 * `code === 0` matters: without it this overwrites the exit code of a run that already failed
 * for a real reason.
 */
process.on("exit", (code) => {
  const ran = pass + fail;
  if (code === 0 && ran !== EXPECTED) {
    console.log(
      `\nFAIL: ran ${ran} assertions, expected ${EXPECTED} — a case was added or lost.`
    );
    process.exitCode = 1;
  }
});
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
