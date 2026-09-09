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
  GROWS_WITH_THE_STRIP,
  merge as mergeAt,
  parentCountOf,
  DEFAULT_LIFTS,
  needsFrom,
  subjectKindFrom,
  provenanceComplaints,
  establishedNothingComplaint,
  refusedBaselineComplaint,
  totalityComplaint,
  noteDigest,
} from "./eject-subject-audit.mjs";
import { registeredCheckers } from "./assert-eject-subjects-classified.mjs";
import {
  classifierFor,
  staticFor,
  isStatic,
  STATIC_PREFIX,
  NON_TREE,
} from "./lib/eject-classify.mjs";

/*
 * THE TARGET IS NAMED ONCE, HERE (#855). `classifyOne` and `merge` both refuse to
 * run without knowing what was ejected, so the fixtures below bind the default
 * target and are otherwise unchanged — the cases at the bottom of this file are
 * the ones that exercise a DIFFERENT target, and they call `mergeAt` directly so
 * the wrapper cannot hide the parameter from them.
 */
const TARGET = "langchain";
const STATIC = staticFor(TARGET);
const classifyOne = classifierFor(TARGET);
const merge = (previous, fresh, sha, baseSha, shaParents) =>
  mergeAt(previous, fresh, sha, baseSha, shaParents, { ejectTarget: TARGET });
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join as pjoin, dirname } from "node:path";

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

ok(
  "a checker DECLARED as growing with the strip is not a violation — the premise still holds " +
    "there, because more stripping means strictly more change and the maximal strip is the bound",
  monotonicityComplaints({
    formatted: { verdict: STATIC, full: 3, ejected: 15 },
  }).length === 0,
  monotonicityComplaints({
    formatted: { verdict: STATIC, full: 3, ejected: 15 },
  })
);

ok(
  "THE COMPANION: an UNDECLARED checker with the same numbers still fires, so the declaration " +
    "cannot become a blanket",
  (() => {
    const c = monotonicityComplaints({
      "not-declared": { verdict: STATIC, full: 3, ejected: 15 },
    });
    return c.length === 1 && /not-declared/.test(c[0]);
  })(),
  monotonicityComplaints({
    "not-declared": { verdict: STATIC, full: 3, ejected: 15 },
  })
);

ok(
  "every declared exemption carries a REASON, and one long enough to be one — an exemption " +
    "without its reason is how a recorded decision becomes a snapshot",
  Object.values(GROWS_WITH_THE_STRIP).every(
    (w) => typeof w === "string" && w.length >= 120
  ),
  Object.entries(GROWS_WITH_THE_STRIP).map(([k, v]) => [k, (v ?? "").length])
);

ok(
  "and every declared name is a REGISTERED checker, so the list cannot outlive its subject",
  (() => {
    const names = registeredCheckers(
      JSON.parse(
        readFileSync(
          pjoin(dirname(fileURLToPath(import.meta.url)), "checks.json"),
          "utf8"
        )
      )
    );
    return Object.keys(GROWS_WITH_THE_STRIP).every((n) => names.includes(n));
  })(),
  Object.keys(GROWS_WITH_THE_STRIP)
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
    { needs: "board-read" }
  ).verdict === NON_TREE,
  classifyOne(
    { subject: { count: 16 } },
    { subject: { count: 17 } },
    { needs: "board-read" }
  )
);

/*
 * THE SECOND WAY OUT OF THE TREE, AND IT COST A CENSUS (#844). `worktree-inventory`
 * declares `subjectKind: "external"` — its subject is the machine's worktree list —
 * and NO channel, so the `needs` rule above never reached it and the comparison ran.
 * Any agent creating a worktree during the eight minutes between the two readings
 * moves the count, and the monotonicity guard then reports a grown subject and asks
 * for "more eject targets", which do not exist and would not help.
 *
 * ASSERTS THE `why`, NOT ONLY THE VERDICT, and that is the point. Handing the OLD
 * signature this object makes it the `needs` positional, which is truthy, so the
 * verdict alone is NON_TREE either way and the case would pass against unfixed code.
 * The reason string is the only thing that separates them.
 */
ok(
  "a checker declaring subjectKind external with NO channel is not-tree-derived",
  classifyOne(
    { subject: { count: 175 } },
    { subject: { count: 179 } },
    {
      subjectKind: "external",
    }
  ).verdict === NON_TREE &&
    /subjectKind:external/.test(
      classifyOne(
        { subject: { count: 175 } },
        { subject: { count: 179 } },
        {
          subjectKind: "external",
        }
      ).why
    ),
  classifyOne(
    { subject: { count: 175 } },
    { subject: { count: 179 } },
    {
      subjectKind: "external",
    }
  )
);

/*
 * PRECEDENCE, SO NO CENSUS ROW IS REWORDED. board-declarations and required-contexts
 * declare BOTH a channel and an external subject. The `needs` branch comes first, so
 * they keep the verdict and the reason they already carry, and this change moves
 * exactly one checker rather than three.
 */
ok(
  "a checker declaring BOTH keeps the channel's reason, so existing rows do not change wording",
  /needs:board-read/.test(
    classifyOne(
      { subject: { count: 1 } },
      { subject: { count: 1 } },
      {
        needs: "board-read",
        subjectKind: "external",
      }
    ).why
  ) &&
    !/subjectKind/.test(
      classifyOne(
        { subject: { count: 1 } },
        { subject: { count: 1 } },
        {
          needs: "board-read",
          subjectKind: "external",
        }
      ).why
    ),
  classifyOne(
    { subject: { count: 1 } },
    { subject: { count: 1 } },
    {
      needs: "board-read",
      subjectKind: "external",
    }
  ).why
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
    { name: "machine", subjectKind: "external" },
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

/*
 * READ SEPARATELY FROM `needs`, BECAUSE THE TWO ARE INDEPENDENT (#844). `machine`
 * carries an external subject and NO channel, and it must not appear in the needs
 * map — the case above asserts that map is unchanged by its presence, which is what
 * makes these two readers genuinely separate rather than one field spelled twice.
 */
ok(
  "subjectKindFrom reads declarations the needs map cannot see",
  JSON.stringify(subjectKindFrom(REGISTRY_FIXTURE)) ===
    JSON.stringify({ machine: "external" }) &&
    needsFrom(REGISTRY_FIXTURE).machine === undefined,
  [subjectKindFrom(REGISTRY_FIXTURE), Object.keys(needsFrom(REGISTRY_FIXTURE))]
);

ok(
  "subjectKindFrom THROWS on a missing `checks` array, like needsFrom — an empty map and a misread one mean opposite things",
  (() => {
    try {
      subjectKindFrom({ $comment: ["x"], unregistered: [] });
      return false;
    } catch (e) {
      return /no `checks` array/.test(e.message);
    }
  })(),
  "expected a throw naming the missing array"
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
      classifyOne(withSubject(1), withSubject(1), { needs: "board-read" }),
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
    "...carrying BOTH shas, because `writtenAt` alone is routinely reachable from no ref",
    moved.retainedFrom?.writtenAt === AT &&
      moved.retainedFrom?.writtenAgainst === BASE,
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
  ok(
    "...and carries it under the CURRENT key names — `retentionFor` returns an earlier " +
      "retention verbatim, so a pre-#876 object would propagate its old keys unseen",
    twice.retainedFrom !== undefined &&
      "writtenAt" in twice.retainedFrom &&
      "writtenAgainst" in twice.retainedFrom &&
      !("measuredAt" in twice.retainedFrom) &&
      !("base" in twice.retainedFrom),
    twice.retainedFrom
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

  /* ── #875: a directly-held note gets the provenance only the exile had ────── */
  const stamped = run(censusOf(authored), staticFresh);
  ok(
    "a note held DIRECTLY is stamped with the derived values it was written beside",
    stamped.noteWrittenAt?.full === 7 &&
      stamped.noteWrittenAt?.ejected === 7 &&
      stamped.noteWrittenAt?.sha === AT,
    stamped.noteWrittenAt
  );
  ok(
    "...and the stamp carries a DIGEST of the prose, so an edit is distinguishable",
    stamped.noteWrittenAt?.noteDigest === noteDigest(NOTE),
    stamped.noteWrittenAt
  );

  const unchanged = run(
    censusOf({ ...authored, noteWrittenAt: stamped.noteWrittenAt }),
    { c: { verdict: STATIC, full: 99, ejected: 99, why: "w" } }
  );
  ok(
    "UNCHANGED prose keeps its original stamp, so a moved row still reads as drifted",
    unchanged.noteWrittenAt?.full === 7 && unchanged.full === 99,
    unchanged.noteWrittenAt
  );

  const edited = run(
    censusOf({
      ...authored,
      full: 99,
      ejected: 99,
      note: "REWRITTEN: the domain is 99",
      noteWrittenAt: stamped.noteWrittenAt,
    }),
    { c: { verdict: STATIC, full: 99, ejected: 99, why: "w" } }
  );
  ok(
    "EDITED prose is RE-STAMPED at the current values — without this a corrected note " +
      "inherits the old stamp and flags forever, loudest where the work was done",
    edited.noteWrittenAt?.full === 99 &&
      edited.noteWrittenAt?.noteDigest ===
        noteDigest("REWRITTEN: the domain is 99"),
    edited.noteWrittenAt
  );

  ok(
    "GUARD: a row with NO note gains no stamp — the field follows the prose, not the row",
    !(
      "noteWrittenAt" in run(censusOf({ ...authored, note: null }), staticFresh)
    ),
    run(censusOf({ ...authored, note: null }), staticFresh)
  );

  const kept = run(censusOf(authored), staticFresh);
  ok(
    "GUARD (holds pre-fix): an unchanged STATIC verdict still carries its note directly",
    kept.note === NOTE && !("retainedFrom" in kept),
    kept
  );
}

/*
 * #843: A RUN THAT COMPARED A TREE WITH ITSELF ESTABLISHED NOTHING.
 *
 * THE ISSUE'S PREMISE WAS FALSE AND THE REAL DEFECT IS NARROWER. "Nothing catches it" is wrong:
 * a PURE no-op makes every verdict `static`, so `vacuityComplaint` sees zero movers and refuses
 * at exit 2 today. Measured, not assumed — the fixture below exits 2 on the unfixed producer.
 *
 * WHAT IS LIVE IS THAT `movers.length > 0` IS A PROXY FOR "THE TREES DIFFER", AND ONE ROW
 * DEFEATS IT. The same fixture with a SINGLE subject drifting 5 -> 4 between two runs of the same
 * tree exits 0 on the unfixed producer and writes a census over two byte-identical trees. Any
 * non-deterministic subject supplies a mover without an eject; one row out of fifty-three.
 *
 * SO THE FAILING FIXTURE IS THE DRIFTING ONE, NOT THE PURE ONE. The pure no-op already exits 2 —
 * for the VACUITY reason — so building against it would have produced a red unrelated to this
 * guard, which is the same green-for-the-wrong-reason trap in a fixture rather than a verdict.
 *
 * `dirty` IS THE DISCRIMINATOR AND `head` IS NOT. Both worktrees sit at the same commit and eject
 * deletes without committing, so equal heads is the NORMAL case.
 */
{
  const HEAD = "a".repeat(40);
  const tree = (dirty) => ({ head: HEAD, dirty });
  const cks = (n) =>
    Object.fromEntries(
      Array.from({ length: n }, (_, i) => [`c${i}`, { name: `c${i}` }])
    );
  const call = (ejectedTree, n = 2, fullTree = tree(false)) =>
    establishedNothingComplaint({
      fullTree,
      ejectedTree,
      fullCheckers: cks(n),
      ejectedCheckers: cks(n),
    });

  ok(
    "identical trees REFUSE — the ejected tree was never modified, so nothing was compared",
    /ejected tree is the FULL tree/.test(call(tree(false)) ?? ""),
    call(tree(false))
  );
  ok(
    "...and THAT message names the commit, so a reader can check which tree was doubled",
    /*
     * BOTH CLAUSES OF THIS GUARD NAME THE COMMIT, so `includes(HEAD)` alone is satisfied by
     * either — a mutation disabling the identical-trees clause left this arm GREEN because the
     * unreadable-dirty message answered instead. Assert the message SHAPE and the commit
     * together, or the arm reports on whichever clause happens to fire.
     */
    (() => {
      const m = call(tree(false)) ?? "";
      return (
        /ejected tree is the FULL tree/.test(m) && m.includes(HEAD.slice(0, 12))
      );
    })(),
    call(tree(false))
  );
  ok(
    "an UNREADABLE dirty refuses too — null is 'could not ask', not 'unchanged'",
    /could not tell whether the eject took/.test(call(tree(null)) ?? ""),
    call(tree(null))
  );
  ok(
    "GUARD (holds pre-fix): a DIRTY ejected tree is silent — the eject took, and zero movers is vacuityComplaint's case, not this one",
    call(tree(true)) === null,
    call(tree(true))
  );
  ok(
    "an EMPTY checker set refuses — the second road to the same vacuous census",
    /no checker phases were recorded/.test(call(tree(true), 0) ?? ""),
    call(tree(true), 0)
  );
  ok(
    "GUARD (holds pre-fix): a MISSING tree is silent — provenanceComplaints owns that refusal, and two guards for one cause send the reader to fix the wrong thing",
    /*
     * `null`, NOT `undefined`. A DEFAULT PARAMETER SUBSTITUTES FOR AN EXPLICIT `undefined`, so
     * `call(tree(false), 2, undefined)` silently passed a VALID full tree and this arm failed
     * against a guard that was behaving correctly. The fixture was wrong, not the subject —
     * caught because the failure message printed the value it actually got.
     */
    call(null) === null && call(tree(false), 2, null) === null,
    [call(null), call(tree(false), 2, null)]
  );
}

/*
 * #855 — THE CENSUS RECORDS WHAT WAS EJECTED, AND NEITHER THE FIELD NOR THE
 * VERDICT NAME IS A CONSTANT.
 *
 * `ejectTarget: "langchain"` was a literal, and so was the target inside every
 * static verdict. Both were right for the only invocation anyone had made and
 * wrong for `--rung`, which the runner has always accepted. The failure is not a
 * mislabel: `eject langchain` is the MAXIMAL strip and implies invariance under
 * every weaker target, so a weaker run labelled `langchain` asserts strictly more
 * than it measured.
 *
 * THE COMPANION IS THE FIRST CASE. Deriving a name that was previously a constant
 * is worth nothing if it derives a DIFFERENT one for the run everybody takes —
 * that would rewrite fifty-three rows of an existing census to say the same thing
 * in new words. So the pair is: the default target reproduces the old string
 * exactly, AND a non-default target does not.
 */
/*
 * THROUGH THE CLASSIFIER, NOT AROUND IT — AND THE FIRST VERSION WENT AROUND IT.
 *
 * This fixture read `verdict: staticFor(t)`, and merge() copies `r.verdict` rather
 * than re-classifying, so the case below asserted staticFor() plus a pass-through
 * and THE CLASSIFIER WAS NEVER IN THE PATH. Re-hardcoding classifyOne to emit a
 * fixed `"static-under-eject-langchain"` — the exact pre-#855 defect on the verdict
 * side — left all 65 assertions in this repo green. Found by DEV3-lang mutating
 * the two hardcodes separately; reproduced here before repairing.
 *
 * WHY NOTHING ELSE COVERED IT. Every other classifier case in this suite runs at
 * langchain, where the derived string and the old hardcode are byte-identical BY
 * DESIGN — that identity is what makes this change cost the census nothing, and it
 * is exactly what makes langchain useless as a test of derivation. A non-default
 * target is the only place the two differ, so it is the only place the classifier
 * can be caught, and it has to be the CLASSIFIER that produces the string.
 */
const staticAt = (t) => ({
  c: classifierFor(t)({ subject: { count: 5 } }, { subject: { count: 5 } }),
});
ok(
  "COMPANION: the default target reproduces the constant it replaced byte for byte — nothing in the census is renamed",
  staticFor("langchain") === "static-under-eject-langchain",
  staticFor("langchain")
);
{
  const out = mergeAt(
    null,
    staticAt("deepagents"),
    "a".repeat(40),
    "b".repeat(40),
    1,
    {
      ejectTarget: "deepagents",
    }
  );
  /*
   * TWO ASSERTIONS, NOT ONE, BECAUSE THEY ARE TWO LITERALS. `ejectTarget` and the
   * target inside the verdict were separate hardcodes in separate files, and a
   * single case covering both is killed by either mutation — so it could not say
   * WHICH one had come back. Split, the kill sets are disjoint.
   */
  ok(
    "the census FIELD records the non-default target",
    out.ejectTarget === "deepagents",
    out.ejectTarget
  );
  ok(
    "...and the VERDICT names it too, so a row cannot claim a target the census does not",
    out.checkers.c.verdict === "static-under-eject-deepagents",
    out.checkers.c.verdict
  );
  ok(
    "a static row at a non-default target still gets the note/lifts treatment — read by prefix, not by matching one target",
    isStatic(out.checkers.c.verdict) && out.checkers.c.lifts === DEFAULT_LIFTS,
    out.checkers.c
  );
}
{
  const threw = (t) => {
    try {
      mergeAt(null, staticAt("langchain"), "a".repeat(40), "b".repeat(40), 1, {
        ejectTarget: t,
      });
      return false;
    } catch {
      return true;
    }
  };
  ok(
    "merge REFUSES a missing, blank or non-string target rather than defaulting one — the literal is not reachable again through an omission",
    threw(undefined) && threw(null) && threw("") && threw("   ") && threw(7),
    [threw(undefined), threw(null), threw(""), threw("   "), threw(7)]
  );
}
{
  /*
   * THE GUARD MUST NOT BE DATA-DEPENDENT. Only ONE branch of classifyOne uses the
   * target, so validating it where it is used would let a run in which nothing is
   * static classify happily with no target at all — and that census is exactly as
   * unattributable as the other one. The fixture here is deliberately `moved`, so
   * the target is never consulted by the classification itself.
   */
  let threw = false;
  try {
    const c = classifierFor(undefined);
    c({ subject: { count: 1 } }, { subject: { count: 2 } }, null);
  } catch {
    threw = true;
  }
  ok(
    "classifying refuses an unusable target even when NO row would be static — the check is on the run, not on the data",
    threw,
    threw
  );
}
/*
 * READER AND PRODUCER VALIDATE DIFFERENT SETS, AND IT FAILS CLOSED (DEV3-lang).
 * `staticFor("")` throws, so the producer cannot write the bare prefix; `isStatic`
 * accepts it. Only a hand-edit reaches that state, and the consequence of accepting
 * it is that the row is treated as static and therefore REQUIRES a note — the safe
 * direction. Asserted rather than repaired: tightening the reader would need its own
 * argument, and an undocumented asymmetry is what turns into a surprise later.
 */
ok(
  "the bare prefix is accepted by the reader though the producer cannot write it — asymmetric, and closed rather than open",
  isStatic(STATIC_PREFIX) === true &&
    (() => {
      try {
        staticFor("");
        return false;
      } catch {
        return true;
      }
    })(),
  [isStatic(STATIC_PREFIX)]
);

ok(
  "isStatic recognises a target it has never been told about — a consumer that decoded ejectTarget would answer no for every row of that census",
  isStatic("static-under-eject-deepagents") &&
    isStatic(STATIC_PREFIX + "software-developer-agent") &&
    !isStatic("moved") &&
    !isStatic("static-under-eject") &&
    !isStatic(undefined),
  null
);

/* ── THE RENAME IS COMPLETE ON THE REAL TREE, RE-CHECKED AT MERGE TIME ───────
 *
 * #876 renamed the retention's inner keys and migrated every row that carried a
 * retention WHEN IT WAS WRITTEN. That was correct and it was not enough: while the
 * PR sat in the queue, #904 moved `worktree-inventory` out of STATIC, #834
 * quarantined its note, and MAIN's producer — still emitting the old names — wrote
 * a second retention under `measuredAt`/`base`. The rebase produced a census with
 * ONE ROW IN EACH VOCABULARY.
 *
 * NOTHING CAUGHT IT. The eject gate, `assert-census-fresh`, this selftest and the
 * formatter were all green with the census in two vocabularies at once, because
 * these inner keys are WRITE-ONLY: the producer emits them, the census stores them,
 * and until this case nothing read them back outside the fixtures above. Mutating
 * them to the old names left every gate at exit 0 — that was measured, not assumed.
 *
 * So this is the first consumer of the field, and it exists because a migration
 * whose SUBJECT CAN GROW cannot be settled by a review: no reader of #876 could see
 * a row that did not exist yet. The check has to run against the tree at merge time,
 * which is what a proof does and a review cannot.
 */
{
  const ROOT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
  const census = JSON.parse(
    readFileSync(
      pjoin(ROOT_DIR, "scripts", "eject-subject-census.json"),
      "utf8"
    )
  );
  const retentions = Object.entries(census.checkers ?? {}).filter(
    ([, v]) => v && v.retainedFrom
  );
  const stale = retentions
    .filter(
      ([, v]) => "measuredAt" in v.retainedFrom || "base" in v.retainedFrom
    )
    .map(([name]) => name);

  ok(
    "the REAL census carries no retention under the old inner keys — a migration " +
      "queued behind a producer that emits the old shape goes stale in place",
    stale.length === 0,
    `rows still on the old keys: ${stale.join(", ") || "(none)"}`
  );

  /*
   * WITHOUT THIS THE CASE ABOVE PASSES OVER A CENSUS THAT RETAINS NOTHING, which is
   * the state every fresh classification starts in. An absence assertion needs a
   * presence companion or it is green for the wrong reason.
   */
  ok(
    "...and the census HAS retentions, so that absence is measured rather than vacuous",
    retentions.length > 0,
    `retention rows found: ${retentions.length}`
  );
}

/* ---- #920: the run disqualifies its own output, rather than a person doing it -------------- */

/*
 * THE OCCURRENCE. A run wrote 54 entries against a 62-check registry, exited 0, and printed a
 * normal completion. It was caught by someone comparing two numbers by hand before committing.
 * Both numbers were already inside the process.
 *
 * TWO GUARDS, TWO CAUSES, AND THE CASES BELOW KEEP THEM APART — the same rule #953 is about.
 * `refusedBaselineComplaint` names a full tree that could not answer; `totalityComplaint` names
 * an artifact with holes. Either can occur without the other, so neither message may be
 * reachable from the other's condition.
 */
ok(
  "a checker REFUSING in the FULL tree is a refusal, and the message names it",
  (() => {
    const why = refusedBaselineComplaint({
      a: { exit: 0 },
      "readme-quickstart": { exit: 2 },
    });
    return (
      why !== null && why.includes("readme-quickstart") && why.includes("FULL")
    );
  })(),
  refusedBaselineComplaint({ a: { exit: 0 }, "readme-quickstart": { exit: 2 } })
);

/*
 * THE COMPANION, AND IT IS THE ONE THAT MAKES THE GUARD SURVIVABLE. Nine rows in main's census
 * are `absent` BECAUSE a checker refused in the ejected tree — the eject deleted what it reads.
 * A guard blind to which side refused would refuse every run ever taken, citing nine checkers
 * that behaved exactly as designed.
 */
ok(
  "a refusal in the EJECTED tree is NOT this guard's business — it is the ordinary `absent` verdict",
  refusedBaselineComplaint({ a: { exit: 0 }, b: { exit: 0 } }) === null &&
    classifyOne({ subject: { count: 5 }, exit: 0 }, { exit: 2 }).verdict ===
      "absent",
  classifyOne({ subject: { count: 5 }, exit: 0 }, { exit: 2 })
);

/*
 * AND NOT EXIT 1 EITHER. Main's census carries exactly one `no-baseline`, from a checker that
 * FAILS on the full tree — the documented self-referential case. Refusing on that looks like
 * the more general guard and would refuse every run.
 */
ok(
  "a checker FAILING (exit 1) on the full tree is not a refusal — that is the live `no-baseline` row",
  refusedBaselineComplaint({ "eject-subjects-classified": { exit: 1 } }) ===
    null,
  refusedBaselineComplaint({ "eject-subjects-classified": { exit: 1 } })
);

ok(
  "a census SHORT of its registry is refused, and the missing names are in the message",
  (() => {
    const why = totalityComplaint(["a", "b", "c"], { checkers: { a: {} } });
    return why !== null && why.includes("b") && why.includes("c");
  })(),
  totalityComplaint(["a", "b", "c"], { checkers: { a: {} } })
);

/*
 * THE OTHER DIRECTION, because a one-way check leaves the census free to accumulate rows for
 * checkers that no longer exist — #774's ruling, and the reason `reconcile` is imported here
 * rather than half of it being re-implemented.
 */
ok(
  "a classified name the registry no longer has is refused too",
  (totalityComplaint(["a"], { checkers: { a: {}, gone: {} } }) ?? "").includes(
    "gone"
  ),
  totalityComplaint(["a"], { checkers: { a: {}, gone: {} } })
);

/*
 * THE MESSAGE MUST NOT DESCRIBE A FILE ON DISK. This refusal fires BEFORE the write, so a
 * reader told "the census is short" would go and look at a census that is still the old, whole
 * one. What was refused is the census this run WOULD have written.
 */
ok(
  "the refusal says nothing was written, because it fires before the write",
  (totalityComplaint(["a", "b"], { checkers: { a: {} } }) ?? "").includes(
    "NOTHING WAS WRITTEN"
  ),
  totalityComplaint(["a", "b"], { checkers: { a: {} } })
);

ok(
  "a census that reconciles produces no complaint",
  totalityComplaint(["a", "b"], { checkers: { a: {}, b: {} } }) === null,
  totalityComplaint(["a", "b"], { checkers: { a: {}, b: {} } })
);

/*
 * THE POSITIVE CONTROL, ON THE REAL ARTIFACTS. Every case above is fabricated, so together they
 * show the guard CAN fire and nothing about whether it fires on a real pair. A guard that refuses
 * the repository's own committed census would be discovered by whoever next runs the eight-minute
 * audit, which is the worst place to discover it.
 *
 * THE SUBJECT IS THE CHECKOUT THIS RUN HAS, NOT `main`. On a pull request that is the PR's tree,
 * so a failure here is USUALLY a census nobody has regenerated on somebody's branch, and NOT a
 * broken main. An earlier title said "main's own", whose honest reading is that main is broken
 * right now — an emergency — and a reader had to reconcile two trees by hand to find out which
 * tree the arm meant. The title now names the subject it actually has and the message names the
 * sha, so the FAIL locates itself.
 *
 * AND IT REPORTS `totalityComplaint`'s OWN MESSAGE RATHER THAN A FIXED STRING. The complaint
 * names the checkers that are short, which is the sentence a registrant needs; collapsing it to
 * `=== null` and substituting a summary threw that away one line from where it was wanted, and
 * two people paid for it in diagnosis on #1164 and #1165.
 */
const committedPair = (() => {
  const root = pjoin(dirname(fileURLToPath(import.meta.url)), "..");
  let at = null;
  try {
    at = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  } catch {
    at =
      null; /* could not ask — reported as such, never as a tree name we do not have */
  }
  const registry = JSON.parse(
    readFileSync(pjoin(root, "scripts/checks.json"), "utf8")
  );
  const census = JSON.parse(
    readFileSync(pjoin(root, "scripts/eject-subject-census.json"), "utf8")
  );
  const registered = registeredCheckers(registry);
  const vacuous =
    registered.length === 0 || Object.keys(census.checkers ?? {}).length === 0;
  const complaint = vacuous
    ? `one side of the pair is empty (registry ${registered.length}, census ` +
      `${
        Object.keys(census.checkers ?? {}).length
      }) — the comparison would assert nothing`
    : totalityComplaint(registered, census);
  return { reconciles: !vacuous && complaint === null, complaint, at };
})();
ok(
  "the checkout's own checks.json and census reconcile — the guard does not refuse the committed state",
  committedPair.reconciles,
  `at ${
    committedPair.at ??
    "an unknown sha — `git rev-parse HEAD` could not be asked"
  }: ${committedPair.complaint}`
);

/* ---- #920, AT THE PROCESS: the guards are WIRED, not merely written ------------------------ */

/*
 * A GUARD NOBODY CALLS IS A GREEN THAT PROVES NOTHING, and every case above drives the two
 * functions directly — which says the functions work and nothing about whether `main` consults
 * them. The defect this issue records is precisely a run that finished normally, so the
 * property under test is a PROCESS one: the audit must exit 2 and must not write.
 *
 * THE FILE IS THE EVIDENCE, NOT THE OUTPUT. Both refusals claim "NOTHING WAS WRITTEN", and a
 * message is the process's report about itself — the class of evidence that produced the
 * failure being fixed. So the census bytes are compared before and after, and restored if the
 * run wrote them, so a broken guard cannot leave a two-row census behind on the way to failing.
 */
const SELF_ROOT = pjoin(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = tmpdir();
const HEAD_SHA = "0".repeat(39) + "1";
const auditFixture = (fullChecks, ejectedChecks) => {
  const dir = mkdtempSync(pjoin(TMP, "audit-wiring-"));
  const write = (name, tree, checks) => {
    const at = pjoin(dir, name);
    writeFileSync(at, JSON.stringify({ tree, checks }));
    return at;
  };
  return {
    dir,
    full: write("full.json", { head: HEAD_SHA, dirty: false }, fullChecks),
    ejected: write(
      "ejected.json",
      { head: HEAD_SHA, dirty: true },
      ejectedChecks
    ),
  };
};
const runAudit = (fx) => {
  const script = pjoin(SELF_ROOT, "scripts/eject-subject-audit.mjs");
  const censusAt = pjoin(SELF_ROOT, "scripts/eject-subject-census.json");
  const before = readFileSync(censusAt, "utf8");
  let code = 0;
  let out = "";
  try {
    out = execFileSync(
      "node",
      [
        script,
        "--full",
        fx.full,
        "--ejected",
        fx.ejected,
        "--sha",
        HEAD_SHA,
        "--base",
        HEAD_SHA,
        "--eject-target",
        "langchain",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
  } catch (e) {
    code = typeof e?.status === "number" ? e.status : 1;
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  const after = readFileSync(censusAt, "utf8");
  const wrote = after !== before;
  if (wrote) writeFileSync(censusAt, before);
  rmSync(fx.dir, { recursive: true, force: true });
  return { code, out, wrote };
};

{
  const r = runAudit(
    auditFixture(
      [
        { name: "moves", phase: "checker", exit: 0, subject: { count: 5 } },
        { name: "readme-quickstart", phase: "checker", exit: 2 },
      ],
      [
        { name: "moves", phase: "checker", exit: 0, subject: { count: 3 } },
        {
          name: "readme-quickstart",
          phase: "checker",
          exit: 0,
          subject: { count: 1 },
        },
      ]
    )
  );
  ok(
    "WIRED: a full-tree refusal makes the AUDIT exit 2, naming the checker",
    r.code === 2 && /readme-quickstart/.test(r.out) && /FULL tree/.test(r.out),
    { code: r.code, out: r.out.slice(0, 240) }
  );
  ok(
    "...and it wrote no census, which is what the refusal claims",
    r.wrote === false,
    "the audit WROTE the census on a path that says NOTHING WAS WRITTEN"
  );
}

{
  const r = runAudit(
    auditFixture(
      [
        { name: "moves", phase: "checker", exit: 0, subject: { count: 5 } },
        { name: "alsoMoves", phase: "checker", exit: 0, subject: { count: 9 } },
      ],
      [
        { name: "moves", phase: "checker", exit: 0, subject: { count: 3 } },
        { name: "alsoMoves", phase: "checker", exit: 0, subject: { count: 2 } },
      ]
    )
  );
  ok(
    "WIRED: a census short of the registry makes the AUDIT exit 2 before writing",
    r.code === 2 && /does not reconcile with checks.json/.test(r.out),
    { code: r.code, out: r.out.slice(0, 240) }
  );
  ok(
    "...and main's committed census is byte-identical afterwards",
    r.wrote === false,
    "the short census reached disk"
  );
}

/*
 * AND THE HAPPY PATH STILL REACHES THE WRITE. Both arms above prove the audit can REFUSE, and
 * two refusals plus no success is how a guard that refuses everything looks — the false-refusal
 * shape, discovered otherwise by whoever next pays the eight-minute run. Every registered
 * checker is present here and every subject shrinks, which is what a healthy reading is, so the
 * run must classify, reconcile and WRITE.
 *
 * IT ALSO EXERCISES `main` ON THE PATH NOTHING ELSE DOES. Every unit case above drives pure
 * functions; only this one runs the code after the last guard. The census bytes are restored
 * immediately, so the assertion is that the run wrote, not that the repository changed.
 */
ok(
  "a complete, healthy reading still classifies and WRITES — the guards did not make the audit inert",
  (() => {
    const registered = registeredCheckers(
      JSON.parse(readFileSync(pjoin(SELF_ROOT, "scripts/checks.json"), "utf8"))
    );
    const at = (count) =>
      registered.map((name) => ({
        name,
        phase: "checker",
        exit: 0,
        subject: { count },
      }));
    const r = runAudit(auditFixture(at(5), at(3)));
    return registered.length > 0 && r.code === 0 && r.wrote === true;
  })(),
  "a healthy reading did not reach the write"
);

/* ---- #1071: the producer stamps a defaulted `lifts` and carries the stamp ---------------- */

/*
 * THE REPORTER WAS PINNED AND THE WRITER WAS NOT. Mutating the producer so the stamp is never
 * written, and again so it is dropped on `keep`, left every reporter arm green — the same
 * predicate-pinned/wiring-unpinned shape #1070 was amended for. These arms are on `merge`.
 */
{
  const S_V = STATIC;
  const fresh = (v = S_V) => ({
    x: { verdict: v, full: 2, ejected: 2, why: "w" },
  });

  ok(
    "a NEWLY static row is stamped, and the stamp records the VALUE written, not only when and where",
    (() => {
      const r = merge(undefined, fresh(), "sha1").checkers.x;
      return (
        r.lifts === DEFAULT_LIFTS &&
        r.liftsDefaultedAt &&
        r.liftsDefaultedAt.value === DEFAULT_LIFTS &&
        r.liftsDefaultedAt.sha === "sha1"
      );
    })()
  );

  ok(
    "the stamp is CARRIED FORWARD on a kept row — `keep` means carried, not examined, so a default surviving a re-run is still unruled",
    (() => {
      const prev = {
        checkers: {
          x: {
            verdict: S_V,
            note: "n",
            lifts: DEFAULT_LIFTS,
            liftsDefaultedAt: { value: DEFAULT_LIFTS, sha: "sha1", at: "t" },
          },
        },
      };
      const r = merge(prev, fresh(), "sha2").checkers.x;
      return r.liftsDefaultedAt && r.liftsDefaultedAt.sha === "sha1";
    })()
  );

  ok(
    "a row that LEAVES static drops the stamp with `lifts` itself — it cannot become an undischargeable expectation on a verdict that never returns",
    (() => {
      const prev = {
        checkers: {
          x: {
            verdict: S_V,
            note: "n",
            lifts: DEFAULT_LIFTS,
            liftsDefaultedAt: { value: DEFAULT_LIFTS, sha: "sha1", at: "t" },
          },
        },
      };
      const r = merge(prev, fresh("not-tree-derived"), "sha2").checkers.x;
      return r.liftsDefaultedAt === undefined && r.lifts === undefined;
    })()
  );

  ok(
    "and the QUARANTINE does not carry it: retentionFor copies note and lifts by name, so the stamp cannot cross into a non-static verdict",
    (() => {
      const prev = {
        checkers: {
          x: {
            verdict: S_V,
            note: "n",
            lifts: DEFAULT_LIFTS,
            liftsDefaultedAt: { value: DEFAULT_LIFTS, sha: "sha1", at: "t" },
          },
        },
      };
      const r = merge(prev, fresh("no-baseline"), "sha2").checkers.x;
      return r.retainedFrom && !("liftsDefaultedAt" in r.retainedFrom);
    })()
  );

  /*
   * A RULING IS CARRIED AND NEVER MINTED. `liftsDefaultedAt` says HOW the value arrived;
   * `liftsRuledAt` says WHETHER a person decided it. A producer that could write the second
   * would be manufacturing the examination this pair exists to make visible, so the first arm
   * below is the one that matters and it asserts an ABSENCE.
   */
  const withRuling = (over = {}) => ({
    checkers: {
      x: {
        verdict: S_V,
        note: "n",
        lifts: DEFAULT_LIFTS,
        liftsRuledAt: { value: DEFAULT_LIFTS, by: "DEV2", at: "t" },
        ...over,
      },
    },
  });

  ok(
    "the producer NEVER mints a ruling: a newly static row gets a default stamp and no `liftsRuledAt`, because a mechanical run has examined nothing",
    (() => {
      const r = merge(undefined, fresh(), "sha1").checkers.x;
      return r.liftsDefaultedAt && r.liftsRuledAt === undefined;
    })()
  );

  ok(
    "a hand-written ruling SURVIVES a regeneration — the producer rebuilds each row from a closed literal, so a field it does not carry is a field it silently deletes",
    (() => {
      const r = merge(withRuling(), fresh(), "sha2").checkers.x;
      return r.liftsRuledAt && r.liftsRuledAt.by === "DEV2";
    })()
  );

  ok(
    "a ruling is DROPPED when the verdict changed, because a decision about a row asking a different question is not a decision about this one",
    (() => {
      const r = merge(withRuling(), fresh("not-tree-derived"), "sha2").checkers
        .x;
      return r.liftsRuledAt === undefined && r.lifts === undefined;
    })()
  );

  ok(
    "and the ruling cannot cross into a quarantine either: it rides `lifts`, so a row under a permanent verdict carries no decision about a value it no longer has",
    (() => {
      const r = merge(withRuling(), fresh("no-baseline"), "sha2").checkers.x;
      return r.retainedFrom && !("liftsRuledAt" in r.retainedFrom);
    })()
  );

  /*
   * BOTH ARMS BELOW EXIST BECAUSE A MUTATION SURVIVED, AND EACH SURVIVOR WAS A REAL GAP RATHER
   * THAN REDUNDANCY -- the fixtures above take the other branch in both cases.
   *
   * `keep` is not spelled by `isStatic`. Dropping the `keep` guard survived every arm here,
   * because they all move the row to a NON-static verdict, where the `isStatic` branch discards
   * the field whatever the variable holds. The two disagree only on a static -> DIFFERENT-static
   * hop, which is one eject target to another and perfectly reachable.
   *
   * And `retentionFor` has TWO returns. The arm above exercises the first, which builds the
   * closed literal; the second passes an EARLIER retention through. The induction "the literal is
   * closed, so no retention can carry the ruling" holds only while that second return stays a
   * pass-through, so a fixture whose row has a retention and NO note pins it directly.
   */
  ok(
    "a ruling is dropped on a static -> DIFFERENT-static hop: `keep` compares verdicts and `isStatic` does not, so a decision about one eject target does not answer for another",
    (() => {
      const other = STATIC_PREFIX + "software-developer-agent";
      const prev = {
        checkers: {
          x: {
            verdict: other,
            note: "n",
            lifts: DEFAULT_LIFTS,
            liftsRuledAt: { value: DEFAULT_LIFTS, by: "DEV2", at: "t" },
          },
        },
      };
      const r = merge(prev, fresh(S_V), "sha2").checkers.x;
      return r.verdict === S_V && r.liftsRuledAt === undefined;
    })()
  );

  ok(
    "retentionFor's PASS-THROUGH return carries no ruling either — the closed literal is only the first branch, and the second is what an earlier retention travels through",
    (() => {
      const prev = {
        checkers: {
          x: {
            verdict: S_V,
            lifts: DEFAULT_LIFTS,
            liftsRuledAt: { value: DEFAULT_LIFTS, by: "DEV2", at: "t" },
            retainedFrom: { note: "earlier", lifts: "#1", verdict: S_V },
          },
        },
      };
      const r = merge(prev, fresh(S_V), "sha2").checkers.x;
      return r.retainedFrom && !("liftsRuledAt" in r.retainedFrom);
    })()
  );
}

/* ---- #1040: the carry is COUNTED, so an unresolved transient is visible ------------------- */

/*
 * PINNING THE WRITER, NOT ONLY THE READER. The consumer's arms live in the classifier's proof and
 * would all pass against a producer that never wrote `carriedFor` -- the predicate-pinned,
 * wiring-unpinned shape that has cost this repository four separate findings. These drive `merge`.
 */
{
  const S_V = STATIC;
  const OPT = { ejectTarget: TARGET };
  const authored = {
    verdict: S_V,
    full: 7,
    ejected: 7,
    why: "w",
    note: "authored",
    lifts: "#900",
  };
  const cen = (row, at, base) => ({
    measuredAt: at,
    base,
    checkers: { c: row },
  });
  const gone = {
    c: { verdict: "no-baseline", full: null, ejected: null, why: "moved" },
  };
  const hop = (prev, at, base, sha) =>
    merge(cen(prev, at, base), gone, sha, base, 1, OPT).checkers.c;

  const h1 = hop(authored, "M0", "B0", "s0");
  const h2 = hop(h1, "M1", "B1", "s1");
  const h3 = hop(h2, "M2", "B2", "s2");

  ok(
    "a FRESH quarantine is carriedFor 0 — it was taken this audit, which is the ordinary state and must not report",
    h1.retainedFrom?.carriedFor === 0
  );

  ok(
    "each further transient audit INCREMENTS it, so `has not resolved` is a count rather than an inference",
    h2.retainedFrom?.carriedFor === 1 && h3.retainedFrom?.carriedFor === 2
  );

  ok(
    "and the expectation rides with it: the retention still names the verdict it is expected to return to, unchanged across every hop",
    h1.retainedFrom?.verdict === S_V &&
      h3.retainedFrom?.verdict === S_V &&
      h3.retainedFrom?.note === "authored"
  );

  ok(
    "the count does NOT depend on a sha resolving — `writtenAt` freezes at the quarantine while `measuredAt` advances, so it differs from the current reading on the first hop exactly as on the third, and this repo squash-merges",
    h1.retainedFrom?.writtenAt === "M0" && h3.retainedFrom?.writtenAt === "M0"
  );
}

const EXPECTED = 94; // +6 for #1071's carried ruling, 37 + 6 for #843 + 8 for #855 + 4 for #844's external rule + 5 for #875 + 3 for #876/#883 + 13 for #920 + 4 for #1040 + 4 for #1170's declared exemption
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
