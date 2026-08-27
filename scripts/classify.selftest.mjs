#!/usr/bin/env node
/**
 * classify.selftest.mjs — prove CHECK-1 can fail, by MUTATION.
 *
 * WHY MUTATION AND NOT UNIT TESTS.
 * classify.mjs is the census that eject and CHECK-2 are built on. If it is broken it reports a
 * serene green over a broken tree, and every number downstream inherits the lie. Reading the
 * code cannot establish that it fails when it should — only watching it fail can.
 *
 * So each case below takes the REAL manifest and the REAL repo, breaks exactly one thing, and
 * asserts the classifier catches it. One mutation per gate, named for the gate it targets. If
 * a gate is ever silently disabled — an early return, an inverted condition, a swallowed
 * error — its mutation goes green here and this suite fails.
 *
 * This is not hypothetical hygiene. Building this classifier, two of my own gates caught two of
 * my own bugs before any of it reached CI:
 *   - C4 caught globToRegExp compiling `dir/**` to a regex that matched NOTHING, which had
 *     silently zeroed every glob in the manifest.
 *   - C7 caught five real rung files sitting in `shared` (docs/rungs/*.md, the open-swe e2e
 *     specs, two SSE fixtures, deepagents-handler.ts) that `pnpm eject` would have shipped
 *     into a fork that ejected those rungs.
 * A harness that finds its author's bugs is worth more than one that agrees with them.
 *
 * Usage: node scripts/classify.selftest.mjs
 */
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLASSIFY = join(ROOT, "scripts", "classify.mjs");
const REAL = JSON.parse(readFileSync(join(ROOT, "rungs.json"), "utf8"));
const TMP = mkdtempSync(join(tmpdir(), "classify-selftest-"));

/*
 * CLEAN UP EVEN WHEN THIS RUN DOES NOT FINISH.
 *
 * The teardown at the bottom of this file is correct and was never reached by
 * a run that threw or was interrupted — and each abandoned run leaves a full
 * set of worktrees in the OS temp directory. Measured on one machine today:
 *
 *     211M  /…/T/eject-selftest-5pC5Rk   (25 worktrees)
 *     101M  /…/T/eject-selftest-luoRbw   ( 8 worktrees)
 *
 * 312 MB from two interrupted runs, plus 33 stale worktree registrations in
 * the real repo that `git worktree prune` could not clear, because the
 * directories were still there. Nothing reports this; it is only ever found by
 * running out of disk or by counting worktrees for some other reason.
 *
 * A timeout is the ordinary way it happens — this suite spawns a lot of git
 * and is slow enough to be killed by one. SIGKILL still leaks, and nothing in
 * process can change that.
 */
function tearDownSandboxes() {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  try {
    execFileSync("git", ["worktree", "prune"], { cwd: ROOT, stdio: "ignore" });
  } catch {
    /* best effort */
  }
}
process.on("exit", tearDownSandboxes);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    tearDownSandboxes();
    process.exit(130);
  });
}


let pass = 0;
let fail = 0;

/** Run classify.mjs against a (possibly mutated) manifest and optional cwd. Never throws. */
function run(manifest, { cwd } = {}) {
  const path = join(TMP, `m-${Math.abs(hash(JSON.stringify(manifest)))}.json`);
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  try {
    const out = execFileSync("node", [CLASSIFY], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        RUNGS_MANIFEST: path,
        ...(cwd ? { RUNGS_CWD: cwd } : {}),
      },
    });
    return { rc: 0, out };
  } catch (e) {
    return { rc: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++)
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}
/** Deep clone so each mutation starts from a pristine copy of the real manifest. */
const clone = () => JSON.parse(JSON.stringify(REAL));

/** A mutation must be CAUGHT: non-zero exit, and the named gate must be the one that fired. */
function mutationCaught(name, gate, mutate) {
  const m = clone();
  const before = JSON.stringify(m);
  mutate(m);

  /*
   * A MUTATION THAT CHANGED NOTHING IS NOT A SURVIVING MUTATION.
   *
   * Every case below plants an invalid manifest and asserts the checker
   * rejects it. If the edit produces a manifest IDENTICAL to the real one,
   * the checker exits 0 — correctly — and the old code reported
   * "MUTATION SURVIVED, classify.mjs is NOT trustworthy". That accuses the
   * checker of a failure that belongs to the mutation.
   *
   * It is the same distinction we keep finding in the checks themselves: a
   * check that did not fire and a check that had nothing to fire on are
   * opposite facts, and reporting them identically sends whoever reads it to
   * debug the wrong artifact. This bit us for real — "the ragged cell copied
   * to the wrong runtime" became a no-op the moment django gained
   * deep-research, because the two runtimes' lists became equal and copying
   * one onto the other stopped changing anything.
   *
   * Still counted as a failure: a case that proves nothing must not sit green.
   * Only the diagnosis changes.
   */
  if (JSON.stringify(m) === before) {
    console.error(
      `  FAIL ${name.padEnd(56)} MUTATION IS A NO-OP — it no longer alters the manifest`
    );
    console.error(
      `       ${gate} is not implicated. The manifest changed underneath this case:`
    );
    console.error(
      `       the state this mutation was written to create is now the real one.`
    );
    fail++;
    return;
  }

  const { rc, out } = run(m);
  if (rc !== 0 && out.includes(gate)) {
    console.log(`  ok   ${name.padEnd(56)} (caught by ${gate})`);
    pass++;
  } else if (rc !== 0) {
    console.error(`  FAIL ${name.padEnd(56)} failed, but not via ${gate}`);
    console.error(
      `       ${
        out.split("\n").filter((l) => l.startsWith("FAIL"))[0] ??
        out.slice(0, 200)
      }`
    );
    fail++;
  } else {
    console.error(
      `  FAIL ${name.padEnd(56)} MUTATION SURVIVED — ${gate} did not fire`
    );
    fail++;
  }
}

function expectPass(name, mutate = () => {}) {
  const m = clone();
  mutate(m);
  const { rc, out } = run(m);
  if (rc === 0) {
    console.log(`  ok   ${name.padEnd(56)} (exit 0, correctly accepted)`);
    pass++;
  } else {
    console.error(`  FAIL ${name.padEnd(56)} expected 0, got ${rc}`);
    console.error(
      `       ${out.split("\n").filter((l) => l.startsWith("FAIL"))[0] ?? ""}`
    );
    fail++;
  }
}

console.log("classify.mjs self-test — proving CHECK-1 can fail, by mutation\n");

// --- C1: the walk must find a real tree --------------------------------------------------
// A git repo with two files. Without C1, "all zero rung files are classified" passes and the
// whole census is vacuously green — the failure mode ARCHITECT's >10-modules guard prevents.
{
  const empty = join(TMP, "tiny-repo");
  mkdirSync(empty, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: empty });
  writeFileSync(join(empty, "a.txt"), "a");
  execFileSync("git", ["add", "-A"], { cwd: empty });
  const { rc, out } = run(clone(), { cwd: empty });
  if (rc !== 0 && out.includes("C1 walk")) {
    console.log(
      `  ok   ${"tiny tree (walk found almost nothing)".padEnd(
        56
      )} (caught by C1 walk)`
    );
    pass++;
  } else {
    console.error(`  FAIL tiny tree — C1 did not fire (rc=${rc})`);
    fail++;
  }
}

// --- C2: totality --------------------------------------------------------------------------
mutationCaught(
  "a shared path removed -> files unclassified",
  "C2 total",
  (m) => {
    m.shared.paths = m.shared.paths.filter(
      (p) => p !== "packages/**" && p !== "packages/server/**"
    );
  }
);

// --- C3: disjointness ----------------------------------------------------------------------
mutationCaught("two rungs claim the same file", "C3 disjoint", (m) => {
  const victim = m.rungs.find((r) => r.id === "langchain").owns.ts[0];
  m.rungs.find((r) => r.id === "langgraph").owns.ts.push(victim);
});

// --- C4: a glob that matches nothing --------------------------------------------------------
mutationCaught("manifest glob matches nothing (rot)", "C4 glob", (m) => {
  m.rungs[0].owns.ts.push("packages/server/src/adapters/does-not-exist.ts");
});
mutationCaught("shared glob matches nothing (rot)", "C4 glob", (m) => {
  m.shared.paths.push("no/such/dir/**");
});

// --- C5: a `planned` rung that has shipped --------------------------------------------------
mutationCaught("a rung with source is marked planned", "C5 planned", (m) => {
  m.rungs.find((r) => r.id === "open-swe").state = "planned";
});

// --- C6: the frozen census drifts -----------------------------------------------------------
mutationCaught("ownedFileCount too low (under-count)", "C6 census", (m) => {
  m.rungs.find((r) => r.id === "open-swe").ownedFileCount -= 1;
});
mutationCaught("ownedFileCount too high (over-count)", "C6 census", (m) => {
  m.rungs.find((r) => r.id === "deepagents").ownedFileCount += 1;
});

// --- C7: a rung file swallowed by a broad `shared` glob -------------------------------------
// The exact defect #40 introduced: docs/rungs/4-open-swe.md under `docs/**`. Totality does NOT
// catch it — the file is classified, just wrongly — so only C7 stands between that file and a
// fork that ejected rung 4 while still shipping its documentation.
mutationCaught("rung doc falls through to shared", "C7 misfiled", (m) => {
  const r = m.rungs.find((x) => x.id === "open-swe");
  r.owns.docs = [];
  r.ownedFileCount -= 1;
});
mutationCaught("rung e2e spec falls through to shared", "C7 misfiled", (m) => {
  const r = m.rungs.find((x) => x.id === "open-swe");
  const before = r.owns.ts.length;
  r.owns.ts = r.owns.ts.filter((g) => !g.startsWith("e2e/"));
  r.ownedFileCount -= before - r.owns.ts.length;
});
mutationCaught(
  "rung SSE fixture falls through to shared",
  "C7 misfiled",
  (m) => {
    const r = m.rungs.find((x) => x.id === "langchain");
    r.owns.ts = r.owns.ts.filter((g) => !g.includes("__fixtures__"));
    r.ownedFileCount -= 1;
  }
);

// --- C8: the manifest's topology claim must match the Python source -------------------------
// deep-research is the ragged corner of the ladder: deepagents-only, and now on BOTH of its
// runtimes (it was deepagents x fastapi alone until django's RESEARCH_TOOLS gained it). So the
// raggedness is rung-level, not runtime-level, and mutations that relied on two runtimes
// disagreeing no longer alter anything — see the no-op guard in mutationCaught.
// These mutations prove the manifest cannot drift from the six ai_backends modules that define it.
mutationCaught(
  "declares a topology the source does not have",
  "C8 topology",
  (m) => {
    m.rungs
      .find((r) => r.id === "langchain")
      .runtimes.django.topologies.push("deep-research");
  }
);
mutationCaught("omits a topology the source does have", "C8 topology", (m) => {
  const rt = m.rungs.find((r) => r.id === "deepagents").runtimes.fastapi;
  rt.topologies = rt.topologies.filter((t) => t !== "deep-research");
});
mutationCaught(
  "one rung's whole topology list pasted onto another rung",
  "C8 topology",
  (m) => {
    /*
     * This case used to read "the ragged cell copied to the wrong runtime" and
     * gave deepagents x django fastapi's list, which at the time included a
     * deep-research django did not have. It went INERT when django gained
     * deep-research: both runtimes' lists became equal, so copying one onto the
     * other changed nothing and the case accused the checker of missing a
     * mutation that no longer existed. The no-op guard above now names that
     * situation instead of blaming C8.
     *
     * The hazard it was written for is real and outlived the asymmetry: a
     * whole-list paste from a cell that legitimately has a topology onto one
     * that does not. No two RUNTIMES differ today — the ladder is
     * runtime-uniform — so the paste is cross-RUNG, which is where the
     * remaining raggedness lives: deep-research is deepagents-only, and
     * langchain's Python source has no research agent on either runtime.
     *
     * Distinct from "declares a topology the source does not have" above, which
     * appends a single entry. This replaces the list wholesale, which is what an
     * actual copy-paste between manifest blocks looks like.
     */
    m.rungs.find((r) => r.id === "langchain").runtimes.django.topologies = [
      "react",
      "plan-execute",
      "deep-research",
    ];
  }
);
mutationCaught(
  "topologies declared with no source to check",
  "C8 topology",
  (m) => {
    delete m.rungs.find((r) => r.id === "langgraph").runtimes.fastapi
      .topologiesSource;
  }
);
mutationCaught(
  "topologiesSource points at a missing file",
  "C8 topology",
  (m) => {
    m.rungs.find((r) => r.id === "langgraph").runtimes.django.topologiesSource =
      "apps/django-backend/deepagents_backend/ai_backends/gone.py";
  }
);

// --- Positives: the checker must also ACCEPT truth, or it is just `exit 1` in a costume -----
expectPass("the real, unmutated manifest");
expectPass("C7 allowlist genuinely suppresses a false positive", (m) => {
  // Removing the Django project-package exception must NOT be needed for a green run; adding a
  // redundant entry must stay green. Proves the allowlist is a real escape hatch, not decoration.
  m.shared.knownRungNamedSharedPaths.push("docs/NOT-A-REAL-FILE-langchain.md");
});

// --- Non-vacuity of THIS suite --------------------------------------------------------------
/**
 * THE UNTRACKED BLIND SPOT (#224).
 *
 * classify enumerates with `git ls-files`, so an untracked file is invisible — and the moment
 * `pnpm rungs` is most used is exactly the window in which the new file is still untracked.
 * It answered PASS on a branch adding a rung-owned e2e helper, and ten CI jobs went red on the
 * freeze that PASS said was unnecessary.
 *
 * A REAL WORKTREE, not a bare temp dir: classify refuses a tree with fewer than
 * MIN_TRACKED_FILES, so a synthetic two-file repo never reaches the guard and the case would
 * pass without exercising it.
 */
{
  const wt = join(TMP, "wt-untracked");
  let staged = false;
  try {
    execFileSync("git", ["worktree", "add", "--detach", "-f", wt, "HEAD"], {
      cwd: ROOT,
      stdio: "ignore",
    });
    staged = true;
  } catch {
    /* worktree unavailable — reported below rather than silently skipped */
  }

  if (!staged) {
    console.error("  FAIL untracked guard — could not create a worktree to test in");
    fail++;
  } else {
    // Clean tree first: the CONTROL. Without it, a guard that fired unconditionally would
    // satisfy the assertion below while making every real run inconclusive.
    const clean = run(REAL, { cwd: wt });
    const controlOk = clean.rc === 0 && /PASS: classification is total/.test(clean.out);

    writeFileSync(join(wt, "e2e", "rungs", "open-swe", "zz-untracked-probe.ts"), "// probe\n");
    const dirty = run(REAL, { cwd: wt });

    if (
      controlOk &&
      dirty.rc === 2 &&
      /INCONCLUSIVE/.test(dirty.out) &&
      /zz-untracked-probe\.ts/.test(dirty.out)
    ) {
      console.log(
        `  ok   ${"untracked rung-owned file -> INCONCLUSIVE".padEnd(52)} (rc=2, named)`
      );
      pass++;
    } else {
      console.error(
        `  FAIL untracked guard (control rc=${clean.rc} ok=${controlOk}, dirty rc=${dirty.rc}) ` +
          `— exit 2 and the filename are both required`
      );
      fail++;
    }
    try {
      rmSync(wt, { recursive: true, force: true });
      execFileSync("git", ["worktree", "prune"], { cwd: ROOT, stdio: "ignore" });
    } catch {
      /* best effort */
    }
  }
}

const EXPECTED_CASES = 19;
const total = pass + fail;
console.log();
if (total !== EXPECTED_CASES) {
  console.error(
    `FAIL: self-test ran ${total} cases, expected ${EXPECTED_CASES} — the harness itself is broken.\n` +
      `      (If you added or removed a case on purpose, update EXPECTED_CASES.)`
  );
  rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
}
rmSync(TMP, { recursive: true, force: true });
if (fail !== 0) {
  console.error(
    `FAIL: ${fail}/${total} mutations survived or misfired. classify.mjs is NOT trustworthy.`
  );
  process.exit(1);
}
console.log(
  `PASS: ${pass}/${total}. Every gate was watched failing on a deliberate mutation,\n` +
    `      and the unmutated manifest still passes. The census means something.`
);
