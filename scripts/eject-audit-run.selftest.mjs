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
} from "./eject-audit-run.mjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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

const EXPECTED = 21; // +6 for #866's dirty-tree filter
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
