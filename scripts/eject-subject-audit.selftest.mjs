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
  provenanceComplaints,
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

/*
 * PROVENANCE (#822). The case that motivated it: both records present, parseable,
 * complete and internally consistent, describing a tree nobody meant to measure.
 * Every refusal that existed before — missing, empty, unparseable, "did it MEASURE" —
 * passes such a record. These are the ones that do not.
 */
const OK = {
  tree: { head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", dirty: false },
  ran: [{ phase: "checker" }],
};

ok(
  "two records from the claimed tree raise nothing",
  provenanceComplaints({
    full: OK,
    ejected: OK,
    sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  }).length === 0,
  provenanceComplaints({
    full: OK,
    ejected: OK,
    sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  })
);

ok(
  "a record with NO tree is refused — absent provenance is not fine provenance",
  /carries no `tree`/.test(
    provenanceComplaints({
      full: { ran: [] },
      ejected: OK,
      sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    })[0] ?? ""
  ),
  provenanceComplaints({
    full: { ran: [] },
    ejected: OK,
    sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  })
);

/*
 * THE FAILURE THAT PRODUCED #822, AS DATA: a stage ran in the shared checkout, so the
 * halves describe different trees. Both records are otherwise perfect.
 */
ok(
  "two halves from DIFFERENT trees are refused, and the message says both",
  (() => {
    const b = provenanceComplaints({
      full: OK,
      ejected: {
        tree: {
          head: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          dirty: false,
        },
        ran: [],
      },
      sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    return b.some((x) => /measured DIFFERENT trees/.test(x));
  })(),
  provenanceComplaints({
    full: OK,
    ejected: {
      tree: { head: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", dirty: false },
      ran: [],
    },
    sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  })
);

ok(
  "records agreeing with EACH OTHER but not with --sha are still refused",
  provenanceComplaints({
    full: {
      tree: { head: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", dirty: false },
      ran: [],
    },
    ejected: {
      tree: { head: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", dirty: false },
      ran: [],
    },
    sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  }).length === 2,
  provenanceComplaints({
    full: {
      tree: { head: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", dirty: false },
      ran: [],
    },
    ejected: {
      tree: { head: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", dirty: false },
      ran: [],
    },
    sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  })
);

/*
 * DIRTY IS FATAL because HEAD names what was committed and the checks ran against what
 * was on disk. The shared checkout in the original failure had 441 uncommitted tracked
 * changes, so its sha was real and described nothing anyone measured.
 */
ok(
  "a DIRTY tree is refused even when its head matches the claim",
  /DIRTY tree/.test(
    provenanceComplaints({
      full: {
        tree: { head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", dirty: true },
        ran: [],
      },
      ejected: OK,
      sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    })[0] ?? ""
  ),
  provenanceComplaints({
    full: {
      tree: { head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", dirty: true },
      ran: [],
    },
    ejected: OK,
    sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  })
);

ok(
  "head null (git could not answer) is refused as unattributable, not treated as a match",
  /unattributable/.test(
    provenanceComplaints({
      full: { tree: { head: null, dirty: null }, ran: [] },
      ejected: OK,
      sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    })[0] ?? ""
  ),
  provenanceComplaints({
    full: { tree: { head: null, dirty: null }, ran: [] },
    ejected: OK,
    sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  })
);

/*
 * AND THE EJECTED HALF IS DIRTY BY CONSTRUCTION. `pnpm eject` deletes tracked files —
 * 424 of 435 for langchain — so refusing on its dirtiness would refuse every run. This
 * case exists because the first version of the check did exactly that, and it would
 * have broken `pnpm eject-audit` completely rather than in an edge case.
 */
ok(
  "a DIRTY ejected record is accepted — the eject IS the intervention being measured",
  provenanceComplaints({
    full: OK,
    ejected: {
      tree: { head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", dirty: true },
      ran: [],
    },
    sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  }).length === 0,
  provenanceComplaints({
    full: OK,
    ejected: {
      tree: { head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", dirty: true },
      ran: [],
    },
    sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  })
);

/*
 * #846: `why` IS A TRACE, AND NOTHING ASSERTED IT UNTIL NOW.
 *
 * The branch for an exit-1 ejected reading used to end by naming the eject as the cause. The
 * classifier observes one thing — this checker exited 1 there and passed on the full tree —
 * and that sentence reported two, the second not derivable from the first. Disproved by
 * readme-quickstart, which left that branch after #840 changed only its EXIT CODE: `ejected`
 * stayed null on both sides, so the recorded VALUE never moved and its meaning did.
 *
 * THE OBVIOUS REPAIR IS WRONG AND THIS CASE IS WHY. "Stop generating causes" applied across
 * the file would delete the only diagnostic that resolved the issue's own instance: `why` is
 * what identifies WHICH branch produced a row, and the verdicts cannot do it. Eight branches
 * collapse into FOUR verdict names — three of them say `absent` and three say `no-baseline` —
 * so a reader holding only the verdict cannot tell "the checker was never recorded" from "it
 * refused" from "it passed without reporting a subject".
 *
 * Nothing tested that before this case. Every existing classifyOne assertion reads `.verdict`,
 * so two branches could have collapsed to one sentence and the suite would have stayed green
 * while the trace quietly stopped distinguishing anything.
 */
{
  const withSubject = (n) => ({ exit: 0, subject: { count: n } });
  const branches = [
    [
      "needs declared",
      classifyOne(withSubject(1), withSubject(1), "board-read"),
    ],
    ["full reading missing", classifyOne(undefined, withSubject(1), null)],
    [
      "full tree fails",
      classifyOne({ exit: 1, subject: { count: 1 } }, withSubject(1), null),
    ],
    [
      "full tree reports no subject",
      classifyOne({ exit: 0 }, withSubject(1), null),
    ],
    ["ejected reading missing", classifyOne(withSubject(1), undefined, null)],
    ["ejected refuses", classifyOne(withSubject(1), { exit: 2 }, null)],
    ["ejected fails", classifyOne(withSubject(1), { exit: 1 }, null)],
    [
      "ejected reports no subject",
      classifyOne(withSubject(1), { exit: 0 }, null),
    ],
  ];
  const whys = branches.map(([, r]) => r.why);
  const verdicts = new Set(branches.map(([, r]) => r.verdict));

  ok(
    "every classifier branch produces a DISTINCT why — the trace can identify which one fired",
    new Set(whys).size === whys.length,
    `${new Set(whys).size} distinct of ${whys.length}`
  );
  ok(
    "...which the verdicts alone cannot do, so the field is load-bearing rather than decorative",
    verdicts.size < branches.length,
    `${verdicts.size} verdict name(s) across ${branches.length} branches`
  );
  ok(
    "an exit-1 ejected reading states what was observed and stops there",
    /FAILS in the ejected tree while passing on the full one$/.test(
      classifyOne(withSubject(1), { exit: 1 }, null).why
    ),
    classifyOne(withSubject(1), { exit: 1 }, null).why
  );
}

/*
 * #834: THE AUTHORED HALF SURVIVES A VERDICT CHANGE.
 *
 * `note` and `lifts` were emitted only inside merge()'s STATIC branch, so they vanished whenever
 * a verdict moved off STATIC — and the same non-STATIC verdict exempts the row from
 * assert-eject-subjects-classified's note requirement, so nothing complained. Four notes were
 * destroyed and hand-restored in one night, each time under a green gate.
 *
 * THE TRIGGER IS USUALLY ENVIRONMENTAL. `board-declarations` left STATIC because GitHub was
 * throttled; `readme-quickstart` left because a tree was unbuilt. So these cases drive the
 * transition directly rather than reproducing a cause, because the cause is not the point — ANY
 * failure moves the verdict.
 *
 * SIX OF THESE NINE FAIL ON THE PRE-FIX CODE; THREE ARE MARKED GUARD AND PASS EITHER WAY. That
 * split is measured, not asserted — this proof was run against main's merge() and the six
 * failed by name. The labels were WRONG BEFORE THAT RUN: "returning to STATIC does not
 * auto-restore" reads like coverage of the change and is not, because the old code also set
 * `note: null` on that path. It is relabelled rather than dropped, since the boundary it holds
 * is real. A case that cannot fail should say so rather than be counted as coverage (#846).
 */
{
  const NOTE = "authored: why this domain does not vary by rung";
  const AT = "1".repeat(40);
  const BASE = "2".repeat(40);
  const NOW = "3".repeat(40);
  const NOW_BASE = "4".repeat(40);
  const censusOf = (entry, measuredAt = AT, base = BASE) => ({
    measuredAt,
    base,
    checkers: { c: entry },
  });
  const authored = {
    verdict: STATIC,
    full: 7,
    ejected: 7,
    why: "w",
    note: NOTE,
    lifts: "#780",
  };
  const movedFresh = {
    c: { verdict: "no-baseline", full: null, ejected: null, why: "moved" },
  };
  const staticFresh = { c: { verdict: STATIC, full: 7, ejected: 7, why: "w" } };
  const run = (prev, fresh) => merge(prev, fresh, NOW, NOW_BASE, 1).checkers.c;

  const moved = run(censusOf(authored), movedFresh);
  ok(
    "a verdict leaving STATIC RETAINS the authored note rather than dropping it",
    moved.retainedFrom?.note === NOTE,
    moved
  );
  ok(
    "...and its `lifts` with it, so a human-set pointer is not silently reset either",
    moved.retainedFrom?.lifts === "#780",
    moved.retainedFrom
  );
  ok(
    "...scoped to the verdict it described, asserting nothing about the current one",
    moved.retainedFrom?.verdict === STATIC && !("note" in moved),
    moved
  );
  ok(
    "...carrying BOTH shas, because `measuredAt` alone is routinely reachable from no ref",
    moved.retainedFrom?.measuredAt === AT && moved.retainedFrom?.base === BASE,
    moved.retainedFrom
  );

  const returned = run(censusOf(moved), staticFresh);
  ok(
    "GUARD (holds pre-fix): returning to STATIC does NOT auto-restore — a human still confirms",
    returned.note === null,
    returned
  );
  ok(
    "...but the retained text is in front of them rather than in a backup they had to take",
    returned.retainedFrom?.note === NOTE,
    returned
  );

  const twice = run(censusOf(moved), movedFresh);
  ok(
    "a SECOND consecutive transient run does not lose what the first one saved",
    twice.retainedFrom?.note === NOTE,
    twice
  );

  /* unchanged-behaviour guards: these pass before the fix too, and are here to hold the
   * boundary — the change must not start decorating rows that had nothing authored. */
  const untouched = run(
    { measuredAt: AT, base: BASE, checkers: {} },
    staticFresh
  );
  ok(
    "GUARD (holds pre-fix): a row with nothing authored gains no `retainedFrom`",
    !("retainedFrom" in untouched),
    untouched
  );
  const kept = run(censusOf(authored), staticFresh);
  ok(
    "GUARD (holds pre-fix): an unchanged STATIC verdict still carries its note directly",
    kept.note === NOTE && !("retainedFrom" in kept),
    kept
  );
}

const EXPECTED = 37; // 28 on main (+3 for #846's trace cases) + 9 for #834
const total = pass + fail;
/*
 * THE COUNT GUARD RUNS AT EXIT, NOT IN LINE (#836).
 *
 * It used to sit here as a plain `if`, so it ran at THIS POINT in the file and saw
 * only the cases above it. Both occurrences of the defect were created by appending a
 * case at the END of the file — which is after the guard, because the guard IS the
 * summary block at the end. The count then matched the cases the guard could see and
 * the suite reported "PASS: 14/8".
 *
 * Comparing the tally at the guard rather than via a hoisted binding does NOT fix
 * that: a case appended below the guard still runs after it. Only a hook firing at
 * EXIT sees everything, because nothing can be appended past process exit.
 *
 * `code === 0` MATTERS: without it this overwrites the exit code of a run that already
 * failed for a real reason, turning a genuine defect into a count complaint.
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
console.log(`\n${pass}/${total} passed`);
process.exit(fail === 0 ? 0 : 1);
