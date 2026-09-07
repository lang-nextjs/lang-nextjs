#!/usr/bin/env node
/**
 * PROOF FOR assert-git-subject-stances.mjs — it catches an undeclared script, refuses to
 * take a declaration on trust, and cannot exempt itself.
 *
 * EVERY PLANT IS BUILT IN A TEMP REPO. Mutating this tree to prove the gate can fail would
 * leave the repository broken if a case threw between planting and restoring, and the gate
 * under test reads the working tree — so a half-restored plant would be indistinguishable
 * from a real violation on the next run.
 */
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { population } from "./assert-git-subject-stances.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECKER = join(ROOT, "scripts", "assert-git-subject-stances.mjs");

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name} — ${JSON.stringify(detail)?.slice(0, 260)}`);
  }
};

const git = (cwd, ...a) =>
  execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: "pipe" });

function run(cwd) {
  try {
    return {
      code: 0,
      out: execFileSync("node", [CHECKER, "--cwd", cwd], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (e) {
    return { code: e.status, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/** A repo with `scripts/` files and a stances file; `untracked` names files left uncommitted. */
function fixture({ files = {}, stances = {}, untracked = {} }) {
  const repo = mkdtempSync(join(tmpdir(), "stance-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "p@example.com");
  git(repo, "config", "user.name", "p");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  for (const [rel, body] of Object.entries(files))
    writeFileSync(join(repo, rel), body);
  writeFileSync(
    join(repo, "scripts/git-subject-stances.json"),
    JSON.stringify({ stances }, null, 2)
  );
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  for (const [rel, body] of Object.entries(untracked))
    writeFileSync(join(repo, rel), body);
  return repo;
}

const USES_GIT = 'execFileSync("git", ["ls-files", "-z"]);\n';
const USES_GIT_OTHERS =
  'execFileSync("git", ["ls-files", "-z", "--others"]);\n';
const WHY =
  "its subject is the committed tree a fork would receive, which is the tracked set exactly.";

/* ── CONTROL: the real repository ─────────────────────────────────────────────────────── */
{
  const r = run(ROOT);
  ok(
    "CONTROL: the real repo passes, over a subject the output names",
    r.code === 0,
    r.out
  );
  ok(
    "...and the subject is a real population, not an empty one passing vacuously",
    /SUBJECT: \d+ script\(s\)/.test(r.out) &&
      Number(/SUBJECT: (\d+)/.exec(r.out)?.[1] ?? 0) > 5,
    r.out.split("\n")[0]
  );
  /*
   * NO SELF-EXEMPTION. The gate matches on the literal "ls-files", which its own source
   * contains, so it belongs to its own population. This is the case that fails if someone
   * later "tidies" the detection in a way that quietly drops it — the exact shape the gate
   * exists to prevent, applied to the gate.
   */
  const stances = JSON.parse(
    readFileSync(join(ROOT, "scripts/git-subject-stances.json"), "utf8")
  ).stances;
  /*
   * THE LABEL AND THE BODY MUST HAVE THE SAME SUBJECT. This asserted only that the JSON
   * carries an entry for the gate — a claim about the DECLARATION FILE — while its name
   * claims a property of the CLASSIFIER. With a self-exemption added to the detection and
   * the JSON entry left in place, the old form reported ok WHILE THE GATE WAS EXEMPT FROM
   * ITS OWN RULE. Both halves are asserted now: it is IN the population, and it declares.
   */
  const self = "scripts/assert-git-subject-stances.mjs";
  ok(
    "...and the gate DECLARES ITSELF — it cannot be exempt from its own rule",
    population(ROOT).some((m) => m.rel === self) && Boolean(stances[self]),
    {
      inPopulation: population(ROOT).some((m) => m.rel === self),
      declared: Boolean(stances[self]),
    }
  );
}

/* ── PLANT: a git-subject script with no stance at all ────────────────────────────────── */
{
  const repo = fixture({ files: { "scripts/a.mjs": USES_GIT }, stances: {} });
  const r = run(repo);
  ok(
    "PLANT: an undeclared git-subject script FAILS (exit 1)",
    r.code === 1,
    r.out.slice(0, 200)
  );
  ok(
    "...and it is named, not counted",
    /scripts\/a\.mjs/.test(r.out),
    r.out.slice(0, 200)
  );
  rmSync(repo, { recursive: true, force: true });
}

/* ── PLANT: an UNTRACKED new script — the defect this gate committed on its own first run ─ */
{
  const repo = fixture({
    files: { "scripts/a.mjs": USES_GIT },
    stances: {
      "scripts/a.mjs": { untracked: "out-of-scope", why: WHY, lifts: null },
    },
    untracked: { "scripts/brand-new.mjs": USES_GIT },
  });
  const r = run(repo);
  ok(
    "PLANT: a NEW, still-untracked git-subject script is caught — the gate sees past ls-files",
    r.code === 1 && /brand-new\.mjs/.test(r.out),
    { code: r.code, out: r.out.slice(0, 220) }
  );
  rmSync(repo, { recursive: true, force: true });
}

/* ── PLANT: "examined" that the source cannot support ─────────────────────────────────── */
{
  const repo = fixture({
    files: { "scripts/a.mjs": USES_GIT }, // no --others
    stances: {
      "scripts/a.mjs": { untracked: "examined", why: WHY, lifts: null },
    },
  });
  const r = run(repo);
  ok(
    'PLANT: "examined" without `--others` FAILS — a declaration is corroborated, not trusted',
    r.code === 1 && /never passes/.test(r.out),
    r.out.slice(0, 240)
  );
  rmSync(repo, { recursive: true, force: true });
}
{
  const repo = fixture({
    files: { "scripts/a.mjs": USES_GIT_OTHERS },
    stances: {
      "scripts/a.mjs": { untracked: "examined", why: WHY, lifts: null },
    },
  });
  const r = run(repo);
  ok(
    "...and the SAME declaration passes when the source does pass `--others`",
    r.code === 0,
    r.out.slice(0, 200)
  );
  rmSync(repo, { recursive: true, force: true });
}

/* ── PLANT: a gap with nowhere to go, and a decision pretending to be one ─────────────── */
{
  const repo = fixture({
    files: { "scripts/a.mjs": USES_GIT },
    stances: {
      "scripts/a.mjs": { untracked: "unexamined", why: WHY, lifts: null },
    },
  });
  const r = run(repo);
  ok(
    'PLANT: "unexamined" with no issue pointer FAILS — a gap with no pointer becomes a decision',
    r.code === 1 && /lifts/.test(r.out),
    r.out.slice(0, 240)
  );
  rmSync(repo, { recursive: true, force: true });
}
{
  const repo = fixture({
    files: { "scripts/a.mjs": USES_GIT },
    stances: {
      "scripts/a.mjs": { untracked: "out-of-scope", why: WHY, lifts: "#123" },
    },
  });
  const r = run(repo);
  ok(
    "PLANT: a stated decision carrying a `lifts` pointer FAILS — only a gap is pending",
    r.code === 1,
    r.out.slice(0, 220)
  );
  rmSync(repo, { recursive: true, force: true });
}

/* ── PLANT: a reason too short to be one ──────────────────────────────────────────────── */
{
  const repo = fixture({
    files: { "scripts/a.mjs": USES_GIT },
    stances: {
      "scripts/a.mjs": { untracked: "out-of-scope", why: "n/a", lifts: null },
    },
  });
  const r = run(repo);
  ok(
    "PLANT: a placeholder `why` FAILS — the reason is the whole mechanism",
    r.code === 1 && /usable `why`/.test(r.out),
    r.out.slice(0, 220)
  );
  rmSync(repo, { recursive: true, force: true });
}

/* ── PLANT: over-reach, which is the CLASSIFIER'S positive control ────────────────────── */
{
  const repo = fixture({
    files: {
      "scripts/a.mjs": USES_GIT,
      "scripts/nogit.mjs": "export const x = 1;\n",
    },
    stances: {
      "scripts/a.mjs": { untracked: "out-of-scope", why: WHY, lifts: null },
      "scripts/nogit.mjs": { untracked: "out-of-scope", why: WHY, lifts: null },
    },
  });
  const r = run(repo);
  ok(
    "PLANT: a stance for a script OUTSIDE the population FAILS — this is how classifier drift surfaces",
    r.code === 1 && /NOT in the population/.test(r.out),
    r.out.slice(0, 240)
  );
  rmSync(repo, { recursive: true, force: true });
}

/* ── REFUSALS: could not ask ──────────────────────────────────────────────────────────── */
{
  const repo = fixture({ files: { "scripts/a.mjs": USES_GIT }, stances: {} });
  rmSync(join(repo, "scripts/git-subject-stances.json"), { force: true });
  const r = run(repo);
  ok(
    "REFUSE: an unreadable stances file exits 2, not 1 — nothing is violated, nothing was asked",
    r.code === 2,
    r.out.slice(0, 200)
  );
  rmSync(repo, { recursive: true, force: true });
}
{
  const repo = fixture({
    files: { "scripts/none.mjs": "export const x = 1;\n" },
    stances: {},
  });
  const r = run(repo);
  ok(
    "REFUSE: a tree where NOTHING matches exits 2 rather than passing over an empty population",
    r.code === 2 && /found nothing/.test(r.out),
    { code: r.code, out: r.out.slice(0, 200) }
  );
  rmSync(repo, { recursive: true, force: true });
}

const total = pass + fail;
console.log();
if (fail) {
  console.error(`FAIL: ${fail}/${total} cases wrong.`);
  process.exit(1);
}
console.log(
  `PASS: ${pass}/${total}. The gate names an undeclared script, refuses to take "examined"\n` +
    `      on trust, keeps a gap pointing at an issue, surfaces classifier drift through\n` +
    `      over-reach, and includes ITSELF in the population it polices.`
);
