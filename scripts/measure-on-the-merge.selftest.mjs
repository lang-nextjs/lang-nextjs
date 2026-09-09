#!/usr/bin/env node
/**
 * measure-on-the-merge.selftest.mjs — proof for #922's instrument.
 *
 * TWO HALVES, AND ONLY ONE OF THEM NEEDS A REPOSITORY. `classifyExit` is pure, so every exit
 * state is driven directly rather than by spawning a process that happens to exit that way --
 * including the states a live run would almost never produce. `materialiseMerge` needs real git,
 * so it gets a real repository built here in `tmpdir()`, never the checkout this file lives in.
 *
 * WHY THE FIXTURE REPOSITORY IS BUILT AND NOT BORROWED. A proof that merged two refs of THIS
 * repository would pass or fail according to what landed on main this morning, which is the
 * defect the tool exists to fix, reproduced in its own proof.
 */
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyExit } from "./measure-on-the-merge.mjs";
import {
  materialiseMerge,
  describe,
  REFUSAL,
  cleanup,
} from "./lib/merged-tree.mjs";
import { probeWorktrees } from "./lib/probe-worktrees.mjs";

/*
 * THE VERDICT COMES FROM AN EXIT HOOK, AND THIS FILE NEVER CALLS `process.exit` (#1122).
 *
 * A file ending in `process.exit(...)` has a position past which an appended arm is DEAD, and a
 * dead arm contributes nothing while the suite reports the same green. #1145's ratchet caught this
 * file the first time it could see it — it was the first new selftest after that gate landed, and
 * it had the defect.
 *
 * MOVING ONLY THE COUNT GUARD INTO A HOOK IS NOT ENOUGH: `eject-subject-audit.selftest.mjs` does
 * exactly that under #1119 and still probes `inert`, because it still exits. The property is that
 * there is NO statement after which an `ok()` stops counting, which requires the exit call to be
 * absent rather than relocated.
 *
 * EXPECTED IS DECLARED SO A LOST ARM IS ALSO VISIBLE. The hook catches an arm appended below the
 * verdict; the count catches one deleted from anywhere. They are different failures and neither
 * subsumes the other.
 */
const results = [];
const EXPECTED = 23;
const ok = (label, cond, got) => {
  results.push({ ok: Boolean(cond), name: label, got });
};

process.exitCode = 0;
process.on("exit", () => {
  for (const r of results)
    process.stdout.write(
      `  ${r.ok ? "ok  " : "FAIL"} ${r.name}` +
        (r.ok ? "" : ` — got ${JSON.stringify(r.got)}`) +
        "\n"
    );
  const failed = results.filter((r) => !r.ok);
  process.stdout.write(
    `\n  ${results.length - failed.length}/${results.length} passed\n`
  );
  if (results.length !== EXPECTED)
    process.stderr.write(
      `\nFAIL: ran ${results.length} arm(s), expected ${EXPECTED} — ` +
        "an arm was added or lost.\n"
    );
  if (failed.length > 0 || results.length !== EXPECTED) process.exitCode = 1;
});

/* ── classifyExit: pure, so every state is reachable ─────────────────────────── */

ok(
  "status 0 is a PASS",
  classifyExit({ status: 0 }).exit === 0,
  classifyExit({ status: 0 })
);
ok(
  "status 1 is a VIOLATION and says so, because a reader acts on this word",
  classifyExit({ status: 1 }).exit === 1 &&
    /VIOLATED/.test(classifyExit({ status: 1 }).detail),
  classifyExit({ status: 1 })
);
ok(
  "status 2 stays a REFUSAL rather than collapsing into a violation",
  classifyExit({ status: 2 }).exit === 2 &&
    /REFUSED/.test(classifyExit({ status: 2 }).detail),
  classifyExit({ status: 2 })
);

/*
 * THE ARM THAT EARNS THE MAPPING. 127 is a missing executable. Forwarding it unchanged would
 * report a TYPO IN THE COMMAND as a violated property -- an argument against a change, sourced
 * from a shell error. 128 is `git rev-parse` on a bad ref, which is how I got this wrong by hand
 * while testing the tool: I asserted a failing command exits 1, and git exits 128.
 */
for (const s of [127, 128, 3, 255]) {
  const r = classifyExit({ status: s });
  ok(
    `status ${s} is OUTSIDE the convention, so it refuses (2) rather than reporting a violation`,
    r.exit === 2 &&
      new RegExp(String(s)).test(r.detail) &&
      /convention/.test(r.detail),
    r
  );
}

ok(
  "THE COMPANION: 0, 1 and 2 are the ONLY statuses that pass through, so the mapping cannot " +
    "quietly widen",
  [...Array(256).keys()].every((s) =>
    [0, 1, 2].includes(s)
      ? classifyExit({ status: s }).exit === s
      : classifyExit({ status: s }).exit === 2
  ),
  [...Array(256).keys()].filter(
    (s) => ![0, 1, 2].includes(s) && classifyExit({ status: s }).exit !== 2
  )
);

ok(
  "a SIGNAL is a refusal — a killed command did not answer",
  classifyExit({ signal: "SIGKILL" }).exit === 2,
  classifyExit({ signal: "SIGKILL" })
);
ok(
  "a spawn ERROR is a refusal and names the cause, not a violation",
  classifyExit({ error: new Error("ENOENT") }).exit === 2 &&
    /ENOENT/.test(classifyExit({ error: new Error("ENOENT") }).detail),
  classifyExit({ error: new Error("ENOENT") })
);
ok(
  "an error OUTRANKS a status, so a crash that also set a code cannot read as a finding",
  classifyExit({ status: 1, error: new Error("boom") }).exit === 2,
  classifyExit({ status: 1, error: new Error("boom") })
);

/* ── materialiseMerge: a real repository, built here ──────────────────────────── */

function withRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), "motfix-"));
  const g = (...a) =>
    execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
  try {
    g("init", "-q", "-b", "main");
    g("config", "user.email", "t@local");
    g("config", "user.name", "t");
    writeFileSync(join(dir, "shared.txt"), "base\n");
    g("add", "-A");
    g("commit", "-q", "-m", "root");
    const root = g("rev-parse", "HEAD");
    return fn({ dir, g, root });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

withRepo(({ dir, g, root }) => {
  // two branches touching DIFFERENT files: a clean merge
  g("checkout", "-q", "-b", "feature");
  writeFileSync(join(dir, "only-on-feature.txt"), "f\n");
  g("add", "-A");
  g("commit", "-q", "-m", "feature");
  const head = g("rev-parse", "HEAD");
  g("checkout", "-q", "main");
  writeFileSync(join(dir, "only-on-main.txt"), "m\n");
  g("add", "-A");
  g("commit", "-q", "-m", "main moves");
  const base = g("rev-parse", "HEAD");

  const before = g("worktree", "list").split("\n").length;
  const r = materialiseMerge({ base, head, prefix: "mot-", cwd: dir });
  ok("a clean merge materialises", r.ok === true, r.ok ? "ok" : r);

  ok(
    "THE POINT OF THE TOOL: the merged tree carries BOTH sides, so a property measured here is " +
      "measured on neither parent alone",
    r.ok &&
      existsSync(join(r.dir, "only-on-feature.txt")) &&
      existsSync(join(r.dir, "only-on-main.txt")),
    r.ok && {
      feature: existsSync(join(r.dir, "only-on-feature.txt")),
      main: existsSync(join(r.dir, "only-on-main.txt")),
    }
  );
  ok(
    "both parents are reported, because a merge result without its inputs is unattributable",
    r.ok && r.baseSha === base && r.headSha === head,
    r.ok && { baseSha: r.baseSha, headSha: r.headSha }
  );

  const d = describe(r);
  ok(
    "describe() names both shas AND states its own expiry, so a pasted result carries its scope",
    d.includes(head.slice(0, 12)) &&
      d.includes(base.slice(0, 12)) &&
      /expires|re-taken/.test(d),
    d
  );

  const dirPath = r.dir;
  r.cleanup();
  ok(
    "cleanup removes BOTH halves — the directory AND git's admin entry, which is the residue a " +
      "worktree-counting checker sees (#1166)",
    !existsSync(dirPath) && g("worktree", "list").split("\n").length === before,
    { dirGone: !existsSync(dirPath), listed: g("worktree", "list") }
  );
});

withRepo(({ dir, g }) => {
  // both branches edit the SAME line: a conflict
  g("checkout", "-q", "-b", "feature");
  writeFileSync(join(dir, "shared.txt"), "feature\n");
  g("add", "-A");
  g("commit", "-q", "-m", "feature edits shared");
  const head = g("rev-parse", "HEAD");
  g("checkout", "-q", "main");
  writeFileSync(join(dir, "shared.txt"), "main\n");
  g("add", "-A");
  g("commit", "-q", "-m", "main edits shared");
  const base = g("rev-parse", "HEAD");

  const r = materialiseMerge({ base, head, prefix: "mot-", cwd: dir });
  ok(
    "a CONFLICT is a refusal, not a finding — `could not ask` and `the answer is no` are the two " +
      "states this exists to keep apart",
    r.ok === false && r.refusal === REFUSAL.CONFLICT,
    r
  );
  ok(
    "and the conflict refusal still names both shas, so it is attributable",
    r.baseSha === base && r.headSha === head,
    { baseSha: r.baseSha, headSha: r.headSha }
  );
  /*
   * COUNTED BY PATH, NOT BY GREPPING A LISTING (#815, lib/probe-worktrees.mjs). The first version
   * of this arm asserted `!list.includes("mot-")` and FAILED against a correct implementation:
   * the fixture repository is itself a `mot-...` directory and appears in its own worktree list.
   * The prefixes are now disjoint (`motfix-` for the fixture, `mot-` for probes) AND the count
   * comes from the porcelain form, because either fix alone leaves the other confound live.
   */
  ok(
    "a conflicted merge leaves NO probe worktree behind — nothing was created to leak",
    probeWorktrees(g("worktree", "list", "--porcelain"), "mot-").length === 0,
    g("worktree", "list", "--porcelain")
  );
});

withRepo(({ dir, g, root }) => {
  const bad = materialiseMerge({
    base: root,
    head: "no-such-ref",
    prefix: "mot-",
    cwd: dir,
  });
  ok(
    "an unresolvable HEAD refuses and says which side is missing",
    bad.ok === false &&
      bad.refusal === REFUSAL.UNRESOLVABLE &&
      /head/.test(bad.message),
    bad
  );
  const bad2 = materialiseMerge({
    base: "no-such-ref",
    head: root,
    prefix: "mot-",
    cwd: dir,
  });
  ok(
    "an unresolvable BASE refuses too, and names the base rather than the head",
    bad2.ok === false &&
      bad2.refusal === REFUSAL.UNRESOLVABLE &&
      /base/.test(bad2.message),
    bad2
  );
  ok(
    "THE COMPANION: a resolvable pair does NOT refuse, so the guard is not refusing everything",
    materialiseMerge({ base: root, head: root, prefix: "mot-", cwd: dir })
      .ok === true,
    materialiseMerge({ base: root, head: root, prefix: "mot-", cwd: dir })
  );
  cleanup(
    join(dir, "unused"),
    dir
  ); /* cleanup of a path that was never added must not throw */
  ok(
    "cleanup of a never-created worktree is a no-op rather than a throw",
    true,
    "no throw"
  );
});
