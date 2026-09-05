#!/usr/bin/env node
/**
 * Self-test — plants each shape the checker claims to catch.
 *
 * THE BAR THIS HAS TO CLEAR (#749): a planted fourth restriction must be CAUGHT,
 * and the exclusion must be STATED rather than merely absent. Both are here, and
 * so are the two ways this checker was already wrong once.
 *
 * The first version resolved its scope with a character class that could not
 * survive an escaped slash, so it matched zero files, EXCLUDED all three
 * restrictions it exists to count, printed "0 restriction(s) in scope" and
 * exited 0 — then froze {webkit: 0, firefox: 0}. A record of nothing that would
 * have passed forever. REFUSE B below is that defect, planted.
 */
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECKER = join(ROOT, "scripts", "assert-cross-browser-coverage.mjs");
const TMP = realpathSync(mkdtempSync(join(tmpdir(), "cbc-selftest-")));

function tearDown() {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
process.on("exit", tearDown);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    tearDown();
    process.exit(130);
  });
}

let pass = 0;
let fail = 0;
let n = 0;

const CONFIG = `
const CROSS_BROWSER_TESTMATCH = [
  /(^|\\/)hitl\\.spec\\.ts$/,
];
export default {
  projects: [
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
      testMatch: CROSS_BROWSER_TESTMATCH,
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
      testMatch: CROSS_BROWSER_TESTMATCH,
    },
  ],
};
`;

/** A restriction as it really appears: `test.skip(` opens, condition follows. */
const restriction = (cond, issue) => `
  test("case ${n}-${Math.random()
  .toString(36)
  .slice(2, 6)}", async ({ browserName }) => {
    test.skip(
      ${cond},
      "#${issue}: a reason that spans its own line, as they all do"
    );
  });
`;

function sandbox({ config = CONFIG, hitl = "", matrix = null, frozen }) {
  const dir = join(TMP, `wt-${n++}`);
  mkdirSync(join(dir, "e2e", "matrix"), { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "playwright.config.ts"), config);
  writeFileSync(
    join(dir, "e2e", "hitl.spec.ts"),
    hitl || "// no restrictions\n"
  );
  if (matrix)
    writeFileSync(join(dir, "e2e", "matrix", "adapter.spec.ts"), matrix);
  if (frozen !== undefined)
    writeFileSync(
      join(dir, "scripts", "cross-browser-coverage.json"),
      JSON.stringify(frozen, null, 2)
    );
  return dir;
}

function run(dir, extra = []) {
  try {
    const out = execFileSync(
      process.execPath,
      [CHECKER, "--cwd", dir, ...extra],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    return { rc: 0, out };
  } catch (e) {
    return { rc: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  ok   ${name.padEnd(66)} ${detail}`);
  } else {
    fail++;
    console.log(`  FAIL ${name.padEnd(66)} ${detail}`);
  }
}

console.log("assert-cross-browser-coverage self-test — plants each shape\n");

const THREE =
  restriction('browserName !== "chromium"', 675) +
  restriction('browserName === "webkit"', 114) +
  restriction('browserName === "webkit"', 114);
const FROZEN_THREE = {
  engines: { webkit: 3, firefox: 1 },
  issues: { 114: 2, 675: 1 },
};

// --- ACCEPT: the recorded state passes -------------------------------------
{
  const r = run(sandbox({ hitl: THREE, frozen: FROZEN_THREE }));
  check(
    "the frozen state passes",
    r.rc === 0,
    r.rc === 0 ? "(accepted)" : `(rc=${r.rc} — refuses its own subject)`
  );
}

// --- REJECT A: THE BAR — a planted fourth restriction is caught -------------
{
  const r = run(
    sandbox({
      hitl: THREE + restriction('browserName === "webkit"', 999),
      frozen: FROZEN_THREE,
    })
  );
  const named = /engine webkit: frozen 3 -> observed 4/.test(r.out ?? "");
  check(
    "THE BAR: a fourth restriction is CAUGHT, and the engine is named",
    r.rc === 1 && named,
    named
      ? "(caught: webkit 3 -> 4)"
      : `(rc=${r.rc}; engine not named in output)`
  );
}

// --- REJECT B: the unit — one restriction, TWO numbers ----------------------
{
  /*
   * The ruling's core point. A count of RESTRICTIONS cannot express this: adding
   * one `!== "chromium"` costs webkit AND firefox, and the restriction that does
   * it reads as a single decision whose stated reason mentions only webkit —
   * which is how the existing one got there.
   */
  const r = run(
    sandbox({
      hitl: THREE + restriction('browserName !== "chromium"', 777),
      frozen: FROZEN_THREE,
    })
  );
  const both =
    /engine webkit: frozen 3 -> observed 4/.test(r.out ?? "") &&
    /engine firefox: frozen 1 -> observed 2/.test(r.out ?? "");
  check(
    "one restriction that costs two engines moves BOTH numbers",
    r.rc === 1 && both,
    both
      ? "(webkit 3->4 AND firefox 1->2)"
      : `(rc=${r.rc}; only one number moved)`
  );
}

// --- REJECT C: a quarantine SPREADING, with the engine totals unchanged -----
{
  /*
   * The per-issue tally earning its place. Re-attributing an existing
   * restriction from #675 to #114 leaves webkit 3 / firefox 1 EXACTLY as frozen
   * — a per-engine check alone sees nothing — while #114 goes 2 -> 3. "A
   * quarantine is spreading" and "a new skip appeared" are different alarms.
   */
  const spread =
    restriction('browserName !== "chromium"', 114) +
    restriction('browserName === "webkit"', 114) +
    restriction('browserName === "webkit"', 114);
  const r = run(sandbox({ hitl: spread, frozen: FROZEN_THREE }));
  const engineFlat = !/engine (webkit|firefox):/.test(r.out ?? "");
  const issueMoved = /issue #114: frozen 2 -> observed 3/.test(r.out ?? "");
  check(
    "a re-attributed restriction moves the ISSUE tally with engines flat",
    r.rc === 1 && engineFlat && issueMoved,
    issueMoved
      ? `(#114 2->3, engines unchanged=${engineFlat})`
      : `(rc=${r.rc}; the issue tally did not move)`
  );
}

// --- STATED: the exclusion is printed, not merely unmatched -----------------
{
  const r = run(
    sandbox({
      hitl: THREE,
      matrix: restriction(
        'browserName === "chromium" && page.viewportSize()?.width === 412',
        0
      ),
      frozen: FROZEN_THREE,
    })
  );
  const stated = /EXCLUDED .*adapter\.spec\.ts/.test(r.out ?? "");
  const reasoned = /not matched by CROSS_BROWSER_TESTMATCH/.test(r.out ?? "");
  check(
    "an out-of-scope restriction is STATED as excluded, with the reason",
    r.rc === 0 && stated && reasoned,
    stated && reasoned
      ? "(named, with the reason)"
      : `(rc=${r.rc} stated=${stated} reasoned=${reasoned} — silence is not an exclusion)`
  );
}

// --- THE TRAP: multi-line calls are counted --------------------------------
{
  /*
   * `grep -cE 'test\\.(skip|fixme)\\(.*browserName'` returns 0 on every one of
   * these, because the condition is on the next line. A line-wise checker would
   * report a clean tree here and freeze zeroes.
   */
  const r = run(
    sandbox({
      hitl: THREE,
      frozen: { engines: { webkit: 0, firefox: 0 }, issues: {} },
    })
  );
  const sawThem = /engine webkit: frozen 0 -> observed 3/.test(r.out ?? "");
  check(
    "multi-line restrictions are counted, not missed by a line-wise scan",
    r.rc === 1 && sawThem,
    sawThem ? "(observed 3 across a continuation)" : `(rc=${r.rc}; saw none)`
  );
}

// --- REFUSE A: a condition the checker cannot read -------------------------
{
  const r = run(
    sandbox({
      hitl: restriction(
        'browserName === "webkit" || process.env.CI === "true"',
        1
      ),
      frozen: FROZEN_THREE,
    })
  );
  check(
    "an unreadable condition REFUSES rather than counting zero engines",
    r.rc === 2 && /cannot read the condition/.test(r.out ?? ""),
    r.rc === 2
      ? "(refused — could not ask)"
      : `(rc=${r.rc}; guessed at a compound condition)`
  );
}

// --- REFUSE B: this checker's own first defect, planted --------------------
{
  /*
   * The scope resolving to nothing. Its first version did this for real: the
   * patterns matched no files, every restriction fell into "excluded", and it
   * exited 0 having counted nothing.
   */
  // ASSERT THE SUBSTITUTION TOOK. The first version of this case searched for
  // two backslashes where the template literal has one, so `replace` was a
  // silent no-op returning an UNCHANGED config — the case then ran against a
  // healthy scope and reported rc=0, which reads as "the guard does not fire".
  // A fixture that fails to plant its defect is indistinguishable from a checker
  // that cannot catch it, and only checking the EFFECT separates them.
  const broken = CONFIG.replace("hitl\\.spec\\.ts", "no-such-file\\.spec\\.ts");
  if (broken === CONFIG) {
    console.error("  FIXTURE ERROR: the config substitution matched nothing.");
    process.exit(1);
  }
  const r = run(sandbox({ config: broken, hitl: THREE, frozen: FROZEN_THREE }));
  check(
    "a scope matching NO files refuses, rather than reporting zeroes",
    r.rc === 2 && /never read/.test(r.out ?? ""),
    r.rc === 2
      ? "(refused — the defect this file shipped with once)"
      : `(rc=${r.rc}; zeroes about nothing)`
  );
}

// --- REFUSE C: no frozen record at all -------------------------------------
{
  const r = run(sandbox({ hitl: THREE }));
  check(
    "an absent frozen record refuses and says how to create one",
    r.rc === 2 && /--freeze/.test(r.out ?? ""),
    r.rc === 2 ? "(refused)" : `(rc=${r.rc})`
  );
}

const total = pass + fail;
if (fail) {
  console.error(
    `\nFAIL: ${fail}/${total} cases wrong. The checker is NOT trustworthy.`
  );
  process.exit(1);
}
console.log(
  `\nPASS: ${pass}/${total}. A planted fourth restriction is caught and its engine named, a\n` +
    "      restriction costing two engines moves two numbers, a re-attributed one moves the\n" +
    "      issue tally with engines flat, and the out-of-scope case is STATED rather than\n" +
    "      silently unmatched."
);
