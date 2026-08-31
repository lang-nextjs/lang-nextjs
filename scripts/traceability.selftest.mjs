#!/usr/bin/env node
/**
 * Selftest for traceability.mjs.
 *
 * Plants each defect the checker claims to catch, in a throwaway copy, and asserts a NON-ZERO
 * exit. Every case also asserts the mutation ACTUALLY LANDED before running the checker — a
 * mutation that silently fails to apply proves nothing, and this repo has been bitten by that
 * more than once.
 *
 * The cases that matter most are the two vacuity ones. A link checker that validates only the
 * rows which happen to carry a citation passes cleanly on a file with zero citations, and a
 * parse that matches nothing passes on everything. Either would ship as a decoration.
 */
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const CHECKER = join(HERE, "traceability.mjs");
const PROJECT_REL = ".planning/PROJECT.md";

let failures = 0;
const ok = (n) => console.log(`  PASS  ${n}`);
const bad = (n, why) => {
  console.error(`  FAIL  ${n}\n        ${why}`);
  failures += 1;
};
/*
 * A HOLE IS NOT A PASS, AND IT IS NOT A FAILURE. It is a case whose SUBJECT does not currently
 * exist, so it can neither confirm nor deny — and the honest report is to name it rather than
 * go quietly green or red a correct tree.
 *
 * This is the rule run-checks.mjs already applies to channel-skipped checks: "A SKIP IS NOT A
 * PASS. It is recorded with its own status, counted separately, and announced." Same reasoning
 * here: a suite that sums holes into passes reports a number overstating what it examined,
 * which is the family this file exists to catch.
 */
let holes = 0;
const hole = (n, why) => {
  console.log(`  HOLE  ${n}\n        ${why}`);
  holes += 1;
};

/*
 * THE CITED ARTIFACTS ARE PART OF THE FIXTURE (#504).
 *
 * This copied PROJECT.md and nothing else, which was sufficient for exactly as long as no row
 * named an external file: the checker resolves `join(ROOT, relPath)`, so against a temp root
 * holding one file EVERY citation is unresolvable. The first citation ever added turned the
 * baseline case red, and the harness had never been wrong — it had never been exercised.
 *
 * Note which cases kept passing, because it is the whole lesson: "a citation naming a file
 * that does not exist FAILS" and "a citation naming a test the file lacks FAILS" both passed
 * throughout. They only need the citation to be UNRESOLVABLE, which the temp root guaranteed.
 * So this suite could prove the checker REJECTS a bad citation and could never prove it
 * ACCEPTS a good one, and nothing could reveal that until a good one existed.
 *
 * Copying the cited files — rather than the repo — keeps the fixture minimal and
 * self-maintaining: it copies exactly what the current PROJECT.md cites, so the next citation
 * needs no change here.
 */
const CITE_G = /verified by `([^`]+)` "([^"]+)"/g;

/*
 * The checker owns this pattern; this is a second copy and therefore a thing that can drift.
 * Assert the checker's source still contains the identical literal, so a change there fails
 * HERE rather than silently making the fixture copy the wrong set. Two declarations of one
 * fact, with something asserting they agree.
 */
{
  const literal = '/verified by `([^`]+)` "([^"]+)"/';
  if (!readFileSync(CHECKER, "utf8").includes(literal))
    throw new Error(
      `traceability.mjs no longer contains the CITE literal this harness copies:\n  ${literal}\n` +
        `Update CITE_G here to match, or the fixture will copy the wrong files and every ` +
        `citation case becomes vacuous.`,
    );
}

/** Repo-relative paths named by a citation in the given PROJECT.md text. */
function citedPaths(projectText) {
  return [...projectText.matchAll(CITE_G)].map((m) => m[1]);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "trace-"));
  mkdirSync(join(root, ".planning"), { recursive: true });
  cpSync(join(REPO, PROJECT_REL), join(root, PROJECT_REL));
  for (const rel of citedPaths(readFileSync(join(REPO, PROJECT_REL), "utf8"))) {
    const src = join(REPO, rel);
    if (!existsSync(src)) continue; // a genuinely broken citation is the checker's to report
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    cpSync(src, join(root, rel));
  }
  return root;
}
function run(root) {
  try {
    execFileSync("node", [CHECKER, "--root", root], {
      encoding: "utf8",
      stdio: "pipe",
    });
    return { code: 0, out: "" };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

/*
 * THE RETRACTED_TICKS CASES FOLLOW THE LIST, NOT A NAME THAT WAS ONCE IN IT.
 *
 * Both cases below hardcoded PKG-04. That worked while PKG-04 was a listed ✓ row and broke the
 * moment the row was retired (#510) — not by failing usefully, but by mutating nothing, which
 * the harness correctly reports as proving nothing. Reading the set from the checker keeps them
 * pointed at whatever is actually listed.
 *
 * AND WHEN THE SET IS EMPTY THEY EXERCISE NOTHING, WHICH IS SAID RATHER THAN SKIPPED QUIETLY.
 * RETRACTED_TICKS only ever shrinks, so empty is its expected end state, and at that point the
 * staleness arms it guards have no case proving they still work. That is a real gap and it
 * belongs to whoever owns the mechanism (#512) — not to a silent green here.
 */
function retractedIds() {
  const m = /const RETRACTED_TICKS = new Set\(\[(.*?)\]\)/s.exec(
    readFileSync(CHECKER, "utf8"),
  );
  if (!m)
    throw new Error(
      "traceability.mjs no longer declares RETRACTED_TICKS as a Set literal",
    );
  return [...m[1].matchAll(/"([A-Z0-9]+-[0-9]+)"/g)].map((x) => x[1]);
}

function withFixture(name, mutate, expect) {
  const root = fixture();
  try {
    const m = mutate(root);
    if (m && typeof m === "object" && m.hole) return hole(name, m.hole);
    if (m === false)
      return bad(name, "MUTATION DID NOT APPLY — the case proves nothing");
    const { code, out } = run(root);
    // `expect` may be "pass"/"fail", or {fail: "substring"} to also pin WHAT IT SAID. A case
    // that only pins the exit code cannot tell a diagnostic apart from a bare refusal, and for
    // the duplicate-id interaction the message IS the fix — the failure already existed.
    const want = typeof expect === "string" ? expect : "fail";
    if (want === "fail" && code === 0)
      return bad(name, "checker exited 0; it cannot detect this");
    if (want === "pass" && code !== 0)
      return bad(name, `checker exited ${code}:\n${out}`);
    if (typeof expect === "object" && !out.includes(expect.fail))
      return bad(
        name,
        `it failed, but said nothing about the cause. Expected to find:\n        ${expect.fail}\n        got:\n${out}`,
      );
    ok(name);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
/**
 * Like withFixture("fail"), but asserts WHICH check fired.
 *
 * Added because three cases below passed against a checker with the check they name REMOVED —
 * a planted row is uncited and duplicated and self-retracting all at once, so an exit code
 * alone cannot say which rule caught it. Attribution is the difference between a case that
 * tests a rule and a case that tests the file being malformed.
 */
function withFixtureSaying(name, mutate, needle) {
  const root = fixture();
  try {
    const m = mutate(root);
    if (m && typeof m === "object" && m.hole) return hole(name, m.hole);
    if (m === false)
      return bad(name, "MUTATION DID NOT APPLY — the case proves nothing");
    const { code, out } = run(root);
    if (code === 0) return bad(name, "checker exited 0; it cannot detect this");
    if (!out.includes(needle))
      return bad(
        name,
        `checker failed for a DIFFERENT reason — no "${needle}" in:\n${out}`,
      );
    ok(name);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const readP = (root) => readFileSync(join(root, PROJECT_REL), "utf8");
const writeP = (root, s) => writeFileSync(join(root, PROJECT_REL), s);

console.log("traceability selftest");

withFixture("the tree as it stands passes", () => true, "pass");

/*
 * THE POSITIVE CONTROL FOR THE CITATION PATH, absent until #504 and the reason it shipped.
 * The three existing citation cases are all REJECTIONS — broken path, missing test name, stale
 * allowlist. A suite made only of rejection cases can be satisfied by a checker that rejects
 * everything, and by a harness in which nothing resolves.
 */
withFixture(
  "a GOOD citation passes, with the cited file actually present in the fixture",
  (root) => {
    const cites = citedPaths(readFileSync(join(root, PROJECT_REL), "utf8"));
    // Vacuity: with zero citations this case asserts nothing, so it must REFUSE, not pass.
    if (cites.length === 0) return false;
    return cites.every((rel) => existsSync(join(root, rel)));
  },
  "pass",
);

/*
 * ...and the companion that proves the case above passes BECAUSE of the copy. Delete the cited
 * file while leaving the citation intact — distinct from the broken-path case, which mutates
 * the citation instead. This is the exact state the harness was in before #504, so it fails
 * here or the fix is not proven.
 */
/*
 * THE DUPLICATE-ID / UNCITED INTERACTION (#504 follow-up, found by DEV5 before it cost a round).
 *
 * A duplicated id is either fully cited or fully allowlisted, never half, and the failure you
 * get for the half state names an ID YOU JUST CITED. This pins the DIAGNOSTIC, not the failure
 * — the failure already existed and was the confusing part. If the explanation is ever dropped
 * from the checker, this goes red rather than the interaction going quiet again.
 */
withFixture(
  "citing ONE row of a duplicated id explains that the other rows must be cited too",
  (root) => {
    const P = join(root, PROJECT_REL);
    const before = readFileSync(P, "utf8");
    // Cite exactly one of ADAPT-03's two rows, against a file the fixture HAS — an
    // unresolvable path would fail for a different reason and mask the one under test.
    //
    // This is the FIRST error an author meets: they cite one row and get STALE ALLOWLIST.
    // Deleting the entry then produces the confusing second error, and that arm is not
    // reachable here because UNCITED is a const in the checker, not fixture state. Pinning the
    // first message is what matters anyway — it is where the reader still has a choice.
    const after = before.replace(
      /^(- ✓ \*\*ADAPT-03\*\* \(v1\.5\)[^\n]*?) — v1\.5$/m,
      `$1 — verified by \`${PROJECT_REL}\` "ADAPT-03" — v1.5`,
    );
    if (after === before) return false;
    writeFileSync(P, after);
    return true;
  },
  { fail: "THERE IS NO PARTIAL STATE THAT PASSES" },
);

withFixture(
  "deleting the cited file makes a correct citation fail — the copy is what makes it pass",
  (root) => {
    const cites = citedPaths(readFileSync(join(root, PROJECT_REL), "utf8"));
    if (cites.length === 0) return false;
    const victim = join(root, cites[0]);
    if (!existsSync(victim)) return false;
    unlinkSync(victim);
    return !existsSync(victim);
  },
  "fail",
);

// ── TOTALITY: a NEW uncited ✓ row must fail, even though every existing row is allowlisted ──
withFixture(
  "a new uncited ✓ row FAILS (totality, not just present-citation validation)",
  (root) => {
    const s = readP(root);
    writeP(
      root,
      s + "\n- ✓ **NEW-99** — a claim nobody linked to a test — v9.9\n",
    );
    return readP(root).includes("NEW-99");
  },
  "fail",
);

// ── a citation that points at nothing ───────────────────────────────────────────────────
withFixture(
  "a citation naming a file that does not exist FAILS",
  (root) => {
    const s = readP(root);
    writeP(
      root,
      s +
        '\n- ✓ **NEW-98** — x — v9.9 — verified by `packages/server/src/no-such-file.test.ts` "nope"\n',
    );
    return readP(root).includes("no-such-file");
  },
  "fail",
);

// ── a citation to a real file that lacks the named test ─────────────────────────────────
withFixture(
  "a citation naming a test the file does NOT contain FAILS",
  (root) => {
    // Copy a real test file in so the path resolves and only the NAME is wrong. Without this
    // the case would pass for the wrong reason — a missing file, not a missing test.
    mkdirSync(join(root, "packages/server/src"), { recursive: true });
    cpSync(
      join(REPO, "packages/server/src/approval-registry.test.ts"),
      join(root, "packages/server/src/approval-registry.test.ts"),
    );
    const s = readP(root);
    writeP(
      root,
      s +
        '\n- ✓ **NEW-97** — x — v9.9 — verified by `packages/server/src/approval-registry.test.ts` "a test name that is definitely not in there"\n',
    );
    return readP(root).includes("NEW-97");
  },
  "fail",
);

// ── G1: a parse that matches nothing must not report success ────────────────────────────
withFixture(
  "an unparseable PROJECT.md FAILS rather than passing vacuously",
  (root) => {
    writeP(root, "# PROJECT\n\nno requirement rows here at all\n");
    return !readP(root).includes("✓");
  },
  "fail",
);

// ── G2: a NEW duplicate (not one of the two allowlisted) must be refused ────────────────
withFixture(
  "a newly duplicated id FAILS",
  (root) => {
    const s = readP(root);
    const line = s.split("\n").find((l) => l.startsWith("- ✓ **SRV-01**"));
    writeP(root, s + "\n" + line + "\n");
    return (readP(root).match(/\*\*SRV-01\*\*/g) || []).length === 2;
  },
  "fail",
);

// ── G3: a backfilled row makes its allowlist entry stale ────────────────────────────────
withFixture(
  "citing an allowlisted row makes its UNCITED entry STALE and FAILS",
  (root) => {
    // The delete-me property: the allowlist must shrink as rows are backfilled, and the
    // checker must say so rather than silently tolerating a now-unnecessary exemption.
    mkdirSync(join(root, "packages/server/src"), { recursive: true });
    cpSync(
      join(REPO, "packages/server/src/approval-registry.test.ts"),
      join(root, "packages/server/src/approval-registry.test.ts"),
    );
    const name = readFileSync(
      join(REPO, "packages/server/src/approval-registry.test.ts"),
      "utf8",
    ).match(/it\("([^"]{10,60})"/)?.[1];
    if (!name) return false;
    const s = readP(root);
    const out = s.replace(
      /^(- ✓ \*\*SRV-01\*\*.*)$/m,
      `$1 — verified by \`packages/server/src/approval-registry.test.ts\` "${name}"`,
    );
    writeP(root, out);
    return out !== s;
  },
  "fail",
);

/*
 * RETRACTED TICKS (#510) — a ✓ row whose own prose denies it.
 *
 * THE SUBJECTS ARE CONSTRUCTED, NOT THE TWO REAL ROWS. PKG-03 and PKG-04 are PRODUCT's to
 * repair, and the honest repair removes the tick — deleting the only live instance. A guard
 * whose only test is "does it flag the two rows that exist today" stops examining anything the
 * moment it succeeds at its purpose. These plant their own subject, so the ordering of the two
 * fixes does not matter.
 *
 * AND EACH ASSERTS WHICH RULE FIRED. The first draft of these did not, and all three passed
 * against a checker with the retraction check deleted: a planted ✓ row is also uncited, so the
 * pre-existing totality rule failed it and the case looked green for a reason that had nothing
 * to do with #510.
 */
withFixtureSaying(
  "a NEW self-retracting ✓ row is refused — and refused AS a retraction",
  (root) => {
    // CITED on purpose, so the totality rule cannot be what fails it. The only thing left
    // that can object is the retraction.
    mkdirSync(join(root, "packages/server/src"), { recursive: true });
    cpSync(
      join(REPO, "packages/server/src/approval-registry.test.ts"),
      join(root, "packages/server/src/approval-registry.test.ts"),
    );
    const name = readFileSync(
      join(REPO, "packages/server/src/approval-registry.test.ts"),
      "utf8",
    ).match(/it\("([^"]{10,60})"/)?.[1];
    if (!name) return false;
    const s = readP(root);
    const out = s.replace(
      /^(- ✓ \*\*SRV-01\*\*.*)$/m,
      `$1\n- ✓ **ZZZ-99** — a thing — v1.0 *(nothing runs it, so nothing passes it)* — verified by \`packages/server/src/approval-registry.test.ts\` "${name}"`,
    );
    writeP(root, out);
    return out !== s;
  },
  "RETRACTED TICK: ZZZ-99",
);

/*
 * The other direction, and what keeps the exception list from becoming a mute button: when a
 * listed row is repaired its entry must go STALE and say so. Both repairs are covered, because
 * they are different edits and only one of them is the honest one.
 */
withFixtureSaying(
  "rewriting a listed row so it no longer retracts makes its entry STALE",
  (root) => {
    const s = readP(root);
    const [id] = retractedIds();
    if (!id)
      return {
        hole: "RETRACTED_TICKS is EMPTY, so no listed row exists to mutate. This arm of the staleness guard currently has no case proving it works: the mechanism has outlived its last member (#510, #512).",
      };
    const out = s.replace(
      new RegExp(`^(- ✓ \\*\\*${id}\\*\\*).*$`, "m"),
      "$1 — a row that no longer retracts itself — v1.0",
    );
    writeP(root, out);
    return out !== s;
  },
  "delete it from RETRACTED_TICKS",
);

withFixtureSaying(
  "removing the tick from a listed row makes its entry STALE",
  (root) => {
    const s = readP(root);
    const [id] = retractedIds();
    if (!id)
      return {
        hole: "RETRACTED_TICKS is EMPTY, so no listed row exists to mutate. This arm of the staleness guard currently has no case proving it works: the mechanism has outlived its last member (#510, #512).",
      };
    const out = s.replace(
      new RegExp(`^- ✓ (\\*\\*${id}\\*\\*.*)$`, "m"),
      "- ✗ $1",
    );
    writeP(root, out);
    return out !== s;
  },
  "delete it from RETRACTED_TICKS",
);

/*
 * CITATION SYNTAX (#555) — three problems that looked like one.
 *
 * The fixture appends rows rather than editing existing ones, so these cases do not depend on
 * any particular requirement id surviving the backfill.
 */
/** Copy a real repo file into the fixture so a citation to it can resolve. */
const bring = (root, rel) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  cpSync(join(REPO, rel), join(root, rel));
};

const ROW_ANCHOR = /^(- ✓ \*\*SRV-01\*\*.*)$/m;
const addRow = (root, text) => {
  const s = readP(root);
  const out = s.replace(ROW_ANCHOR, `$1\n${text}`);
  writeP(root, out);
  return out !== s;
};

/*
 * A TABLE-GENERATED TEST IS CITED AS WRITTEN. `${type}` and all — the checker matches the
 * SOURCE, and the template is a literal in it. This is the case that dissolved the problem;
 * without it the next reader re-derives "generated names are not citable".
 */
withFixture(
  "a citation naming a template literal, `${...}` included, is ACCEPTED",
  (root) => {
    bring(root, "packages/react/src/schemas.test.ts");
    return addRow(
      root,
      "- ✓ **ZZZ-90** — a table-generated proof — v1.0 — verified by " +
        '`packages/react/src/schemas.test.ts` "returns { ok: true } for a valid ${type} envelope"',
    );
  },
  "pass",
);

/*
 * EVERY CITATION IS VALIDATED, NOT THE FIRST. This is the case that catches a /g regex reused
 * with .exec across rows — its lastIndex persists, so the second row's search starts wherever
 * the first left off and returns null spuriously. Only one row is cited on main today, so that
 * bug would have been LATENT and this suite would have passed while skipping citations.
 */
withFixture(
  "a row whose SECOND citation is broken FAILS — extras are checked, not carried",
  (root) => {
    /*
     * CITES A FILE THIS ONE IS NOT WRITTEN IN. The first draft cited
     * traceability.selftest.mjs for a name it claimed was absent — and that name is a literal
     * HERE, in the case asserting its absence, so `includes` found it and the case passed for
     * the worst possible reason. A fixture that cites its own source can never assert absence.
     */
    bring(root, "packages/react/src/schemas.test.ts");
    return addRow(
      root,
      "- ✓ **ZZZ-91** — two clauses — v1.0 — verified by " +
        '`packages/react/src/schemas.test.ts` "returns { ok: true } for a valid ${type} envelope"' +
        ' — verified by `packages/react/src/schemas.test.ts` "PHRASE_THAT_IS_NOT_THERE_' +
        'A9F3"',
    );
  },
  { fail: "contains no test named" },
);

/* CHECKER CITATIONS — allowed, and the conditions are what keep them honest. */
withFixture(
  "citing a checker that runs in CI and has its own proof is ACCEPTED",
  (root) => {
    bring(root, "scripts/assert-build-order.mjs");
    bring(root, "scripts/assert-build-order.selftest.mjs");
    bring(root, "package.json");
    bring(root, ".github/workflows/ci.yml");
    return addRow(
      root,
      "- ✓ **ZZZ-92** — proven by a checker — v1.0 — verified by " +
        '`scripts/assert-build-order.mjs` "turbo run build --dry=json"',
    );
  },
  "pass",
);

withFixture(
  "citing a checker's SELFTEST is refused — it is the proof, not the checker",
  (root) => {
    bring(root, "scripts/assert-build-order.selftest.mjs");
    return addRow(
      root,
      "- ✓ **ZZZ-93** — cites the wrong half — v1.0 — verified by " +
        '`scripts/assert-build-order.selftest.mjs` "build"',
    );
  },
  { fail: "SELFTEST CITED" },
);

withFixture(
  "citing a checker nothing in CI invokes is refused",
  (root) => {
    // A real checker file with a real selftest beside it, so the ONLY thing wrong is that
    // no package.json script and no workflow runs it.
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(
      join(root, "scripts/zzz-unrun.mjs"),
      "// nothing invokes this\n",
    );
    writeFileSync(
      join(root, "scripts/zzz-unrun.selftest.mjs"),
      "// its proof\n",
    );
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: {} }, null, 2),
    );
    return addRow(
      root,
      "- ✓ **ZZZ-94** — cites a checker nobody runs — v1.0 — verified by " +
        '`scripts/zzz-unrun.mjs` "nothing invokes this"',
    );
  },
  { fail: "UNRUN CHECKER" },
);

console.log(
  (failures ? `\n${failures} case(s) FAILED` : "\nall selftest cases passed") +
    (holes ? ` — ${holes} recorded HOLE(s), which are NOT passes` : ""),
);
process.exit(failures ? 1 : 0);
