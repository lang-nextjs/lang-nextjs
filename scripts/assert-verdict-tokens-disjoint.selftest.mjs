#!/usr/bin/env node
/**
 * Proof for assert-verdict-tokens-disjoint.mjs.
 *
 * THE REJECT ARM RECREATES THE ACTUAL DEFECT rather than asserting on a crafted string: a copy
 * of the tree with the fixture flag ignored, so the selftest's fixtures print the REAL token
 * again — which is precisely the state main was in when a fixture's TRANSPORT_DEFECT was nearly
 * reported as a real one while measuring #400.
 *
 * The ACCEPT arm is the real tree. Without it, a checker that failed on everything would satisfy
 * every reject case here.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { namesAreSeparable, tally } from "./assert-verdict-tokens-disjoint.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CHECKER = join(HERE, "assert-verdict-tokens-disjoint.mjs");

let pass = 0,
  fail = 0,
  ran = 0;
const watched = [];
const ok = (n, w) => {
  console.log(`  ok      ${n}`);
  watched.push(w);
  pass++;
};
const bad = (n, why, out) => {
  console.error(`  FAIL    ${n}\n          ${why}`);
  if (out)
    console.error(
      String(out)
        .split("\n")
        .slice(0, 12)
        .map((l) => `          | ${l}`)
        .join("\n")
    );
  fail++;
};

/** A scratch tree carrying the scripts the checker reads, optionally sabotaged. */
function tree(mutate = () => {}) {
  const d = mkdtempSync(join(tmpdir(), "vtok-"));
  mkdirSync(join(d, "scripts"), { recursive: true });
  cpSync(join(ROOT, "scripts"), join(d, "scripts"), { recursive: true });
  mutate(d);
  return d;
}
function run(cwd) {
  ran++;
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [CHECKER, "--cwd", cwd], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

console.log("assert-verdict-tokens-disjoint selftest\n");

// ── REJECT: the defect itself, recreated ──────────────────────────────────────────────────
{
  const d = tree((root) => {
    const p = join(root, "scripts/classify-live-failure.mjs");
    const s = readFileSync(p, "utf8");
    // The fix, undone: fixtures print the real token again.
    writeFileSync(
      p,
      s.replace(/const IS_FIXTURE = [^;]+;/, "const IS_FIXTURE = false;")
    );
  });
  const r = run(d);
  if (
    r.code === 1 &&
    /FIXTURE verdict\(s\) printed with the REAL token/.test(r.out)
  )
    ok(
      "REJECT  fixtures printing the REAL token are caught",
      "the #496 collision recreated and reported, with the offending lines quoted"
    );
  else bad("REJECT fixtures printing the REAL token", `exit=${r.code}`, r.out);
  rmSync(d, { recursive: true, force: true });
}

// ── ACCEPT: the tree as it stands ─────────────────────────────────────────────────────────
{
  const d = tree();
  const r = run(d);
  if (r.code === 0 && /token sets are disjoint/.test(r.out))
    ok(
      "ACCEPT  the real tree passes",
      "a checker that failed on everything is ruled out"
    );
  else bad("ACCEPT the real tree", `exit=${r.code}`, r.out);
  rmSync(d, { recursive: true, force: true });
}

// ── REJECT: presence, the half that rots ──────────────────────────────────────────────────
{
  const d = tree((root) => {
    const p = join(root, "scripts/classify-live-failure.mjs");
    const s = readFileSync(p, "utf8");
    // A classifier that stopped emitting the record at all. Disjointness is then trivially
    // true — of nothing — and only the presence companion notices.
    writeFileSync(p, s.replace("console.log(RECORD);", "void RECORD;"));
  });
  const r = run(d);
  if (r.code === 1 && /ZERO fixture verdicts|ZERO real verdicts/.test(r.out))
    ok(
      "REJECT  a classifier that emits NO verdict is caught by the presence companion",
      "disjointness over an empty set refusing to read as agreement"
    );
  else bad("REJECT no verdicts emitted", `exit=${r.code}`, r.out);
  rmSync(d, { recursive: true, force: true });
}

// ── the two pure properties, with inputs that can actually be constructed ─────────────────
{
  ran++;
  const shadowing = !namesAreSeparable(
    "LIVE_X_VERDICT",
    "PREFIX_LIVE_X_VERDICT"
  );
  const distinct = namesAreSeparable(
    "LIVE_TRANSPORT_VERDICT",
    "LIVE_TRANSPORT_SELFTEST_VERDICT"
  );
  if (shadowing && distinct)
    ok(
      "a token that CONTAINS the other is not separable, and the shipped pair is",
      "the shadow guard watched rejecting a pair no grep could split"
    );
  else bad("namesAreSeparable", `shadowing=${shadowing} distinct=${distinct}`);
}
{
  ran++;
  // A GREP DOES NOT ANCHOR, and neither does this. The first version used startsWith and
  // counted zero of both, because the selftest surfaces verdicts inside its own report lines.
  const t = tally(
    "  ok  some case   LIVE_TRANSPORT_SELFTEST_VERDICT verdict=PASS\n" +
      "LIVE_TRANSPORT_VERDICT verdict=TRANSPORT_DEFECT defects=2\n"
  );
  if (t.fixture.length === 1 && t.real.length === 1)
    ok(
      "a verdict INDENTED inside another line is still counted",
      "the anchoring mistake that made this checker green over a live collision"
    );
  else bad("tally", `fixture=${t.fixture.length} real=${t.real.length}`);
}

const EXPECTED = 5;
console.log();
if (ran !== EXPECTED) {
  console.error(
    `FAIL: ran ${ran} case(s), expected ${EXPECTED} — the harness is broken.`
  );
  process.exit(1);
}
if (fail) {
  console.error(`FAIL: ${fail}/${ran}. The checker is NOT trustworthy.`);
  process.exit(1);
}
console.log(`PASS: ${pass}/${ran}. Watched:`);
for (const w of watched) console.log(`      - ${w}`);
