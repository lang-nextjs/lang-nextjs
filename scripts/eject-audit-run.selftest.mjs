#!/usr/bin/env node
/**
 * eject-audit-run.selftest.mjs — proves the two preconditions `pnpm eject-audit`
 * refuses on, and proves the record check is a POSITIVE CONTROL rather than a status
 * reading.
 *
 * WHAT IT CANNOT PROVE, stated because a proof that does not say so reads as complete:
 * it does not run the producer. Doing that materialises two worktrees and spends
 * eight minutes installing and building them, which is why the audit is not on the
 * per-PR path in the first place. What is proven here is every decision made BEFORE
 * anything expensive happens, plus the artifact check made after — which is exactly
 * the set that decides whether a bad census can be written.
 */
import {
  trackedChanges,
  recordComplaint,
  rungComplaint,
  treeShaComplaints,
  stage,
  keptTreePaths,
  describeKept,
  inFlightTrees,
  INFLIGHT,
  parseAuditArgs,
} from "./eject-audit-run.mjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0;
let fail = 0;
const ok = (label, cond, got) => {
  if (cond) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label} — got ${JSON.stringify(got)}`);
  }
};

const RUNGS = {
  rungs: [
    { id: "langchain" },
    { id: "langgraph" },
    { id: "software-developer-agent" },
  ],
};

ok(
  "the known audit arguments are parsed without accepting positional input",
  JSON.stringify(parseAuditArgs(["--keep", "--rung", "langgraph"])) ===
    JSON.stringify({
      keep: true,
      reclaim: false,
      rung: "langgraph",
      help: false,
    }),
  parseAuditArgs(["--keep", "--rung", "langgraph"])
);

ok(
  "an unknown argument REFUSES before the audit can create a worktree",
  /unknown argument/.test(parseAuditArgs(["--wat"]).error ?? ""),
  parseAuditArgs(["--wat"])
);

ok(
  "a missing --rung value REFUSES instead of silently selecting the default",
  /requires a rung name/.test(parseAuditArgs(["--rung"]).error ?? ""),
  parseAuditArgs(["--rung"])
);

ok(
  "a flag-shaped --rung value is refused rather than consumed as a name",
  /requires a rung name/.test(parseAuditArgs(["--rung", "--keep"]).error ?? ""),
  parseAuditArgs(["--rung", "--keep"])
);

ok(
  "--help is a recognized read-only request",
  parseAuditArgs(["--help"]).help === true,
  parseAuditArgs(["--help"])
);

ok(
  "a rung rungs.json declares is accepted",
  rungComplaint(RUNGS, "langchain") === null,
  rungComplaint(RUNGS, "langchain")
);

ok(
  "an unknown rung is refused, and the message LISTS the valid ones",
  /unknown rung/.test(rungComplaint(RUNGS, "nope") ?? "") &&
    /langchain, langgraph, software-developer-agent/.test(
      rungComplaint(RUNGS, "nope") ?? ""
    ),
  rungComplaint(RUNGS, "nope")
);

/*
 * THE KEY IS `id`, AND THIS IS THE CASE THAT CATCHES READING THE WRONG ONE. I first
 * wrote `.map(r => r.name)`, which yields [] on every real rungs.json — so the
 * validator refused with "declares no rungs" against a file declaring five, and
 * would have refused every VALID rung too. A fixture using `name` here would pass
 * against that bug, so the fixture uses `id` exactly as the real file does.
 */
ok(
  "entries keyed by something other than `id` are not silently read as valid rungs",
  rungComplaint({ rungs: [{ name: "langchain" }] }, "langchain") !== null,
  rungComplaint({ rungs: [{ name: "langchain" }] }, "langchain")
);

ok(
  "a rungs.json with no rungs REFUSES rather than accepting anything",
  /declares no rungs/.test(rungComplaint({ rungs: [] }, "langchain") ?? ""),
  rungComplaint({ rungs: [] }, "langchain")
);

/*
 * THE RECORD CHECK IS THE POSITIVE CONTROL ON THE ARTIFACT. The bug that produced
 * #819 was found only because a refusal sat unread in a body whose pipeline reported
 * exit 0. So the question asked of each half is "did it MEASURE", answered by the
 * record, never by a status that a `| tail` has already thrown away.
 */
const dir = mkdtempSync(join(tmpdir(), "record-check-"));
try {
  const write = (name, body) => {
    const p = join(dir, name);
    writeFileSync(p, body);
    return p;
  };

  ok(
    "a record with entries is accepted",
    recordComplaint(
      write("good.json", JSON.stringify({ ran: [{ name: "x" }] }))
    ) === null,
    recordComplaint(join(dir, "good.json"))
  );

  ok(
    "a MISSING record is refused — the run did not reach the end",
    /no record was written/.test(
      recordComplaint(join(dir, "absent.json")) ?? ""
    ),
    recordComplaint(join(dir, "absent.json"))
  );

  ok(
    "a record with no `ran` array is refused, not read as zero checks",
    /no `ran` array/.test(recordComplaint(write("shape.json", "{}")) ?? ""),
    recordComplaint(join(dir, "shape.json"))
  );

  /*
   * AN EMPTY `ran` IS THE DANGEROUS ONE. It is valid JSON of the right shape, and
   * passing it to the consumer yields a census of nothing that looks like a census —
   * the vacuity the audit's own header warns about, arriving through the producer
   * rather than through an unprepared tree.
   */
  ok(
    "an EMPTY record is refused rather than classified as a tree with no checkers",
    /record is empty/.test(
      recordComplaint(write("empty.json", JSON.stringify({ ran: [] }))) ?? ""
    ),
    recordComplaint(join(dir, "empty.json"))
  );

  ok(
    "a truncated / unparseable record is refused with the parse error named",
    /not readable JSON/.test(
      recordComplaint(write("trunc.json", '{"ran": [{"na')) ?? ""
    ),
    recordComplaint(join(dir, "trunc.json"))
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

/*
 * THE PROVENANCE CHECK. `--sha` is a claim the consumer cannot verify, so the producer
 * resolves it from the tree instead — and this proves the resolution notices when a
 * tree is not where it was asked to be. The failure it guards against writes TWO
 * NORMAL-LOOKING RECORDS about the wrong directory, so there is no later symptom to
 * catch: it has to be caught here or not at all.
 */
ok(
  "two trees at the expected commit raise nothing",
  treeShaComplaints("abc123", { full: "abc123", ejected: "abc123" }).length ===
    0,
  treeShaComplaints("abc123", { full: "abc123", ejected: "abc123" })
);

ok(
  "ONE tree at the wrong commit is caught, and the message names WHICH",
  treeShaComplaints("abc123", { full: "abc123", ejected: "def456" }).length ===
    1 &&
    /ejected/.test(
      treeShaComplaints("abc123", { full: "abc123", ejected: "def456" })[0]
    ),
  treeShaComplaints("abc123", { full: "abc123", ejected: "def456" })
);

ok(
  "an UNREADABLE head is caught rather than compared as equal-to-nothing",
  treeShaComplaints("abc123", { full: null }).length === 1 &&
    /unreadable/.test(treeShaComplaints("abc123", { full: null })[0]),
  treeShaComplaints("abc123", { full: null })
);

/*
 * THE COMPARATOR ABOVE IS PROVEN AGAINST STRING LITERALS, WHICH IS NOT THE RISK.
 * "abc123" vs "def456" shows the comparison works; it cannot distinguish that from
 * the comparison being wired to the wrong input. The failure this guards against
 * lives in the WIRING — reading a head from a directory that is not the one the
 * stages will run in — so this arm builds a real worktree at a DIFFERENT commit and
 * drives the same `git -C <dir> rev-parse HEAD` the producer uses.
 */
{
  const git = (a, cwd) =>
    execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
  const root = join(new URL(".", import.meta.url).pathname, "..");
  const wt = mkdtempSync(join(tmpdir(), "wrongtree-"));
  rmSync(wt, { recursive: true, force: true });
  let fired = null;
  try {
    const expected = git(["rev-parse", "HEAD"], root);
    git(["worktree", "add", "-q", "--detach", wt, `${expected}~1`], root);
    const actual = git(["rev-parse", "HEAD"], wt);
    fired = {
      differs: actual !== expected,
      complaints: treeShaComplaints(expected, { "the full tree": actual }),
    };
  } finally {
    try {
      execFileSync("git", ["worktree", "remove", "--force", wt], {
        cwd: root,
        stdio: "ignore",
      });
    } catch {
      rmSync(wt, { recursive: true, force: true });
    }
    try {
      execFileSync("git", ["worktree", "prune"], {
        cwd: root,
        stdio: "ignore",
      });
    } catch {}
  }

  ok(
    "a REAL worktree at the wrong commit is caught through the same rev-parse the producer uses",
    fired.differs && fired.complaints.length === 1,
    fired
  );
}

/*
 * `stage()` REFUSING A FALSY cwd, tested at the entry point rather than by scanning
 * call sites for the mistake. This is the defect that shipped: CLASSIFY passed three
 * arguments, spawnSync inherited process.cwd(), and the header claimed every stage
 * had an explicit cwd. The guard fires BEFORE anything is spawned.
 */
ok(
  "stage() REFUSES a missing cwd rather than letting spawnSync inherit process.cwd()",
  (() => {
    try {
      stage("PROBE", "node", ["-e", "process.exit(0)"], undefined);
      return false;
    } catch (e) {
      return /no cwd given/.test(e.message);
    }
  })(),
  "expected a throw naming the missing cwd"
);

ok(
  "stage() still runs when a cwd IS given — the guard is not refusing everything",
  stage("PROBE", "node", ["-e", "process.exit(7)"], tmpdir()).status === 7,
  stage("PROBE", "node", ["-e", "process.exit(7)"], tmpdir())
);

/*
 * #866: THE DIRTY-TREE REFUSAL, WHICH THE REGISTRY'S JUSTIFICATION ALREADY CLAIMED WAS COVERED.
 *
 * checks.json leaves eject-audit-run.mjs unregistered on the ground that this proof "covers
 * every decision made before anything expensive runs". It covered four of five. The fifth was
 * the dirty-tree refusal — three lines inline in main(), unreachable from a proof that imports
 * the module's exported names.
 *
 * And it is the one that matters most, by its own note: a dirty tree is "the one precondition a
 * reader cannot detect afterwards, because the resulting census looks entirely normal". The
 * other four announce themselves. This one produces a plausible artifact about a tree nobody
 * measured, which is the failure the whole audit exists to prevent.
 *
 * THE UNTRACKED EXEMPTION IS THE POINT RATHER THAN A DETAIL, and it fails silently in BOTH
 * directions: lose it and every run refuses over a stray notes file, so nobody can ever take a
 * census; widen it and a genuinely dirty tree is measured and the census names a sha whose
 * working state it does not describe. Neither shows up as an error, so both need an arm.
 */
{
  const n = (porcelain) => trackedChanges(porcelain).length;

  ok(
    "a tracked modification is a dirty tree",
    n(" M scripts/x.mjs") === 1,
    trackedChanges(" M scripts/x.mjs")
  );
  ok(
    "a staged addition and a deletion both count — the eject's own signature is deletions",
    n("A  scripts/new.mjs\n D scripts/gone.mjs") === 2,
    trackedChanges("A  scripts/new.mjs\n D scripts/gone.mjs")
  );
  ok(
    "an UNTRACKED file is NOT a dirty tree — refusing on it would refuse on the caller's notes",
    n("?? notes.md") === 0,
    trackedChanges("?? notes.md")
  );
  ok(
    "...and a tracked change is still found when untracked noise sits beside it",
    n("?? notes.md\n M scripts/x.mjs\n?? scratch/") === 1,
    trackedChanges("?? notes.md\n M scripts/x.mjs\n?? scratch/")
  );
  ok(
    "a clean tree is clean, and blank lines are not changes",
    n("") === 0 && n("\n\n") === 0,
    [trackedChanges(""), trackedChanges("\n\n")]
  );

  /*
   * THE ANCHORING BOUNDARY. The exemption is `startsWith("?? ")`, and a substring test would
   * agree with it on every line anyone has looked at — porcelain puts the status first, so
   * "?? " appears at position 0 for untracked and essentially never elsewhere. This is the
   * line that separates the two: a tracked file whose PATH contains those characters is a
   * change, and `includes` would exempt it.
   */
  ok(
    "the exemption is ANCHORED — a tracked path containing '?? ' is still a change",
    n(" M docs/what is a ?? thing.md") === 1,
    trackedChanges(" M docs/what is a ?? thing.md")
  );
}

/* ---- kept trees: found by PATH, never by a pattern over the human listing ---------------- */

/*
 * THE MATCHER IS THE EASY HALF AND THIS FILE ALREADY KNOWS WHY. `git worktree list` prints the
 * BRANCH in brackets beside the path, so matching a name against that line also matches a
 * worktree whose BRANCH merely mentions it — which is how the worktree eject-audit-run.mjs was
 * being written in got removed, --force, with the file untracked. `--porcelain` puts the path
 * alone on its `worktree ` line, so a basename test cannot reach the branch at all. The third
 * arm below is that exact case.
 */
const PORCELAIN = [
  "worktree /Users/x/code/lang-nextjs2",
  "HEAD 1111111111111111111111111111111111111111",
  "branch refs/heads/main",
  "",
  "worktree /tmp/eject-audit-full-AAAAAA",
  "HEAD 2222222222222222222222222222222222222222",
  "detached",
  "",
  "worktree /tmp/eject-audit-ejected-BBBBBB",
  "HEAD 3333333333333333333333333333333333333333",
  "detached",
  "",
  "worktree /Users/x/code/wt-500",
  "HEAD 4444444444444444444444444444444444444444",
  "branch refs/heads/fix/500-eject-audit-full-rewrite",
  "",
].join("\n");

ok(
  "both audit trees are found, and nothing else is",
  (() => {
    const got = keptTreePaths(PORCELAIN);
    return (
      got.length === 2 &&
      got.includes("/tmp/eject-audit-full-AAAAAA") &&
      got.includes("/tmp/eject-audit-ejected-BBBBBB")
    );
  })()
);

ok(
  "a worktree whose BRANCH mentions eject-audit is NOT matched — the incident this guards",
  !keptTreePaths(PORCELAIN).includes("/Users/x/code/wt-500")
);

/*
 * A TREE A RUN IS USING IS NOT A CANDIDATE, AND THIS IS THE ARM THAT WOULD HAVE CAUGHT THE
 * BLOCKING DEFECT. The audit's trees carry the same prefixes the matcher hunts, by construction —
 * so before the marker existed, a `--reclaim` issued during a run would have --force removed both
 * trees of a measurement somebody was waiting on. Measured live on this board: two trees of a
 * running audit came back as reclaim candidates.
 *
 * THERE WAS AN `exclude` PARAMETER AND NEITHER CALL SITE PASSED IT. Worse than no guard: the
 * signature read as evidence that live trees were handled, so the question stopped being asked.
 * It is gone; the tree's own marker is the single mechanism.
 */
ok(
  "a tree carrying the in-flight marker is NOT a reclaim candidate",
  keptTreePaths(PORCELAIN, (p) => p === "/tmp/eject-audit-full-AAAAAA")
    .length === 1
);

ok(
  "...and with every tree marked, there are no candidates at all",
  keptTreePaths(PORCELAIN, () => true).length === 0
);

ok(
  "a marker whose pid is GONE is reported as a crashed run, not silently skipped",
  (() => {
    const seen = inFlightTrees(PORCELAIN, (p) =>
      p === "/tmp/eject-audit-full-AAAAAA"
        ? JSON.stringify({ pid: 999999999 })
        : (() => {
            throw new Error("no marker");
          })()
    );
    return seen.length === 1 && seen[0].alive === false;
  })()
);

ok(
  "a marker naming THIS process reads as alive",
  (() => {
    const seen = inFlightTrees(PORCELAIN, (p) =>
      p === "/tmp/eject-audit-ejected-BBBBBB"
        ? JSON.stringify({ pid: process.pid })
        : (() => {
            throw new Error("no marker");
          })()
    );
    return seen.length === 1 && seen[0].alive === true;
  })()
);

ok(
  "the marker name is a dotfile inside the tree, so it cannot collide with a worktree path",
  INFLIGHT.startsWith(".") && !INFLIGHT.includes("/")
);

ok(
  "an empty listing yields nothing rather than throwing",
  keptTreePaths("").length === 0 && keptTreePaths(null).length === 0
);

ok(
  "the description carries the SHA, which is what says whether a loss is reconstructable",
  (() => {
    const line = describeKept(["/tmp/eject-audit-full-AAAAAA"], 0, () => ({
      mtimeMs: 0,
      sha: "deadbee",
    }))[0];
    return line.includes("deadbee") && line.includes("today");
  })()
);

ok(
  "an unreadable tree says so in both fields rather than inventing them",
  describeKept(["/tmp/gone"], 0, () => ({ mtimeMs: null, sha: null }))[0] ===
    "/tmp/gone  sha unknown  (age unknown)"
);

/*
 * AND THE DESTRUCTIVE PATH IS DRIVEN AGAINST WORKTREES THIS PROOF CREATES, NEVER AGAINST THE
 * REGISTER IT FINDS. An earlier version of this feature was tested by pointing --reclaim at the
 * live register to see whether it worked; it did, and removed six trees kept by other sessions'
 * refused runs. The content was reconstructable from the shas and the RUN STATE was not, which
 * is precisely what the retention exists to keep. A proof of a destructive path must construct
 * its own subject — and if the case cannot be fabricated, that is a reason to stop rather than
 * to borrow live state.
 */
/*
 * THE ARMS ABOVE STUB THE PROBE, SO NONE OF THEM TOUCHES THE REAL ONE. `liveInFlight` reads a
 * file from disk, and a stub cannot be wrong about that. This drives the default probe against a
 * marker that actually exists, on a worktree this proof creates.
 */
ok(
  "the DEFAULT probe reads the marker off disk: present skips, absent does not",
  (() => {
    const root = realpathSync(new URL("..", import.meta.url).pathname);
    const g = (args) =>
      execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    const t = realpathSync(mkdtempSync(join(tmpdir(), "eject-audit-full-")));
    g(["worktree", "add", "-q", "--detach", t, g(["rev-parse", "HEAD"])]);
    const porcelain = () => g(["worktree", "list", "--porcelain"]);
    const before = keptTreePaths(porcelain()).includes(t);
    writeFileSync(join(t, INFLIGHT), JSON.stringify({ pid: process.pid }));
    const marked = keptTreePaths(porcelain()).includes(t);
    const reported = inFlightTrees(porcelain()).some(
      (l) => l.path === t && l.alive === true
    );
    rmSync(join(t, INFLIGHT), { force: true });
    const cleared = keptTreePaths(porcelain()).includes(t);
    try {
      g(["worktree", "remove", "--force", t]);
    } catch {}
    return before && !marked && reported && cleared;
  })()
);

ok(
  "--reclaim removes the trees it is given and reports each one's sha before removing it",
  (() => {
    /*
     * REALPATH, BECAUSE macOS PUTS TEMP DIRS BEHIND A SYMLINK. `mkdtempSync` returns
     * /var/folders/..., git registers /private/var/folders/... — /var is a symlink to
     * /private/var — so a raw string comparison against the register fails on macOS and
     * passes on Ubuntu. scripts/lib/is-main.mjs records the same trap costing the same
     * kind of fixture, and this arm found it by failing rather than by anyone remembering.
     */
    const a = realpathSync(mkdtempSync(join(tmpdir(), "eject-audit-full-")));
    const b = realpathSync(mkdtempSync(join(tmpdir(), "eject-audit-ejected-")));
    const g = (args, cwd) =>
      execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    const root = new URL("..", import.meta.url).pathname;
    const sha = g(["rev-parse", "HEAD"], root);
    g(["worktree", "add", "-q", "--detach", a, sha], root);
    g(["worktree", "add", "-q", "--detach", b, sha], root);
    const seen = keptTreePaths(g(["worktree", "list", "--porcelain"], root));
    const found = seen.includes(a) && seen.includes(b);
    const described = describeKept([a]).join("");
    for (const t of [a, b])
      try {
        g(["worktree", "remove", "--force", t], root);
      } catch {}
    const after = keptTreePaths(g(["worktree", "list", "--porcelain"], root));
    return (
      found &&
      described.includes(sha.slice(0, 7)) &&
      !after.includes(a) &&
      !after.includes(b)
    );
  })()
);

const EXPECTED = 38; // +6 for #866's dirty-tree filter; +5 for #1068 argv parsing
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
