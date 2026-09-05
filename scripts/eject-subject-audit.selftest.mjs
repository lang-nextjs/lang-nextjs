/**
 * PROOF for eject-subject-audit.mjs (#755).
 *
 * The audit's guards are the point, not its arithmetic. Two of them exist because
 * the failure they prevent produces a CLEAN-LOOKING result:
 *
 *   vacuity        zero movers is what a failed eject or a failed install looks
 *                  like, and a census recorded from it asserts that no checker
 *                  responds to the tree.
 *   monotonicity   "one eject covers the ladder" is a plausible unproven premise.
 *                  Asserting it here is what makes it falsifiable.
 *
 * Each has a COMPANION, because a guard that fires on everything is a guard that
 * gets removed.
 */
import {
  checkersOf,
  vacuityComplaint,
  monotonicityComplaints,
  merge,
  parentCountOf,
  DEFAULT_LIFTS,
  needsFrom,
} from "./eject-subject-audit.mjs";
import { STATIC, NON_TREE, classifyOne } from "./lib/eject-classify.mjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";

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

ok(
  "checkersOf keeps checker phases and drops proofs — a proof failing says nothing about a subject",
  JSON.stringify(
    Object.keys(
      checkersOf([
        { name: "a", phase: "checker" },
        { name: "a", phase: "proof" },
        { name: "b", phase: "checker" },
      ])
    )
  ) === JSON.stringify(["a", "b"]),
  Object.keys(
    checkersOf([
      { name: "a", phase: "checker" },
      { name: "a", phase: "proof" },
      { name: "b", phase: "checker" },
    ])
  )
);

/* ── VACUITY ───────────────────────────────────────────────────────────────── */

ok(
  "zero movers REFUSES, and the message names checks known to move",
  (() => {
    const m = vacuityComplaint({
      a: { verdict: STATIC },
      b: { verdict: "absent" },
    });
    return m !== null && /sibling-tests-are-owned/.test(m) && /53 -> 1/.test(m);
  })(),
  vacuityComplaint({ a: { verdict: STATIC }, b: { verdict: "absent" } })
);

ok(
  "THE COMPANION: one mover is enough, so the guard does not fire on a real census",
  vacuityComplaint({ a: { verdict: "moved" }, b: { verdict: STATIC } }) ===
    null,
  vacuityComplaint({ a: { verdict: "moved" }, b: { verdict: STATIC } })
);

/* ── MONOTONICITY ──────────────────────────────────────────────────────────── */

ok(
  "a subject that GREW under ejection is a violation, named by checker",
  (() => {
    const c = monotonicityComplaints({
      big: { verdict: "moved", full: 10, ejected: 12 },
    });
    return (
      c.length === 1 && /big/.test(c[0]) && /one-eject assumption/.test(c[0])
    );
  })(),
  monotonicityComplaints({ big: { verdict: "moved", full: 10, ejected: 12 } })
);

ok(
  "THE COMPANION: shrinking and unchanged subjects are not violations",
  monotonicityComplaints({
    a: { verdict: "moved", full: 10, ejected: 4 },
    b: { verdict: STATIC, full: 7, ejected: 7 },
    c: { verdict: "absent", full: 5, ejected: null },
  }).length === 0,
  monotonicityComplaints({
    a: { verdict: "moved", full: 10, ejected: 4 },
    b: { verdict: STATIC, full: 7, ejected: 7 },
    c: { verdict: "absent", full: 5, ejected: null },
  })
);

/* ── NOTE LIFECYCLE ────────────────────────────────────────────────────────── */

const prev = {
  checkers: {
    keeps: { verdict: STATIC, note: "domain is fixtures", lifts: null },
    moves: { verdict: STATIC, note: "stale reason", lifts: null },
  },
};

ok(
  "a note survives a re-run when the verdict is unchanged",
  merge(
    prev,
    { keeps: { verdict: STATIC, full: 5, ejected: 5, why: "w" } },
    "sha"
  ).checkers.keeps.note === "domain is fixtures",
  merge(
    prev,
    { keeps: { verdict: STATIC, full: 5, ejected: 5, why: "w" } },
    "sha"
  ).checkers.keeps
);

/*
 * THE ONE THAT MATTERS. `static -> moved` means the note describes a state that
 * no longer exists. The repair is to DELETE it, not to keep it beside a verdict
 * it contradicts — so the merge must not carry it across.
 */
ok(
  "a note is DROPPED when static-under-eject-langchain becomes moved — the repair is deletion, not tolerance",
  merge(
    prev,
    { moves: { verdict: "moved", full: 9, ejected: 4, why: "w" } },
    "sha"
  ).checkers.moves.note === undefined,
  merge(
    prev,
    { moves: { verdict: "moved", full: 9, ejected: 4, why: "w" } },
    "sha"
  ).checkers.moves
);

ok(
  "a NEW static gets a PENDING lifts marker rather than a silent null — the shape, not a pinned number, because pinning the literal is what let a closed issue sit here unnoticed",
  merge(
    null,
    { fresh: { verdict: STATIC, full: 3, ejected: 3, why: "w" } },
    "sha"
  ).checkers.fresh.lifts === DEFAULT_LIFTS && /^#\d+$/.test(DEFAULT_LIFTS),
  merge(
    null,
    { fresh: { verdict: STATIC, full: 3, ejected: 3, why: "w" } },
    "sha"
  ).checkers.fresh
);

ok(
  "the census records BOTH the measurement sha and the durable base it was cut from",
  merge(
    null,
    { a: { verdict: "moved", full: 2, ejected: 1, why: "w" } },
    "d41664ca"
  ).measuredAt === "d41664ca" &&
    merge(
      null,
      { a: { verdict: "moved", full: 2, ejected: 1, why: "w" } },
      "d41664ca",
      "70fb8afa"
    ).base === "70fb8afa",
  merge(
    null,
    { a: { verdict: "moved", full: 2, ejected: 1, why: "w" } },
    "d41664ca"
  )
);

/*
 * A MERGE-COMMIT FIXTURE MUST BE BUILT, NOT FOUND. This repo squash-merges, so
 * `git rev-list --merges origin/main` returns ZERO — there is no merge commit in
 * main's history to anchor on, and the one on the branch that motivated this field
 * does not survive its own squash. A test pinned to such a sha passes today and
 * reports `null` forever after, which reads as "could not ask" rather than as a
 * broken fixture.
 */
function withRepo(fn) {
  const dir = mkdtempSync(pjoin(tmpdir(), "parents-"));
  const g = (...a) =>
    execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
  try {
    g("init", "-q", "-b", "main");
    g("config", "user.email", "t@local");
    g("config", "user.name", "t");
    g("commit", "-q", "--allow-empty", "-m", "root");
    const root = g("rev-parse", "HEAD");
    g("commit", "-q", "--allow-empty", "-m", "second");
    const linear = g("rev-parse", "HEAD");
    g("checkout", "-q", "-b", "side", root);
    g("commit", "-q", "--allow-empty", "-m", "side");
    g("checkout", "-q", "main");
    g("merge", "-q", "--no-ff", "-m", "merge", "side");
    const merged = g("rev-parse", "HEAD");
    return fn({ dir, root, linear, merged });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

ok(
  "parentCountOf separates a merge commit from a linear one and from the root",
  withRepo(
    ({ dir, root, linear, merged }) =>
      parentCountOf(merged, dir) === 2 &&
      parentCountOf(linear, dir) === 1 &&
      parentCountOf(root, dir) === 0
  ),
  withRepo(({ dir, root, linear, merged }) => ({
    merged: parentCountOf(merged, dir),
    linear: parentCountOf(linear, dir),
    root: parentCountOf(root, dir),
  }))
);

ok(
  "an unresolvable sha reads null (could not ask), NOT 0 (a root commit)",
  withRepo(
    ({ dir }) =>
      parentCountOf("0000000000000000000000000000000000000000", dir) === null
  ),
  withRepo(({ dir }) =>
    parentCountOf("0000000000000000000000000000000000000000", dir)
  )
);

/*
 * merge() MUST NOT CONSULT GIT. It is a pure data function; the reading is taken
 * once at the call site against a resolved sha and passed in. Proven by handing it
 * a sha that exists in NO repository together with a parent count of 2 — if merge
 * were deriving the value itself it could only produce null here.
 */
ok(
  "merge records the parent count it is GIVEN, without consulting a repository",
  merge(
    null,
    { a: { verdict: "moved", full: 2, ejected: 1, why: "w" } },
    "ffffffffffffffffffffffffffffffffffffffff",
    "70fb8afa",
    2
  ).measuredAtParents === 2,
  merge(
    null,
    { a: { verdict: "moved", full: 2, ejected: 1, why: "w" } },
    "ffffffffffffffffffffffffffffffffffffffff",
    "70fb8afa",
    2
  ).measuredAtParents
);

/*
 * THE CASE THAT MOTIVATED THE VERDICT, AS DATA. board-declarations read 16 on the
 * full tree and 17 on the ejected one because an issue was filed between the two
 * halves — an eject, an install and a build apart. Without the declaration that is
 * a monotonicity violation telling the reader to go find a second eject target.
 */
ok(
  "a checker declaring `needs` is not-tree-derived even when its counts differ",
  classifyOne(
    { subject: { count: 16 } },
    { subject: { count: 17 } },
    "board-read"
  ).verdict === NON_TREE,
  classifyOne(
    { subject: { count: 16 } },
    { subject: { count: 17 } },
    "board-read"
  )
);

ok(
  "the SAME readings without the declaration are still judged normally — the verdict turns on the declaration, not on the numbers",
  classifyOne({ subject: { count: 16 } }, { subject: { count: 17 } }, null)
    .verdict === "moved",
  classifyOne({ subject: { count: 16 } }, { subject: { count: 17 } }, null)
);

ok(
  "monotonicity does not complain about a grown not-tree-derived subject, and DOES about a tree-derived one",
  monotonicityComplaints({
    board: { verdict: NON_TREE, full: 16, ejected: 17 },
  }).length === 0 &&
    monotonicityComplaints({
      real: { verdict: "moved", full: 16, ejected: 17 },
    }).length === 1,
  {
    nonTree: monotonicityComplaints({
      board: { verdict: NON_TREE, full: 16, ejected: 17 },
    }).length,
    tree: monotonicityComplaints({
      real: { verdict: "moved", full: 16, ejected: 17 },
    }).length,
  }
);

/*
 * THE FIXTURE CARRIES ALL THREE ARRAYS IN THE ORDER THE REAL FILE HAS THEM, because
 * a fixture with only `checks` cannot reproduce the defect: the sniff finds the
 * right array by luck and the case passes against broken code.
 */
const REGISTRY_FIXTURE = {
  $comment: ["a line of prose", "another line"],
  checks: [
    { name: "plain" },
    { name: "networked", needs: "board-read" },
    { name: "shaped", needs: "merge-commit" },
  ],
  unregistered: [{ name: "not-a-gate", needs: "board-read" }],
};

ok(
  "needsFrom reads the `checks` array by name, past a longer $comment array that comes first",
  JSON.stringify(needsFrom(REGISTRY_FIXTURE)) ===
    JSON.stringify({ networked: "board-read", shaped: "merge-commit" }),
  needsFrom(REGISTRY_FIXTURE)
);

ok(
  "an `unregistered` entry's needs is NOT picked up — only registered checkers are classified",
  needsFrom(REGISTRY_FIXTURE)["not-a-gate"] === undefined,
  Object.keys(needsFrom(REGISTRY_FIXTURE))
);

ok(
  "a registry with no `checks` array THROWS rather than returning an empty map",
  (() => {
    try {
      needsFrom({ $comment: ["x"], unregistered: [] });
      return false;
    } catch (e) {
      return /no `checks` array/.test(e.message);
    }
  })(),
  "expected a throw naming the missing array"
);

const EXPECTED = 18;
const total = pass + fail;
if (total !== EXPECTED) {
  console.log(
    `\nFAIL: ran ${total} assertions, expected ${EXPECTED} — a case was added or lost.`
  );
  process.exit(1);
}
console.log(`\n${pass}/${total} passed`);
process.exit(fail === 0 ? 0 : 1);
