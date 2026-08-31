#!/usr/bin/env node
/**
 * Proof for assert-every-rung-is-witnessed.mjs.
 *
 * TWO KINDS OF CASE, AND THE SPLIT IS THE HONEST PART.
 *
 * Where the failure is reachable through the REAL matrix generator, the sandbox copies
 * `matrix.mjs` and drives it against a synthetic manifest — the floor moving, a forest, a
 * manifest that encodes the ladder twice and disagrees.
 *
 * The unwitnessed-rung rejection is NOT reachable that way: `matrix.mjs` refuses a manifest
 * where any rung gets no job, and given a cell per rung the lowest one removes everything above
 * the floor. So that case supplies the cells directly through a stub generator. It is a
 * measurement of the CHECKER, not of the repo, and marking which is which is the point — a
 * proof that quietly used a stub everywhere would look identical and mean much less.
 *
 * Usage: node scripts/assert-every-rung-is-witnessed.selftest.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKER = join(HERE, "assert-every-rung-is-witnessed.mjs");
const REAL_MATRIX = join(HERE, "matrix.mjs");
const TMP = mkdtempSync(join(tmpdir(), "witness-"));
let pass = 0, fail = 0;

const rung = (id, ordinal, requires, languages = ["ts"]) => ({
  id, ordinal, requires, languages, runtimes: [], shape: "s", state: "implemented",
  target: null, ownedFileCount: 0, reach: {}, owns: {},
});

/** `generator: "real"` copies matrix.mjs; otherwise a stub emitting the given cells. */
function sandbox(rungs, { generator = "real", cells = null } = {}) {
  const dir = mkdtempSync(join(TMP, "case-"));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "rungs.json"), JSON.stringify({ rungs }));
  if (generator === "real") {
    copyFileSync(REAL_MATRIX, join(dir, "scripts", "matrix.mjs"));
  } else {
    writeFileSync(
      join(dir, "scripts", "matrix.mjs"),
      `console.log("matrix=" + JSON.stringify({ include: ${JSON.stringify(cells)} }));\n`
    );
  }
  return dir;
}

function run(dir) {
  try {
    return { rc: 0, out: execFileSync("node", [CHECKER, "--cwd", dir], { encoding: "utf8" }) };
  } catch (e) {
    return { rc: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

function expect(label, want, dir, mustSay = []) {
  const { rc, out } = run(dir);
  const got = rc === 0 ? "accept" : rc === 2 ? "refuse" : "reject";
  const said = mustSay.every((s) => out.includes(s));
  if (got === want && said) { console.log(`  ok   ${label.padEnd(62)} (${want})`); pass++; }
  else {
    console.error(`  FAIL ${label} — wanted ${want}, got ${got} (rc=${rc}), named=${said}`);
    console.error(out.split("\n").map((l) => "         " + l).join("\n"));
    fail++;
  }
}

const LADDER = [rung("base", 1, []), rung("mid", 2, ["base"]), rung("top", 3, ["mid"])];

console.log("\nassert-every-rung-is-witnessed — driven by the REAL matrix generator\n");

expect("a complete ladder: every rung above the floor is witnessed", "accept",
  sandbox(LADDER), ["floor is \"base\"", "mid", "top", "PASS"]);

/*
 * THE FLOOR IS COMPUTED, NOT NAMED. Insert a rung BELOW the old floor: the new one requires
 * nothing and becomes excluded, and the OLD floor now has to be witnessed like any other rung.
 * A hardcoded name would keep excusing "base" and would stop excusing the rung that actually
 * cannot be removed — wrong in both directions at once.
 */
expect("insert a rung below the floor: the exclusion MOVES to it", "accept",
  sandbox([rung("newfloor", 0, []), rung("base", 1, ["newfloor"]), rung("mid", 2, ["base"])]),
  ["floor is \"newfloor\"", "base", "removed by"]);

console.log("\nassert-every-rung-is-witnessed — REFUSALS (the ladder is not a ladder)\n");

expect("two rungs requiring nothing is a forest, not a ladder", "refuse",
  sandbox([rung("a", 1, []), rung("b", 2, []), rung("c", 3, ["a"])]),
  ["forest", "ambiguous"]);

expect("no rung requiring nothing is a cycle", "refuse",
  sandbox([rung("a", 1, ["b"]), rung("b", 2, ["a"])]), ["cycle"]);

/*
 * TWO ENCODINGS OF THE SAME LADDER THAT DISAGREE. `requires` and `ordinal` both say where the
 * floor is, and nothing else asserts they agree; if they diverge every verdict is over the
 * wrong subject.
 */
expect("requires and ordinal disagree about the floor", "refuse",
  sandbox([rung("a", 5, []), rung("b", 1, ["a"])]), ["disagree"]);

expect("a single-rung ladder has no 'above the floor' to check", "refuse",
  sandbox([rung("only", 1, [])]), ["fewer than two"]);

console.log("\nassert-every-rung-is-witnessed — REJECT (stubbed: not reachable via the real generator)\n");

/*
 * THE CASE THE CHECK EXISTS FOR, and it has to be built by hand: matrix.mjs refuses a manifest
 * where a rung gets no cell, so the lowest cell always exists and always removes everything
 * above the floor. This supplies cells directly to show the checker CAN fail — without it the
 * green above would be a green nobody has watched fail.
 */
expect("a rung above the floor that no cell removes", "reject",
  sandbox(LADDER, {
    generator: "stub",
    // No cell retains ONLY [base], so nothing ever removes `mid`.
    cells: [
      { name: "cell-mid", retained: "base,mid" },
      { name: "cell-top", retained: "base,mid,top" },
    ],
  }),
  ["mid", "removed by NO cell", "never been shown"]);

expect("a matrix that emits no cells at all is a refusal", "refuse",
  sandbox(LADDER, { generator: "stub", cells: [] }), ["no cells"]);

const EXPECTED = 8;
const total = pass + fail;
console.log();
rmSync(TMP, { recursive: true, force: true });
if (total !== EXPECTED) { console.error(`FAIL: ran ${total} cases, expected ${EXPECTED} — the harness is broken.`); process.exit(1); }
if (fail !== 0) { console.error(`FAIL: ${fail}/${total} cases wrong.`); process.exit(1); }
console.log(
  `PASS: ${pass}/${total}. The exclusion follows the floor when the ladder changes, a ladder\n` +
    `      that is not a ladder is refused rather than guessed at, and the unwitnessed-rung\n` +
    `      rejection is demonstrated on supplied cells because the real generator cannot\n` +
    `      currently produce it.`
);
